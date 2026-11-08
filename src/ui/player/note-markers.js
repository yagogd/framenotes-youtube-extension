(() => {
  "use strict";
  const ytx = globalThis.__YTX;

  ytx.createNoteMarkers = ({ getUi, openSavedNote, updateNotesButton }) => {
    let previewHideTimer = null;
    let mounted = null;

    function getPreview(player) {
      let preview = player.querySelector(":scope > .ytx-progress-marker-preview");
      if (preview) return preview;
      preview = document.createElement("div");
      preview.className = "ytx-progress-marker-preview";
      preview.id = `ytx-marker-preview-${Math.random().toString(36).slice(2)}`;
      preview.setAttribute("role", "button");
      preview.setAttribute("tabindex", "0");
      preview.setAttribute("aria-label", "Abrir esta nota");
      preview.hidden = true;
      preview.addEventListener("pointerenter", () => clearTimeout(previewHideTimer));
      preview.addEventListener("pointerleave", () => scheduleHide(preview));
      preview.addEventListener("click", () => openSavedNote(preview.dataset.noteId));
      preview.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openSavedNote(preview.dataset.noteId);
        }
      });
      player.appendChild(preview);
      return preview;
    }

    function scheduleHide(preview) {
      clearTimeout(previewHideTimer);
      previewHideTimer = setTimeout(() => { preview.hidden = true; }, 700);
    }

    function showPreview(marker, item, time, player, preview) {
      const type = item.type === "favorite" ? "Favorito" : "Nota";
      const content = item.type === "favorite"
        ? (item.text || item.note || "Momento guardado como favorito")
        : (item.note || item.text || "Nota sin texto");
      const heading = document.createElement("div");
      heading.className = "ytx-progress-marker-preview__heading";
      heading.textContent = `${type} · ${time}`;
      const body = document.createElement("div");
      body.className = "ytx-progress-marker-preview__body";
      body.textContent = content;
      preview.replaceChildren(heading, body);
      preview.dataset.noteId = item.id;
      preview.classList.toggle("ytx-progress-marker-preview--favorite", item.type === "favorite");
      preview.hidden = false;
      const playerRect = player.getBoundingClientRect();
      const markerRect = marker.getBoundingClientRect();
      const center = markerRect.left - playerRect.left + markerRect.width / 2;
      preview.style.left = `${Math.max(8, Math.min(playerRect.width - preview.offsetWidth - 8, center - preview.offsetWidth / 2))}px`;
      preview.style.bottom = `${Math.max(48, playerRect.bottom - markerRect.top + 9)}px`;
    }

    function handlePointerMove(event) {
      const player = getUi()?.player;
      const progressBar = player?.querySelector(".ytp-progress-bar");
      const progressList = player?.querySelector(".ytp-progress-list");
      const preview = player?.querySelector(":scope > .ytx-progress-marker-preview");
      if (!player || !progressBar || !progressList || !preview) return;
      const progressRect = progressList.getBoundingClientRect();
      const previewRect = preview.hidden ? null : preview.getBoundingClientRect();
      const insidePath = previewRect && event.clientX >= previewRect.left - 12 && event.clientX <= previewRect.right + 12 &&
        event.clientY >= previewRect.top - 8 && event.clientY <= progressRect.top + progressRect.height / 2 + 18;
      if (preview.contains(event.target) || insidePath) {
        clearTimeout(previewHideTimer);
        return;
      }
      if (Math.abs(event.clientY - (progressRect.top + progressRect.height / 2)) > 16) {
        preview.hidden = true;
        return;
      }
      let closest = null;
      let closestDistance = Infinity;
      progressBar.querySelectorAll(".ytx-progress-marker").forEach((marker) => {
        const rect = marker.getBoundingClientRect();
        const distance = event.clientX < rect.left ? rect.left - event.clientX : event.clientX > rect.right ? event.clientX - rect.right : 0;
        if (distance < closestDistance) { closest = marker; closestDistance = distance; }
      });
      if (!closest || closestDistance > 10 || !closest._ytxSavedItem) {
        preview.hidden = true;
        return;
      }
      clearTimeout(previewHideTimer);
      const item = closest._ytxSavedItem;
      showPreview(closest, item, ytx.formatTime(item.startMs), player, preview);
    }

    function refresh() {
      const player = document.querySelector(".html5-video-player");
      const progressBar = player?.querySelector(".ytp-progress-bar");
      const video = document.querySelector("video");
      if (!player || !progressBar || !video || !Number.isFinite(video.duration) || video.duration <= 0) return;
      const preview = getPreview(player);
      preview.hidden = true;
      let layer = progressBar.querySelector(":scope > .ytx-progress-markers");
      if (!layer) {
        layer = document.createElement("div");
        layer.className = "ytx-progress-markers";
        progressBar.appendChild(layer);
      }
      const barLine = progressBar.querySelector(".ytp-progress-list") || progressBar;
      layer.style.setProperty("--ytx-marker-bar-height", `${Math.max(2, Math.round(barLine.getBoundingClientRect().height))}px`);
      layer.replaceChildren();
      (ytx.state.savedNotes || []).forEach((item) => {
        const startSeconds = Math.max(0, Number(item.startMs) / 1000 || 0);
        const endSeconds = Math.max(startSeconds, Number(item.endMs) / 1000 || startSeconds);
        const marker = document.createElement("button");
        marker.type = "button";
        marker._ytxSavedItem = item;
        marker.className = `ytx-progress-marker ytx-progress-marker--${item.type === "favorite" ? "favorite" : "note"}`;
        marker.style.left = `${Math.min(100, startSeconds / video.duration * 100)}%`;
        const durationPercent = Math.max(0, (endSeconds - startSeconds) / video.duration * 100);
        if (durationPercent > 0) {
          marker.classList.add("ytx-progress-marker--range");
          const available = Math.max(0, 100 - startSeconds / video.duration * 100);
          marker.style.setProperty("width", `max(8px,${Math.min(available, durationPercent)}%)`, "important");
        }
        const time = ytx.formatTime(item.startMs);
        marker.setAttribute("aria-label", `Ir a la nota del minuto ${time}`);
        marker.setAttribute("aria-describedby", preview.id);
        const show = () => showPreview(marker, item, time, player, preview);
        marker.addEventListener("pointerenter", show);
        marker.addEventListener("focus", show);
        marker.addEventListener("blur", () => { preview.hidden = true; });
        marker.addEventListener("keydown", (event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          event.stopPropagation();
          openSavedNote(item.id);
        });
        marker.addEventListener("click", (event) => {
          event.stopPropagation();
          preview.hidden = true;
          video.currentTime = startSeconds;
        });
        layer.appendChild(marker);
      });
      updateNotesButton();
    }

    function mount(player, video) {
      destroy();
      const onDurationChange = refresh;
      const onPointerMove = handlePointerMove;
      const onClick = (event) => {
        const preview = player.querySelector(":scope > .ytx-progress-marker-preview");
        if (!preview || preview.hidden) return;
        const rect = preview.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        openSavedNote(preview.dataset.noteId);
      };
      const onKeyDown = (event) => {
        const preview = player.querySelector(":scope > .ytx-progress-marker-preview");
        if (!preview || preview.hidden || (event.key !== "Enter" && event.key !== " ")) return;
        if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "")) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        openSavedNote(preview.dataset.noteId);
      };
      video?.addEventListener("durationchange", onDurationChange);
      document.addEventListener("pointermove", onPointerMove, true);
      document.addEventListener("click", onClick, true);
      document.addEventListener("keydown", onKeyDown, true);
      mounted = { video, onDurationChange, onPointerMove, onClick, onKeyDown };
      refresh();
    }

    function destroy() {
      clearTimeout(previewHideTimer);
      if (mounted) {
        mounted.video?.removeEventListener("durationchange", mounted.onDurationChange);
        document.removeEventListener("pointermove", mounted.onPointerMove, true);
        document.removeEventListener("click", mounted.onClick, true);
        document.removeEventListener("keydown", mounted.onKeyDown, true);
      }
      mounted = null;
      document.querySelectorAll(".ytx-progress-markers,.ytx-progress-marker-preview").forEach((element) => element.remove());
    }

    return { mount, refresh, destroy, hidePreview: () => {
      clearTimeout(previewHideTimer);
      const preview = getUi()?.player?.querySelector(":scope > .ytx-progress-marker-preview");
      if (preview) preview.hidden = true;
    } };
  };
})();
