(() => {
  "use strict";

  globalThis.YTXI18n?.start({ scope: "content" });
  if (globalThis.__ytTranscriptContentLoaded) return;
  globalThis.__ytTranscriptContentLoaded = true;

  const ytx = globalThis.__YTX;
  const state = ytx.state;
  let initializing = true;
  const initialStorageChanges = new Map();

  function injectPageScript(path) {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = chrome.runtime.getURL(path);
      script.onload = () => { script.remove(); resolve(); };
      script.onerror = () => { script.remove(); reject(new Error(`No se pudo cargar ${path}`)); };
      (document.head || document.documentElement).appendChild(script);
    });
  }

  function onStorageChanged(changes, area) {
    if (area !== "local") return;
    if (initializing) {
      Object.entries(changes).forEach(([key, change]) => initialStorageChanges.set(key, change));
      return;
    }
    const relevant = changes.extensionEnabled || changes.transcriptEnabled || changes.transcriptMode ||
      changes.transcriptGrouping || changes.transcriptPreferredLanguage || changes.transcriptAutoOpenNextVideo ||
      changes.transcriptFavoriteLanguages ||
      changes.transcriptDisplayLeadMs ||
      changes.transcriptRememberLayout ||
      changes.transcriptPanelBackground || changes.transcriptPanelTextColor || changes.transcriptPanelFont ||
      changes.transcriptPanelFontSize || changes.transcriptPanelOpacity ||
      changes.notesAppearanceMode || changes.notesAppearance || changes.notesWindowAppearance ||
      changes.noteEditorAppearance || changes.noteStartOffset;
    if (!relevant) return;
    const needsTranscriptRequest = Boolean(changes.extensionEnabled || changes.transcriptEnabled || changes.transcriptPreferredLanguage);
    if (changes.extensionEnabled) {
      state.settings.extensionEnabled = changes.extensionEnabled.newValue !== false;
      if (state.settings.extensionEnabled) {
        state.dismissedVideoId = null;
        ytx.bridge.start();
        ytx.navigation.start();
        ytx.playerControls.start();
      } else {
        ytx.bridge.sendControl();
        ytx.navigation.stop();
        ytx.playerControls.stop();
        ytx.bridge.stop();
      }
    }
    if (changes.transcriptEnabled) {
      state.settings.enabled = changes.transcriptEnabled.newValue;
      if (changes.transcriptEnabled.newValue) state.dismissedVideoId = null;
    }
    if (changes.transcriptMode) state.settings.mode = changes.transcriptMode.newValue;
    if (changes.transcriptGrouping) state.settings.grouping = changes.transcriptGrouping.newValue;
    if (changes.transcriptPreferredLanguage) state.settings.preferredLanguage = changes.transcriptPreferredLanguage.newValue || "auto";
    if (changes.transcriptFavoriteLanguages) {
      state.settings.favoriteLanguages = Array.isArray(changes.transcriptFavoriteLanguages.newValue)
        ? changes.transcriptFavoriteLanguages.newValue : ["es", "en"];
      ytx.panel.updateTrackSelector?.();
    }
    if (changes.transcriptAutoOpenNextVideo) state.settings.autoOpenNextVideo = changes.transcriptAutoOpenNextVideo.newValue !== false;
    if (changes.transcriptRememberLayout) state.settings.rememberLayout = changes.transcriptRememberLayout.newValue !== false;
    if (changes.transcriptDisplayLeadMs) state.settings.displayLeadMs = Math.min(10000, Math.max(-10000, Number(changes.transcriptDisplayLeadMs.newValue) || 0));
    if (changes.transcriptPanelBackground) state.appearance.background = changes.transcriptPanelBackground.newValue;
    if (changes.transcriptPanelTextColor) state.appearance.text = changes.transcriptPanelTextColor.newValue;
    if (changes.transcriptPanelFont) state.appearance.font = changes.transcriptPanelFont.newValue;
    if (changes.transcriptPanelFontSize) state.appearance.fontSize = changes.transcriptPanelFontSize.newValue;
    if (changes.transcriptPanelOpacity) state.appearance.opacity = changes.transcriptPanelOpacity.newValue;
    if (changes.notesAppearanceMode) state.settings.notesAppearanceMode = changes.notesAppearanceMode.newValue === "separate" ? "separate" : "shared";
    if (changes.notesAppearance) state.notesAppearance = changes.notesAppearance.newValue;
    if (changes.notesWindowAppearance) state.notesWindowAppearance = changes.notesWindowAppearance.newValue;
    if (changes.noteEditorAppearance) state.noteEditorAppearance = changes.noteEditorAppearance.newValue;
    if (changes.noteStartOffset) state.settings.noteStartOffset = Math.min(30, Math.max(0, Number(changes.noteStartOffset.newValue) || 3));

    const appearanceChanged = changes.transcriptPanelBackground || changes.transcriptPanelTextColor ||
      changes.transcriptPanelFont || changes.transcriptPanelFontSize || changes.transcriptPanelOpacity;
    const notesAppearanceChanged = changes.notesAppearanceMode || changes.notesAppearance ||
      changes.notesWindowAppearance || changes.noteEditorAppearance;
    const functionalChanged = changes.extensionEnabled || changes.transcriptEnabled || changes.transcriptMode ||
      changes.transcriptGrouping || changes.transcriptPreferredLanguage || changes.transcriptAutoOpenNextVideo;
    const timingChanged = Boolean(changes.transcriptDisplayLeadMs);
    const offsetChanged = Boolean(changes.noteStartOffset);
    if (offsetChanged && !appearanceChanged && !functionalChanged && !timingChanged &&
      !changes.transcriptFavoriteLanguages && !notesAppearanceChanged) return;
    if (notesAppearanceChanged && !functionalChanged && !timingChanged) {
      ytx.panel.applyAppearance?.();
      ytx.noteEditorAppearance?.apply?.();
      return;
    }
    if (timingChanged && !appearanceChanged && !functionalChanged && !changes.transcriptFavoriteLanguages) {
      ytx.sync.updateActiveBlock();
      return;
    }
    if (changes.transcriptFavoriteLanguages && !appearanceChanged && !functionalChanged) return;
    if (appearanceChanged && !functionalChanged) {
      ytx.panel.applyAppearance?.();
      return;
    }

    if (!state.settings.extensionEnabled || !state.settings.enabled) ytx.panel.remove();
    else if (state.transcript) ytx.renderer.renderCurrentMode();
    else ytx.panel.ensure();
    ytx.panel.applyAppearance?.();
    if (needsTranscriptRequest) ytx.bridge.sendControl();
  }

  async function start() {
    chrome.storage.onChanged.addListener(onStorageChanged);

    try {
      const initialDefaults = {
        transcriptEnabled: true,
        extensionEnabled: true,
        transcriptMode: "full",
        transcriptGrouping: "sentences",
        transcriptPreferredLanguage: "auto",
        transcriptFavoriteLanguages: ["es", "en"],
        transcriptAutoOpenNextVideo: true,
        transcriptRememberLayout: true,
        transcriptPanelBackground: "#1e1e22",
        transcriptPanelTextColor: "#e4e4e7",
        transcriptPanelFont: "Inter, Roboto, Arial, sans-serif",
        transcriptPanelFontSize: 13.5,
        transcriptPanelOpacity: 0.84,
        transcriptDisplayLeadMs: 1100,
        notesAppearanceMode: "shared",
        notesAppearance: { background: "#08080a", text: "#e4e4e7", font: "Inter, Roboto, Arial, sans-serif", fontSize: 13.5, opacity: 0.54 },
        notesWindowAppearance: { background: "#08080a", text: "#e4e4e7", font: "Inter, Roboto, Arial, sans-serif", fontSize: 13.5, opacity: 0.54 },
        noteEditorAppearance: { background: "#08080a", text: "#e4e4e7", font: "Inter, Roboto, Arial, sans-serif", fontSize: 13.5, opacity: 0.54 },
        noteStartOffset: 3,
      };
      const settingsPromise = new Promise((resolve) => chrome.storage.local.get(initialDefaults, resolve));
      await injectPageScript("src/transcript/transcript-parser.js");
      await injectPageScript("src/injected/transcript-network.js");
      const stored = await settingsPromise;
      initialStorageChanges.forEach((change, key) => {
        stored[key] = change.newValue === undefined ? initialDefaults[key] : change.newValue;
      });
      initializing = false;
      state.settings.enabled = stored.transcriptEnabled;
      state.settings.extensionEnabled = stored.extensionEnabled;
      state.settings.mode = stored.transcriptMode;
      state.settings.grouping = stored.transcriptGrouping;
      state.settings.preferredLanguage = stored.transcriptPreferredLanguage;
      state.settings.favoriteLanguages = Array.isArray(stored.transcriptFavoriteLanguages)
        ? stored.transcriptFavoriteLanguages : ["es", "en"];
      state.settings.autoOpenNextVideo = stored.transcriptAutoOpenNextVideo;
      state.settings.rememberLayout = stored.transcriptRememberLayout !== false;
      state.settings.displayLeadMs = Math.min(10000, Math.max(-10000, Number(stored.transcriptDisplayLeadMs) || 0));
      state.settings.notesAppearanceMode = stored.notesAppearanceMode === "separate" ? "separate" : "shared";
      state.settings.noteStartOffset = Math.min(30, Math.max(0, Number(stored.noteStartOffset) || 3));
      state.notesAppearance = stored.notesAppearance;
      state.notesWindowAppearance = stored.notesWindowAppearance;
      state.noteEditorAppearance = stored.noteEditorAppearance;
      state.appearance = {
        background: stored.transcriptPanelBackground,
        text: stored.transcriptPanelTextColor,
        font: stored.transcriptPanelFont,
        fontSize: stored.transcriptPanelFontSize,
        opacity: stored.transcriptPanelOpacity,
      };
      if (state.settings.extensionEnabled) {
        ytx.bridge.start();
        ytx.navigation.start();
        ytx.playerControls.start();
      }
      if (state.settings.extensionEnabled && ytx.isWatchPage()) ytx.notes.loadCurrent();
      if (state.settings.extensionEnabled && state.settings.enabled && ytx.isWatchPage()) ytx.panel.ensure();
      ytx.bridge.sendControl();
    } catch (error) {
      console.error("YouTube Transcript:", error);
      ytx.panel.showMessage("No se pudo cargar", error.message);
    }
  }

  ytx.destroy = () => {
    chrome.storage.onChanged.removeListener(onStorageChanged);
    ytx.navigation.stop();
    ytx.playerControls.stop();
    ytx.bridge.stop();
    ytx.panel.remove();
  };

  start();
})();
