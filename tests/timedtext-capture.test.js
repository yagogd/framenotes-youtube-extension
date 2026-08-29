const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

test("captura el cuerpo de fetch sin lanzar una segunda petición", async () => {
  const source = fs.readFileSync(require.resolve("../src/injected/timedtext-capture.js"), "utf8");
  const url = "https://www.youtube.com/api/timedtext?v=video-1&lang=es&fmt=json3";
  const body = JSON.stringify({ events: [] });
  const response = {
    url,
    status: 200,
    headers: { get: () => "application/json" },
    clone: () => ({ text: async () => body }),
  };
  const originalPromise = Promise.resolve(response);
  let fetchCount = 0;
  const window = {
    fetch() {
      fetchCount += 1;
      return originalPromise;
    },
    dispatchEvent() {},
  };
  class MockXmlHttpRequest {}
  MockXmlHttpRequest.prototype.open = function open() {};
  MockXmlHttpRequest.prototype.send = function send() {};

  vm.runInNewContext(source, {
    window,
    XMLHttpRequest: MockXmlHttpRequest,
    URL,
    location: { href: "https://www.youtube.com/watch?v=video-1" },
    CustomEvent: class CustomEvent {
      constructor(type, init) { this.type = type; this.detail = init.detail; }
    },
  });

  const returnedPromise = window.fetch(url);
  assert.equal(returnedPromise, originalPromise);
  await returnedPromise;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fetchCount, 1);
  assert.equal(window.__ytxTimedTextCaptureBuffer.length, 1);
  assert.equal(window.__ytxTimedTextCaptureBuffer[0].body, body);
});
