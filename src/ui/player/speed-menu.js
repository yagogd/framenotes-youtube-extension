(() => {
  "use strict";
  const ytx = globalThis.__YTX;
  const DEFAULT_PRESETS = [0.5, 1, 1.5, 2, 2.5, 3, 4, 8];

  function normalize(values) {
    const unique = [...new Set((Array.isArray(values) ? values : []).map(Number)
      .filter((value) => Number.isFinite(value) && value >= 0.1 && value <= 16)
      .map((value) => Number(value.toFixed(2))))].sort((a, b) => a - b);
    return unique.length >= 4 ? unique : DEFAULT_PRESETS;
  }

  ytx.createPlayerSpeedMenu = ({ player, button }) => {
    const element = document.createElement("div");
    element.className = "ytx-player-speed-menu";
    element.hidden = true;
    const heading = document.createElement("strong");
    heading.className = "ytx-player-speed-menu__heading";
    heading.textContent = "Velocidad de reproducción";
    const value = document.createElement("input");
    value.className = "ytx-player-speed-menu__value";
    value.type = "number";
    value.min = "0.1";
    value.max = "16";
    value.step = "0.25";
    value.value = "1";
    value.setAttribute("aria-label", "Velocidad del vídeo");
    const sliderRow = document.createElement("div");
    sliderRow.className = "ytx-player-speed-menu__slider-row";
    const down = document.createElement("button");
    down.type = "button";
    down.textContent = "−";
    down.setAttribute("aria-label", "Reducir velocidad en 0,25");
    const slider = document.createElement("input");
    slider.className = "ytx-player-speed-menu__range";
    slider.type = "range";
    slider.min = "0.1";
    slider.max = "16";
    slider.step = "0.1";
    slider.value = "1";
    slider.setAttribute("aria-label", "Deslizador de velocidad");
    const up = document.createElement("button");
    up.type = "button";
    up.textContent = "+";
    up.setAttribute("aria-label", "Aumentar velocidad en 0,25");
    sliderRow.append(down, slider, up);
    const error = document.createElement("span");
    error.className = "ytx-player-speed-error";
    error.hidden = true;
    const presetContainer = document.createElement("div");
    presetContainer.className = "ytx-player-speed-menu__presets";
    const presets = [];

    function setRate(rate) {
      const requested = Number(rate);
      if (requested > 16) {
        error.textContent = "Máximo 16×";
        error.hidden = false;
        return;
      }
      const normalized = Math.max(0.1, Math.round(requested * 100) / 100);
      if (!Number.isFinite(normalized)) return;
      error.hidden = true;
      window.postMessage({ source: "YT_SPEED_CONTROL", rate: normalized }, "*");
      update(normalized);
    }

    function update(rate) {
      const normalized = Number(rate) || 1;
      value.value = String(normalized);
      slider.value = String(normalized);
      presets.forEach((preset) => preset.classList.toggle("ytx-speed-preset--active", Number(preset.dataset.rate) === normalized));
    }

    function renderPresets(values) {
      const rates = normalize(values);
      presetContainer.replaceChildren();
      presets.splice(0);
      presetContainer.style.gridTemplateColumns = `repeat(${rates.length <= 4 ? rates.length : 4}, 1fr)`;
      rates.forEach((rate) => {
        const preset = document.createElement("button");
        preset.type = "button";
        preset.textContent = String(rate).replace(".", ",");
        preset.dataset.rate = String(rate);
        preset.addEventListener("click", () => setRate(rate));
        presetContainer.appendChild(preset);
        presets.push(preset);
      });
      update(value.value);
    }

    function close() {
      element.hidden = true;
      button.setAttribute("aria-expanded", "false");
      player.classList.remove("ytx-speed-menu-open");
    }

    function raiseAboveNotesOverlays() {
      const host = element.parentElement;
      if (!host) return;
      let highest = 76;
      host.querySelectorAll(".ytx-video-notes-window, .ytx-player-note-editor, .ytp-settings-menu, [class*='ytp-note']").forEach((candidate) => {
        const z = Number(getComputedStyle(candidate).zIndex);
        if (Number.isFinite(z)) highest = Math.max(highest, z);
      });
      element.style.zIndex = String(highest + 1);
    }

    function toggle() {
      const opening = element.hidden;
      element.hidden = !opening;
      button.setAttribute("aria-expanded", String(!element.hidden));
      player.classList.toggle("ytx-speed-menu-open", opening);
      if (opening) {
        raiseAboveNotesOverlays();
        chrome.storage.local.get({ speedPresets: DEFAULT_PRESETS }, (stored) => renderPresets(stored.speedPresets));
      }
    }

    const onDocumentClick = (event) => {
      if (!element.hidden && !element.contains(event.target) && !button.contains(event.target)) close();
    };
    const blockShortcuts = (event) => {
      if (event.target !== value) return;
      event.stopImmediatePropagation();
      if (event.type !== "keydown") return;
      if (event.key === "Enter") {
        event.preventDefault();
        setRate(value.value);
        value.blur();
      } else if (event.key === "Escape") {
        event.preventDefault();
        close();
        button.focus();
      }
    };

    element.append(heading, value, sliderRow, presetContainer, error);
    player.appendChild(element);
    renderPresets(DEFAULT_PRESETS);
    button.addEventListener("click", toggle);
    down.addEventListener("click", () => setRate(Number(value.value) - 0.25));
    up.addEventListener("click", () => setRate(Number(value.value) + 0.25));
    slider.addEventListener("input", () => setRate(slider.value));
    document.addEventListener("click", onDocumentClick, true);
    ["keydown", "keyup", "keypress"].forEach((type) => window.addEventListener(type, blockShortcuts, true));
    const onLeave = () => close();
    const onVisibilityChange = () => { if (document.hidden) close(); };
    window.addEventListener("yt-navigate-finish", onLeave);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("blur", onLeave);
    window.addEventListener("pagehide", onLeave);
    chrome.storage.local.get({ lastSpeed: 1, rememberPlaybackSpeed: true, speedPresets: DEFAULT_PRESETS }, (stored) => {
      renderPresets(stored.speedPresets);
      setRate(stored.rememberPlaybackSpeed === false ? 1 : (stored.lastSpeed || 1));
    });

    return {
      element, update, renderPresets, setRate,
      destroy() {
        document.removeEventListener("click", onDocumentClick, true);
        ["keydown", "keyup", "keypress"].forEach((type) => window.removeEventListener(type, blockShortcuts, true));
        window.removeEventListener("yt-navigate-finish", onLeave);
        document.removeEventListener("visibilitychange", onVisibilityChange);
        window.removeEventListener("blur", onLeave);
        window.removeEventListener("pagehide", onLeave);
        player.classList.remove("ytx-speed-menu-open");
        element.remove();
      },
    };
  };
})();
