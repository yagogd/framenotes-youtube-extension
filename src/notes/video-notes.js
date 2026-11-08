(() => {
  "use strict";
  const ytx = globalThis.__YTX;
  const state = ytx.state;
  const STORAGE_KEY = "ytxSavedNotes";
  const RECORDS_KEY = "ytxVideoRecords";
  const SETTINGS_KEY = "ytxObsidianSettings";
  const EXPORT_SETTING_KEYS = ["defaultFolder", "fileNameTemplate", "noteTemplate", "generalNoteTemplate", "timestampNoteTemplate", "includeSource", "includeVideoId", "includeChannel", "includeUrl", "includeNoteCreatedDate", "includeVideoPublishedDate", "includeGeneralNote", "includeTimestampNotes", "includeTags", "contentOrder"];
  let editorDraft = null;
  let editorReturnFocus = null;
  let autoSyncTimer = 0;
  let currentTags = [];
  let currentFolder = "";
  let availableTags = [];
  let availableFolders = [];
  let catalogRefreshedAt = 0;
  let feedbackTimer = 0;
  let videoFieldsSaveChain = Promise.resolve();

  function resizeGeneralNote() {
    const textarea = state.ui?.generalNote;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.max(70, textarea.scrollHeight)}px`;
  }

  function videoId() {
    return new URL(location.href).searchParams.get("v") || "";
  }

  function videoMetadata() {
    const id = videoId();
    const heading = document.querySelector("h1.ytd-watch-metadata yt-formatted-string, h1.title yt-formatted-string");
    const directDate = document.querySelector('meta[itemprop="datePublished"], meta[itemprop="uploadDate"], meta[property="datePublished"], link[itemprop="uploadDate"]')?.getAttribute("content") || "";
    let embeddedDate = "";
    if (!directDate) {
      for (const script of document.scripts) {
        const match = script.textContent?.match(/"(?:publishDate|uploadDate|datePublished)"\s*:\s*"(\d{4}-\d{2}-\d{2})/);
        if (match) { embeddedDate = match[1]; break; }
      }
    }
    return {
      videoId: id,
      videoTitle: heading?.textContent?.trim() || document.title.replace(/\s*-\s*YouTube\s*$/, ""),
      videoUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`,
      channel: document.querySelector("#owner #channel-name a, ytd-video-owner-renderer #channel-name a")?.textContent?.trim() || "",
      videoPublishedAt: directDate || embeddedDate,
    };
  }

  function readAll() {
    return new Promise((resolve) => {
      chrome.storage.local.get({ [STORAGE_KEY]: [] }, (stored) => {
        resolve(Array.isArray(stored[STORAGE_KEY]) ? stored[STORAGE_KEY] : []);
      });
    });
  }

  async function writeAll(items) {
    await chrome.storage.local.set({ [STORAGE_KEY]: items });
  }

  function readStorage(defaults) { return new Promise((resolve) => chrome.storage.local.get(defaults, resolve)); }

  async function ensureVideoRecord(patch = {}) {
    const metadata = videoMetadata();
    if (!metadata.videoId) return null;
    const stored = await readStorage({ [RECORDS_KEY]: {}, [SETTINGS_KEY]: {} });
    const records = stored[RECORDS_KEY] || {};
    const previous = records[metadata.videoId] || {};
    const settings = { ...YTXObsidianCore.DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] || {}) };
    const record = {
      generalNote: "", tags: [], folder: "", createdAt: new Date().toISOString(), obsidian: { status: "never", path: "", fingerprint: "", error: "" },
      ...previous, ...metadata, ...patch,
      videoPublishedAt: metadata.videoPublishedAt || previous.videoPublishedAt || "",
      timestampNotes: state.savedNotes.slice(),
    };
    if (YTXObsidianCore.hasNoteContent(record) && !record.obsidian?.exportSettings) {
      record.obsidian = { ...record.obsidian, exportSettings:Object.fromEntries(EXPORT_SETTING_KEYS.map((key) => [key, Array.isArray(settings[key]) ? settings[key].slice() : settings[key]])) };
    }
    if (Object.prototype.hasOwnProperty.call(patch, "folder") && previous.folder !== record.folder && previous.obsidian?.path) {
      record.obsidian = { ...record.obsidian, status:"pending", path:"", relocateFrom:previous.obsidian.path };
    }
    const renderSettings = { ...settings, ...(record.obsidian?.exportSettings || {}) };
    const fingerprint = YTXObsidianCore.contentFingerprint(record, renderSettings);
    if (record.obsidian?.fingerprint && record.obsidian.fingerprint !== fingerprint) record.obsidian = { ...record.obsidian, status: "pending" };
    records[metadata.videoId] = record;
    await chrome.storage.local.set({ [RECORDS_KEY]: records });
    return { record, settings };
  }

  function scheduleAutoSync(result) {
    if (result?.settings?.enabled && result.settings.apiUrl && result.settings.apiToken) {
      clearTimeout(autoSyncTimer);
      const scheduledVideoId = result.record.videoId;
      autoSyncTimer = setTimeout(() => chrome.runtime.sendMessage({ type: "YTX_OBSIDIAN_SYNC", videoId: scheduledVideoId }), 800);
    }
  }

  function statusText(status, configured, error) {
    if (!configured) return "Obsidian: no configurado";
    return ({ never: "Obsidian: listo", pending: "Obsidian: cambios sin guardar", synced: "Obsidian: sincronizado", error: `Obsidian: ${error || "error"}` })[status] || "Obsidian: listo";
  }

  async function loadVideoRecord() {
    if (!state.ui || !videoId()) return;
    const stored = await readStorage({ [RECORDS_KEY]: {}, [SETTINGS_KEY]: {} });
    const record = stored[RECORDS_KEY]?.[videoId()] || (await ensureVideoRecord())?.record;
    const settings = { ...YTXObsidianCore.DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] || {}) };
    if (!record) return;
    if (document.activeElement !== state.ui.generalNote) {
      state.ui.generalNote.value = record.generalNote || "";
      resizeGeneralNote();
    }
    if (document.activeElement !== state.ui.folder) {
      currentFolder = record.folder || "";
      state.ui.folder.value = "";
      renderFolderSelection();
    }
    currentTags = YTXObsidianCore.normalizeTags(record.tags);
    renderTagChips();
    state.ui.syncStatus.textContent = statusText(record.obsidian?.status, settings.enabled && settings.apiUrl && settings.apiToken, record.obsidian?.error);
    state.ui.syncButton.disabled = !settings.enabled || !settings.apiUrl || !settings.apiToken;
  }

  function saveVideoFields() {
    const ui = state.ui;
    const snapshot = {
      generalNote: ui.generalNote.value,
      folder: currentFolder,
      tags: currentTags.slice(),
      updatedAt: new Date().toISOString(),
    };
    videoFieldsSaveChain = videoFieldsSaveChain.catch(() => {}).then(async () => {
      const result = await ensureVideoRecord(snapshot);
      scheduleAutoSync(result);
      if (state.ui && result?.record) {
        state.ui.syncStatus.textContent = statusText(result.record.obsidian?.status, result.settings?.enabled && result.settings?.apiUrl && result.settings?.apiToken, result.record.obsidian?.error);
      }
      return result;
    });
    return videoFieldsSaveChain;
  }

  function renderTagChips() {
    const ui = state.ui;
    if (!ui?.tagsChips) return;
    ui.tagsChips.replaceChildren();
    currentTags.forEach((tag) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.textContent = `#${tag} ×`;
      chip.setAttribute("aria-label", `Eliminar tag ${tag}`);
      chip.addEventListener("click", () => {
        currentTags = currentTags.filter((item) => item !== tag);
        renderTagChips();
        saveVideoFields();
        showFeedback(`Tag #${tag} eliminado`);
      });
      ui.tagsChips.appendChild(chip);
    });
  }

  function renderFolderSelection() {
    const ui = state.ui;
    if (!ui?.folderSelection) return;
    ui.folderSelection.replaceChildren();
    if (!currentFolder) {
      const empty = document.createElement("span");
      empty.className = "ytx-video-note__folder-default";
      empty.textContent = "Se usará la carpeta predeterminada";
      ui.folderSelection.appendChild(empty);
      return;
    }
    const chip = document.createElement("button");
    chip.type = "button";
    chip.textContent = `${currentFolder} ×`;
    chip.setAttribute("aria-label", `Quitar carpeta ${currentFolder}`);
    chip.addEventListener("click", () => {
      currentFolder = "";
      renderFolderSelection();
      saveVideoFields();
      showFeedback("Se usará la carpeta predeterminada");
    });
    ui.folderSelection.appendChild(chip);
  }

  function showFeedback(message) {
    const feedback = state.ui?.organizationFeedback;
    if (!feedback) return;
    clearTimeout(feedbackTimer);
    feedback.textContent = `✓ ${message}`;
    feedback.classList.remove("ytx-video-note__feedback--visible");
    requestAnimationFrame(() => feedback.classList.add("ytx-video-note__feedback--visible"));
    feedbackTimer = setTimeout(() => feedback.classList.remove("ytx-video-note__feedback--visible"), 2200);
  }

  function catalogButton(label, onSelect) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", onSelect);
    return button;
  }

  function renderCatalog(container, items, query, onSelect, createLabel) {
    const normalizedQuery = String(query || "").trim().toLocaleLowerCase();
    const matches = items.filter((item) => !normalizedQuery || item.toLocaleLowerCase().includes(normalizedQuery)).slice(0, 60);
    const children = matches.map((item) => catalogButton(item, () => onSelect(item)));
    if (normalizedQuery && !items.some((item) => item.toLocaleLowerCase() === normalizedQuery)) {
      children.unshift(catalogButton(createLabel(String(query).trim()), () => onSelect(String(query).trim())));
    }
    if (!children.length) {
      const empty = document.createElement("div");
      empty.className = "ytx-video-note__catalog-empty";
      empty.textContent = "No hay elementos disponibles.";
      children.push(empty);
    }
    container.replaceChildren(...children);
    container.hidden = false;
  }

  function renderTagCatalog() {
    const ui = state.ui;
    renderCatalog(ui.tagsCatalog, availableTags.filter((tag) => !currentTags.includes(tag)), ui.tagsInput.value, (tag) => {
      currentTags = YTXObsidianCore.normalizeTags([...currentTags, tag]);
      ui.tagsInput.value = "";
      ui.tagsCatalog.hidden = true;
      renderTagChips();
      saveVideoFields();
      showFeedback(`Tag #${tag.replace(/^#/, "")} añadido`);
    }, (tag) => `Crear tag #${tag.replace(/^#/, "")}`);
  }

  function renderFolderCatalog() {
    const ui = state.ui;
    renderCatalog(ui.folderCatalog, availableFolders, ui.folder.value, (folder) => {
      currentFolder = folder;
      ui.folder.value = "";
      ui.folderCatalog.hidden = true;
      renderFolderSelection();
      saveVideoFields();
      showFeedback(`Carpeta configurada: ${folder}`);
    }, (folder) => `Crear carpeta ${folder}`);
  }

  function renderNoteEditorTagCatalog() {
    const ui = state.ui;
    const parts = ui.noteEditorTags.value.split(",");
    const query = parts.pop()?.trim() || "";
    const selected = YTXObsidianCore.normalizeTags(parts);
    renderCatalog(ui.noteEditorTagsCatalog, availableTags.filter((tag) => !selected.includes(tag)), query, (tag) => {
      ui.noteEditorTags.value = [...selected, tag].join(", ") + ", ";
      ui.noteEditorTagsCatalog.hidden = true;
      ui.noteEditorTags.focus();
    }, (tag) => `Crear tag #${tag.replace(/^#/, "")}`);
  }

  function refreshOrganizationCatalog(force = false) {
    if (!force && Date.now() - catalogRefreshedAt < 15000) return;
    catalogRefreshedAt = Date.now();
    chrome.runtime.sendMessage({ type:"YTX_OBSIDIAN_CATALOG" }, (response) => {
      if (!response?.ok || !state.ui) return;
      availableTags = response.tags || [];
      availableFolders = response.folders || [];
      if (!state.ui.tagsCatalog.hidden) renderTagCatalog();
      if (!state.ui.folderCatalog.hidden) renderFolderCatalog();
      if (!state.ui.noteEditorTagsCatalog.hidden) renderNoteEditorTagCatalog();
    });
  }

  async function loadCurrent() {
    const all = await readAll();
    state.savedNotes = all.filter((item) => item.videoId === videoId());
    renderDrawer();
    refreshMarkers();
    ytx.playerControls?.refreshNoteMarkers();
    ytx.playerControls?.updateNotesButton();
    await ensureVideoRecord();
    return state.savedNotes;
  }

  async function save(draft) {
    const all = await readAll();
    const item = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      ...videoMetadata(),
      type: draft.type || "note",
      startMs: Math.max(0, Number(draft.startMs) || 0),
      endMs: Math.max(Number(draft.endMs) || 0, Number(draft.startMs) || 0),
      text: String(draft.text || "").trim(),
      note: String(draft.note || "").trim(),
      tags: YTXObsidianCore.normalizeTags(draft.tags),
      createdAt: new Date().toISOString(),
    };
    all.push(item);
    await writeAll(all);
    await loadCurrent();
    scheduleAutoSync(await ensureVideoRecord());
    return item;
  }

  async function update(id, draft) {
    const all = await readAll();
    const index = all.findIndex((item) => item.id === id);
    if (index === -1) return null;
    all[index] = {
      ...all[index],
      note: String(draft.note || "").trim(),
      tags: YTXObsidianCore.normalizeTags(draft.tags ?? all[index].tags),
      updatedAt: new Date().toISOString(),
    };
    await writeAll(all);
    await loadCurrent();
    scheduleAutoSync(await ensureVideoRecord());
    return all[index];
  }

  async function remove(id) {
    const all = await readAll();
    await writeAll(all.filter((item) => item.id !== id));
    await loadCurrent();
    scheduleAutoSync(await ensureVideoRecord());
  }

  function jumpTo(startMs) {
    const video = document.querySelector("video");
    if (video) video.currentTime = startMs / 1000;
  }

  function selectedTextInside(row, fallback) {
    const selection = window.getSelection();
    return selection && !selection.isCollapsed && row.contains(selection.anchorNode)
      ? selection.toString().replace(/\s+/g, " ").trim()
      : fallback;
  }

  function openEditor(draft) {
    const ui = state.ui;
    if (!ui) return;
    editorDraft = draft;
    editorReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ui.noteEditorTime.textContent = ytx.formatTime(draft.startMs);
    ui.noteEditorText.textContent = draft.text || "Marcador sin texto";
    ui.noteEditorInput.value = draft.note || "";
    ui.noteEditorTags.value = (draft.tags || []).join(", ");
    ui.notesWorkspace.classList.add("ytx-panel--note-editor-open");
    ui.noteEditorInput.focus();
  }

  function renderDrawer() {
    const ui = state.ui;
    if (!ui?.notesList) return;
    ui.notesList.replaceChildren();
    if (!state.savedNotes.length) {
      const empty = document.createElement("p");
      empty.className = "ytx-notes__empty";
      empty.textContent = "Todavía no hay marcadores en este vídeo.";
      ui.notesList.appendChild(empty);
      return;
    }

    state.savedNotes
      .slice()
      .sort((a, b) => a.startMs - b.startMs)
      .forEach((item) => {
        const row = document.createElement("div");
        row.className = `ytx-note-item ytx-note-item--${item.type === "favorite" ? "favorite" : "note"}`;
        row.dataset.noteId = item.id;
        const jump = document.createElement("button");
        jump.className = "ytx-note-item__jump";
        jump.textContent = ytx.formatTime(item.startMs);
        jump.addEventListener("click", () => jumpTo(item.startMs));
        const body = document.createElement("div");
        body.className = "ytx-note-item__body";
        const text = document.createElement("div");
        text.className = "ytx-note-item__text";
        text.textContent = item.text || "Momento guardado";
        body.appendChild(text);
        if (item.note) {
          const note = document.createElement("div");
          note.className = "ytx-note-item__note";
          note.textContent = item.note;
          body.appendChild(note);
        }
        if (item.tags?.length) {
          const tags = document.createElement("div");
          tags.className = "ytx-note-item__tags";
          item.tags.forEach((tag) => {
            const chip = document.createElement("span");
            chip.textContent = `#${tag}`;
            tags.appendChild(chip);
          });
          body.appendChild(tags);
        }
        const deleteButton = document.createElement("button");
        deleteButton.className = "ytx-note-item__delete";
        ytx.panel.setButtonIcon(deleteButton, "trash");
        ytx.panel.labelButton(deleteButton, "Eliminar nota");
        deleteButton.addEventListener("click", async () => {
          const confirmed = await ytx.panel.confirmAction("¿Quieres eliminar esta nota? Esta acción no se puede deshacer.");
          if (confirmed) remove(item.id);
        });
        const editButton = document.createElement("button");
        editButton.className = "ytx-note-item__edit";
        ytx.panel.setButtonIcon(editButton, "edit");
        ytx.panel.labelButton(editButton, "Editar nota");
        editButton.addEventListener("click", () => openEditor({ ...item, editingId: item.id }));
        const actions = document.createElement("div");
        actions.className = "ytx-note-item__actions";
        actions.append(editButton, deleteButton);
        row.append(jump, body, actions);
        ui.notesList.appendChild(row);
      });
  }

  function refreshMarkers() {
    const content = state.ui?.content;
    if (!content) return;
    content.querySelectorAll("[data-block-index]").forEach((row) => {
      const block = state.displayBlocks[Number(row.dataset.blockIndex)];
      const saved = block && state.savedNotes.some((item) => Math.abs(item.startMs - block.startMs) < 500);
      row.classList.toggle("ytx-transcript-row--saved", Boolean(saved));
      const favorite = row.querySelector(".ytx-row-action--favorite");
      if (favorite) {
        favorite.setAttribute("aria-pressed", String(Boolean(saved)));
        ytx.panel.labelButton(favorite, saved ? "Quitar de favoritos" : "Guardar en favoritos");
      }
    });
  }

  function createBlockActions(block, row) {
    const actions = document.createElement("div");
    actions.className = "ytx-row-actions";
    const copy = document.createElement("button");
    copy.className = "ytx-row-action";
    ytx.panel.setButtonIcon(copy, "copy");
    ytx.panel.labelButton(copy, "Copiar fragmento");
    copy.addEventListener("click", () => navigator.clipboard.writeText(selectedTextInside(row, block.text)));

    const favorite = document.createElement("button");
    favorite.className = "ytx-row-action ytx-row-action--favorite";
    ytx.panel.setButtonIcon(favorite, "star");
    ytx.panel.labelButton(favorite, "Guardar en favoritos");
    favorite.setAttribute("aria-pressed", "false");
    favorite.addEventListener("click", () => {
      const existing = state.savedNotes.find((item) => Math.abs(item.startMs - block.startMs) < 500);
      if (existing) remove(existing.id);
      else save({ ...block, type: "favorite", note: "" });
    });

    const note = document.createElement("button");
    note.className = "ytx-row-action";
    ytx.panel.setButtonIcon(note, "edit");
    ytx.panel.labelButton(note, "Añadir nota");
    note.addEventListener("click", () => openEditor({
      ...block,
      type: "note",
      text: selectedTextInside(row, block.text),
      note: "",
    }));
    actions.append(copy, favorite, note);
    return actions;
  }

  function attach(ui) {
    let saveTimer = 0;
    const compactWorkspace = () => { ui.notesWorkspace.style.height = "auto"; };
    const removeNotesOnlyHostIfEmpty = () => {
      const anySectionOpen = ui.notesWorkspace.classList.contains("ytx-panel--notes-open") || ui.notesWorkspace.classList.contains("ytx-panel--general-open") || ui.notesWorkspace.classList.contains("ytx-panel--organization-open");
      const windowActive = ui.notesWorkspace.classList.contains("ytx-video-notes-window--active");
      if (!anySectionOpen && !windowActive && ui.panel.classList.contains("ytx-panel--notes-host-only")) ytx.panel.remove();
    };
    const makeChevron = () => {
      const chevron = document.createElement("span");
      chevron.className = "ytx-notes-section__chevron";
      chevron.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
      return chevron;
    };
    const chevrons = { general: makeChevron(), organization: makeChevron(), notes: makeChevron() };
    ui.videoNoteHeader.prepend(chevrons.general);
    ui.organizationHeader.prepend(chevrons.organization);
    ui.notesHeader.prepend(chevrons.notes);
    const updateChevrons = () => {
      const generalOpen = ui.notesWorkspace.classList.contains("ytx-panel--general-open");
      const organizationOpen = ui.notesWorkspace.classList.contains("ytx-panel--organization-open");
      const notesOpen = ui.notesWorkspace.classList.contains("ytx-panel--notes-open");
      chevrons.general.classList.toggle("ytx-notes-section__chevron--closed", !generalOpen);
      chevrons.organization.classList.toggle("ytx-notes-section__chevron--closed", !organizationOpen);
      chevrons.notes.classList.toggle("ytx-notes-section__chevron--closed", !notesOpen);
      ytx.panel.setButtonIcon(ui.generalClose, generalOpen ? "close" : "plus");
      ytx.panel.labelButton(ui.generalClose, generalOpen ? "Cerrar nota general" : "Ampliar nota general");
      ytx.panel.setButtonIcon(ui.organizationClose, organizationOpen ? "close" : "plus");
      ytx.panel.labelButton(ui.organizationClose, organizationOpen ? "Cerrar organización" : "Ampliar organización");
      ytx.panel.setButtonIcon(ui.notesClose, notesOpen ? "close" : "plus");
      ytx.panel.labelButton(ui.notesClose, notesOpen ? "Cerrar marcadores de este vídeo" : "Ampliar marcadores de este vídeo");
    };
    const toggleSection = (cls) => {
      const open = !ui.notesWorkspace.classList.contains(cls);
      ui.panel.classList.toggle(cls, open);
      ui.notesWorkspace.classList.toggle(cls, open);
      if (open) ui.notesWorkspace.classList.add("ytx-video-notes-window--active");
      if (open && (cls === "ytx-panel--general-open" || cls === "ytx-panel--organization-open")) refreshOrganizationCatalog();
      if (cls === "ytx-panel--notes-open") {
        ui.notesToggle.setAttribute("aria-expanded", String(open));
        ytx.panel.labelButton(ui.notesToggle, open ? "Cerrar notas y favoritos de este vídeo" : "Mostrar notas y favoritos de este vídeo");
        renderDrawer();
      }
      if (cls === "ytx-panel--general-open") ui.generalToggle.setAttribute("aria-expanded", String(open));
      updateChevrons();
      compactWorkspace();
      removeNotesOnlyHostIfEmpty();
    };
    const setNotesOpen = (open) => {
      if (open) {
        ui.panel.classList.add("ytx-panel--general-open");
        ui.notesWorkspace.classList.add("ytx-panel--general-open");
        ui.notesWorkspace.classList.add("ytx-panel--organization-open");
        ui.generalToggle.setAttribute("aria-expanded", "true");
        refreshOrganizationCatalog();
      } else {
        ui.panel.classList.remove("ytx-panel--general-open");
        ui.notesWorkspace.classList.remove("ytx-panel--general-open");
        ui.notesWorkspace.classList.remove("ytx-panel--organization-open");
        ui.generalToggle.setAttribute("aria-expanded", "false");
      }
      ui.panel.classList.toggle("ytx-panel--notes-open", open);
      ui.notesWorkspace.classList.toggle("ytx-panel--notes-open", open);
      if (open) ui.notesWorkspace.classList.add("ytx-video-notes-window--active");
      ui.notesToggle.setAttribute("aria-expanded", String(open));
      ytx.panel.labelButton(ui.notesToggle, open ? "Cerrar notas y favoritos de este vídeo" : "Mostrar notas y favoritos de este vídeo");
      compactWorkspace();
      renderDrawer();
      updateChevrons();
    };
    const setGeneralOpen = (open) => {
      if (open) {
        ui.panel.classList.remove("ytx-panel--notes-open");
        ui.notesWorkspace.classList.remove("ytx-panel--notes-open");
        ui.notesToggle.setAttribute("aria-expanded", "false");
      }
      ui.panel.classList.toggle("ytx-panel--general-open", open);
      ui.notesWorkspace.classList.toggle("ytx-panel--general-open", open);
      ui.panel.classList.toggle("ytx-panel--organization-open", open);
      ui.notesWorkspace.classList.toggle("ytx-panel--organization-open", open);
      if (open) ui.notesWorkspace.classList.add("ytx-video-notes-window--active");
      ui.generalToggle.setAttribute("aria-expanded", String(open));
      if (open) refreshOrganizationCatalog();
      updateChevrons();
    };
    const onToggleNotes = () => setNotesOpen(!ui.panel.classList.contains("ytx-panel--notes-open"));
    const onCloseNotes = () => {
      const closing = ui.notesWorkspace.classList.contains("ytx-panel--notes-open");
      toggleSection("ytx-panel--notes-open");
      if (closing && !ui.panel.classList.contains("ytx-panel--notes-host-only")) ui.notesToggle.focus();
    };
    const onToggleGeneral = () => setGeneralOpen(!ui.panel.classList.contains("ytx-panel--general-open"));
    const onCloseGeneral = () => {
      const closing = ui.notesWorkspace.classList.contains("ytx-panel--general-open");
      toggleSection("ytx-panel--general-open");
      if (closing && !ui.panel.classList.contains("ytx-panel--notes-host-only")) ui.generalToggle.focus();
    };
    const onCloseOrganization = () => toggleSection("ytx-panel--organization-open");
    const onCloseWorkspace = () => {
      ui.panel.classList.remove("ytx-panel--notes-open", "ytx-panel--general-open");
      ui.notesWorkspace.classList.remove("ytx-panel--notes-open", "ytx-panel--general-open", "ytx-panel--organization-open");
      ui.notesWorkspace.classList.remove("ytx-video-notes-window--active");
      ui.notesToggle.setAttribute("aria-expanded", "false");
      ui.generalToggle.setAttribute("aria-expanded", "false");
      compactWorkspace();
      updateChevrons();
      removeNotesOnlyHostIfEmpty();
    };
    const onHeaderGeneralClick = (event) => { if (event.target.closest(".ytx-notes__close")) return; toggleSection("ytx-panel--general-open"); };
    const onHeaderOrganizationClick = (event) => { if (event.target.closest(".ytx-notes__close")) return; toggleSection("ytx-panel--organization-open"); };
    const onHeaderNotesClick = (event) => { if (event.target.closest(".ytx-notes__close")) return; toggleSection("ytx-panel--notes-open"); };
    const onCancel = () => {
      editorDraft = null;
      ui.notesWorkspace.classList.remove("ytx-panel--note-editor-open");
      editorReturnFocus?.focus();
      editorReturnFocus = null;
    };
    const onSave = async () => {
      if (!editorDraft) return;
      const fields = { note:ui.noteEditorInput.value, tags:YTXObsidianCore.normalizeTags(ui.noteEditorTags.value) };
      if (editorDraft.editingId) await update(editorDraft.editingId, fields);
      else await save({ ...editorDraft, ...fields });
      onCancel();
    };
    const onEditorKeyDown = (event) => {
      if (event.key !== "Escape" || !ui.notesWorkspace.classList.contains("ytx-panel--note-editor-open")) return;
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    };
    const onStorageChanged = (changes, area) => {
      if (area !== "local") return;
      if (changes[STORAGE_KEY]) loadCurrent();
      if (changes[RECORDS_KEY] || changes[SETTINGS_KEY]) loadVideoRecord();
    };
    const queueFieldSave = () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveVideoFields, 400); };
    const commitTags = () => {
      const additions = YTXObsidianCore.normalizeTags(ui.tagsInput.value);
      if (!additions.length) return;
      currentTags = YTXObsidianCore.normalizeTags([...currentTags, ...additions]);
      ui.tagsInput.value = "";
      renderTagChips();
      renderTagCatalog();
      saveVideoFields();
      showFeedback(`${additions.length === 1 ? "Tag añadido" : "Tags añadidos"}`);
    };
    const onTagKeyDown = (event) => {
      event.stopPropagation();
      if (event.key !== "Enter" && event.key !== ",") return;
      event.preventDefault();
      commitTags();
    };
    const hideCatalog = (event) => { event.currentTarget.nextElementSibling.hidden = true; };
    const scrollCatalog = (event) => {
      const catalog = event.target instanceof Element ? event.target.closest(".ytx-video-note__catalog") : null;
      if (!catalog || !ui.notesWorkspace.contains(catalog) || catalog.hidden) return;
      if (catalog.scrollHeight <= catalog.clientHeight) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      const multiplier = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 18 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? catalog.clientHeight : 1;
      catalog.scrollTop += event.deltaY * multiplier;
    };
    const onTagFocus = () => { renderTagCatalog(); refreshOrganizationCatalog(); };
    const onFolderFocus = () => { renderFolderCatalog(); refreshOrganizationCatalog(); };
    const onNoteTagFocus = () => { renderNoteEditorTagCatalog(); refreshOrganizationCatalog(); };
    const onGeneralKeyDown = async (event) => {
      event.stopPropagation();
      if (event.key !== "Enter" || event.shiftKey) return;
      event.preventDefault();
      clearTimeout(saveTimer);
      await saveVideoFields();
      showFeedback("Nota general guardada");
      ui.generalNote.blur();
    };
    const onGeneralInput = () => {
      resizeGeneralNote();
      queueFieldSave();
    };
    const onFolderKeyDown = (event) => {
      event.stopPropagation();
      if (event.key !== "Enter") return;
      event.preventDefault();
      const folder = ui.folder.value.trim();
      if (folder) currentFolder = folder;
      ui.folder.value = "";
      ui.folderCatalog.hidden = true;
      renderFolderSelection();
      saveVideoFields();
      showFeedback(currentFolder ? `Carpeta configurada: ${currentFolder}` : "Se usará la carpeta predeterminada");
    };
    const onSync = async () => {
      clearTimeout(saveTimer);
      await saveVideoFields();
      clearTimeout(autoSyncTimer);
      ui.syncButton.disabled = true;
      ui.syncStatus.textContent = "Obsidian: guardando…";
      chrome.runtime.sendMessage({ type: "YTX_OBSIDIAN_SYNC", videoId: videoId() }, (response) => {
        ui.syncButton.disabled = false;
        if (chrome.runtime.lastError) ui.syncStatus.textContent = `Obsidian: ${chrome.runtime.lastError.message}`;
        else ui.syncStatus.textContent = response?.ok ? "Obsidian: sincronizado" : `Obsidian: ${response?.error || "error"}`;
      });
    };
    ui.notesToggle.addEventListener("click", onToggleNotes);
    ui.generalToggle.addEventListener("click", onToggleGeneral);
    ui.generalClose.addEventListener("click", onCloseGeneral);
    ui.notesClose.addEventListener("click", onCloseNotes);
    ui.notesWorkspaceClose.addEventListener("click", onCloseWorkspace);
    ui.organizationClose.addEventListener("click", onCloseOrganization);
    ui.videoNoteHeader.addEventListener("click", onHeaderGeneralClick);
    ui.organizationHeader.addEventListener("click", onHeaderOrganizationClick);
    ui.notesHeader.addEventListener("click", onHeaderNotesClick);
    ui.noteEditorCancel.addEventListener("click", onCancel);
    ui.noteEditorSave.addEventListener("click", onSave);
    ui.noteEditorTags.addEventListener("focus", onNoteTagFocus);
    ui.noteEditorTags.addEventListener("input", renderNoteEditorTagCatalog);
    ui.noteEditorTags.addEventListener("blur", hideCatalog);
    ui.notesWorkspace.addEventListener("keydown", onEditorKeyDown);
    const stopKey = (event) => event.stopPropagation();
    ui.generalNote.addEventListener("input", onGeneralInput);
    ui.generalNote.addEventListener("keydown", onGeneralKeyDown);
    ui.generalNote.addEventListener("keyup", stopKey);
    ui.generalNote.addEventListener("keypress", stopKey);
    ui.tagsInput.addEventListener("keydown", onTagKeyDown);
    ui.tagsInput.addEventListener("keyup", stopKey);
    ui.tagsInput.addEventListener("keypress", stopKey);
    ui.tagsInput.addEventListener("change", commitTags);
    ui.tagsInput.addEventListener("focus", onTagFocus);
    ui.tagsInput.addEventListener("click", onTagFocus);
    ui.tagsInput.addEventListener("input", renderTagCatalog);
    ui.tagsInput.addEventListener("blur", hideCatalog);
    ui.folder.addEventListener("focus", onFolderFocus);
    ui.folder.addEventListener("click", onFolderFocus);
    ui.folder.addEventListener("input", renderFolderCatalog);
    ui.folder.addEventListener("blur", hideCatalog);
    ui.folder.addEventListener("keydown", onFolderKeyDown);
    ui.folder.addEventListener("keyup", stopKey);
    ui.folder.addEventListener("keypress", stopKey);
    window.addEventListener("wheel", scrollCatalog, { capture:true, passive:false });
    [ui.folderCatalog, ui.tagsCatalog].forEach((catalog) => catalog.addEventListener("wheel", scrollCatalog, { capture:true, passive:false }));
    ui.syncButton.addEventListener("click", onSync);
    chrome.storage.onChanged.addListener(onStorageChanged);
    updateChevrons();
    loadCurrent();
    loadVideoRecord();
    refreshOrganizationCatalog();
    return () => {
      ui.notesToggle.removeEventListener("click", onToggleNotes);
      ui.generalToggle.removeEventListener("click", onToggleGeneral);
      ui.generalClose.removeEventListener("click", onCloseGeneral);
      ui.notesClose.removeEventListener("click", onCloseNotes);
      ui.notesWorkspaceClose.removeEventListener("click", onCloseWorkspace);
      ui.organizationClose.removeEventListener("click", onCloseOrganization);
      ui.videoNoteHeader.removeEventListener("click", onHeaderGeneralClick);
      ui.organizationHeader.removeEventListener("click", onHeaderOrganizationClick);
      ui.notesHeader.removeEventListener("click", onHeaderNotesClick);
      ui.noteEditorCancel.removeEventListener("click", onCancel);
      ui.noteEditorSave.removeEventListener("click", onSave);
      ui.noteEditorTags.removeEventListener("focus", onNoteTagFocus);
      ui.noteEditorTags.removeEventListener("input", renderNoteEditorTagCatalog);
      ui.noteEditorTags.removeEventListener("blur", hideCatalog);
      ui.notesWorkspace.removeEventListener("keydown", onEditorKeyDown);
      ui.generalNote.removeEventListener("input", onGeneralInput);
      ui.generalNote.removeEventListener("keydown", onGeneralKeyDown);
      ui.generalNote.removeEventListener("keyup", stopKey);
      ui.generalNote.removeEventListener("keypress", stopKey);
      ui.tagsInput.removeEventListener("keydown", onTagKeyDown);
      ui.tagsInput.removeEventListener("keyup", stopKey);
      ui.tagsInput.removeEventListener("keypress", stopKey);
      ui.tagsInput.removeEventListener("change", commitTags);
      ui.tagsInput.removeEventListener("focus", onTagFocus);
      ui.tagsInput.removeEventListener("click", onTagFocus);
      ui.tagsInput.removeEventListener("input", renderTagCatalog);
      ui.tagsInput.removeEventListener("blur", hideCatalog);
      ui.folder.removeEventListener("focus", onFolderFocus);
      ui.folder.removeEventListener("click", onFolderFocus);
      ui.folder.removeEventListener("input", renderFolderCatalog);
      ui.folder.removeEventListener("blur", hideCatalog);
      ui.folder.removeEventListener("keydown", onFolderKeyDown);
      ui.folder.removeEventListener("keyup", stopKey);
      ui.folder.removeEventListener("keypress", stopKey);
      window.removeEventListener("wheel", scrollCatalog, true);
      [ui.folderCatalog, ui.tagsCatalog].forEach((catalog) => catalog.removeEventListener("wheel", scrollCatalog, true));
      ui.syncButton.removeEventListener("click", onSync);
      clearTimeout(saveTimer);
      clearTimeout(autoSyncTimer);
      clearTimeout(feedbackTimer);
      chrome.storage.onChanged.removeListener(onStorageChanged);
    };
  }

  ytx.notes = { attach, loadCurrent, save, update, remove, createBlockActions, refreshMarkers, getAvailableTags:() => availableTags.slice() };
})();
