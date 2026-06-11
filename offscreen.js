// Offscreen document: captures tab audio, keeps it audible, runs speech
// recognition (local Whisper via transformers.js, or Chrome's Web Speech API)
// and streams subtitle text back to the background service worker.

'use strict';

const SR16 = 16000;

const MODEL_IDS = {
  tiny: 'onnx-community/whisper-tiny',
  base: 'onnx-community/whisper-base',
  small: 'onnx-community/whisper-small',
};

// language code -> BCP-47 tag for the Web Speech API
const BCP47 = {
  en: 'en-US', es: 'es-ES', pt: 'pt-BR', fr: 'fr-FR', de: 'de-DE',
  it: 'it-IT', ru: 'ru-RU', ja: 'ja-JP', ko: 'ko-KR', zh: 'zh-CN',
  ar: 'ar-SA', hi: 'hi-IN', tr: 'tr-TR', pl: 'pl-PL', nl: 'nl-NL',
  uk: 'uk-UA', vi: 'vi-VN', th: 'th-TH', id: 'id-ID',
};

const state = {
  active: false,
  media: null,
  audioCtx: null,
  worklet: null,
  engine: null, // 'whisper' | 'webspeech'
  settings: null,
  recognition: null,
  transcriber: null,
  transcriberModel: null,
  // chunker
  blocks: [],
  bufLen: 0,
  silenceRun: Infinity,
  hadVoice: false,
  queue: [],
  pumping: false,
};

// ---------------------------------------------------------------- messaging

function send(msg) {
  return chrome.runtime.sendMessage({ target: 'bg', ...msg }).catch(() => {});
}

function sendStatus(status, detail, progress) {
  return send({ type: 'status', status, detail, progress });
}

function sendSubtitle(text, isFinal) {
  return send({ type: 'subtitle', text, isFinal });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'offscreen') return false;
  if (msg.type === 'start') {
    start(msg.streamId, msg.settings)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => {
        console.error(e);
        sendStatus('error', e.message || String(e));
        sendResponse({ ok: false });
      });
    return true;
  }
  if (msg.type === 'stop') {
    stop();
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

// ------------------------------------------------------------------ capture

async function start(streamId, settings) {
  stop();
  state.settings = settings;
  state.active = true;

  state.media = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
    video: false,
  });

  // Tab audio is muted while captured; play it back so the viewer still hears it.
  state.audioCtx = new AudioContext();
  const source = state.audioCtx.createMediaStreamSource(state.media);
  source.connect(state.audioCtx.destination);

  const engine = settings.engine || 'whisper';
  if (engine === 'webspeech' || engine === 'auto') {
    try {
      startWebSpeech(settings, engine === 'auto');
      state.engine = 'webspeech';
      sendStatus('live', 'Live (Chrome speech recognition)');
      return;
    } catch (e) {
      if (engine === 'webspeech') {
        throw new Error(
          'Chrome built-in recognition is unavailable on this browser (' +
            (e.message || e) +
            '). Switch the engine to Whisper.'
        );
      }
      console.warn('Web Speech unavailable, falling back to Whisper:', e);
    }
  }

  state.engine = 'whisper';
  await startWhisper(source, settings);
}

function stop() {
  state.active = false;
  if (state.recognition) {
    try { state.recognition.stop(); } catch (e) {}
    state.recognition = null;
  }
  if (state.worklet) {
    try { state.worklet.port.onmessage = null; } catch (e) {}
    state.worklet = null;
  }
  if (state.audioCtx) {
    state.audioCtx.close().catch(() => {});
    state.audioCtx = null;
  }
  if (state.media) {
    for (const track of state.media.getTracks()) track.stop();
    state.media = null;
  }
  state.blocks = [];
  state.bufLen = 0;
  state.silenceRun = Infinity;
  state.hadVoice = false;
  state.queue = [];
}

// --------------------------------------------------- engine 1: Web Speech API

function startWebSpeech(settings, autoFallback) {
  const SR = self.SpeechRecognition || self.webkitSpeechRecognition;
  if (!SR) throw new Error('SpeechRecognition not supported');

  const track = state.media.getAudioTracks()[0];
  const rec = new SR();
  rec.continuous = true;
  rec.interimResults = true;
  if (settings.language) rec.lang = BCP47[settings.language] || settings.language;

  let gotResult = false;
  rec.onresult = (event) => {
    gotResult = true;
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const res = event.results[i];
      if (res.isFinal) {
        const text = res[0].transcript.trim();
        if (text) sendSubtitle(text, true);
      } else {
        interim += res[0].transcript;
      }
    }
    if (interim.trim()) sendSubtitle(interim.trim(), false);
  };

  rec.onerror = (event) => {
    console.warn('webspeech error:', event.error);
    if (!state.active) return;
    // Non-recoverable errors: fall back to Whisper in auto mode.
    if (['not-allowed', 'service-not-allowed', 'language-not-supported', 'audio-capture'].includes(event.error)) {
      failover(autoFallback, 'Speech service rejected the stream (' + event.error + ')');
    }
  };

  rec.onend = () => {
    if (!state.active || state.recognition !== rec) return;
    // Sessions time out periodically; restart with the same track.
    try {
      rec.start(track);
    } catch (e) {
      failover(autoFallback, 'Could not restart recognition');
    }
  };

  // Chrome 139+ accepts a MediaStreamTrack; older versions throw, which
  // triggers the Whisper fallback in start().
  rec.start(track);
  state.recognition = rec;

  // If nothing at all arrives in the first 12s of audio, assume the engine is
  // not actually working with this track and fail over (auto mode only).
  if (autoFallback) {
    setTimeout(() => {
      if (state.active && state.engine === 'webspeech' && !gotResult) {
        failover(true, 'No results from Chrome recognition');
      }
    }, 12000);
  }
}

function failover(autoFallback, reason) {
  if (!state.active) return;
  if (state.recognition) {
    try { state.recognition.onend = null; state.recognition.stop(); } catch (e) {}
    state.recognition = null;
  }
  if (!autoFallback) {
    sendStatus('error', reason + '. Switch the engine to Whisper in the popup.');
    return;
  }
  console.warn('Falling back to Whisper:', reason);
  state.engine = 'whisper';
  const source = state.audioCtx.createMediaStreamSource(state.media);
  startWhisper(source, state.settings).catch((e) => {
    sendStatus('error', e.message || String(e));
  });
}

// ------------------------------------------------- engine 2: local Whisper

async function startWhisper(source, settings) {
  sendStatus('loading-model', 'Loading speech model…', 0);
  await loadTranscriber(settings);
  if (!state.active) return;

  await state.audioCtx.audioWorklet.addModule('worklet.js');
  if (!state.active) return;
  const tap = new AudioWorkletNode(state.audioCtx, 'pcm-tap');
  source.connect(tap);
  // Keep the worklet in the processing graph without making it audible.
  const mute = state.audioCtx.createGain();
  mute.gain.value = 0;
  tap.connect(mute).connect(state.audioCtx.destination);
  state.worklet = tap;

  const inRate = state.audioCtx.sampleRate;
  tap.port.onmessage = (e) => {
    if (!state.active || state.engine !== 'whisper') return;
    onSamples(resampleTo16k(e.data, inRate));
  };

  sendStatus('live', 'Live (Whisper ' + (settings.model || 'base') + ')');
}

async function loadTranscriber(settings) {
  const modelId = MODEL_IDS[settings.model] || MODEL_IDS.base;
  if (state.transcriber && state.transcriberModel === modelId) return;

  const { pipeline, env } = await import('./lib/transformers.min.js');
  env.allowLocalModels = false;
  env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('lib/');

  const progressFiles = {};
  let lastSent = 0;
  const progress_callback = (p) => {
    if (p.status !== 'progress' || !p.total) return;
    progressFiles[p.file] = { loaded: p.loaded, total: p.total };
    const now = Date.now();
    if (now - lastSent < 250) return;
    lastSent = now;
    let loaded = 0;
    let total = 0;
    for (const f of Object.values(progressFiles)) {
      loaded += f.loaded;
      total += f.total;
    }
    const pct = total ? Math.round((loaded / total) * 100) : 0;
    sendStatus('loading-model', 'Downloading speech model… ' + pct + '%', pct);
  };

  let transcriber;
  try {
    transcriber = await pipeline('automatic-speech-recognition', modelId, {
      device: 'webgpu',
      dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
      progress_callback,
    });
  } catch (e) {
    console.warn('WebGPU unavailable, using WASM:', e);
    sendStatus('loading-model', 'Loading speech model (CPU)…', 0);
    transcriber = await pipeline('automatic-speech-recognition', modelId, {
      device: 'wasm',
      dtype: 'q8',
      progress_callback,
    });
  }
  state.transcriber = transcriber;
  state.transcriberModel = modelId;
}

// Voice-activity based chunking: flush a chunk to the ASR queue when speech
// is followed by ~0.5s of silence, or when 6s have accumulated.
const CHUNK = {
  minSec: 1.0,
  maxSec: 6.0,
  silenceSec: 0.5,
  rmsThreshold: 0.006,
};

function onSamples(f32) {
  state.blocks.push(f32);
  state.bufLen += f32.length;

  let sum = 0;
  for (let i = 0; i < f32.length; i++) sum += f32[i] * f32[i];
  const rms = Math.sqrt(sum / f32.length);
  if (rms > CHUNK.rmsThreshold) {
    state.silenceRun = 0;
    state.hadVoice = true;
  } else {
    state.silenceRun += f32.length;
  }

  const secs = state.bufLen / SR16;
  if (!state.hadVoice && secs >= 3) {
    // pure silence/music bed - discard instead of transcribing
    state.blocks = [];
    state.bufLen = 0;
    return;
  }
  if (
    (state.hadVoice && secs >= CHUNK.minSec && state.silenceRun / SR16 >= CHUNK.silenceSec) ||
    secs >= CHUNK.maxSec
  ) {
    flushChunk();
  }
}

function flushChunk() {
  if (state.hadVoice && state.bufLen > 0) {
    const chunk = new Float32Array(state.bufLen);
    let off = 0;
    for (const b of state.blocks) {
      chunk.set(b, off);
      off += b.length;
    }
    state.queue.push(chunk);
    pump();
  }
  state.blocks = [];
  state.bufLen = 0;
  state.silenceRun = Infinity;
  state.hadVoice = false;
}

async function pump() {
  if (state.pumping) return;
  state.pumping = true;
  try {
    while (state.active && state.queue.length > 0) {
      // If transcription falls behind, drop the oldest chunks to stay live.
      while (state.queue.length > 2) state.queue.shift();
      const chunk = state.queue.shift();
      try {
        const opts = {
          task: state.settings.translate ? 'translate' : 'transcribe',
        };
        if (state.settings.language) opts.language = state.settings.language;
        const out = await state.transcriber(chunk, opts);
        const text = (out.text || '').trim();
        if (state.active && text && !isJunk(text)) {
          sendSubtitle(text, true);
        }
      } catch (e) {
        console.error('transcription failed:', e);
        sendStatus('error', 'Transcription failed: ' + (e.message || e));
        return;
      }
    }
  } finally {
    state.pumping = false;
  }
}

// Whisper emits non-speech tags like "[Music]" or "(applause)" on noisy audio.
function isJunk(text) {
  if (/^[\s.,!?\-♪]*$/.test(text)) return true;
  if (/^[\[(].*[\])]$/.test(text)) return true;
  return false;
}

function resampleTo16k(input, fromRate) {
  if (fromRate === SR16) return input;
  const ratio = fromRate / SR16;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = pos - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}
