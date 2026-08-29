(() => {
  "use strict";
  if (globalThis.__ytxSpeedControllerLoaded) return;
  globalThis.__ytxSpeedControllerLoaded = true;

  let preferredRate = 1;
  let extensionEnabled = true;
  let shortcuts = [];
  let shortcutsEnabled = true;
  let pauseShortcutsEnabled = true;
  let pauseShortcuts = [];
  let rememberPlaybackSpeed = true;
  let suppressNextAutomaticRewind = false;
  let heldShortcut = null;
  let retryTimer = null;
  let lastAppliedRate = null;
  const pauseRewind = { enabled: false, seconds: 2, mode: "fixed" };

  function validRate(value) {
    const rate = Number(value);
    return Number.isFinite(rate) && rate > 0 && rate <= 16 ? rate : null;
  }

  function validPositive(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
  }

  function broadcastRate(rate, temporary = false) {
    window.postMessage({ source: "YT_SPEED_STATE", rate, temporary }, "*");
  }

  function applyRate(rate, temporary = false) {
    const video = document.querySelector("video");
    if (!video) return false;
    lastAppliedRate = rate;
    video.playbackRate = rate;
    broadcastRate(rate, temporary);
    return true;
  }

  function setPreferredRate(value, persist = true) {
    const rate = validRate(value);
    if (!rate) return false;
    preferredRate = rate;
    if (persist) chrome.storage.local.set({ lastSpeed: rate });
    if (!heldShortcut) applyRate(rate);
    return true;
  }

  function applyCurrentRateWithRetry() {
    if (!extensionEnabled) return;
    if (retryTimer) clearInterval(retryTimer);
    let attempts = 0;
    const apply = () => {
      attempts += 1;
      const rate = heldShortcut?.speed || preferredRate;
      const applied = applyRate(rate, Boolean(heldShortcut));
      if (applied || attempts >= 40) {
        clearInterval(retryTimer);
        retryTimer = null;
      }
    };
    apply();
    if (!document.querySelector("video")) retryTimer = setInterval(apply, 250);
  }

  function isEditableTarget(target) {
    return target instanceof HTMLElement &&
      (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
  }

  function matchesShortcut(event, shortcut) {
    return event.code === shortcut.code &&
      Boolean(event.ctrlKey) === Boolean(shortcut.ctrl) &&
      Boolean(event.altKey) === Boolean(shortcut.alt) &&
      Boolean(event.shiftKey) === Boolean(shortcut.shift) &&
      Boolean(event.metaKey) === Boolean(shortcut.meta);
  }

  function onKeyDown(event) {
    if (!extensionEnabled || event.repeat || isEditableTarget(event.target)) return;
    const pauseShortcut = pauseShortcutsEnabled
      ? pauseShortcuts.find((candidate) => candidate.enabled !== false && matchesShortcut(event, candidate))
      : null;
    if (pauseShortcut) {
      const video = document.querySelector("video");
      if (!video) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (pauseShortcut.action === "pause-rewind") {
        if (!video.paused) {
          suppressNextAutomaticRewind = true;
          video.pause();
        }
        const shortcutSeconds = validPositive(pauseShortcut.seconds) || 3;
        const multiplier = pauseShortcut.mode === "scaled" ? video.playbackRate : 1;
        video.currentTime = Math.max(0, video.currentTime - shortcutSeconds * multiplier);
      } else if (video.paused) {
        video.play().catch(() => {});
      } else {
        suppressNextAutomaticRewind = true;
        video.pause();
      }
      return;
    }
    if (!shortcutsEnabled) return;
    const shortcut = shortcuts.find((candidate) => candidate.enabled !== false && matchesShortcut(event, candidate));
    if (!shortcut) return;

    const speed = validRate(shortcut.speed);
    if (!speed) return;
    event.preventDefault();

    if (shortcut.behavior === "hold") {
      if (heldShortcut) return;
      heldShortcut = { id: shortcut.id, code: shortcut.code, speed };
      applyRate(speed, true);
    } else {
      setPreferredRate(speed, true);
    }
  }

  function onKeyUp(event) {
    if (isEditableTarget(event.target)) return;
    if (extensionEnabled && pauseShortcutsEnabled &&
        pauseShortcuts.some((candidate) => candidate.enabled !== false && matchesShortcut(event, candidate))) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (!heldShortcut || event.code !== heldShortcut.code) return;
    event.preventDefault();
    heldShortcut = null;
    applyRate(preferredRate, false);
  }

  chrome.storage.local.get({
    lastSpeed: 1,
    extensionEnabled: true,
    speedShortcuts: [],
    speedShortcutsEnabled: true,
    pauseShortcutsEnabled: true,
    pauseShortcuts: [],
    pauseRewindEnabled: false,
    pauseRewindSeconds: 2,
    pauseRewindMode: "fixed",
    rememberPlaybackSpeed: true,
  }, (stored) => {
    rememberPlaybackSpeed = stored.rememberPlaybackSpeed !== false;
    preferredRate = rememberPlaybackSpeed ? (validRate(stored.lastSpeed) || 1) : 1;
    extensionEnabled = stored.extensionEnabled !== false;
    shortcuts = Array.isArray(stored.speedShortcuts) ? stored.speedShortcuts : [];
    shortcutsEnabled = stored.speedShortcutsEnabled !== false;
    pauseShortcutsEnabled = stored.pauseShortcutsEnabled !== false;
    pauseShortcuts = Array.isArray(stored.pauseShortcuts) ? stored.pauseShortcuts : [];
    pauseRewind.enabled = Boolean(stored.pauseRewindEnabled);
    pauseRewind.seconds = validPositive(stored.pauseRewindSeconds) || 2;
    pauseRewind.mode = stored.pauseRewindMode === "scaled" ? "scaled" : "fixed";
    if (extensionEnabled) applyCurrentRateWithRetry();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.lastSpeed) {
      preferredRate = validRate(changes.lastSpeed.newValue) || preferredRate;
      if (extensionEnabled && !heldShortcut) applyCurrentRateWithRetry();
    }
    if (changes.extensionEnabled) {
      extensionEnabled = changes.extensionEnabled.newValue !== false;
      heldShortcut = null;
      if (extensionEnabled) applyCurrentRateWithRetry();
      else {
        if (retryTimer) clearInterval(retryTimer);
        retryTimer = null;
        applyRate(1, false);
      }
    }
    if (changes.speedShortcuts) {
      shortcuts = Array.isArray(changes.speedShortcuts.newValue) ? changes.speedShortcuts.newValue : [];
    }
    if (changes.speedShortcutsEnabled) {
      shortcutsEnabled = changes.speedShortcutsEnabled.newValue !== false;
      if (!shortcutsEnabled && heldShortcut) {
        heldShortcut = null;
        applyRate(preferredRate, false);
      }
    }
    if (changes.pauseShortcutsEnabled) pauseShortcutsEnabled = changes.pauseShortcutsEnabled.newValue !== false;
    if (changes.pauseShortcuts) pauseShortcuts = Array.isArray(changes.pauseShortcuts.newValue) ? changes.pauseShortcuts.newValue : [];
    if (changes.pauseRewindEnabled) pauseRewind.enabled = Boolean(changes.pauseRewindEnabled.newValue);
    if (changes.pauseRewindSeconds) pauseRewind.seconds = validPositive(changes.pauseRewindSeconds.newValue) || 2;
    if (changes.pauseRewindMode) pauseRewind.mode = changes.pauseRewindMode.newValue === "scaled" ? "scaled" : "fixed";
    if (changes.rememberPlaybackSpeed) {
      rememberPlaybackSpeed = changes.rememberPlaybackSpeed.newValue !== false;
      if (rememberPlaybackSpeed) {
        chrome.storage.local.get({ lastSpeed: 1 }, (stored) => {
          preferredRate = validRate(stored.lastSpeed) || preferredRate;
        });
      }
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type !== "set-speed") return;
    if (!extensionEnabled) {
      sendResponse({ ok: false, error: "La extensión está apagada" });
      return;
    }
    const ok = setPreferredRate(message.value, true);
    sendResponse({ ok, error: ok ? undefined : Number(message.value) > 16 ? "La velocidad máxima es 16x" : "Velocidad no válida" });
  });

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== "YT_SPEED_CONTROL") return;
    if (!extensionEnabled) return;
    setPreferredRate(event.data.rate, true);
  });

  function onRateChange(event) {
    if (!extensionEnabled || heldShortcut) return;
    const video = event.target;
    if (!(video instanceof HTMLVideoElement)) return;
    const rate = validRate(video.playbackRate);
    if (!rate) return;
    if (lastAppliedRate != null && Math.abs(rate - lastAppliedRate) < 0.001) return;
    lastAppliedRate = rate;
    preferredRate = rate;
    chrome.storage.local.set({ lastSpeed: rate });
  }

  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", onKeyUp, true);
  window.addEventListener("yt-navigate-finish", () => {
    if (!extensionEnabled) return;
    if (!rememberPlaybackSpeed) preferredRate = 1;
    applyCurrentRateWithRetry();
  });
  document.addEventListener("loadedmetadata", (event) => {
    if (extensionEnabled && event.target instanceof HTMLVideoElement) {
      applyRate(heldShortcut?.speed || preferredRate, Boolean(heldShortcut));
    }
  }, true);
  document.addEventListener("ratechange", onRateChange, true);
  document.addEventListener("pause", (event) => {
    const video = event.target;
    if (suppressNextAutomaticRewind) {
      suppressNextAutomaticRewind = false;
      return;
    }
    if (!extensionEnabled || !(video instanceof HTMLVideoElement) || !pauseRewind.enabled || video.ended) return;
    const multiplier = pauseRewind.mode === "scaled" ? video.playbackRate : 1;
    video.currentTime = Math.max(0, video.currentTime - pauseRewind.seconds * multiplier);
  }, true);
})();
