# Kick Live Subtitles

A Chrome extension that generates **real-time subtitles for Kick streams**.
It captures the tab's audio and transcribes it **locally in your browser**
with OpenAI's Whisper model (via [transformers.js](https://github.com/huggingface/transformers.js))
— no API key, no audio ever leaves your machine (when using the Whisper engine).

## Install (unpacked extension)

1. Open Chrome and go to `chrome://extensions`.
2. Turn on **Developer mode** (toggle, top right).
3. Click **Load unpacked** and select this folder (`Kick_realtime_subtitle`).
4. Pin "Kick Live Subtitles" to the toolbar.

## Use

1. Open a stream on **kick.com** and start playing it.
2. Click the extension icon → **Start subtitles**.
3. The first start downloads the speech model (~40–250 MB depending on the
   model). It is cached by the browser, so later starts are instant.
4. Subtitles appear over the player. **Drag** them to move, **double-click**
   to reset position. They work in fullscreen too.
5. Click **Stop subtitles** when done (or just close the tab).

> While subtitles run, the stream's audio is routed through the extension —
> you still hear everything normally.

## Settings (popup)

| Setting | Notes |
|---|---|
| **Engine** | *Whisper (local AI)* — private, works offline after model download. *Chrome built-in* — much lower latency, needs Chrome 139+ (recognition on a media stream track); quality/language support varies. *Auto* — tries Chrome built-in, falls back to Whisper. |
| **Model** | Whisper size: *tiny* (fastest, weakest), *base* (good default), *small* (most accurate, needs a decent GPU for real-time). |
| **Language** | *Auto detect* or force the stream's language. Forcing it improves accuracy. |
| **Translate to English** | Whisper-only: translates any language into English subtitles. |
| **Sync delay** | Shows the stream a few seconds late so captions appear exactly when words are spoken (default 4 s, 0 = off). See below. |
| **Text size / Background** | Subtitle appearance; applies live. |

Engine/model/language/sync changes take effect the next time you press Start.

## A/V sync (the "Sync delay" setting)

Transcription inherently takes a couple of seconds, so without compensation
captions appear *after* the words are spoken. Pausing or delaying the player
itself wouldn't help — the transcriber listens to the same playback, so its
output would shift by the same amount.

Instead, the extension transcribes the **live** audio and delays what you
see and hear:

- **Audio** — the capture passthrough runs through a `DelayNode`.
- **Video** — the player's frames are captured (`captureStream`), encoded
  with WebCodecs (H.264/VP8, hardware-accelerated), held in a small encoded
  buffer (a few MB) for the delay duration, then decoded onto a canvas that
  covers the live video. Player controls still work normally.
- **Captions** — each transcribed chunk carries the wall-clock time its
  audio played live; the overlay shows it exactly `delay` seconds later,
  in step with the delayed video.

With the default 4 s delay and Whisper finishing in ~2–4 s, captions land
in sync with speech. The first few seconds after Start are quiet/black while
the buffer fills. If WebCodecs isn't available the extension automatically
falls back to live video with immediate (late) captions.

## How it works

```
popup ──start──▶ background (service worker)
                    │ creates offscreen document, passes tabCapture stream ID
                    ▼
              offscreen.html ── getUserMedia(tab audio)
                    ├── plays audio back to you (passthrough)
                    ├── AudioWorklet taps PCM → resampled to 16 kHz mono
                    ├── voice-activity chunking (~1–6 s per chunk)
                    ├── Whisper (WebGPU, WASM fallback) or Web Speech API
                    ▼
              background ──subtitle text──▶ content script overlay on kick.com
```

- `manifest.json` — MV3 manifest (tabCapture, offscreen, storage, activeTab).
- `background.js` — session orchestration and message routing.
- `offscreen.js` — audio capture, VAD chunking, both ASR engines.
- `worklet.js` — AudioWorklet that taps raw PCM.
- `content.js` / `content.css` — draggable subtitle overlay on kick.com.
- `popup.html` / `popup.js` — controls and settings.
- `lib/` — transformers.js 3.8.1 + ONNX Runtime WASM (bundled locally; MV3
  forbids remote code). Model weights are fetched from huggingface.co on
  first use and cached.

## Performance notes

- **WebGPU** is used automatically when available (`chrome://gpu` to check).
  On a discrete GPU, *base* transcribes a 5 s chunk in well under a second.
- Without WebGPU it falls back to multithread-less WASM — use the *tiny*
  model there.
- Subtitle latency with Whisper is roughly 1.5–4 s (it waits for a pause in
  speech). The *Chrome built-in* engine gives sub-second interim results if
  your Chrome version supports it.

## Troubleshooting

- **"Open a kick.com stream in this tab first"** — the active tab must be a
  `https://kick.com/...` page.
- **Stuck on "Downloading speech model"** — check your connection;
  the model comes from `huggingface.co`. Delete and re-add the extension to
  clear a corrupted cache.
- **No subtitles, audio still playing** — the stream may have no speech
  (silence/music is skipped on purpose), or the model is still warming up
  (first chunk compiles GPU shaders).
- **Garbled/repeated text** — try forcing the language, or a bigger model.
- **Chrome built-in engine errors immediately** — your Chrome doesn't
  support feeding tab audio to speech recognition yet; use Whisper.
