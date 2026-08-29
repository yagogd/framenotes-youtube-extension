const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeJson3Events,
  groupCuesIntoBlocks,
  blocksForMode,
  parseTimedText,
} = require("../src/transcript/transcript-parser.js");

function cue(startMs, endMs, text) {
  return { startMs, endMs, durationMs: endMs - startMs, text };
}

test("normaliza un evento con varios segmentos y conserva sus tiempos", () => {
  const result = normalizeJson3Events({
    events: [{
      tStartMs: 320,
      dDurationMs: 3280,
      segs: [{ utf8: "Cuando" }, { utf8: " estás", tOffsetMs: 599 }],
    }],
  });
  assert.deepEqual(result, [cue(320, 3600, "Cuando estás")]);
});

test("ignora eventos sin segmentos", () => {
  assert.deepEqual(normalizeJson3Events({ events: [{ tStartMs: 10 }] }), []);
});

test("ignora eventos formados solo por saltos de línea", () => {
  assert.deepEqual(normalizeJson3Events({
    events: [{ tStartMs: 2510, dDurationMs: 1090, aAppend: 1, segs: [{ utf8: "\n" }] }],
  }), []);
});

test("limpia saltos y espacios duplicados", () => {
  const [result] = normalizeJson3Events({
    events: [{ tStartMs: 0, dDurationMs: 100, segs: [{ utf8: "  Hola\n  mundo  " }] }],
  });
  assert.equal(result.text, "Hola mundo");
});

test("elimina etiquetas de formato incluidas en el texto", () => {
  const [result] = normalizeJson3Events({
    events: [{
      tStartMs: 0,
      dDurationMs: 1000,
      segs: [{ utf8: "<b>Hola</b> <i>mundo</i> &lt;b&gt;sin etiquetas&lt;/b&gt;" }],
    }],
  });
  assert.equal(result.text, "Hola mundo sin etiquetas");
});

test("elimina anotaciones sonoras entre corchetes", () => {
  const [result] = normalizeJson3Events({
    events: [{
      tStartMs: 0,
      dDurationMs: 1000,
      segs: [{ utf8: "[Música] Hola [resopla] mundo [APLAUSOS]" }],
    }],
  });
  assert.equal(result.text, "Hola mundo");
});

test("conserva el marcador de palabras censuradas", () => {
  const [result] = normalizeJson3Events({
    events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "Esto es [_] importante" }] }],
  });
  assert.equal(result.text, "Esto es [_] importante");
});

test("descarta eventos que solo contienen una anotación sonora", () => {
  const result = normalizeJson3Events({
    events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "[Música]" }] }],
  });
  assert.deepEqual(result, []);
});

test("agrupa cues cercanos", () => {
  const blocks = groupCuesIntoBlocks([
    cue(0, 1000, "Una explicación"),
    cue(1200, 2200, "que continúa sin pausa"),
  ]);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].text, "Una explicación que continúa sin pausa");
  assert.equal(blocks[0].startMs, 0);
  assert.equal(blocks[0].endMs, 2200);
});

test("separa bloques por una pausa larga", () => {
  const blocks = groupCuesIntoBlocks([
    cue(0, 1000, "Primer fragmento"),
    cue(2501, 3500, "Segundo fragmento"),
  ]);
  assert.equal(blocks.length, 2);
});

test("separa por puntuación cuando el bloque ya tiene contenido suficiente", () => {
  const blocks = groupCuesIntoBlocks([
    cue(0, 1000, "Esta primera oración tiene longitud suficiente para cerrarse."),
    cue(1100, 2000, "Empieza otra oración"),
  ]);
  assert.equal(blocks.length, 2);
});

test("no deja aislada una oración muy corta aunque tenga puntuación", () => {
  const blocks = groupCuesIntoBlocks([
    cue(0, 500, "Sí."),
    cue(600, 1500, "Esta es la explicación que viene después"),
  ]);
  assert.equal(blocks.length, 1);
});

test("el modo original conserva un bloque por cue", () => {
  const blocks = blocksForMode([
    cue(0, 1000, "Primer cue"),
    cue(1100, 2000, "Segundo cue"),
  ], "original");
  assert.equal(blocks.length, 2);
  assert.equal(blocks[1].cueStartIndex, 1);
});

test("el modo por frases separa incluso una oración corta terminada en punto", () => {
  const blocks = blocksForMode([
    cue(0, 500, "Sí."),
    cue(600, 1500, "Esta es la explicación siguiente"),
  ], "sentences");
  assert.equal(blocks.length, 2);
});

test("el modo por frases separa varios puntos dentro del mismo cue", () => {
  const blocks = blocksForMode([
    cue(1000, 4000, "Primera frase. Segunda frase. Tercera sin punto"),
  ], "sentences");
  assert.deepEqual(blocks.map((block) => block.text), [
    "Primera frase.",
    "Segunda frase.",
    "Tercera sin punto",
  ]);
  assert.equal(blocks[0].startMs, 1000);
  assert.equal(blocks[2].endMs, 4000);
  assert.ok(blocks[0].endMs <= blocks[1].startMs);
});

test("mantiene una batería de preguntas del mismo cue en un único bloque", () => {
  const blocks = blocksForMode([
    cue(0, 3000, "¿Cómo? ¿Por qué? ¿Cuándo?"),
  ], "sentences");
  assert.deepEqual(blocks.map((block) => block.text), ["¿Cómo? ¿Por qué? ¿Cuándo?"]);
});

test("mantiene una batería de preguntas repartida entre cues cercanos", () => {
  const blocks = blocksForMode([
    cue(0, 800, "¿Cómo?"),
    cue(900, 1700, "¿Por qué?"),
    cue(1800, 2600, "¿Cuándo?"),
  ], "sentences");
  assert.deepEqual(blocks.map((block) => block.text), ["¿Cómo? ¿Por qué? ¿Cuándo?"]);
  assert.equal(blocks[0].startMs, 0);
  assert.equal(blocks[0].endMs, 2600);
});

test("una pausa larga sí corta una batería de preguntas", () => {
  const blocks = blocksForMode([
    cue(0, 800, "¿Cómo?"),
    cue(2000, 2800, "¿Por qué?"),
  ], "sentences");
  assert.equal(blocks.length, 2);
});

test("fusiona duplicados progresivos evidentes sin perder el intervalo", () => {
  const result = normalizeJson3Events({
    events: [
      { tStartMs: 100, dDurationMs: 900, segs: [{ utf8: "Hola" }] },
      { tStartMs: 100, dDurationMs: 1400, aAppend: 1, segs: [{ utf8: "Hola mundo" }] },
    ],
  });
  assert.deepEqual(result, [cue(100, 1500, "Hola mundo")]);
});

test("parsea timedtext XML clásico sin una segunda descarga", () => {
  const result = parseTimedText('<transcript><text start="1.25" dur="2.5">Hola &amp; mundo</text></transcript>');
  assert.deepEqual(result.cues, [cue(1250, 3750, "Hola & mundo")]);
});

test("parsea timedtext srv3 con tiempos en milisegundos", () => {
  const result = parseTimedText('<timedtext format="3"><body><p t="320" d="1800"><s>Texto </s><s>capturado</s></p></body></timedtext>');
  assert.deepEqual(result.cues, [cue(320, 2120, "Texto capturado")]);
});
