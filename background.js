// Service worker: orchestrates capture sessions and routes messages
// popup -> background -> offscreen (capture + ASR) -> background -> content script (overlay)

const session = {
  tabId: null,
  status: 'idle', // idle | starting | loading-model | live | error
  detail: '',
};

const SETTING_DEFAULTS = {
  engine: 'whisper', // 'whisper' | 'webspeech' | 'auto'
  model: 'base', // 'tiny' | 'base' | 'small'
  language: '', // '' = auto-detect
  translate: false,
  fontSize: 22,
  bgOpacity: 0.55,
  syncDelay: 4, // seconds of A/V delay so captions appear in sync
};

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Captures tab audio to generate live subtitles',
  });
}

async function startCapture(tabId, streamId) {
  if (session.tabId !== null) {
    await stopCapture();
  }
  await ensureOffscreen();
  const settings = await chrome.storage.local.get(SETTING_DEFAULTS);
  session.tabId = tabId;
  setStatus('starting', 'Starting capture…');
  // Kick off the delayed-video pipeline on the page right away so it buffers
  // in step with the (immediately started) delayed audio in the offscreen doc.
  const delay = Math.max(0, Math.min(10, Number(settings.syncDelay) || 0));
  if (delay > 0) {
    sendToTab(tabId, { type: 'kls-sync', delay });
  }
  await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'start',
    streamId,
    settings,
  });
  chrome.action.setBadgeText({ text: 'CC' });
  chrome.action.setBadgeBackgroundColor({ color: '#53fc18' });
}

async function stopCapture() {
  const tabId = session.tabId;
  session.tabId = null;
  try {
    await chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop' });
  } catch (e) {
    // offscreen document may already be gone
  }
  try {
    if (await chrome.offscreen.hasDocument()) {
      await chrome.offscreen.closeDocument();
    }
  } catch (e) {}
  setStatus('idle', '');
  chrome.action.setBadgeText({ text: '' });
  if (tabId !== null) {
    sendToTab(tabId, { type: 'kls-stop' });
  }
}

function setStatus(status, detail, progress) {
  session.status = status;
  session.detail = detail || '';
  const msg = { type: 'kls-status', status, detail: session.detail, progress };
  // popup (if open)
  chrome.runtime.sendMessage({ target: 'popup', ...msg }).catch(() => {});
  // overlay on the captured tab
  if (session.tabId !== null) sendToTab(session.tabId, msg);
}

function sendToTab(tabId, msg) {
  chrome.tabs.sendMessage(tabId, msg).catch(() => {
    // content script not present (e.g. tab navigated away) - ignore
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target === 'bg') {
    if (msg.type === 'subtitle') {
      if (session.tabId !== null) {
        sendToTab(session.tabId, {
          type: 'kls-subtitle',
          text: msg.text,
          isFinal: msg.isFinal,
          t0: msg.t0,
          dur: msg.dur,
          est: msg.est,
        });
      }
      sendResponse({});
    } else if (msg.type === 'sync-failed') {
      // The page couldn't delay the video (no WebCodecs, codec error, ...).
      // Drop the audio delay too so sound stays in sync with the live video.
      chrome.runtime
        .sendMessage({ target: 'offscreen', type: 'set-delay', seconds: 0 })
        .catch(() => {});
      sendResponse({});
    } else if (msg.type === 'status') {
      setStatus(msg.status, msg.detail, msg.progress);
      if (msg.status === 'error') {
        chrome.action.setBadgeText({ text: '!' });
        chrome.action.setBadgeBackgroundColor({ color: '#e8463c' });
      }
      sendResponse({});
    }
    return false;
  }

  if (msg.target === 'popup-cmd') {
    if (msg.type === 'start') {
      startCapture(msg.tabId, msg.streamId)
        .then(() => sendResponse({ ok: true }))
        .catch((e) => {
          setStatus('error', e.message || String(e));
          sendResponse({ ok: false, error: e.message || String(e) });
        });
      return true; // async response
    }
    if (msg.type === 'stop') {
      stopCapture().then(() => sendResponse({ ok: true }));
      return true;
    }
    if (msg.type === 'get-state') {
      sendResponse({ tabId: session.tabId, status: session.status, detail: session.detail });
      return false;
    }
  }
  return false;
});

// Stop when the captured tab is closed or navigates off kick.com
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === session.tabId) stopCapture();
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId === session.tabId && changeInfo.url && !/^https:\/\/([a-z0-9-]+\.)*kick\.com\//i.test(changeInfo.url)) {
    stopCapture();
  }
});
