'use strict';

const DEFAULTS = {
  engine: 'whisper',
  model: 'base',
  language: '',
  translate: false,
  fontSize: 22,
  bgOpacity: 0.55,
};

const els = {
  engine: document.getElementById('engine'),
  model: document.getElementById('model'),
  modelRow: document.getElementById('modelRow'),
  language: document.getElementById('language'),
  translate: document.getElementById('translate'),
  translateRow: document.getElementById('translateRow'),
  fontSize: document.getElementById('fontSize'),
  bgOpacity: document.getElementById('bgOpacity'),
  toggle: document.getElementById('toggle'),
  status: document.getElementById('status'),
};

let running = false;

async function init() {
  const s = await chrome.storage.local.get(DEFAULTS);
  els.engine.value = s.engine;
  els.model.value = s.model;
  els.language.value = s.language;
  els.translate.checked = s.translate;
  els.fontSize.value = s.fontSize;
  els.bgOpacity.value = s.bgOpacity;
  updateEngineRows();

  const state = await chrome.runtime.sendMessage({ target: 'popup-cmd', type: 'get-state' });
  applyState(state);
  els.toggle.disabled = false;
}

function updateEngineRows() {
  const whisperish = els.engine.value !== 'webspeech';
  els.modelRow.style.display = whisperish ? '' : 'none';
  els.translateRow.style.display = whisperish ? '' : 'none';
}

function applyState(state) {
  running = state && state.tabId !== null && state.status !== 'idle' && state.status !== 'error';
  els.toggle.textContent = running ? 'Stop subtitles' : 'Start subtitles';
  els.toggle.classList.toggle('stop', running);
  setStatusText(state ? state.status : 'idle', state ? state.detail : '');
}

function setStatusText(status, detail) {
  els.status.classList.toggle('error', status === 'error');
  if (status === 'idle') {
    els.status.textContent = '';
  } else if (status === 'live') {
    els.status.textContent = detail || 'Live';
  } else {
    els.status.textContent = detail || status;
  }
}

function saveSettings() {
  return chrome.storage.local.set({
    engine: els.engine.value,
    model: els.model.value,
    language: els.language.value,
    translate: els.translate.checked,
    fontSize: Number(els.fontSize.value),
    bgOpacity: Number(els.bgOpacity.value),
  });
}

for (const id of ['engine', 'model', 'language', 'translate', 'fontSize', 'bgOpacity']) {
  els[id].addEventListener('change', () => {
    updateEngineRows();
    saveSettings();
  });
}
// Sliders save live so the overlay updates while dragging.
els.fontSize.addEventListener('input', saveSettings);
els.bgOpacity.addEventListener('input', saveSettings);

els.toggle.addEventListener('click', async () => {
  els.toggle.disabled = true;
  try {
    await handleToggle();
  } catch (e) {
    setStatusText('error', e.message || String(e));
  } finally {
    els.toggle.disabled = false;
  }
});

async function handleToggle() {
  if (running) {
    await chrome.runtime.sendMessage({ target: 'popup-cmd', type: 'stop' });
    applyState({ tabId: null, status: 'idle', detail: '' });
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https:\/\/([a-z0-9-]+\.)*kick\.com\//i.test(tab.url || '')) {
    setStatusText('error', 'Open a kick.com stream in this tab first.');
    return;
  }
  await saveSettings();
  // Get the capture stream ID here in the popup: tabCapture requires the
  // extension to be invoked on the tab, which opening this popup satisfies.
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  const res = await chrome.runtime.sendMessage({ target: 'popup-cmd', type: 'start', tabId: tab.id, streamId });
  if (res && res.ok) {
    applyState({ tabId: tab.id, status: 'starting', detail: 'Starting capture…' });
  } else {
    setStatusText('error', (res && res.error) || 'Failed to start capture.');
  }
}

// Live status updates while the popup is open
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target === 'popup' && msg.type === 'kls-status') {
    if (msg.status === 'idle' || msg.status === 'error') {
      applyState({ tabId: msg.status === 'error' ? -1 : null, status: msg.status, detail: msg.detail });
      if (msg.status === 'error') {
        running = false;
        els.toggle.textContent = 'Start subtitles';
        els.toggle.classList.remove('stop');
      }
    } else {
      running = true;
      els.toggle.textContent = 'Stop subtitles';
      els.toggle.classList.add('stop');
      setStatusText(msg.status, msg.detail);
    }
  }
});

init();
