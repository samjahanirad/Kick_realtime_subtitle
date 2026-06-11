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

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'kls-subtitle') {
      showSubtitle(msg.text, msg.isFinal);
      sendResponse({});
    } else if (msg.type === 'kls-status') {
      showStatus(msg.status, msg.detail);
      sendResponse({});
    } else if (msg.type === 'kls-stop') {
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
