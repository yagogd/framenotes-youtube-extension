(() => {
  "use strict";
  const ytx = globalThis.__YTX;
  const state = ytx.state;
  let observer = null;
  let storageListener = null;
  let currentUi = null;
  let ensureScheduled = false;

  const ICONS = {
    transcript: '<path d="M6 3h9l3 3v15H6Z"/><path d="M15 3v4h4M9 11h6M9 15h6"/>',
    speed: '<circle cx="12" cy="12" r="8"/><path d="m12 12 4-3M7 17h10"/>',
    notes: '<path d="M5 5h14v11H9l-4 3V5Z"/><path d="M8 9h8M8 12h6"/>',
    addNote: '<path d="M5 5h14v11H9l-4 3V5Z"/><path d="M12 8v6M9 11h6"/>',
  };

  function icon(name) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.classList.add("ytx-player-icon");
    svg.innerHTML = ICONS[name];
    return svg;
  }

  function createControl(name, label) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `ytp-button ytx-player-control ytx-player-control--${name}`;
    button.title = label;
    button.setAttribute("aria-label", label);
    button.appendChild(icon(name));
    return button;
  }

  function updateTranscriptButton() {
    if (!currentUi) return;
    const visible = Boolean(state.ui?.panel?.isConnected && !state.ui.panel.classList.contains("ytx-panel--notes-host-only"));
    currentUi.transcriptButton.setAttribute("aria-pressed", String(visible));
    currentUi.transcriptButton.classList.toggle("ytx-player-control--active", visible);
    currentUi.transcriptButton.title = visible ? "Ocultar transcripción" : "Mostrar transcripción";
  }

  function updateNotesButton() {
    if (!currentUi) return;
    const count = state.savedNotes?.length || 0;
    currentUi.notesCount.textContent = String(count);
    currentUi.notesCount.hidden = count === 0;
    currentUi.notesButton.title = count
      ? `Notas y favoritos de este vídeo (${count})`
      : "Notas y favoritos de este vídeo";
    currentUi.notesButton.setAttribute("aria-label", currentUi.notesButton.title);
  }

  const noteMarkers = ytx.createNoteMarkers({
    getUi: () => currentUi,
    openSavedNote: (noteId) => openSavedNote(noteId),
    updateNotesButton,
  });
  const noteEditor = ytx.createPlayerNoteEditor({ onSaved: () => noteMarkers.refresh() });

  function toggleTranscript() {
    if (state.ui?.panel?.isConnected && state.ui.panel.classList.contains("ytx-panel--notes-host-only")) {
      state.ui.panel.classList.remove("ytx-panel--notes-host-only");
      state.dismissedVideoId = null;
      chrome.storage.local.set({ transcriptEnabled: true });
      state.settings.enabled = true;
      ytx.bridge.sendControl();
      updateTranscriptButton();
      return;
    }
    if (state.ui?.panel?.isConnected) {
      chrome.storage.local.set({ transcriptEnabled: false });
      return;
    }
    state.dismissedVideoId = null;
    chrome.storage.local.set({ transcriptEnabled: true }, () => {
      state.settings.enabled = true;
      ytx.panel.ensure();
      ytx.bridge.sendControl();
      setTimeout(updateTranscriptButton, 50);
    });
  }

  function openNotes(forceOpen = false) {
    state.dismissedVideoId = null;
    const transcriptWasVisible = Boolean(state.ui?.panel?.isConnected && !state.ui.panel.classList.contains("ytx-panel--notes-host-only"));
    const ui = state.ui || ytx.panel.create();
    if (!transcriptWasVisible) ui?.panel?.classList.add("ytx-panel--notes-host-only");
    setTimeout(() => {
      const notesToggle = state.ui?.notesToggle || ui?.notesToggle;
      const isOpen = Boolean(state.ui?.panel?.classList.contains("ytx-panel--notes-open"));
      if (notesToggle && (forceOpen ? !isOpen : true)) notesToggle.click();
      updateTranscriptButton();
    }, 80);
  }

  function openSavedNote(noteId) {
    if (!noteId) return;
    noteMarkers.hidePreview();
    openNotes(true);
    setTimeout(() => {
      const row = Array.from(state.ui?.notesList?.querySelectorAll(".ytx-note-item") || [])
        .find((candidate) => candidate.dataset.noteId === noteId);
      if (!row) return;
      row.scrollIntoView({ block: "center", behavior: "smooth" });
      row.classList.add("ytx-note-item--focused");
      setTimeout(() => row.classList.remove("ytx-note-item--focused"), 2200);
    }, 160);
  }

  function createUi(player, rightControls) {
    const group = document.createElement("div");
    group.className = "ytp-right-controls ytx-player-controls";
    const transcriptButton = createControl("transcript", "Mostrar transcripción");
    transcriptButton.setAttribute("aria-pressed", "false");
    const speedButton = createControl("speed", "Controlar velocidad");
    speedButton.setAttribute("aria-expanded", "false");
    const notesButton = createControl("notes", "Notas y favoritos de este vídeo");
    const notesCount = document.createElement("span");
    notesCount.className = "ytx-player-control__badge";
    notesCount.hidden = true;
    notesButton.appendChild(notesCount);
    const addNoteButton = createControl("addNote", "Crear una nota en este momento");
    group.append(transcriptButton, speedButton, notesButton, addNoteButton);
    rightControls.insertAdjacentElement("beforebegin", group);

    const speedMenu = ytx.createPlayerSpeedMenu({ player, button: speedButton });

    const video = player.querySelector("video");
    currentUi = { player, group, transcriptButton, speedButton, notesButton, notesCount, addNoteButton, speedMenu, video };
    noteMarkers.mount(player, video);
    transcriptButton.addEventListener("click", toggleTranscript);
    notesButton.addEventListener("click", () => {
      if (state.ui?.panel?.classList.contains("ytx-panel--notes-open")) {
        state.ui.notesWorkspaceClose?.click();
      } else {
        openNotes(false);
      }
    });
    addNoteButton.addEventListener("click", () => noteEditor.open(player, video, addNoteButton));
    updateTranscriptButton();
    updateNotesButton();
    noteMarkers.refresh();
  }

  function ensure() {
    if (!state.settings.extensionEnabled || !ytx.isWatchPage()) {
      remove();
      return;
    }
    const player = document.querySelector(".html5-video-player");
    const rightControls = player?.querySelector(".ytp-right-controls:not(.ytx-player-controls)");
    if (!player || !rightControls) return;
    if (currentUi?.group?.isConnected && currentUi.player === player) {
      updateTranscriptButton();
      if (!document.querySelector(".html5-video-player .ytp-progress-bar > .ytx-progress-markers")) noteMarkers.refresh();
      return;
    }
    remove();
    createUi(player, rightControls);
  }

  function scheduleEnsure() {
    if (ensureScheduled) return;
    ensureScheduled = true;
    requestAnimationFrame(() => {
      ensureScheduled = false;
      ensure();
    });
  }

  function remove() {
    noteEditor.destroy();
    currentUi?.group?.remove();
    currentUi?.speedMenu?.destroy();
    noteMarkers.destroy();
    currentUi = null;
  }

  function start() {
    if (observer) return;
    observer = new MutationObserver(scheduleEnsure);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    storageListener = (changes, area) => {
      if (area !== "local") return;
      if (changes.extensionEnabled) {
        state.settings.extensionEnabled = changes.extensionEnabled.newValue !== false;
        ensure();
      }
      if (changes.transcriptEnabled) setTimeout(updateTranscriptButton, 0);
      if (changes.lastSpeed && currentUi) {
        const value = Number(changes.lastSpeed.newValue) || 1;
        currentUi.speedMenu.update(value);
      }
      if (changes.speedPresets && currentUi) currentUi.speedMenu.renderPresets(changes.speedPresets.newValue);
      if (changes.ytxSavedNotes) setTimeout(() => ytx.notes.loadCurrent(), 0);
    };
    chrome.storage.onChanged.addListener(storageListener);
    ensure();
  }

  function stop() {
    observer?.disconnect();
    observer = null;
    if (storageListener) chrome.storage.onChanged.removeListener(storageListener);
    storageListener = null;
    remove();
  }

  ytx.playerControls = { start, stop, ensure, remove, refreshNoteMarkers: noteMarkers.refresh, updateTranscriptButton, updateNotesButton };
})();
