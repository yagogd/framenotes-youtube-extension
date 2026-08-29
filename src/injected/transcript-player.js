(() => {
  if (window.YTXTranscriptPlayer) return;

  function videoIdFromLocation() {
    return new URL(location.href).searchParams.get("v");
  }

  function playerResponse() {
    return document.getElementById("movie_player")?.getPlayerResponse?.() || window.ytInitialPlayerResponse;
  }

  function captionData() {
    return playerResponse()?.captions?.playerCaptionsTracklistRenderer || {};
  }

  function responseVideoId() {
    return playerResponse()?.videoDetails?.videoId || null;
  }

  function captionTracks() {
    return captionData().captionTracks || [];
  }

  function translationLanguages() {
    return captionData().translationLanguages || [];
  }

  function trackName(track) {
    return track.name?.simpleText || track.name?.runs?.map((run) => run.text).join("") ||
      track.languageName?.simpleText || track.languageName?.runs?.map((run) => run.text).join("") ||
      track.languageCode || "Desconocido";
  }

  function collectTracks(currentVideoId) {
    const originalTracks = captionTracks().map((track, index) => ({
      id: `${track.languageCode || "unknown"}:${track.kind || "manual"}:${index}`,
      languageCode: track.languageCode || "unknown",
      languageName: trackName(track),
      isAutomatic: track.kind === "asr",
      isTranslatable: track.isTranslatable !== false,
      baseUrl: track.baseUrl,
    })).filter((track) => {
      if (!track.baseUrl) return false;
      const trackVideoId = new URL(track.baseUrl).searchParams.get("v");
      return !trackVideoId || !currentVideoId || trackVideoId === currentVideoId;
    });
    const translatableTracks = originalTracks.filter((track) => track.isTranslatable);
    const translationSource = translatableTracks.find((track) => !track.isAutomatic) || translatableTracks[0];
    const originalLanguages = new Set(originalTracks.map((track) => track.languageCode.toLocaleLowerCase()));
    const translatedTracks = translationSource ? translationLanguages()
      .filter((language) => language.languageCode && !originalLanguages.has(language.languageCode.toLocaleLowerCase()))
      .map((language) => {
        const url = new URL(translationSource.baseUrl);
        url.searchParams.set("tlang", language.languageCode);
        return {
          id: `translated:${language.languageCode}`,
          languageCode: language.languageCode,
          languageName: trackName(language),
          isAutomatic: true,
          isTranslated: true,
          sourceLanguageCode: translationSource.languageCode,
          sourceIsAutomatic: Boolean(translationSource.isAutomatic),
          baseUrl: url.href,
        };
      }) : [];
    return [...originalTracks, ...translatedTracks];
  }

  function preferredTrack(tracks, preferredLanguage) {
    if (!tracks.length) return null;
    if (!preferredLanguage || preferredLanguage === "auto") return tracks[0];
    const language = preferredLanguage.toLocaleLowerCase();
    const matches = tracks.filter((track) => {
      const code = track.languageCode.toLocaleLowerCase();
      return code === language || code.startsWith(`${language}-`);
    });
    return matches.find((track) => !track.isAutomatic) || matches[0] || tracks[0];
  }

  function captionUrlMatchesTrack(url, track) {
    const parsed = new URL(url);
    const translated = parsed.searchParams.get("tlang");
    const language = parsed.searchParams.get("lang") || "";
    if (track.isTranslated) {
      const source = track.sourceLanguageCode || "";
      const sourceIsAutomatic = parsed.searchParams.get("kind") === "asr";
      return translated === track.languageCode && sourceIsAutomatic === Boolean(track.sourceIsAutomatic) &&
        (!source || language === source || language.startsWith(`${source}-`));
    }
    const automatic = parsed.searchParams.get("kind") === "asr";
    return !translated && automatic === Boolean(track.isAutomatic) &&
      (language === track.languageCode || language.startsWith(`${track.languageCode}-`) ||
      track.languageCode.startsWith(`${language}-`));
  }

  function trackInformation(url) {
    const parsedUrl = new URL(url);
    const translatedLanguage = parsedUrl.searchParams.get("tlang");
    const languageCode = translatedLanguage || parsedUrl.searchParams.get("lang") || "desconocido";
    let languageName = languageCode;
    let isAutomatic = translatedLanguage ? true : parsedUrl.searchParams.get("kind") === "asr";
    const isTranslated = Boolean(translatedLanguage);

    if (translatedLanguage) {
      const language = translationLanguages().find((candidate) => candidate.languageCode === translatedLanguage);
      if (language) languageName = trackName(language);
      return { languageCode, languageName, isAutomatic, isTranslated };
    }

    const urlKind = parsedUrl.searchParams.get("kind") || "manual";
    const track = captionTracks().find((candidate) =>
      candidate.languageCode === languageCode && (candidate.kind || "manual") === urlKind
    ) || captionTracks().find((candidate) => candidate.languageCode === languageCode);
    if (track) {
      languageName = trackName(track);
      isAutomatic = track.kind === "asr";
    }
    return { languageCode, languageName, isAutomatic, isTranslated };
  }

  function waitForTracks({ currentVideoId, generation, timeoutMs = 10000, isCurrent, schedule, cancelScheduled }) {
    const deadline = Date.now() + timeoutMs;
    const player = document.getElementById("movie_player");
    return new Promise((resolve) => {
      let settled = false;
      let pollTimer = null;

      const cleanup = () => {
        player?.removeEventListener?.("onApiChange", tryResolve);
        player?.removeEventListener?.("onReady", tryResolve);
        document.removeEventListener("yt-player-updated", tryResolve);
        window.removeEventListener("ytx-transcript-ready-internal", tryResolve);
        if (pollTimer) cancelScheduled(pollTimer);
      };
      const finish = (tracks) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(tracks);
      };
      const tryResolve = () => {
        if (settled) return;
        if (!isCurrent(generation)) {
          finish([]);
          return;
        }
        const tracks = captionTracks();
        const videoId = responseVideoId();
        if ((!videoId || videoId === currentVideoId) && tracks.length) finish(collectTracks(currentVideoId));
      };
      const poll = () => {
        if (settled) return;
        tryResolve();
        if (!settled) {
          if (Date.now() >= deadline) finish([]);
          else pollTimer = schedule(poll, 250);
        }
      };

      player?.addEventListener?.("onApiChange", tryResolve);
      player?.addEventListener?.("onReady", tryResolve);
      document.addEventListener("yt-player-updated", tryResolve);
      window.addEventListener("ytx-transcript-ready-internal", tryResolve);
      tryResolve();
      if (!settled) pollTimer = schedule(poll, 250);
    });
  }

  function createCaptionProbe({ schedule, cancelScheduled, isCurrent }) {
    let active = null;
    let ignoreRequestsUntil = 0;

    function finish(success = false) {
      const probe = active;
      if (!probe) return;
      active = null;
      cancelScheduled(probe.timeout);
      const player = document.getElementById("movie_player");
      const button = document.querySelector(".ytp-subtitles-button");
      ignoreRequestsUntil = Date.now() + 2500;
      if (probe.previousTrack) {
        try { player?.setOption?.("captions", "track", probe.previousTrack); } catch (_) { /* Restauración opcional. */ }
      }
      const restore = (attempt = 0) => {
        const pressed = button?.getAttribute("aria-pressed") === "true";
        if (button && pressed !== probe.wasEnabled) button.click();
        const restored = !button || (button.getAttribute("aria-pressed") === "true") === probe.wasEnabled;
        if (!restored && attempt < 20) {
          schedule(() => restore(attempt + 1), 100);
          return;
        }
        requestAnimationFrame(() => requestAnimationFrame(() => {
          player?.classList.remove("ytx-caption-probe-active");
        }));
      };
      restore();
      probe.resolve(success);
    }

    function request(track, generation) {
      if (!isCurrent(generation) || active) return Promise.resolve(false);
      const player = document.getElementById("movie_player");
      const button = document.querySelector(".ytp-subtitles-button");
      if (!player || !button) return Promise.resolve(false);
      return new Promise((resolve) => {
        const wasEnabled = button.getAttribute("aria-pressed") === "true";
        const previousTrack = player.getOption?.("captions", "track") || null;
        const sourceCode = track.sourceLanguageCode || track.languageCode;
        const sourceTrack = captionTracks().find((candidate) => candidate.languageCode === sourceCode &&
          (candidate.kind === "asr") === Boolean(track.isTranslated ? track.sourceIsAutomatic : track.isAutomatic)) ||
          captionTracks().find((candidate) => candidate.languageCode === sourceCode);
        const requestedTrack = sourceTrack ? { ...sourceTrack } : { languageCode: sourceCode };
        if (track.isTranslated) {
          requestedTrack.translationLanguage = translationLanguages()
            .find((language) => language.languageCode === track.languageCode) || { languageCode: track.languageCode };
        }
        player.classList.add("ytx-caption-probe-active");
        const timeout = schedule(() => finish(false), 8000);
        active = { generation, wasEnabled, resolve, timeout, previousTrack, track };
        try {
          player.loadModule?.("captions");
          player.setOption?.("captions", "track", requestedTrack);
        } catch (_) { /* El clic inferior conserva el mecanismo de respaldo. */ }
        schedule(() => {
          if (active?.generation !== generation) return;
          if (button.getAttribute("aria-pressed") !== "true") button.click();
        }, 120);
      });
    }

    return {
      request,
      finish,
      cancel: () => finish(false),
      shouldIgnorePlayerRequests: () => !active && Date.now() < ignoreRequestsUntil,
      get active() { return active; },
    };
  }

  window.YTXTranscriptPlayer = {
    videoIdFromLocation,
    responseVideoId,
    captionTracks,
    collectTracks,
    preferredTrack,
    captionUrlMatchesTrack,
    trackInformation,
    waitForTracks,
    createCaptionProbe,
  };
})();
