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
  delayNode: null,
  delaySec: 0,
  worklet: null,
  engine: null, // 'whisper' | 'webspeech'
  settings: null,
  recognition: null,
  transcriber: null,
  transcriberModel: null,
  // chunker
  blocks: [],
  bufLen: 0,
  bufStartWall: 0, // Date.now() of the first sample in the buffer
  silenceRun: Infinity,
  hadVoice: false,
  flushGen: 0,
  queue: [],
  // inference
  inferTimer: null,
  inferBusy: false,
  lastInferMs: Infinity,
  lastInterimAt: 0,
};

// ---------------------------------------------------------------- messaging

function send(msg) {
  return chrome.runtime.sendMessage({ target: 'bg', ...msg }).catch(() => {});
}

function sendStatus(status, detail, progress) {
  return send({ type: 'status', status, detail, progress });
}

// t0: wall-clock ms of when the transcribed audio started playing live.
// The content script uses it to show the caption in sync with delayed video.
// est marks t0 as a rough estimate (Web Speech gives no audio timestamps).
function sendSubtitle(text, isFinal, t0, dur, est) {
  return send({ type: 'subtitle', text, isFinal, t0, dur, est });
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
  if (msg.type === 'set-delay') {
    // Video sync failed on the page: drop the audio delay so what the user
    // hears matches the live video again.
    state.delaySec = msg.seconds || 0;
    if (state.delayNode) state.delayNode.delayTime.value = state.delaySec;
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

  // Tab audio is muted while captured; play it back so the viewer still hears
  // it. With sync delay enabled, playback is delayed so it matches the delayed
  // video on the page, while transcription below still reads the live audio.
  state.audioCtx = new AudioContext();
  const source = state.audioCtx.createMediaStreamSource(state.media);
  state.delaySec = Math.max(0, Math.min(10, Number(settings.syncDelay) || 0));
  if (state.delaySec > 0) {
    state.delayNode = new DelayNode(state.audioCtx, {
      delayTime: state.delaySec,
      maxDelayTime: 10,
    });
    source.connect(state.delayNode);
    state.delayNode.connect(state.audioCtx.destination);
  } else {
    source.connect(state.audioCtx.destination);
  }

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
  stopInferLoop();
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
  state.delayNode = null;
  if (state.media) {
    for (const track of state.media.getTracks()) track.stop();
    state.media = null;
  }
  state.blocks = [];
  state.bufLen = 0;
  state.bufStartWall = 0;
  state.silenceRun = Infinity;
  state.hadVoice = false;
  state.flushGen = 0;
  state.queue = [];
  state.inferBusy = false;
  state.lastInferMs = Infinity;
  state.lastInterimAt = 0;
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
        // Web Speech gives no audio timestamps; estimate when the words were
        // spoken so sync-delayed display lines up roughly.
        if (text) sendSubtitle(text, true, Date.now() - 1500, 2, true);
      } else {
        interim += res[0].transcript;
      }
    }
    if (interim.trim()) sendSubtitle(interim.trim(), false, Date.now() - 800, 1.5, true);
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

  startInferLoop();
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
// is followed by ~0.45s of silence, or when 5s have accumulated.
const CHUNK = {
  minSec: 1.0,
  maxSec: 5.0,
  silenceSec: 0.45,
  rmsThreshold: 0.006,
};

function onSamples(f32) {
  if (state.bufLen === 0) {
    state.bufStartWall = Date.now() - (f32.length / SR16) * 1000;
  }
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
    state.flushGen++; // invalidate any in-flight interim pass
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
    state.queue.push({
      pcm: concatBlocks(state.blocks, state.bufLen),
      t0: state.bufStartWall,
      dur: state.bufLen / SR16,
    });
  }
  state.blocks = [];
  state.bufLen = 0;
  state.silenceRun = Infinity;
  state.hadVoice = false;
  state.flushGen++;
}

function concatBlocks(blocks, len) {
  const out = new Float32Array(len);
  let off = 0;
  for (const b of blocks) {
    out.set(b, off);
    off += b.length;
  }
  return out;
}

// All Whisper inference is serialized through this loop. Finished chunks take
// priority; when idle and the GPU is fast enough, the still-growing buffer is
// transcribed as an interim (italic) caption for lower perceived latency.
function startInferLoop() {
  stopInferLoop();
  state.inferTimer = setInterval(inferTick, 150);
}

function stopInferLoop() {
  if (state.inferTimer) {
    clearInterval(state.inferTimer);
    state.inferTimer = null;
  }
}

async function inferTick() {
  if (state.inferBusy || !state.active || state.engine !== 'whisper') return;
  state.inferBusy = true;
  try {
    if (state.queue.length > 0) {
      // If transcription falls behind, drop the oldest chunks to stay live.
      while (state.queue.length > 2) state.queue.shift();
      const job = state.queue.shift();
      const text = await transcribe(job.pcm);
      if (state.active && text && !isJunk(text)) {
        sendSubtitle(text, true, job.t0, job.dur);
      }
    } else if (canInterim()) {
      const gen = state.flushGen;
      const t0 = state.bufStartWall;
      const pcm = concatBlocks(state.blocks, state.bufLen);
      state.lastInterimAt = Date.now();
      const text = await transcribe(pcm);
      // Discard if the buffer was flushed while we were transcribing: the
      // final result for this audio is already on its way.
      if (state.active && gen === state.flushGen && text && !isJunk(text)) {
        sendSubtitle(text, false, t0, pcm.length / SR16);
      }
    }
  } catch (e) {
    console.error('transcription failed:', e);
    sendStatus('error', 'Transcription failed: ' + (e.message || e));
    stopInferLoop();
  } finally {
    state.inferBusy = false;
  }
}

function canInterim() {
  return (
    state.hadVoice &&
    state.bufLen >= 1.3 * SR16 &&
    Date.now() - state.lastInterimAt >= 1200 &&
    state.lastInferMs < 900
  );
}

async function transcribe(pcm) {
  const opts = {
    task: state.settings.translate ? 'translate' : 'transcribe',
  };
  if (state.settings.language) opts.language = state.settings.language;
  const started = Date.now();
  const out = await state.transcriber(pcm, opts);
  state.lastInferMs = Date.now() - started;
  return (out.text || '').trim();
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
