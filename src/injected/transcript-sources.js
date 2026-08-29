(() => {
  if (window.YTXTranscriptSources) return;

  function json3Url(baseUrl) {
    const url = new URL(baseUrl);
    url.searchParams.set("fmt", "json3");
    return url.href;
  }

  function timedTextVideoId(url) {
    try { return new URL(url).searchParams.get("v"); } catch (_) { return null; }
  }

  function createTimedTextStore(maxBodies = 8) {
    const observedUrls = new Map();
    const capturedBodies = new Map();

    function recordUrl(url, fallbackVideoId = null) {
      try {
        const parsed = new URL(url);
        const videoId = parsed.searchParams.get("v") || fallbackVideoId || "";
        const language = parsed.searchParams.get("lang") || "";
        const translated = parsed.searchParams.get("tlang") || "";
        if (videoId) observedUrls.set(`${videoId}:${language}:${translated}`, url);
      } catch (_) { /* URL inválida; se ignora. */ }
    }

    function rememberBody(entry) {
      if (!entry || typeof entry.url !== "string" || typeof entry.body !== "string") return null;
      if (!entry.body && Number(entry.status) !== 429) return null;
      if (!entry.url.includes("/api/timedtext")) return null;
      const normalized = {
        url: entry.url,
        body: entry.body,
        status: Number(entry.status) || 0,
        contentType: entry.contentType || "",
        retryAfter: entry.retryAfter || "",
        capturedAt: Number(entry.capturedAt) || Date.now(),
      };
      capturedBodies.delete(normalized.url);
      capturedBodies.set(normalized.url, normalized);
      while (capturedBodies.size > maxBodies) capturedBodies.delete(capturedBodies.keys().next().value);
      recordUrl(normalized.url);
      return normalized;
    }

    function findBody(videoId, predicate) {
      return Array.from(capturedBodies.values()).reverse().find((entry) =>
        !entry.invalid && timedTextVideoId(entry.url) === videoId && (!predicate || predicate(entry))
      ) || null;
    }

    function findObserved(videoId, predicate) {
      const prefix = `${videoId}:`;
      return Array.from(observedUrls.entries()).reverse().find(([key, url]) =>
        key.startsWith(prefix) && (!predicate || predicate(url))
      )?.[1] || null;
    }

    function prune(videoId) {
      const prefix = `${videoId}:`;
      for (const [key] of observedUrls) {
        if (!key.startsWith(prefix)) observedUrls.delete(key);
      }
      for (const [url] of capturedBodies) {
        if (timedTextVideoId(url) !== videoId) capturedBodies.delete(url);
      }
    }

    return {
      rememberBody,
      recordUrl,
      findBody,
      findObserved,
      prune,
      getBody: (url) => capturedBodies.get(url) || null,
      hasBody: (url) => capturedBodies.has(url),
    };
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

  async function loadTranscriptApi({ track, videoId, generation, isCurrent, schedule }) {
    const apiKey = window.ytcfg?.get?.("INNERTUBE_API_KEY");
    const context = window.ytcfg?.get?.("INNERTUBE_CONTEXT");
    if (!apiKey || !context || !videoId || !isCurrent(generation)) return null;
    let realParams = currentTranscriptEndpointParams();
    for (let attempt = 0; !realParams && attempt < 8; attempt += 1) {
      await new Promise((resolve) => schedule(resolve, 250));
      if (!isCurrent(generation)) return null;
      realParams = currentTranscriptEndpointParams();
    }
    const candidates = [...new Set([
      realParams,
      transcriptParams(videoId, track.languageCode),
    ].filter(Boolean))];
    try {
      for (const params of candidates) {
        if (!isCurrent(generation)) return null;
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
        if (!isCurrent(generation)) return null;
        if (!response.ok) continue;
        const events = collectTranscriptCues(await response.json());
        const result = window.YTXTranscriptParser.parseJson3({ events });
        if (result.cues.length && isCurrent(generation)) return result;
      }
    } catch (error) {
      console.debug("[Transcript] El endpoint alternativo no devolvió una transcripción:", error);
    }
    return null;
  }

  window.YTXTranscriptSources = {
    json3Url,
    timedTextVideoId,
    createTimedTextStore,
    loadTranscriptApi,
  };
})();
