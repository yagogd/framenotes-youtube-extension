const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function loadInjectedModule(path, globals = {}) {
  const window = globals.window || {};
  vm.runInNewContext(fs.readFileSync(require.resolve(path), "utf8"), {
    window,
    document: globals.document || { getElementById: () => null, querySelector: () => null, addEventListener() {}, removeEventListener() {} },
    location: globals.location || { href: "https://www.youtube.com/watch?v=video-1" },
    URL,
    TextEncoder,
    btoa: (value) => Buffer.from(value, "binary").toString("base64"),
    fetch: globals.fetch || (() => Promise.reject(new Error("fetch inesperado"))),
    requestAnimationFrame: (callback) => callback(),
    console,
  });
  return window;
}

test("el adaptador del player conserva prioridad manual y traducciones", () => {
  const window = {
    ytInitialPlayerResponse: {
      videoDetails: { videoId: "video-1" },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            { languageCode: "es", kind: "asr", name: { simpleText: "Español automático" }, baseUrl: "https://www.youtube.com/api/timedtext?v=video-1&lang=es&kind=asr" },
            { languageCode: "es", name: { simpleText: "Español" }, baseUrl: "https://www.youtube.com/api/timedtext?v=video-1&lang=es", isTranslatable: true },
          ],
          translationLanguages: [{ languageCode: "en", languageName: { simpleText: "English" } }],
        },
      },
    },
  };
  const api = loadInjectedModule("../src/injected/transcript-player.js", { window }).YTXTranscriptPlayer;
  const tracks = api.collectTracks("video-1");

  assert.equal(api.preferredTrack(tracks, "es").isAutomatic, false);
  assert.equal(tracks.find((track) => track.languageCode === "en").sourceIsAutomatic, false);
  assert.equal(api.captionUrlMatchesTrack("https://www.youtube.com/api/timedtext?v=video-1&lang=es&kind=asr", tracks[1]), false);
});

test("el almacén timedtext conserva el vídeo entrante y poda el anterior", () => {
  const api = loadInjectedModule("../src/injected/transcript-sources.js").YTXTranscriptSources;
  const store = api.createTimedTextStore(2);
  const oldUrl = "https://www.youtube.com/api/timedtext?v=old&lang=es";
  const nextUrl = "https://www.youtube.com/api/timedtext?v=next&lang=es";

  store.rememberBody({ url: oldUrl, body: "<transcript></transcript>", status: 200 });
  store.rememberBody({ url: nextUrl, body: "<transcript></transcript>", status: 200 });
  store.prune("next");

  assert.equal(store.findBody("old"), null);
  assert.equal(store.findBody("next").url, nextUrl);
  assert.equal(store.findObserved("next"), nextUrl);
});

test("el almacén conserva URLs firmadas sin parámetro de vídeo", () => {
  const api = loadInjectedModule("../src/injected/transcript-sources.js").YTXTranscriptSources;
  const store = api.createTimedTextStore();
  const signedUrl = "https://www.youtube.com/api/timedtext?lang=es&signature=firma";

  store.recordUrl(signedUrl, "video-1");

  assert.equal(store.findObserved("video-1"), signedUrl);
});
