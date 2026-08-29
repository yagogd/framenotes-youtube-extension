(() => {
  if (window.__ytxTimedTextCaptureInstalled) return;
  window.__ytxTimedTextCaptureInstalled = true;

  const EVENT_NAME = "ytx-timedtext-captured";
  const MAX_ENTRIES = 8;
  const MAX_BODY_LENGTH = 5 * 1024 * 1024;
  const buffer = Array.isArray(window.__ytxTimedTextCaptureBuffer)
    ? window.__ytxTimedTextCaptureBuffer
    : [];
  window.__ytxTimedTextCaptureBuffer = buffer;

  function normalizeUrl(value) {
    try { return new URL(String(value || ""), location.href).href; } catch (_) { return ""; }
  }

  function isTimedTextUrl(url) {
    return Boolean(url && url.includes("/api/timedtext"));
  }

  function emit(url, body, status, contentType, retryAfter) {
    if (!isTimedTextUrl(url) || typeof body !== "string" || body.length > MAX_BODY_LENGTH) return;
    if (!body && Number(status) !== 429) return;
    const entry = {
      url,
      body,
      status: Number(status) || 0,
      contentType: contentType || "",
      retryAfter: retryAfter || "",
      capturedAt: Date.now(),
    };
    buffer.push(entry);
    while (buffer.length > MAX_ENTRIES) buffer.shift();
    window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: entry }));
  }

  function captureFetchResponse(response, fallbackUrl) {
    const url = normalizeUrl(response?.url || fallbackUrl);
    if (!isTimedTextUrl(url)) return;
    try {
      const clone = response.clone();
      clone.text().then((body) => {
        emit(url, body, response.status, response.headers?.get?.("content-type"), response.headers?.get?.("retry-after"));
      }).catch(() => {});
    } catch (_) { /* Una respuesta no clonable usa el fallback normal. */ }
  }

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === "function") {
    window.fetch = function ytxCapturedFetch(...args) {
      const fallbackUrl = normalizeUrl(typeof args[0] === "string" || args[0] instanceof URL ? args[0] : args[0]?.url);
      const request = Reflect.apply(nativeFetch, this, args);
      request.then((response) => captureFetchResponse(response, fallbackUrl)).catch(() => {});
      return request;
    };
  }

  const xhrMetadata = new WeakMap();
  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function ytxCapturedOpen(method, url, ...args) {
    xhrMetadata.set(this, { url: normalizeUrl(url) });
    return Reflect.apply(nativeOpen, this, [method, url, ...args]);
  };

  XMLHttpRequest.prototype.send = function ytxCapturedSend(...args) {
    const metadata = xhrMetadata.get(this);
    if (isTimedTextUrl(metadata?.url)) {
      this.addEventListener("load", () => {
        try {
          const url = normalizeUrl(this.responseURL || metadata.url);
          let body = "";
          if (!this.responseType || this.responseType === "text") body = this.responseText;
          else if (this.responseType === "json") body = JSON.stringify(this.response);
          emit(url, body, this.status, this.getResponseHeader("content-type"), this.getResponseHeader("retry-after"));
        } catch (_) { /* Un responseType no textual usa el fallback normal. */ }
      }, { once: true });
    }
    return Reflect.apply(nativeSend, this, args);
  };
})();
