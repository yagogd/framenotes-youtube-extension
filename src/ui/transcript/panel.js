(() => {
  "use strict";
  const ytx = globalThis.__YTX;
  const state = ytx.state;
  const PANEL_STORAGE_DEFAULTS = { transcriptPanelGeometry: null, transcriptHeaderCollapsed: false };
  const setButtonIcon = (button, name) => ytx.panelView.setButtonIcon(button, name);
  const labelButton = (button, label) => ytx.panelView.labelButton(button, label);

  function applyAppearance() {
    const panel = state.ui?.panel;
    if (!panel) return;
    const rgbaOf = (appearance, fallback) => {
      const hex = /^#[0-9a-f]{6}$/i.test(appearance?.background) ? appearance.background : fallback;
      const red = parseInt(hex.slice(1, 3), 16);
      const green = parseInt(hex.slice(3, 5), 16);
      const blue = parseInt(hex.slice(5, 7), 16);
      const opacity = Math.min(1, Math.max(0.35, Number(appearance?.opacity) || 0.84));
      return `rgba(${red}, ${green}, ${blue}, ${opacity})`;
    };
    const textOf = (appearance, fallback) => appearance?.text || fallback;
    const fontOf = (appearance, fallback) => appearance?.font || fallback;
    const sizeOf = (appearance) => `${Math.min(22, Math.max(10, Number(appearance?.fontSize) || 13.5))}px`;

    const transcript = state.appearance || {};
    panel.style.setProperty("--ytx-panel-background", rgbaOf(transcript, "#1e1e22"));
    panel.style.setProperty("--ytx-panel-text", textOf(transcript, "#e4e4e7"));
    panel.style.setProperty("--ytx-panel-font", fontOf(transcript, "Inter, Roboto, Arial, sans-serif"));
    panel.style.setProperty("--ytx-panel-font-size", sizeOf(transcript));

    const notes = state.ui?.notesWorkspace;
    if (notes) {
      const shared = state.settings?.notesAppearanceMode !== "separate";
      const appearance = shared ? (state.notesAppearance || {}) : (state.notesWindowAppearance || {});
      notes.style.setProperty("--ytx-panel-background", rgbaOf(appearance, "#08080a"));
      notes.style.setProperty("--ytx-panel-text", textOf(appearance, "#e4e4e7"));
      notes.style.setProperty("--ytx-panel-font", fontOf(appearance, "Inter, Roboto, Arial, sans-serif"));
      notes.style.setProperty("--ytx-panel-font-size", sizeOf(appearance));
    }
  }

  function keepNotesWindowAnchored(ui, player) {
    if (!player || typeof ResizeObserver !== "function") return () => {};
    let anchor = { horizontal: "right", vertical: "bottom", x: 16, y: 72 };
    const GAP = 72;
    const MARGIN = 8;
    const capture = () => {
      if (!ui.notesWorkspace.offsetWidth || !ui.notesWorkspace.offsetHeight) return;
      const panelRect = ui.notesWorkspace.getBoundingClientRect();
      const playerRect = player.getBoundingClientRect();
      const left = panelRect.left - playerRect.left;
      const top = panelRect.top - playerRect.top;
      const right = playerRect.right - panelRect.right;
      const bottom = playerRect.bottom - panelRect.bottom;
      anchor = {
        horizontal: left <= right ? "left" : "right",
        vertical: top <= bottom ? "top" : "bottom",
        x: Math.max(8, left <= right ? left : right),
        y: Math.max(8, top <= bottom ? top : bottom),
      };
    };
    const safeArea = () => {
      const playerRect = player.getBoundingClientRect();
      const height = playerRect.height;
      const bottom = Math.max(GAP + MARGIN, height - GAP);
      const editor = player.querySelector(":scope > .ytx-player-note-editor");
      let top = MARGIN;
      if (editor) {
        const editorRect = editor.getBoundingClientRect();
        top = Math.max(MARGIN, Math.round(editorRect.bottom - playerRect.top) + 12);
      }
      return { top, bottom };
    };
    const constrain = () => {
      if (!anchor || !ui.notesWorkspace.offsetWidth || !ui.notesWorkspace.offsetHeight) return;
      const width = player.clientWidth;
      const height = player.clientHeight;
      const safe = safeArea();
      const editor = player.querySelector(":scope > .ytx-player-note-editor");
      if (editor) {
        const cssMax = height - 104;
        const safeMax = safe.bottom - safe.top;
        ui.notesWorkspace.style.maxHeight = `${Math.round(Math.max(80, Math.min(cssMax, safeMax)))}px`;
      } else ui.notesWorkspace.style.removeProperty("max-height");
      let left = anchor.horizontal === "right" ? width - ui.notesWorkspace.offsetWidth - anchor.x : anchor.x;
      let top = anchor.vertical === "bottom" ? height - ui.notesWorkspace.offsetHeight - anchor.y : anchor.y;
      if (top < safe.top) top = safe.top;
      if (height - (top + ui.notesWorkspace.offsetHeight) < GAP) top = height - GAP - ui.notesWorkspace.offsetHeight;
      left = Math.max(8, Math.min(width - ui.notesWorkspace.offsetWidth - 8, left));
      top = Math.max(Math.max(8, safe.top), Math.min(height - ui.notesWorkspace.offsetHeight - 8, top));
      ui.notesWorkspace.style.left = `${Math.round(left)}px`;
      ui.notesWorkspace.style.top = `${Math.round(top)}px`;
      ui.notesWorkspace.style.right = "auto";
      ui.notesWorkspace.style.bottom = "auto";
    };
    const onGeometryChange = () => { capture(); constrain(); };
    ui.notesWorkspace.addEventListener("ytx:geometrychange", onGeometryChange);
    const observer = new ResizeObserver(() => requestAnimationFrame(constrain));
    observer.observe(player);
    const editorObserver = new MutationObserver(() => requestAnimationFrame(constrain));
    editorObserver.observe(player, { childList: true });
    const windowObserver = new ResizeObserver(() => requestAnimationFrame(constrain));
    windowObserver.observe(ui.notesWorkspace);
    constrain();
    return () => {
      observer.disconnect();
      editorObserver.disconnect();
      windowObserver.disconnect();
      ui.notesWorkspace.removeEventListener("ytx:geometrychange", onGeometryChange);
    };
  }

  function overlayHost() {
    const ui = state.ui;
    if (!ui) return null;
    return ui.panel.classList.contains("ytx-panel--notes-host-only") ? ui.notesWorkspace : ui.panel;
  }

  function showNotice(message) {
    const panel = overlayHost();
    if (!panel) return;
    panel.querySelector(".ytx-notice")?.remove();
    const notice = document.createElement("div");
    notice.className = "ytx-notice";
    notice.setAttribute("role", "alertdialog");
    notice.setAttribute("aria-modal", "true");
    notice.setAttribute("aria-label", "Aviso");
    const text = document.createElement("p");
    text.textContent = message;
    const accept = document.createElement("button");
    accept.type = "button";
    accept.className = "ytx-button ytx-notice__accept";
    accept.textContent = "Aceptar";
    const close = () => notice.remove();
    accept.addEventListener("click", close);
    notice.addEventListener("keydown", (event) => { if (event.key === "Escape") close(); });
    notice.append(text, accept);
    panel.appendChild(notice);
    accept.focus();
  }

  function confirmAction(message) {
    const panel = overlayHost();
    if (!panel) return Promise.resolve(false);
    panel.querySelector(".ytx-notice")?.remove();
    return new Promise((resolve) => {
      const notice = document.createElement("div");
      notice.className = "ytx-notice ytx-confirm";
      notice.setAttribute("role", "alertdialog");
      notice.setAttribute("aria-modal", "true");
      notice.setAttribute("aria-label", "Confirmar eliminación");
      const title = document.createElement("strong");
      title.className = "ytx-confirm__title";
      title.textContent = "Eliminar nota";
      const text = document.createElement("p");
      text.textContent = message;
      const actions = document.createElement("div");
      actions.className = "ytx-confirm__actions";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "ytx-button ytx-confirm__cancel";
      cancel.textContent = "Cancelar";
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "ytx-button ytx-confirm__delete";
      remove.textContent = "Eliminar";
      let settled = false;
      const close = (confirmed) => {
        if (settled) return;
        settled = true;
        notice.remove();
        resolve(confirmed);
      };
      cancel.addEventListener("click", () => close(false));
      remove.addEventListener("click", () => close(true));
      notice.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          close(false);
        }
      });
      actions.append(cancel, remove);
      notice.append(title, text, actions);
      panel.appendChild(notice);
      cancel.focus();
    });
  }

  function applyStoredGeometry(panel, geometry) {
    if (!geometry) return null;
    const maxWidth = Math.max(300, Math.min(window.innerWidth * 0.7, window.innerWidth - 16));
    const width = Math.max(300, Math.min(maxWidth, Number(geometry.width) || 420));
    const maxHeight = Math.max(130, window.innerHeight - 24);
    const height = Math.max(130, Math.min(maxHeight, Number(geometry.height) || window.innerHeight - 88));
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, Number(geometry.left) || 8));
    const top = Math.max(8, Math.min(window.innerHeight - 58, Number(geometry.top) || 72));
    panel.style.left = `${left}px`;
    panel.style.right = "auto";
    panel.style.top = `${top}px`;
    panel.style.width = `${width}px`;
    panel.style.height = `${height}px`;
    return height;
  }

  function savePanelGeometry(panel, heightOverride) {
    if (state.settings.rememberLayout === false) return;
    const rect = panel.getBoundingClientRect();
    chrome.storage.local.set({ transcriptPanelGeometry: {
      left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width),
      height: Math.round(heightOverride || rect.height),
    } });
  }

  function setTitle(text) {
    if (!state.ui) return;
    const languageName = ytx.trackSelector.baseLanguageName(text) || "Subtítulos";
    state.ui.title.dataset.fullTitle = languageName;
    state.ui.title.title = languageName;
    if (!state.transcriptTracks?.length && state.ui.trackSelect) state.ui.trackSelect.value = languageName;
  }

  function setupAdaptiveHeader(ui) {
    const update = () => {
      const rect = ui.panel.getBoundingClientRect();
      const compact = rect.height < 340 || rect.width < 520;
      ui.panel.classList.toggle("ytx-panel--compact", compact);
      ui.copyButton.classList.toggle("ytx-button--icon-only", compact);
    };
    const observer = new ResizeObserver(update);
    observer.observe(ui.panel);
    update();
    return () => observer.disconnect();
  }

  function createPanel() {
    if (document.getElementById("yt-transcript-panel")) return state.ui;
    const ui = ytx.panelView.create(state);
    state.ui = ui;
    ytx.playerControls?.updateTranscriptButton();
    applyAppearance();
    ui.cleanups.push(ytx.addResizeHandles(ui.panel));
    ui.cleanups.push(ytx.makePanelDraggable(ui.panel, ui.header));
    const player = ui.notesWorkspace.parentElement?.closest(".html5-video-player");
    ui.cleanups.push(ytx.addResizeHandles(ui.notesWorkspace, player));
    ui.cleanups.push(ytx.makePanelDraggable(ui.notesWorkspace, ui.notesWorkspaceHeader, player));
    ui.cleanups.push(keepNotesWindowAnchored(ui, player));
    ui.cleanups.push(setupAdaptiveHeader(ui));
    ui.cleanups.push(ytx.search.attach(ui));
    ui.cleanups.push(ytx.notes.attach(ui));
    ui.cleanups.push(ytx.trackSelector.attach(ui));
    if (state.search.query) {
      ui.panel.classList.add("ytx-panel--search-open");
      ui.searchToggle.setAttribute("aria-expanded", "true");
    }
    ytx.trackSelector.update(ui);

    let headerCollapsed = false;
    const onCollapseHeader = () => {
      headerCollapsed = !headerCollapsed;
      ui.panel.classList.toggle("ytx-panel--header-collapsed", headerCollapsed);
      setButtonIcon(ui.collapseHeaderButton, headerCollapsed ? "chevronUp" : "chevronDown");
      labelButton(ui.collapseHeaderButton, headerCollapsed ? "Mostrar la cabecera" : "Ocultar la cabecera");
      ui.collapseHeaderButton.setAttribute("aria-expanded", String(!headerCollapsed));
      chrome.storage.local.set({ transcriptHeaderCollapsed: headerCollapsed });
    };
    ui.collapseHeaderButton.addEventListener("click", onCollapseHeader);
    ui.cleanups.push(() => ui.collapseHeaderButton.removeEventListener("click", onCollapseHeader));

    const onClose = () => {
      if (state.settings.autoOpenNextVideo) {
        state.dismissedVideoId = new URL(location.href).searchParams.get("v");
        removePanel();
        ytx.bridge.sendControl();
      } else chrome.storage.local.set({ transcriptEnabled: false });
    };
    ui.closeButton.addEventListener("click", onClose);
    ui.cleanups.push(() => ui.closeButton.removeEventListener("click", onClose));

    const onCopyAll = async () => {
      const blocks = state.displayBlocks || [];
      if (!blocks.length) return;
      await navigator.clipboard.writeText(blocks.map((block) => block.text).join(" "));
      setButtonIcon(ui.copyButton, "check");
      setTimeout(() => { if (state.ui === ui) setButtonIcon(ui.copyButton, "copy"); }, 1200);
    };
    ui.copyButton.addEventListener("click", onCopyAll);
    ui.cleanups.push(() => ui.copyButton.removeEventListener("click", onCopyAll));

    const onCopySelection = (event) => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.toString().trim()) return;
      event.clipboardData.setData("text/plain", selection.toString().replace(/\s+/g, " ").trim());
      event.preventDefault();
    };
    ui.content.addEventListener("copy", onCopySelection);
    ui.cleanups.push(() => ui.content.removeEventListener("copy", onCopySelection));

    let previousScrollTop = ui.content.scrollTop;
    const onContentScroll = () => {
      if (state.pendingScrollTop != null) {
        const matched = Math.abs(ui.content.scrollTop - state.pendingScrollTop) < 2;
        state.pendingScrollTop = null;
        previousScrollTop = ui.content.scrollTop;
        if (matched) return;
      }
      const distanceFromBottom = ui.content.scrollHeight - ui.content.scrollTop - ui.content.clientHeight;
      if (ui.content.scrollTop < previousScrollTop - 1) state.autoScrollEnabled = false;
      else if (distanceFromBottom <= 4) state.autoScrollEnabled = true;
      previousScrollTop = ui.content.scrollTop;
    };
    ui.content.addEventListener("scroll", onContentScroll, { passive: true });
    ui.cleanups.push(() => ui.content.removeEventListener("scroll", onContentScroll));
    const onGeometryChange = () => savePanelGeometry(ui.panel);
    ui.panel.addEventListener("ytx:geometrychange", onGeometryChange);
    ui.cleanups.push(() => ui.panel.removeEventListener("ytx:geometrychange", onGeometryChange));

    chrome.storage.local.get(PANEL_STORAGE_DEFAULTS, (stored) => {
      if (state.ui !== ui) return;
      if (state.settings.rememberLayout !== false) applyStoredGeometry(ui.panel, stored.transcriptPanelGeometry);
      headerCollapsed = state.settings.rememberLayout !== false && Boolean(stored.transcriptHeaderCollapsed);
      ui.panel.classList.toggle("ytx-panel--header-collapsed", headerCollapsed);
      ui.panel.style.minHeight = "130px";
      setButtonIcon(ui.collapseHeaderButton, headerCollapsed ? "chevronUp" : "chevronDown");
      labelButton(ui.collapseHeaderButton, headerCollapsed ? "Mostrar la cabecera" : "Ocultar la cabecera");
      ui.collapseHeaderButton.setAttribute("aria-expanded", String(!headerCollapsed));
    });
    return ui;
  }

  function removePanel() {
    ytx.sync?.stop();
    if (!state.ui) return;
    const notesRemainOpen = state.ui.notesWorkspace?.classList.contains("ytx-video-notes-window--active") ||
      state.ui.notesWorkspace?.classList.contains("ytx-panel--notes-open") ||
      state.ui.notesWorkspace?.classList.contains("ytx-panel--general-open") ||
      state.ui.notesWorkspace?.classList.contains("ytx-panel--organization-open");
    if (notesRemainOpen) {
      state.ui.panel.classList.add("ytx-panel--notes-host-only");
      ytx.playerControls?.updateTranscriptButton();
      return;
    }
    state.ui.cleanups.forEach((cleanup) => cleanup());
    state.ui.notesWorkspace?.remove();
    state.ui.panel.remove();
    state.ui = null;
    ytx.playerControls?.updateTranscriptButton();
  }

  function ensurePanel() {
    if (!state.settings.extensionEnabled || !state.settings.enabled ||
      state.dismissedVideoId === new URL(location.href).searchParams.get("v") || !ytx.isWatchPage()) {
      removePanel();
      return null;
    }
    return state.ui || createPanel();
  }

  function showMessage(title, message) {
    const ui = ensurePanel();
    if (!ui) return;
    setTitle(title);
    ui.copyButton.hidden = true;
    const paragraph = document.createElement("p");
    paragraph.className = "ytx-panel__message";
    paragraph.textContent = message;
    ui.content.replaceChildren(paragraph);
  }

  ytx.panel = {
    create: createPanel, remove: removePanel, ensure: ensurePanel, setTitle, showMessage, showNotice, confirmAction,
    updateTrackSelector: () => ytx.trackSelector.update(), applyAppearance, setButtonIcon, labelButton,
  };
})();
