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
  let captionProbe = null;
  let ignorePlayerCaptionRequestsUntil = 0;
  let requestInFlight = false;
  const observedPlayerUrls = new Map();
  const capturedTimedTextBodies = new Map();
  const pendingObservedFallbacks = new Set();
  const CAPTURE_EVENT = "ytx-timedtext-captured";
  const MAX_CAPTURED_BODIES = 8;
  let activeRequestedTrack = null;

  function schedule(callback, delay) {
    const timer = setTimeout(() => {
      pendingTimers.delete(timer);
      callback();
    }, delay);
    pendingTimers.add(timer);
    return timer;
  }

  function post(payload) {
    window.postMessage({ source: "YT_TRANSCRIPT_EXTENSION", ...payload }, "*");
  }

  function finishCaptionProbe(success = false) {
    const probe = captionProbe;
    if (!probe) return;
    captionProbe = null;
    clearTimeout(probe.timeout);
    pendingTimers.delete(probe.timeout);
    const player = document.getElementById("movie_player");
    const button = document.querySelector(".ytp-subtitles-button");
    ignorePlayerCaptionRequestsUntil = Date.now() + 2500;
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

  function requestSignedCaptionUrl(track, generation) {
    if (!enabled || generation !== requestGeneration || captionProbe) return Promise.resolve(false);
    const player = document.getElementById("movie_player");
    const button = document.querySelector(".ytp-subtitles-button");
    if (!player || !button) return Promise.resolve(false);
    return new Promise((resolve) => {
      const wasEnabled = button.getAttribute("aria-pressed") === "true";
      const previousTrack = player.getOption?.("captions", "track") || null;
      const sourceCode = track.sourceLanguageCode || track.languageCode;
      const sourceTrack = playerCaptionTracks().find((candidate) => candidate.languageCode === sourceCode &&
        (candidate.kind === "asr") === Boolean(track.isTranslated ? track.sourceIsAutomatic : track.isAutomatic)) ||
        playerCaptionTracks().find((candidate) => candidate.languageCode === sourceCode);
      const requestedTrack = sourceTrack ? { ...sourceTrack } : { languageCode: sourceCode };
    if (track.isTranslated) {
        requestedTrack.translationLanguage = playerTranslationLanguages()
          .find((language) => language.languageCode === track.languageCode) || { languageCode: track.languageCode };
      }
      player.classList.add("ytx-caption-probe-active");
      const timeout = schedule(() => finishCaptionProbe(false), 8000);
      captionProbe = { generation, wasEnabled, resolve, timeout, previousTrack, track };
      try {
        player.loadModule?.("captions");
        player.setOption?.("captions", "track", requestedTrack);
      } catch (_) { /* El clic inferior conserva el mecanismo de respaldo. */ }
      schedule(() => {
        if (captionProbe?.generation !== generation) return;
        if (button.getAttribute("aria-pressed") !== "true") button.click();
      }, 120);
    });
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

  function videoIdFromLocation() {
    return new URL(location.href).searchParams.get("v");
  }

  function playerCaptionData() {
    const playerResponse = document.getElementById("movie_player")?.getPlayerResponse?.() || window.ytInitialPlayerResponse;
    return playerResponse?.captions?.playerCaptionsTracklistRenderer || {};
  }

  function playerResponseVideoId() {
    const playerResponse = document.getElementById("movie_player")?.getPlayerResponse?.() || window.ytInitialPlayerResponse;
    return playerResponse?.videoDetails?.videoId || null;
  }

  function playerCaptionTracks() {
    return playerCaptionData().captionTracks || [];
  }

  function playerTranslationLanguages() {
    return playerCaptionData().translationLanguages || [];
  }

  function trackName(track) {
    return track.name?.simpleText || track.name?.runs?.map((run) => run.text).join("") ||
      track.languageName?.simpleText || track.languageName?.runs?.map((run) => run.text).join("") ||
      track.languageCode || "Desconocido";
  }

  function collectTracks() {
    const originalTracks = playerCaptionTracks().map((track, index) => ({
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
    const translatedTracks = translationSource ? playerTranslationLanguages()
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
    availableTracks = [...originalTracks, ...translatedTracks];
    post({
      type: "YT_TRANSCRIPT_TRACKS",
      videoId: currentVideoId,
      tracks: availableTracks.map(({ baseUrl, ...track }) => track),
    });
    return availableTracks;
  }

  function preferredTrack(tracks) {
    if (!tracks.length) return null;
    if (!preferredLanguage || preferredLanguage === "auto") return tracks[0];
    const language = preferredLanguage.toLocaleLowerCase();
    const matches = tracks.filter((track) => {
      const code = track.languageCode.toLocaleLowerCase();
      return code === language || code.startsWith(`${language}-`);
    });
    return matches.find((track) => !track.isAutomatic) || matches[0] || tracks[0];
  }

  function json3Url(baseUrl) {
    const url = new URL(baseUrl);
    url.searchParams.set("fmt", "json3");
    return url.href;
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

  function getTrackInformation(url) {
    const parsedUrl = new URL(url);
    const translatedLanguage = parsedUrl.searchParams.get("tlang");
    const languageCode = translatedLanguage || parsedUrl.searchParams.get("lang") || "desconocido";
    let languageName = languageCode;
    let isAutomatic = translatedLanguage ? true : parsedUrl.searchParams.get("kind") === "asr";
    const isTranslated = Boolean(translatedLanguage);

    if (translatedLanguage) {
      const language = playerTranslationLanguages().find((candidate) => candidate.languageCode === translatedLanguage);
      if (language) languageName = trackName(language);
      return { languageCode, languageName, isAutomatic, isTranslated };
    }

    const tracks = window.ytInitialPlayerResponse?.captions
      ?.playerCaptionsTracklistRenderer?.captionTracks || [];
    const urlKind = new URL(url).searchParams.get("kind") || "manual";
    const track = tracks.find((candidate) => candidate.languageCode === languageCode && (candidate.kind || "manual") === urlKind) ||
      tracks.find((candidate) => candidate.languageCode === languageCode);
    if (track) {
      languageName = track.name?.simpleText ||
        track.name?.runs?.map((run) => run.text).join("") ||
        languageCode;
      isAutomatic = track.kind === "asr";
    }

    return { languageCode, languageName, isAutomatic, isTranslated };
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

  function timedTextVideoId(url) {
    try { return new URL(url).searchParams.get("v"); } catch (_) { return null; }
  }

  function capturedBodyMatchesPreference(entry) {
    if (!entry || timedTextVideoId(entry.url) !== currentVideoId) return false;
    const selected = preferredTrack(availableTracks);
    return Boolean(selected && captionUrlMatchesTrack(entry.url, selected));
  }

  function rememberCapturedTimedText(entry) {
    if (!entry || typeof entry.url !== "string" || typeof entry.body !== "string") return;
    if (!entry.body && Number(entry.status) !== 429) return;
    if (!entry.url.includes("/api/timedtext")) return;
    const normalized = {
      url: entry.url,
      body: entry.body,
      status: Number(entry.status) || 0,
      contentType: entry.contentType || "",
      retryAfter: entry.retryAfter || "",
      capturedAt: Number(entry.capturedAt) || Date.now(),
    };
    capturedTimedTextBodies.delete(normalized.url);
    capturedTimedTextBodies.set(normalized.url, normalized);
    while (capturedTimedTextBodies.size > MAX_CAPTURED_BODIES) {
      capturedTimedTextBodies.delete(capturedTimedTextBodies.keys().next().value);
    }
    recordPlayerTimedTextUrl(normalized.url);
  }

  function processCapturedTimedText(entry, options = {}) {
    const generation = options.generation ?? requestGeneration;
    if (!entry || entry.invalid || !enabled || generation !== requestGeneration) return false;
    if (timedTextVideoId(entry.url) !== currentVideoId) return false;
    if (entry.status === 429) {
      const retryAfter = Number(entry.retryAfter);
      rateLimitedUntil = Date.now() + (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 30000);
      lastFailureKind = "rate-limit";
      const shouldNotify = !transcriptCompleted && (requestInFlight || activeRequestedTrack || captionProbe);
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
    const entries = Array.from(capturedTimedTextBodies.values()).reverse();
    return entries.find((entry) => {
      if (entry.invalid || timedTextVideoId(entry.url) !== currentVideoId) return false;
      return track ? captionUrlMatchesTrack(entry.url, track) : capturedBodyMatchesPreference(entry);
    }) || null;
  }

  function tryCapturedTimedText(generation, track = null) {
    const captured = findCapturedTimedText(track);
    return captured ? processCapturedTimedText(captured, { generation, selectedTrackId: track?.id }) : false;
  }

  function matchingObservedTimedTextUrl() {
    const urls = Array.from(observedPlayerUrls.values()).reverse();
    return urls.find((url) => capturedBodyMatchesPreference({ url })) || null;
  }

  function pruneTimedTextData(videoId) {
    for (const [key, url] of observedPlayerUrls) {
      if (timedTextVideoId(url) !== videoId) observedPlayerUrls.delete(key);
    }
    for (const [url] of capturedTimedTextBodies) {
      if (timedTextVideoId(url) !== videoId) capturedTimedTextBodies.delete(url);
    }
  }

  function handleCapturedTimedText(entry) {
    if (silentObservedUrls.has(entry?.url)) return;
    rememberCapturedTimedText(entry);
    if (!enabled || transcriptCompleted) return;
    if (timedTextVideoId(entry.url) !== currentVideoId) return;
    const probe = captionProbe;
    const requestedTrack = probe?.track || activeRequestedTrack;
    if (requestedTrack) {
      if (captionUrlMatchesTrack(entry.url, requestedTrack)) {
        const loaded = processCapturedTimedText(capturedTimedTextBodies.get(entry.url), {
          generation: probe?.generation ?? requestGeneration,
          selectedTrackId: requestedTrack.id,
        });
        if (probe && loaded && captionProbe === probe) finishCaptionProbe(true);
      }
      return;
    }
    if (capturedBodyMatchesPreference(entry)) processCapturedTimedText(capturedTimedTextBodies.get(entry.url));
  }

  window.addEventListener(CAPTURE_EVENT, (event) => handleCapturedTimedText(event.detail));
  (Array.isArray(window.__ytxTimedTextCaptureBuffer) ? window.__ytxTimedTextCaptureBuffer : [])
    .forEach((entry) => rememberCapturedTimedText(entry));

  function recordPlayerTimedTextUrl(url) {
    try {
      const parsed = new URL(url);
      const v = parsed.searchParams.get("v") || currentVideoId || "";
      const lang = parsed.searchParams.get("lang") || "";
      const tlang = parsed.searchParams.get("tlang") || "";
      if (v) observedPlayerUrls.set(`${v}:${lang}:${tlang}`, url);
    } catch (_) { /* URL inválida; se ignora. */ }
  }

  function matchingPlayerTimedTextUrl(track) {
    if (!currentVideoId || !track) return null;
    const prefix = `${currentVideoId}:`;
    for (const [key, url] of observedPlayerUrls) {
      if (!key.startsWith(prefix)) continue;
      if (captionUrlMatchesTrack(url, track)) return url;
    }
    return null;
  }

  function processObservedTimedText(name, probe = null) {
    const captured = capturedTimedTextBodies.get(name);
    if (captured) {
      const loaded = processCapturedTimedText(captured, probe ? {
        generation: probe.generation,
        selectedTrackId: probe.track.id,
      } : {});
      if (loaded) {
        if (probe && captionProbe === probe) finishCaptionProbe(true);
        return;
      }
      if (captured.status === 429) {
        if (probe && captionProbe === probe) finishCaptionProbe(false);
        return;
      }
    }
    processTimedTextUrl(name, probe ? {
      force: true,
      selectedTrackId: probe.track.id,
      generation: probe.generation,
      ignoreRateLimit: true,
    } : {}).then((loaded) => {
      if (probe && captionProbe === probe) finishCaptionProbe(loaded);
    });
  }

  function handleTimedTextResource(name) {
    if (silentObservedUrls.has(name)) {
      silentObservedUrls.delete(name);
      return;
    }
    recordPlayerTimedTextUrl(name);
    if (!captionProbe && Date.now() < ignorePlayerCaptionRequestsUntil) return;
    const probe = captionProbe;
    const requestedTrack = probe?.track || activeRequestedTrack;
    if (requestedTrack && !captionUrlMatchesTrack(name, requestedTrack)) return;
    if (!requestedTrack && !capturedBodyMatchesPreference({ url: name })) return;
    if (capturedTimedTextBodies.has(name) || !window.__ytxTimedTextCaptureInstalled) {
      processObservedTimedText(name, probe);
      return;
    }
    if (pendingObservedFallbacks.has(name)) return;
    pendingObservedFallbacks.add(name);
    schedule(() => {
      pendingObservedFallbacks.delete(name);
      if (!enabled || transcriptCompleted) return;
      processObservedTimedText(name, probe && captionProbe === probe ? probe : null);
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
    if (captionProbe) finishCaptionProbe(false);
    pendingTimers.forEach((timer) => clearTimeout(timer));
    pendingTimers.clear();
    silentObservedUrls.clear();
    pendingObservedFallbacks.clear();
    observer.disconnect();
    observerActive = false;
  }

  async function waitForCurrentVideoTracks(generation, timeoutMs = 10000) {
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
        if (pollTimer) clearTimeout(pollTimer);
      };

      const tryResolve = () => {
        if (settled || !enabled || generation !== requestGeneration) return;
        const responseVideoId = playerResponseVideoId();
        const tracks = playerCaptionTracks();
        if ((!responseVideoId || responseVideoId === currentVideoId) && tracks.length) {
          settled = true;
          cleanup();
          resolve(collectTracks());
        }
      };

      player?.addEventListener?.("onApiChange", tryResolve);
      player?.addEventListener?.("onReady", tryResolve);
      document.addEventListener("yt-player-updated", tryResolve);
      window.addEventListener("ytx-transcript-ready-internal", tryResolve);

      const poll = () => {
        if (settled || !enabled || generation !== requestGeneration) {
          cleanup();
          resolve([]);
          return;
        }
        tryResolve();
        if (!settled) {
          if (Date.now() >= deadline) {
            cleanup();
            resolve([]);
          } else {
            pollTimer = schedule(poll, 250);
          }
        }
      };

      tryResolve();
      pollTimer = schedule(poll, 250);
    });
  }

  function transcriptParams(videoId, languageCode) {
    const encoder = new TextEncoder();
    const field = (number, value) => {
      const bytes = encoder.encode(value);
      return [(number << 3) | 2, bytes.length, ...bytes];
    };
    const language = field(1, languageCode || "");
    const payload = [...field(1, videoId), (2 << 3) | 2, language.length, ...language];
    return btoa(String.fromCharCode(...payload));
  }

  function findTranscriptEndpointParams(root) {
    const seen = new WeakSet();
    const stack = [root];
    let inspected = 0;
    while (stack.length && inspected < 100000) {
      const value = stack.pop();
      if (!value || typeof value !== "object" || seen.has(value)) continue;
      seen.add(value);
      inspected += 1;
      const params = value.getTranscriptEndpoint?.params;
      if (typeof params === "string" && params) return params;
      if (Array.isArray(value)) stack.push(...value);
      else Object.values(value).forEach((child) => {
        if (child && typeof child === "object") stack.push(child);
      });
    }
    return null;
  }

  function currentTranscriptEndpointParams() {
    const roots = [
      document.querySelector("ytd-watch-flexy")?.data,
      document.querySelector("ytd-app")?.data,
      window.ytInitialData,
    ];
    for (const root of roots) {
      const params = findTranscriptEndpointParams(root);
      if (params) return params;
    }
    return null;
  }

  function collectTranscriptCues(value, cues = []) {
    if (!value || typeof value !== "object") return cues;
    const renderer = value.transcriptCueRenderer;
    if (renderer) {
      const text = renderer.cue?.simpleText || renderer.cue?.runs?.map((run) => run.text).join("") || "";
      const startMs = Number(renderer.startOffsetMs) || 0;
      const durationMs = Number(renderer.durationMs) || 0;
      if (text) cues.push({ tStartMs: startMs, dDurationMs: durationMs, segs: [{ utf8: text }] });
    }
    Object.values(value).forEach((child) => collectTranscriptCues(child, cues));
    return cues;
  }

  async function loadTrackFromTranscriptApi(track, generation) {
    const apiKey = window.ytcfg?.get?.("INNERTUBE_API_KEY");
    const context = window.ytcfg?.get?.("INNERTUBE_CONTEXT");
    if (!apiKey || !context || !currentVideoId || generation !== requestGeneration) return false;
    let realParams = currentTranscriptEndpointParams();
    for (let attempt = 0; !realParams && attempt < 8; attempt += 1) {
      await new Promise((resolve) => schedule(resolve, 250));
      if (!enabled || generation !== requestGeneration) return false;
      realParams = currentTranscriptEndpointParams();
    }
    const candidates = [...new Set([
      realParams,
      transcriptParams(currentVideoId, track.languageCode),
    ].filter(Boolean))];
    try {
      let parsedTranscript = null;
      for (const params of candidates) {
        const response = await fetch(`/youtubei/v1/get_transcript?key=${encodeURIComponent(apiKey)}&prettyPrint=false`, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            "X-YouTube-Client-Name": String(window.ytcfg?.get?.("INNERTUBE_CONTEXT_CLIENT_NAME") || 1),
            "X-YouTube-Client-Version": String(context.client?.clientVersion || ""),
          },
          body: JSON.stringify({ context, params }),
        });
        if (!response.ok) continue;
        const data = await response.json();
        const events = collectTranscriptCues(data);
        const result = window.YTXTranscriptParser.parseJson3({ events });
        if (result.cues.length) {
          parsedTranscript = result;
          break;
        }
      }
      if (!parsedTranscript || generation !== requestGeneration) return false;
      const { cues, blocks } = parsedTranscript;
      transcriptCompleted = true;
      lastReadyPayload = {
        type: "YT_TRANSCRIPT_READY",
        videoId: currentVideoId,
        cues,
        blocks,
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
    } catch (error) {
      console.debug("[Transcript] El endpoint alternativo no devolvió una transcripción:", error);
      return false;
    }
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
