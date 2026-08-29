(() => {
  if (window.__ytTranscriptNetworkObserverLoaded) return;
  window.__ytTranscriptNetworkObserverLoaded = true;

  const processedUrls = new Set();
  const transcriptCache = new Map();
  let currentVideoId = null;
  let requestGeneration = 0;
  let activeFetchController = null;
  let lastFailureKind = null;
  let rateLimitedUntil = 0;
  let transcriptCompleted = false;
  let enabled = false;
  let preferredLanguage = "auto";
  let lastReadyPayload = null;
  let availableTracks = [];
  const pendingTimers = new Set();
  let observerActive = false;
  let observerStarted = false;
  const silentObservedUrls = new Set();
  let requestInFlight = false;
  const pendingObservedFallbacks = new Set();
  const CAPTURE_EVENT = "ytx-timedtext-captured";
  let activeRequestedTrack = null;
  const playerApi = window.YTXTranscriptPlayer;
  const sourceApi = window.YTXTranscriptSources;
  if (!playerApi || !sourceApi) throw new Error("Los módulos de transcripción no están disponibles");
  const timedTextStore = sourceApi.createTimedTextStore(8);

  function schedule(callback, delay) {
    const timer = setTimeout(() => {
      pendingTimers.delete(timer);
      callback();
    }, delay);
    pendingTimers.add(timer);
    return timer;
  }

  function cancelScheduled(timer) {
    clearTimeout(timer);
    pendingTimers.delete(timer);
  }

  const captionProbe = playerApi.createCaptionProbe({
    schedule,
    cancelScheduled,
    isCurrent: (generation) => enabled && generation === requestGeneration,
  });

  function post(payload) {
    window.postMessage({ source: "YT_TRANSCRIPT_EXTENSION", ...payload }, "*");
  }

  function collectTracks() {
    availableTracks = playerApi.collectTracks(currentVideoId);
    post({
      type: "YT_TRANSCRIPT_TRACKS",
      videoId: currentVideoId,
      tracks: availableTracks.map(({ baseUrl, ...track }) => track),
    });
    return availableTracks;
  }

  function preferredTrack(tracks) {
    return playerApi.preferredTrack(tracks, preferredLanguage);
  }

  const captionUrlMatchesTrack = playerApi.captionUrlMatchesTrack;
  const json3Url = sourceApi.json3Url;
  const timedTextVideoId = sourceApi.timedTextVideoId;
  const videoIdFromLocation = playerApi.videoIdFromLocation;
  const getTrackInformation = playerApi.trackInformation;

  function finishCaptionProbe(success = false) {
    captionProbe.finish(success);
  }

  function requestSignedCaptionUrl(track, generation) {
    return captionProbe.request(track, generation);
  }

  function cacheKey(videoId, trackId) {
    return videoId && trackId ? `${videoId}:${trackId}` : null;
  }

  function restoreCachedTranscript(trackId) {
    const key = cacheKey(currentVideoId, trackId);
    const cached = key ? transcriptCache.get(key) : null;
    if (!cached) return false;
    transcriptCompleted = true;
    lastReadyPayload = { ...cached, tracks: availableTracks.map(({ baseUrl, ...track }) => track) };
    post(lastReadyPayload);
    return true;
  }

  function completeTimedTextBody(url, text, options = {}) {
    const {
      selectedTrackId = null,
      generation = requestGeneration,
      videoIdAtDetection = currentVideoId,
      abortActiveFetch = false,
    } = options;
    if (!text.trim()) {
      lastFailureKind = "empty";
      throw new Error("YouTube devolvió una respuesta vacía para esta pista");
    }
    if (!window.YTXTranscriptParser) throw new Error("El parser de transcripción no está disponible");
    const parser = window.YTXTranscriptParser;
    const { cues, blocks } = parser.parseTimedText
      ? parser.parseTimedText(text)
      : parser.parseJson3(JSON.parse(text));
    if (!cues.length) throw new Error("La transcripción extraída está vacía");
    if (videoIdAtDetection !== currentVideoId || generation !== requestGeneration) return false;

    if (abortActiveFetch) {
      activeFetchController?.abort();
      activeFetchController = null;
    }
    transcriptCompleted = true;
    if (!availableTracks.length) collectTracks();
    const trackInformation = getTrackInformation(url);
    lastReadyPayload = {
      type: "YT_TRANSCRIPT_READY",
      videoId: currentVideoId,
      cues,
      blocks,
      ...trackInformation,
      selectedTrackId: selectedTrackId || availableTracks.find((track) =>
        track.languageCode === trackInformation.languageCode && track.isAutomatic === trackInformation.isAutomatic
      )?.id || null,
      tracks: availableTracks.map(({ baseUrl, ...track }) => track),
    };
    const key = cacheKey(currentVideoId, lastReadyPayload.selectedTrackId);
    if (key) transcriptCache.set(key, lastReadyPayload);
    post(lastReadyPayload);
    window.dispatchEvent(new Event("ytx-transcript-ready-internal"));
    return true;
  }

  async function processTimedTextUrl(url, options = {}) {
    const { force = false, selectedTrackId = null, generation = requestGeneration, silentFailure = false, ignoreRateLimit = false } = options;
    if (!enabled || (!force && processedUrls.has(url)) || (!force && transcriptCompleted)) return false;
    if (!force && activeFetchController) return false;
    if (generation !== requestGeneration) return false;

    if (!ignoreRateLimit && Date.now() < rateLimitedUntil) {
      if (!silentFailure) post({
        type: "YT_TRANSCRIPT_ERROR",
        message: "YouTube ha limitado temporalmente las peticiones de subtítulos. Espera unos segundos antes de cambiar de idioma.",
      });
      return false;
    }

    const requestedVideoId = new URL(url).searchParams.get("v");
    if (requestedVideoId && currentVideoId && requestedVideoId !== currentVideoId) return false;

    processedUrls.add(url);
    if (silentFailure) silentObservedUrls.add(url);
    lastFailureKind = null;
    const videoIdAtDetection = currentVideoId;
    let controller = null;
    try {
      if (force) activeFetchController?.abort();
      controller = new AbortController();
      activeFetchController = controller;
      const response = await fetch(url, { credentials: "include", signal: controller.signal });
      const text = await response.text();
      if (response.status === 429) {
        const retryAfter = Number(response.headers.get("retry-after"));
        rateLimitedUntil = Date.now() + (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 30000);
        lastFailureKind = "rate-limit";
        throw new Error("HTTP 429: YouTube ha limitado temporalmente las peticiones de subtítulos");
      }
      if (!response.ok) {
        lastFailureKind = "http";
        throw new Error(`HTTP ${response.status}`);
      }
      return completeTimedTextBody(url, text, { selectedTrackId, generation, videoIdAtDetection });
    } catch (error) {
      if (error?.name === "AbortError" || generation !== requestGeneration) return false;
      if (!silentFailure) console.error("[Transcript] Error:", error);
      if (!silentFailure && videoIdAtDetection === currentVideoId) {
        post({ type: "YT_TRANSCRIPT_ERROR", message: String(error.message || error) });
      }
      return false;
    } finally {
      if (activeFetchController === controller) activeFetchController = null;
    }
  }

  function capturedBodyMatchesPreference(entry) {
    if (!entry || timedTextVideoId(entry.url) !== currentVideoId) return false;
    const selected = preferredTrack(availableTracks);
    return Boolean(selected && captionUrlMatchesTrack(entry.url, selected));
  }

  function rememberCapturedTimedText(entry) {
    return timedTextStore.rememberBody(entry);
  }

  function processCapturedTimedText(entry, options = {}) {
    const generation = options.generation ?? requestGeneration;
    if (!entry || entry.invalid || !enabled || generation !== requestGeneration) return false;
    if (timedTextVideoId(entry.url) !== currentVideoId) return false;
    if (entry.status === 429) {
      const retryAfter = Number(entry.retryAfter);
      rateLimitedUntil = Date.now() + (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 30000);
      lastFailureKind = "rate-limit";
      const shouldNotify = !transcriptCompleted && (requestInFlight || activeRequestedTrack || captionProbe.active);
      if (shouldNotify && !entry.rateLimitNotified) {
        entry.rateLimitNotified = true;
        post({
          type: "YT_TRANSCRIPT_ERROR",
          message: "YouTube ha limitado temporalmente las peticiones de subtítulos. Espera unos segundos antes de cambiar de idioma.",
        });
      }
      return false;
    }
    if (transcriptCompleted) return false;
    if (entry.status && (entry.status < 200 || entry.status >= 300)) return false;
    try {
      lastFailureKind = null;
      return completeTimedTextBody(entry.url, entry.body, {
        selectedTrackId: options.selectedTrackId || null,
        generation,
        videoIdAtDetection: currentVideoId,
        abortActiveFetch: true,
      });
    } catch (_) {
      entry.invalid = true;
      return false;
    }
  }

  function findCapturedTimedText(track = null) {
    return timedTextStore.findBody(currentVideoId, (entry) =>
      track ? captionUrlMatchesTrack(entry.url, track) : capturedBodyMatchesPreference(entry)
    );
  }

  function tryCapturedTimedText(generation, track = null) {
    const captured = findCapturedTimedText(track);
    return captured ? processCapturedTimedText(captured, { generation, selectedTrackId: track?.id }) : false;
  }

  function matchingObservedTimedTextUrl() {
    return timedTextStore.findObserved(currentVideoId, (url) => capturedBodyMatchesPreference({ url }));
  }

  function pruneTimedTextData(videoId) {
    timedTextStore.prune(videoId);
  }

  function handleCapturedTimedText(entry) {
    if (silentObservedUrls.has(entry?.url)) return;
    rememberCapturedTimedText(entry);
    if (!enabled || transcriptCompleted) return;
    if (timedTextVideoId(entry.url) !== currentVideoId) return;
    const probe = captionProbe.active;
    const requestedTrack = probe?.track || activeRequestedTrack;
    if (requestedTrack) {
      if (captionUrlMatchesTrack(entry.url, requestedTrack)) {
        const loaded = processCapturedTimedText(timedTextStore.getBody(entry.url), {
          generation: probe?.generation ?? requestGeneration,
          selectedTrackId: requestedTrack.id,
        });
        if (probe && loaded && captionProbe.active === probe) finishCaptionProbe(true);
      }
      return;
    }
    if (capturedBodyMatchesPreference(entry)) processCapturedTimedText(timedTextStore.getBody(entry.url));
  }

  window.addEventListener(CAPTURE_EVENT, (event) => handleCapturedTimedText(event.detail));
  (Array.isArray(window.__ytxTimedTextCaptureBuffer) ? window.__ytxTimedTextCaptureBuffer : [])
    .forEach((entry) => rememberCapturedTimedText(entry));

  function recordPlayerTimedTextUrl(url) {
    timedTextStore.recordUrl(url, currentVideoId);
  }

  function matchingPlayerTimedTextUrl(track) {
    if (!currentVideoId || !track) return null;
    return timedTextStore.findObserved(currentVideoId, (url) => captionUrlMatchesTrack(url, track));
  }

  function processObservedTimedText(name, probe = null) {
    const captured = timedTextStore.getBody(name);
    if (captured) {
      const loaded = processCapturedTimedText(captured, probe ? {
        generation: probe.generation,
        selectedTrackId: probe.track.id,
      } : {});
      if (loaded) {
        if (probe && captionProbe.active === probe) finishCaptionProbe(true);
        return;
      }
      if (captured.status === 429) {
        if (probe && captionProbe.active === probe) finishCaptionProbe(false);
        return;
      }
    }
    processTimedTextUrl(name, probe ? {
      force: true,
      selectedTrackId: probe.track.id,
      generation: probe.generation,
      ignoreRateLimit: true,
    } : {}).then((loaded) => {
      if (probe && captionProbe.active === probe) finishCaptionProbe(loaded);
    });
  }

  function handleTimedTextResource(name) {
    if (silentObservedUrls.has(name)) {
      silentObservedUrls.delete(name);
      return;
    }
    recordPlayerTimedTextUrl(name);
    if (captionProbe.shouldIgnorePlayerRequests()) return;
    const probe = captionProbe.active;
    const requestedTrack = probe?.track || activeRequestedTrack;
    if (requestedTrack && !captionUrlMatchesTrack(name, requestedTrack)) return;
    if (!requestedTrack && !capturedBodyMatchesPreference({ url: name })) return;
    if (timedTextStore.hasBody(name) || !window.__ytxTimedTextCaptureInstalled) {
      processObservedTimedText(name, probe);
      return;
    }
    if (pendingObservedFallbacks.has(name)) return;
    pendingObservedFallbacks.add(name);
    schedule(() => {
      pendingObservedFallbacks.delete(name);
      if (!enabled || transcriptCompleted) return;
      processObservedTimedText(name, probe && captionProbe.active === probe ? probe : null);
    }, 100);
  }

  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (!entry.name.includes("/api/timedtext")) continue;
      handleTimedTextResource(entry.name);
    }
  });

  function scanBufferedTimedText() {
    const entries = performance.getEntriesByType?.("resource") || [];
    for (const entry of entries) {
      if (entry.name && entry.name.includes("/api/timedtext")) handleTimedTextResource(entry.name);
    }
  }

  function startObserver() {
    if (observerActive) return;
    observer.observe(observerStarted ? { type: "resource" } : { type: "resource", buffered: true });
    observerActive = true;
    observerStarted = true;
    scanBufferedTimedText();
  }

  function stopBackgroundWork() {
    requestGeneration += 1;
    requestInFlight = false;
    activeRequestedTrack = null;
    activeFetchController?.abort();
    activeFetchController = null;
    captionProbe.cancel();
    pendingTimers.forEach((timer) => clearTimeout(timer));
    pendingTimers.clear();
    silentObservedUrls.clear();
    pendingObservedFallbacks.clear();
    observer.disconnect();
    observerActive = false;
  }

  async function waitForCurrentVideoTracks(generation, timeoutMs = 10000) {
    const tracks = await playerApi.waitForTracks({
      currentVideoId,
      generation,
      timeoutMs,
      isCurrent: (candidateGeneration) => enabled && candidateGeneration === requestGeneration,
      schedule,
      cancelScheduled,
    });
    if (!tracks.length) return [];
    availableTracks = tracks;
    post({
      type: "YT_TRANSCRIPT_TRACKS",
      videoId: currentVideoId,
      tracks: availableTracks.map(({ baseUrl, ...track }) => track),
    });
    return availableTracks;
  }

  async function loadTrackFromTranscriptApi(track, generation) {
    const result = await sourceApi.loadTranscriptApi({
      track,
      videoId: currentVideoId,
      generation,
      isCurrent: (candidateGeneration) => enabled && candidateGeneration === requestGeneration,
      schedule,
    });
    if (!result || generation !== requestGeneration) return false;
    transcriptCompleted = true;
    lastReadyPayload = {
      type: "YT_TRANSCRIPT_READY",
      videoId: currentVideoId,
      cues: result.cues,
      blocks: result.blocks,
      languageCode: track.languageCode,
      languageName: track.languageName,
      isAutomatic: Boolean(track.isAutomatic),
      isTranslated: Boolean(track.isTranslated),
      selectedTrackId: track.id,
      tracks: availableTracks.map(({ baseUrl, ...availableTrack }) => availableTrack),
    };
    const key = cacheKey(currentVideoId, track.id);
    if (key) transcriptCache.set(key, lastReadyPayload);
    post(lastReadyPayload);
    return true;
  }

  async function loadTrackDirectly(track, generation) {
    let currentTrack = track;
    const triedUrls = new Set();
    const attemptUrl = async (url) => {
      if (!url || triedUrls.has(url)) return false;
      triedUrls.add(url);
      return processTimedTextUrl(url, {
        force: true, selectedTrackId: currentTrack.id, generation, silentFailure: true,
      });
    };

    // 1. El cuerpo ya descargado por el player no genera ninguna petición adicional.
    if (tryCapturedTimedText(generation, currentTrack)) return true;

    // 2. Si solo conocemos la URL firmada del player, la reutilizamos antes del baseUrl.
    const playerUrl = matchingPlayerTimedTextUrl(currentTrack);
    if (playerUrl) {
      const loaded = await attemptUrl(playerUrl);
      if (loaded || lastFailureKind === "rate-limit") return loaded;
    }

    // 3. Petición propia del baseUrl en JSON3.
    let loaded = await attemptUrl(json3Url(currentTrack.baseUrl));
    if (loaded || lastFailureKind === "rate-limit") return loaded;

    // 4. Solo reintenta si la información disponible ya contiene una URL distinta.
    if (!enabled || generation !== requestGeneration) return false;
    const refreshedTracks = collectTracks();
    const refreshedTrack = refreshedTracks.find((candidate) => candidate.id === track.id) ||
      refreshedTracks.find((candidate) => candidate.languageCode === track.languageCode &&
        Boolean(candidate.isTranslated) === Boolean(track.isTranslated));
    if (refreshedTrack) currentTrack = refreshedTrack;
    if (tryCapturedTimedText(generation, currentTrack)) return true;
    loaded = await attemptUrl(matchingPlayerTimedTextUrl(currentTrack));
    if (loaded || lastFailureKind === "rate-limit") return loaded;
    loaded = await attemptUrl(json3Url(currentTrack.baseUrl));
    if (loaded || lastFailureKind === "rate-limit") return loaded;

    // 5. Fallback: URL firmada vía probe; Innertube como último recurso.
    const probed = await requestSignedCaptionUrl(currentTrack, generation);
    if (probed) return true;
    return loadTrackFromTranscriptApi(currentTrack, generation);
  }

  async function requestTranscript(force = false) {
    if (!enabled) return;
    const nextVideoId = videoIdFromLocation();

    // Reenvía al instante la última transcripción del mismo vídeo (sin red).
    if (!force && nextVideoId && lastReadyPayload?.videoId === nextVideoId) {
      currentVideoId = nextVideoId;
      transcriptCompleted = true;
      post(lastReadyPayload);
      return;
    }
    if (!force && nextVideoId && nextVideoId === currentVideoId && (transcriptCompleted || activeFetchController || requestInFlight)) return;

    requestGeneration += 1;
    const generation = requestGeneration;
    requestInFlight = true;
    activeRequestedTrack = null;
    if (currentVideoId && nextVideoId !== currentVideoId) {
      transcriptCache.clear();
      availableTracks = [];
      pruneTimedTextData(nextVideoId);
    }
    currentVideoId = nextVideoId;
    transcriptCompleted = false;
    processedUrls.clear();
    post({ type: "YT_TRANSCRIPT_LOADING" });
    startObserver();

    // En navegaciones SPA, yt-navigate-finish puede llegar antes de que el reproductor
    // haya sustituido los datos del vídeo anterior. Esperamos la respuesta correcta.
    try {
      if (tryCapturedTimedText(generation)) return;
      const observedUrl = matchingObservedTimedTextUrl();
      const observedLoad = observedUrl
        ? processTimedTextUrl(observedUrl, { generation, silentFailure: true })
        : null;
      const tracks = await waitForCurrentVideoTracks(generation);
      if (generation !== requestGeneration || !enabled) return;
      if (observedLoad && await observedLoad) return;
      if (transcriptCompleted && lastReadyPayload?.videoId === currentVideoId) return;
      const selected = preferredTrack(tracks);
      if (selected) {
        if (restoreCachedTranscript(selected.id)) return;
        activeRequestedTrack = selected;
        let loaded = false;
        try {
          loaded = await loadTrackDirectly(selected, generation);
        } finally {
          if (generation === requestGeneration) activeRequestedTrack = null;
        }
        if (loaded) return;
        if (generation !== requestGeneration || lastFailureKind === "rate-limit") return;
        post({ type: "YT_TRANSCRIPT_ERROR", message: "YouTube no devolvió datos para esta pista de subtítulos." });
        return;
      }

      post({ type: "YT_TRANSCRIPT_UNAVAILABLE", videoId: currentVideoId });
    } finally {
      if (generation === requestGeneration) requestInFlight = false;
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== "YT_TRANSCRIPT_CONTROL") return;
    enabled = Boolean(event.data.enabled);
    preferredLanguage = event.data.preferredLanguage || preferredLanguage || "auto";
    if (!enabled) {
      stopBackgroundWork();
      return;
    }
    if (event.data.selectTrackId) {
      const selected = availableTracks.find((track) => track.id === event.data.selectTrackId) || collectTracks().find((track) => track.id === event.data.selectTrackId);
      if (enabled && selected) {
        startObserver();
        requestGeneration += 1;
        const generation = requestGeneration;
        activeFetchController?.abort();
        if (restoreCachedTranscript(selected.id)) return;
        transcriptCompleted = false;
        activeRequestedTrack = selected;
        post({ type: "YT_TRANSCRIPT_LOADING" });
        loadTrackDirectly(selected, generation).then((loaded) => {
          if (!loaded && generation === requestGeneration && enabled) {
            post({ type: "YT_TRANSCRIPT_ERROR", message: "YouTube no permitió seleccionar esta pista de subtítulos." });
          }
        }).finally(() => {
          if (generation === requestGeneration) activeRequestedTrack = null;
        });
      }
      return;
    }
    requestTranscript();
  });

  window.addEventListener("yt-navigate-finish", () => requestTranscript());
})();
