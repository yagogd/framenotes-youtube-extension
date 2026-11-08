(() => {
  "use strict";
  const ytx = globalThis.__YTX;
  const ICON_PATHS = {
    search: ['<circle cx="11" cy="11" r="7"/>', '<path d="m20 20-4-4"/>'],
    star: ['<path d="m12 2.8 2.8 5.7 6.3.9-4.6 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2-4.6-4.4 6.3-.9Z"/>'],
    list: ['<path d="M8 6h13M8 12h13M8 18h13"/>', '<path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>'],
    chevronUp: ['<path d="m6 15 6-6 6 6"/>'],
    chevronDown: ['<path d="m6 9 6 6 6-6"/>'],
    close: ['<path d="m6 6 12 12M18 6 6 18"/>'],
    plus: ['<path d="M12 5v14M5 12h14"/>'],
    copy: ['<rect x="8" y="8" width="11" height="11" rx="2"/>', '<path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>'],
    check: ['<path d="m5 12 4 4L19 6"/>'],
    edit: ['<path d="M12 20h9"/>', '<path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/>'],
    fileText: ['<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/>', '<path d="M14 2v6h6M8 13h8M8 17h6"/>'],
    trash: ['<path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/>'],
    arrowUp: ['<path d="m6 11 6-6 6 6M12 5v14"/>'],
    arrowDown: ['<path d="m6 13 6 6 6-6M12 19V5"/>'],
  };

  function setButtonIcon(button, name) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.classList.add("ytx-icon");
    svg.innerHTML = (ICON_PATHS[name] || []).join("");
    button.replaceChildren(svg);
  }

  function labelButton(button, label) {
    button.title = label;
    button.setAttribute("aria-label", label);
  }

  function createButton(className, icon, label) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    setButtonIcon(button, icon);
    labelButton(button, label);
    return button;
  }

  function create(state) {
    const panel = document.createElement("aside");
    panel.id = "yt-transcript-panel";
    panel.className = "ytx-panel";
    panel.setAttribute("role", "region");
    panel.setAttribute("aria-label", "Panel de transcripción");
    const header = document.createElement("div");
    header.className = "ytx-panel__header";
    const title = document.createElement("strong");
    title.className = "ytx-panel__title";
    title.dataset.transcriptTitle = "";
    title.dataset.fullTitle = "Cargando transcripción…";
    title.textContent = title.dataset.fullTitle;

    const copyButton = createButton("ytx-button ytx-button--copy", "copy", "Copiar toda la transcripción");
    copyButton.dataset.copyTranscript = "";
    const collapseHeaderButton = createButton("ytx-button ytx-button--collapse-header", "chevronDown", "Ocultar la cabecera");
    collapseHeaderButton.setAttribute("aria-expanded", "true");
    const searchToggle = createButton("ytx-button ytx-button--search", "search", "Buscar en la transcripción");
    searchToggle.setAttribute("aria-expanded", "false");
    searchToggle.setAttribute("aria-controls", "ytx-transcript-search");
    const notesToggle = createButton("ytx-button ytx-button--notes", "list", "Mostrar notas y favoritos de este vídeo");
    notesToggle.setAttribute("aria-expanded", "false");
    notesToggle.setAttribute("aria-controls", "ytx-transcript-notes");
    const generalToggle = createButton("ytx-button ytx-button--general", "fileText", "Editar nota general y organización");
    generalToggle.setAttribute("aria-expanded", "false");
    generalToggle.setAttribute("aria-controls", "ytx-video-note-panel");
    const closeButton = createButton("ytx-button ytx-button--close", "close", "Cerrar la transcripción");

    const content = document.createElement("div");
    content.className = "ytx-panel__content";
    content.dataset.transcriptContent = "";
    content.textContent = "Buscando una pista de subtítulos…";
    const trackUi = ytx.trackSelector.createView();

    const searchBar = document.createElement("div");
    searchBar.id = "ytx-transcript-search";
    searchBar.className = "ytx-search";
    searchBar.setAttribute("role", "search");
    const searchInput = document.createElement("input");
    searchInput.className = "ytx-search__input";
    searchInput.type = "search";
    searchInput.placeholder = "Buscar en la transcripción…";
    searchInput.value = state.search.query;
    searchInput.setAttribute("aria-label", "Buscar texto en la transcripción");
    const searchCounter = document.createElement("span");
    searchCounter.className = "ytx-search__counter";
    searchCounter.textContent = "0/0";
    const searchPrevious = createButton("ytx-search__button", "arrowUp", "Coincidencia anterior");
    const searchNext = createButton("ytx-search__button", "arrowDown", "Coincidencia siguiente");
    const searchClose = createButton("ytx-search__button", "close", "Cerrar búsqueda");
    searchBar.append(searchInput, searchCounter, searchPrevious, searchNext, searchClose);

    const notesDrawer = document.createElement("section");
    notesDrawer.id = "ytx-transcript-notes";
    notesDrawer.className = "ytx-notes";
    notesDrawer.setAttribute("aria-label", "Notas y favoritos de este vídeo");
    const notesHeading = document.createElement("strong");
    notesHeading.className = "ytx-notes__heading";
    notesHeading.textContent = "Marcadores de este vídeo";
    const notesClose = createButton("ytx-notes__close", "close", "Cerrar marcadores de este vídeo");
    const notesHeader = document.createElement("div");
    notesHeader.className = "ytx-notes__header";
    notesHeader.append(notesHeading, notesClose);
    const notesList = document.createElement("div");
    notesList.className = "ytx-notes__list";
    const videoNote = document.createElement("section");
    videoNote.id = "ytx-video-note-panel";
    videoNote.className = "ytx-video-note";
    videoNote.setAttribute("aria-label", "Nota general y organización del vídeo");
    const videoNoteHeader = document.createElement("div");
    videoNoteHeader.className = "ytx-video-note__header";
    const videoNoteTitle = document.createElement("strong");
    videoNoteTitle.textContent = "Nota del vídeo";
    const generalClose = createButton("ytx-notes__close", "close", "Cerrar nota general");
    videoNoteHeader.append(videoNoteTitle, generalClose);
    const generalLabel = document.createElement("label");
    generalLabel.textContent = "NOTA GENERAL";
    const generalNote = document.createElement("textarea");
    generalNote.className = "ytx-video-note__general";
    generalNote.placeholder = "Resumen, conclusiones e ideas generales…";
    generalLabel.appendChild(generalNote);
    const generalHint = document.createElement("small");
    generalHint.className = "ytx-video-note__general-hint";
    generalHint.textContent = "Enter para guardar · Shift + Enter para una nueva línea";
    generalLabel.appendChild(generalHint);
    const organization = document.createElement("section");
    organization.className = "ytx-video-organization";
    const organizationHeader = document.createElement("div");
    organizationHeader.className = "ytx-video-organization__header";
    const organizationTitle = document.createElement("strong");
    organizationTitle.textContent = "Organización";
    const organizationClose = createButton("ytx-notes__close", "close", "Cerrar organización");
    organizationHeader.append(organizationTitle, organizationClose);
    const folder = document.createElement("input");
    folder.className = "ytx-video-note__folder";
    folder.placeholder = "Buscar o crear carpeta…";
    folder.setAttribute("aria-label", "Carpeta de Obsidian");
    folder.setAttribute("autocomplete", "off");
    const folderCatalog = document.createElement("div");
    folderCatalog.className = "ytx-video-note__catalog";
    folderCatalog.hidden = true;
    const folderWrap = document.createElement("div");
    folderWrap.className = "ytx-video-note__picker";
    folderWrap.append(folder, folderCatalog);
    const folderSelection = document.createElement("div");
    folderSelection.className = "ytx-video-note__folder-selection";
    const folderTitle = document.createElement("span");
    folderTitle.className = "ytx-video-note__field-title";
    folderTitle.textContent = "CARPETA";
    const folderField = document.createElement("div");
    folderField.className = "ytx-video-note__field";
    folderField.append(folderTitle, folderSelection, folderWrap);
    const tagsWrap = document.createElement("div");
    tagsWrap.className = "ytx-video-note__tags";
    const tagsTitle = document.createElement("span");
    tagsTitle.className = "ytx-video-note__field-title";
    tagsTitle.textContent = "TAGS";
    const tagsChips = document.createElement("div");
    tagsChips.className = "ytx-video-note__tag-chips";
    const tagsInput = document.createElement("input");
    tagsInput.placeholder = "Buscar o crear tag…";
    tagsInput.setAttribute("aria-label", "Buscar o crear tag de Obsidian");
    tagsInput.setAttribute("autocomplete", "off");
    const tagsCatalog = document.createElement("div");
    tagsCatalog.className = "ytx-video-note__catalog";
    tagsCatalog.hidden = true;
    tagsWrap.append(tagsTitle, tagsChips, tagsInput, tagsCatalog);
    organization.append(organizationHeader, folderField, tagsWrap);
    const syncRow = document.createElement("div");
    syncRow.className = "ytx-video-note__sync";
    const syncStatus = document.createElement("span");
    syncStatus.className = "ytx-video-note__status";
    syncStatus.textContent = "Obsidian: no configurado";
    const syncButton = document.createElement("button");
    syncButton.type = "button";
    syncButton.textContent = "Sincronizar";
    syncRow.append(syncStatus, syncButton);
    const organizationFeedback = document.createElement("div");
    organizationFeedback.className = "ytx-video-note__feedback";
    organizationFeedback.setAttribute("role", "status");
    organizationFeedback.setAttribute("aria-live", "polite");
    videoNote.append(videoNoteHeader, generalLabel);
    organization.appendChild(organizationFeedback);
    notesDrawer.append(notesHeader, notesList);

    const noteEditor = document.createElement("section");
    noteEditor.className = "ytx-note-editor";
    noteEditor.setAttribute("role", "dialog");
    noteEditor.setAttribute("aria-label", "Editor de nota");
    const noteEditorHeading = document.createElement("div");
    noteEditorHeading.className = "ytx-note-editor__heading";
    const noteEditorTime = document.createElement("strong");
    const noteEditorText = document.createElement("span");
    noteEditorText.className = "ytx-note-editor__text";
    noteEditorHeading.append(noteEditorTime, noteEditorText);
    const noteEditorInput = document.createElement("textarea");
    noteEditorInput.className = "ytx-note-editor__input";
    noteEditorInput.placeholder = "Añade una nota opcional…";
    noteEditorInput.setAttribute("aria-label", "Texto de la nota");
    const noteEditorTags = document.createElement("input");
    noteEditorTags.className = "ytx-note-editor__tags";
    noteEditorTags.placeholder = "Tags de esta nota (separados por comas)";
    noteEditorTags.setAttribute("aria-label", "Tags de esta nota");
    noteEditorTags.setAttribute("autocomplete", "off");
    const noteEditorTagsCatalog = document.createElement("div");
    noteEditorTagsCatalog.className = "ytx-video-note__catalog ytx-note-editor__tags-catalog";
    noteEditorTagsCatalog.hidden = true;
    const noteEditorTagsWrap = document.createElement("div");
    noteEditorTagsWrap.className = "ytx-note-editor__tags-wrap";
    noteEditorTagsWrap.append(noteEditorTags, noteEditorTagsCatalog);
    const noteEditorActions = document.createElement("div");
    noteEditorActions.className = "ytx-note-editor__actions";
    const noteEditorCancel = document.createElement("button");
    noteEditorCancel.className = "ytx-button";
    noteEditorCancel.textContent = "Cancelar";
    const noteEditorSave = document.createElement("button");
    noteEditorSave.className = "ytx-button ytx-note-editor__save";
    noteEditorSave.textContent = "Guardar";
    noteEditorActions.append(noteEditorCancel, noteEditorSave);
    noteEditor.append(noteEditorHeading, noteEditorInput, noteEditorTagsWrap, noteEditorActions);

    const headerActions = document.createElement("div");
    headerActions.className = "ytx-panel__actions";
    const transcriptActions = document.createElement("div");
    transcriptActions.className = "ytx-panel__action-group";
    transcriptActions.append(searchToggle, generalToggle, notesToggle, copyButton);
    const windowActions = document.createElement("div");
    windowActions.className = "ytx-panel__action-group";
    windowActions.append(collapseHeaderButton, closeButton);
    title.replaceChildren(trackUi.trackSelector);
    headerActions.append(transcriptActions, windowActions);
    header.append(title, headerActions);
    const notesWorkspace = document.createElement("aside");
    notesWorkspace.className = "ytx-video-notes-window";
    notesWorkspace.setAttribute("role", "dialog");
    notesWorkspace.setAttribute("aria-label", "Notas y favoritos de este vídeo");
    const notesWorkspaceHeader = document.createElement("div");
    notesWorkspaceHeader.className = "ytx-video-notes-window__header";
    const notesWorkspaceTitle = document.createElement("strong");
    notesWorkspaceTitle.textContent = "Notas del vídeo";
    const notesWorkspaceClose = createButton("ytx-video-notes-window__close", "close", "Cerrar todas las notas del vídeo");
    notesWorkspaceHeader.append(notesWorkspaceTitle, notesWorkspaceClose);
    const notesBody = document.createElement("div");
    notesBody.className = "ytx-video-notes-window__body";
    notesBody.append(videoNote, organization, noteEditor, notesDrawer);
    notesWorkspace.replaceChildren(notesWorkspaceHeader, notesBody);
    panel.append(header, searchBar, content);
    const mountRoot = document.fullscreenElement || document.body;
    mountRoot.appendChild(panel);
    (document.querySelector(".html5-video-player") || mountRoot).appendChild(notesWorkspace);

    return {
      panel, notesWorkspace, notesWorkspaceHeader, notesWorkspaceClose, header, title, content, headerActions, ...trackUi,
      searchToggle, searchBar, searchInput, searchCounter, searchPrevious, searchNext, searchClose,
      generalToggle, generalClose, videoNote, videoNoteHeader, organization, organizationHeader, organizationClose, organizationFeedback,
      notesToggle, notesDrawer, notesHeader, notesClose, notesList, generalNote, folder, folderSelection, folderCatalog, tagsInput, tagsChips, tagsCatalog, syncStatus, syncButton,
      noteEditor, noteEditorTime, noteEditorText, noteEditorInput, noteEditorTags, noteEditorTagsCatalog, noteEditorCancel, noteEditorSave,
      collapseHeaderButton, copyButton, closeButton, cleanups: [],
    };
  }

  ytx.panelView = { create, setButtonIcon, labelButton };
})();
