// Content script: renders the subtitle overlay on kick.com pages.
// Receives subtitle/status messages forwarded by the background worker.

(() => {
  'use strict';
  if (window.__klsInjected) return;
  window.__klsInjected = true;

  const HIDE_AFTER_MS = 6000;

  let overlay = null;
  let lineEl = null;
  let interimEl = null;
  let statusEl = null;
  let finals = [];
  let hideTimer = null;

  // A/V sync: when > 0, the page video is shown delayMs late (via the
  // WebCodecs pipeline below) and captions are scheduled to match.
  let delayMs = 0;
  let lastFinalEnd = 0; // wall-clock end (t0 + dur) of the last shown final
  let pipeline = null;
  let findVideoTries = 0;

  const settings = { fontSize: 22, bgOpacity: 0.55 };
  chrome.storage.local.get(settings).then((s) => {
    Object.assign(settings, s);
    applySettings();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.fontSize) settings.fontSize = changes.fontSize.newValue;
    if (changes.bgOpacity) settings.bgOpacity = changes.bgOpacity.newValue;
    applySettings();
  });

  function ensureOverlay() {
    if (overlay && document.contains(overlay)) return;
    overlay = document.createElement('div');
    overlay.id = 'kls-overlay';
    overlay.innerHTML =
      '<div class="kls-status"></div>' +
      '<div class="kls-line kls-final"></div>' +
      '<div class="kls-line kls-interim"></div>';
    statusEl = overlay.querySelector('.kls-status');
    lineEl = overlay.querySelector('.kls-final');
    interimEl = overlay.querySelector('.kls-interim');
    (document.fullscreenElement || document.body).appendChild(overlay);
    applySettings();
    makeDraggable(overlay);
  }

  function applySettings() {
    if (!overlay) return;
    overlay.style.setProperty('--kls-font-size', settings.fontSize + 'px');
    overlay.style.setProperty('--kls-bg-alpha', settings.bgOpacity);
  }

  // Keep the overlay visible when the player goes fullscreen: it must be a
  // descendant of the fullscreened element to be rendered.
  document.addEventListener('fullscreenchange', () => {
    if (!overlay) return;
    (document.fullscreenElement || document.body).appendChild(overlay);
  });

  function makeDraggable(el) {
    let startX, startY, origX, origY;
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      startX = e.clientX;
      startY = e.clientY;
      const r = el.getBoundingClientRect();
      origX = r.left;
      origY = r.top;
      el.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        el.style.left = origX + dx + 'px';
        el.style.top = origY + dy + 'px';
        el.style.bottom = 'auto';
        el.style.transform = 'none';
      };
      const up = (ev) => {
        el.releasePointerCapture(e.pointerId);
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
    });
    // Double-click resets to the default bottom-center position.
    el.addEventListener('dblclick', () => {
      el.style.left = '50%';
      el.style.top = 'auto';
      el.style.bottom = '12%';
      el.style.transform = 'translateX(-50%)';
    });
  }

  function showSubtitle(text, isFinal) {
    ensureOverlay();
    overlay.classList.add('kls-visible');
    if (isFinal) {
      finals.push(text);
      if (finals.length > 2) finals = finals.slice(-2);
      interimEl.textContent = '';
    } else {
      interimEl.textContent = text;
    }
    lineEl.textContent = finals.join(' ');
    // Keep roughly the last two sentences worth of text on screen.
    while (lineEl.textContent.length > 160 && finals.length > 1) {
      finals.shift();
      lineEl.textContent = finals.join(' ');
    }
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      finals = [];
      lineEl.textContent = '';
      interimEl.textContent = '';
      if (!statusEl.textContent) overlay.classList.remove('kls-visible');
    }, HIDE_AFTER_MS);
  }

  function showStatus(status, detail) {
    ensureOverlay();
    if (status === 'live' || status === 'idle') {
      statusEl.textContent = '';
      if (status === 'idle') overlay.classList.remove('kls-visible');
      return;
    }
    overlay.classList.add('kls-visible');
    statusEl.textContent = detail || status;
  }

  // ------------------------------------------------- caption scheduling

  // Captions carry the wall-clock time their audio played live (t0). With the
  // video shown delayMs late, displaying at t0 + delayMs puts the caption on
  // screen exactly when the delayed video replays that moment.
  function scheduleSubtitle(msg) {
    const showAt = (msg.t0 || Date.now()) + delayMs;
    const wait = showAt - Date.now();
    if (wait <= 10) {
      displaySubtitle(msg);
    } else {
      setTimeout(() => displaySubtitle(msg), wait);
    }
  }

  function displaySubtitle(msg) {
    // Drop interim text whose audio range was already covered by a final.
    // Estimated timestamps (Web Speech) are too coarse for this check.
    if (!msg.isFinal && !msg.est && msg.t0 && msg.t0 < lastFinalEnd - 250) return;
    if (msg.isFinal && !msg.est && msg.t0) lastFinalEnd = msg.t0 + (msg.dur || 0) * 1000;
    showSubtitle(msg.text, msg.isFinal);
  }

  // ------------------------------------------------- delayed video pipeline

  // Shows the player delayMs late: captures the page <video>'s frames,
  // compresses them with WebCodecs (a few MB instead of GB of raw frames),
  // holds the encoded chunks for delayMs, then decodes onto a canvas that
  // covers the live video. Audio is delayed to match by the offscreen
  // document, which also keeps transcribing the live (undelayed) audio.
  class VideoDelayPipeline {
    constructor(video, delayMs) {
      this.video = video;
      this.delayMs = delayMs;
      this.alive = true;
      this.queue = []; // { chunk, config, due }
      this.canvas = null;
      this.ctx = null;
      this.encoder = null;
      this.decoder = null;
      this.reader = null;
      this.track = null;
      this.feedTimer = null;
      this.geoTimer = null;
      this.cfgW = 0;
      this.cfgH = 0;
      this.frameCount = 0;
      this.keyInterval = 60;
      this.activeCodec = null;
      this.decoderConfigured = false;
      this.gotFrame = false;
      this.ondead = null;
    }

    async start() {
      if (typeof VideoEncoder === 'undefined' || typeof MediaStreamTrackProcessor === 'undefined') {
        throw new Error('WebCodecs is not supported by this browser');
      }
      const stream = this.video.captureStream();
      this.track = stream.getVideoTracks()[0];
      if (!this.track) throw new Error('video element has no capturable track');

      this.decoder = new VideoDecoder({
        output: (frame) => this.paint(frame),
        error: (e) => this.die('decoder: ' + (e.message || e)),
      });
      this.encoder = new VideoEncoder({
        output: (chunk, meta) => this.onChunk(chunk, meta),
        error: (e) => this.die('encoder: ' + (e.message || e)),
      });

      this.makeCanvas();
      this.feedTimer = setInterval(() => this.feed(), 16);
      this.geoTimer = setInterval(() => this.checkGeometry(), 300);
      this.readLoop();
    }

    async readLoop() {
      const processor = new MediaStreamTrackProcessor({ track: this.track });
      this.reader = processor.readable.getReader();
      try {
        while (this.alive) {
          const { value: frame, done } = await this.reader.read();
          if (done) break;
          if (!frame) continue;
          if (!this.alive) {
            frame.close();
            break;
          }
          const w = frame.codedWidth;
          const h = frame.codedHeight;
          if (!w || !h) {
            frame.close();
            continue;
          }
          try {
            if (w !== this.cfgW || h !== this.cfgH) {
              await this.configureEncoder(w, h); // stream quality switch
            }
            // Drop frames rather than queueing work if encoding falls behind.
            if (this.encoder.encodeQueueSize <= 2) {
              this.encoder.encode(frame, { keyFrame: this.frameCount % this.keyInterval === 0 });
              this.frameCount++;
            }
          } finally {
            frame.close();
          }
        }
      } catch (e) {
        this.die('capture: ' + (e.message || e));
      }
    }

    async configureEncoder(w, h) {
      const settings = this.track.getSettings ? this.track.getSettings() : {};
      const fps = Math.min(60, settings.frameRate || 30);
      this.keyInterval = Math.max(15, Math.round(fps * 2));
      const bitrate = Math.min(8000000, Math.max(1000000, Math.round(w * h * 3)));
      const candidates = [
        { codec: 'avc1.64002A', avc: { format: 'avc' } }, // H.264 High 4.2
        { codec: 'avc1.42E02A', avc: { format: 'avc' } }, // H.264 Baseline 4.2
        { codec: 'vp8' },
      ];
      for (const cand of candidates) {
        const config = Object.assign({}, cand, {
          width: w,
          height: h,
          bitrate,
          framerate: fps,
          latencyMode: 'realtime',
        });
        try {
          const support = await VideoEncoder.isConfigSupported(config);
          if (support.supported) {
            this.encoder.configure(config);
            this.activeCodec = cand.codec;
            this.cfgW = w;
            this.cfgH = h;
            this.frameCount = 0; // next frame is a keyframe
            return;
          }
        } catch (e) {
          // try the next codec
        }
      }
      throw new Error('no supported video codec for the delay buffer');
    }

    onChunk(chunk, meta) {
      if (!this.alive) return;
      if (this.queue.length > 4000) {
        this.die('delay buffer overflow');
        return;
      }
      this.queue.push({
        chunk,
        config: meta && meta.decoderConfig ? meta.decoderConfig : null,
        due: Date.now() + this.delayMs,
      });
    }

    feed() {
      if (!this.alive) return;
      const now = Date.now();
      while (this.queue.length && this.queue[0].due <= now) {
        const item = this.queue.shift();
        try {
          if (item.config) {
            this.decoder.configure(item.config);
            this.decoderConfigured = true;
          } else if (!this.decoderConfigured && item.chunk.type === 'key') {
            this.decoder.configure({
              codec: this.activeCodec,
              codedWidth: this.cfgW,
              codedHeight: this.cfgH,
            });
            this.decoderConfigured = true;
          }
          if (this.decoderConfigured) this.decoder.decode(item.chunk);
        } catch (e) {
          this.die('decode: ' + (e.message || e));
          return;
        }
      }
    }

    paint(frame) {
      if (!this.alive) {
        frame.close();
        return;
      }
      const c = this.canvas;
      if (c.width !== frame.displayWidth || c.height !== frame.displayHeight) {
        c.width = frame.displayWidth;
        c.height = frame.displayHeight;
      }
      this.ctx.drawImage(frame, 0, 0, c.width, c.height);
      frame.close();
      if (!this.gotFrame) {
        this.gotFrame = true; // buffer is full: reveal the delayed view
        c.style.opacity = '1';
      }
    }

    makeCanvas() {
      const c = document.createElement('canvas');
      c.className = 'kls-delay-canvas';
      const parent = this.video.parentElement || document.body;
      if (getComputedStyle(parent).position === 'static') {
        parent.style.position = 'relative';
      }
      // Sibling right after the video: paints above it, below the player UI.
      this.video.insertAdjacentElement('afterend', c);
      this.canvas = c;
      this.ctx = c.getContext('2d');
      this.checkGeometry();
    }

    checkGeometry() {
      if (!document.contains(this.video)) {
        this.die('video-lost');
        return;
      }
      const v = this.video;
      const s = this.canvas.style;
      s.left = v.offsetLeft + 'px';
      s.top = v.offsetTop + 'px';
      s.width = v.offsetWidth + 'px';
      s.height = v.offsetHeight + 'px';
    }

    die(reason) {
      if (!this.alive) return;
      this.destroy();
      if (this.ondead) this.ondead(reason);
    }

    destroy() {
      this.alive = false;
      clearInterval(this.feedTimer);
      clearInterval(this.geoTimer);
      if (this.reader) {
        try { this.reader.cancel(); } catch (e) {}
      }
      if (this.track) {
        try { this.track.stop(); } catch (e) {}
      }
      if (this.encoder) {
        try { this.encoder.close(); } catch (e) {}
      }
      if (this.decoder) {
        try { this.decoder.close(); } catch (e) {}
      }
      if (this.canvas) this.canvas.remove();
      this.queue = [];
    }
  }

  function findVideo() {
    let best = null;
    let bestArea = 0;
    for (const v of document.querySelectorAll('video')) {
      if (v.readyState < 2 || v.paused) continue;
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea) {
        best = v;
        bestArea = area;
      }
    }
    return best;
  }

  function startSync(delaySec) {
    delayMs = Math.max(0, delaySec) * 1000;
    findVideoTries = 0;
    if (delayMs > 0) initPipeline();
  }

  function initPipeline() {
    if (delayMs <= 0) return;
    if (pipeline) {
      pipeline.destroy();
      pipeline = null;
    }
    const video = findVideo();
    if (!video) {
      if (++findVideoTries > 15) {
        syncFailed('no playing video found');
        return;
      }
      setTimeout(initPipeline, 1000);
      return;
    }
    const p = new VideoDelayPipeline(video, delayMs);
    p.ondead = (reason) => {
      if (pipeline === p) pipeline = null;
      if (delayMs <= 0) return;
      if (reason === 'video-lost') {
        // player swapped its <video> element (quality/channel change) - retry
        findVideoTries = 0;
        setTimeout(initPipeline, 1000);
      } else {
        syncFailed(reason);
      }
    };
    pipeline = p;
    p.start().catch((e) => {
      if (pipeline === p) pipeline = null;
      p.destroy();
      syncFailed(e.message || String(e));
    });
  }

  function syncFailed(reason) {
    console.warn('Kick Live Subtitles: video sync unavailable -', reason);
    delayMs = 0;
    if (pipeline) {
      pipeline.destroy();
      pipeline = null;
    }
    // Tell the offscreen document to drop the audio delay so sound matches
    // the (live) video again; captions will just display immediately.
    chrome.runtime.sendMessage({ target: 'bg', type: 'sync-failed' }).catch(() => {});
  }

  function stopSync() {
    delayMs = 0;
    lastFinalEnd = 0;
    if (pipeline) {
      pipeline.destroy();
      pipeline = null;
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'kls-subtitle') {
      scheduleSubtitle(msg);
      sendResponse({});
    } else if (msg.type === 'kls-status') {
      showStatus(msg.status, msg.detail);
      sendResponse({});
    } else if (msg.type === 'kls-sync') {
      startSync(msg.delay || 0);
      sendResponse({});
    } else if (msg.type === 'kls-stop') {
      stopSync();
      if (overlay) {
        overlay.classList.remove('kls-visible');
        statusEl.textContent = '';
        lineEl.textContent = '';
        interimEl.textContent = '';
        finals = [];
      }
      sendResponse({});
    }
    return false;
  });
})();
