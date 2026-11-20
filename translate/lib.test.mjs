import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildLanguageFile,
  buildRequest,
  buildUnits,
  checkString,
  checkUnit,
  chunkUnits,
  existingValue,
  flatten,
  needsWork,
  readStream,
  pluralCategories,
  unflatten,
} from "./lib.mjs";

const en = {
  common: { save: "Save", cancel: "Cancel" },
  hosts: {
    count_one: "{{count}} host",
    count_other: "{{count}} hosts",
    greeting: "Hello {{name}}\n",
  },
};

test("flatten and unflatten keep order", () => {
  const pairs = flatten(en);
  assert.deepEqual(
    pairs.map(([key]) => key),
    [
      "common.save",
      "common.cancel",
      "hosts.count_one",
      "hosts.count_other",
      "hosts.greeting",
    ],
  );
  assert.deepEqual(unflatten(pairs), en);
});

test("flatten rejects non-string values", () => {
  assert.throws(() => flatten({ a: 1 }), /a must be a string/);
});

test("plural keys become one unit", () => {
  const units = buildUnits(flatten(en));
  assert.deepEqual(
    units.map((u) => u.id),
    ["common.save", "common.cancel", "hosts.count", "hosts.greeting"],
  );
  assert.deepEqual(units[2].forms, {
    one: "{{count}} host",
    other: "{{count}} hosts",
  });
});

test("an old style singular joins its _other group", () => {
  const units = buildUnits([
    ["items", "{{count}} item"],
    ["items_other", "{{count}} items"],
  ]);
  assert.equal(units.length, 1);
  assert.deepEqual(units[0].forms, {
    one: "{{count}} item",
    other: "{{count}} items",
  });
});

test("a key ending in a plural word without _other stays a plain string", () => {
  const units = buildUnits([["status.other", "Other"]]);
  assert.equal(units[0].plural, false);
});

test("plural categories follow the language", () => {
  assert.deepEqual(pluralCategories("de"), ["one", "other"]);
  assert.deepEqual(pluralCategories("ru"), ["one", "few", "many", "other"]);
  assert.deepEqual(pluralCategories("ja"), ["other"]);
  assert.deepEqual(pluralCategories("ar"), [
    "zero",
    "one",
    "two",
    "few",
    "many",
    "other",
  ]);
});

test("needsWork: missing, changed English, retranslate", () => {
  const [save, , count] = buildUnits(flatten(en));
  const de = new Map([["common.save", "Speichern"]]);
  const cats = ["one", "other"];
  assert.equal(needsWork(save, cats, de, undefined, false), false);
  assert.equal(needsWork(save, cats, de, save.hash, false), false);
  assert.equal(needsWork(save, cats, de, "stale", false), true);
  assert.equal(needsWork(save, cats, de, save.hash, true), true);
  assert.equal(needsWork(count, cats, de, undefined, false), true);
  const ru = new Map([
    ["hosts.count_one", "{{count}} хост"],
    ["hosts.count_other", "{{count}} хоста"],
  ]);
  // Russian also needs few and many.
  assert.equal(
    needsWork(count, pluralCategories("ru"), ru, undefined, false),
    true,
  );
  assert.equal(
    existingValue(count, ["one", "other"], ru).other,
    "{{count}} хоста",
  );
});

test("checkString", () => {
  assert.equal(checkString("Save", "Speichern"), null);
  assert.equal(checkString("Hello {{name}}", "Hallo {{ name }}"), null);
  assert.match(checkString("Hello {{name}}", "Hallo"), /placeholders/);
  assert.match(checkString("Hello {{name}}", "Hallo {{Name}}"), /placeholders/);
  assert.match(checkString("Line\n", "Zeile"), /whitespace/);
  assert.match(checkString("Save", " "), /empty/);
  assert.match(checkString("Save", 3), /not a string/);
});

test("checkUnit for plurals", () => {
  const [, , count] = buildUnits(flatten(en));
  const cats = pluralCategories("ru");
  const good = {
    one: "{{count}} хост",
    few: "{{count}} хоста",
    many: "{{count}} хостов",
    other: "{{count}} хоста",
  };
  assert.equal(checkUnit(count, cats, good), null);
  assert.equal(checkUnit(count, cats, { ...good, one: "Один хост" }), null);
  assert.match(
    checkUnit(count, cats, { ...good, few: undefined }),
    /missing few/,
  );
  assert.match(
    checkUnit(count, cats, { ...good, other: "хоста" }),
    /lost a placeholder/,
  );
  assert.match(
    checkUnit(count, cats, { ...good, many: "{{n}} хостов" }),
    /unknown/,
  );
});

test("language file follows English order and drops stale keys", () => {
  const units = buildUnits(flatten(en));
  const cats = ["one", "other"];
  const values = new Map([
    ["hosts.greeting", "Hallo {{name}}\n"],
    ["hosts.count", { one: "{{count}} Host", other: "{{count}} Hosts" }],
    ["common.save", "Speichern"],
    ["gone.key", "Alt"],
  ]);
  const file = buildLanguageFile(units, cats, values);
  assert.deepEqual(
    flatten(file).map(([key]) => key),
    ["common.save", "hosts.count_one", "hosts.count_other", "hosts.greeting"],
  );
});

test("chunks respect size limits", () => {
  const units = buildUnits(
    Array.from({ length: 130 }, (_, i) => [`k${i}`, "word"]),
  );
  assert.deepEqual(
    chunkUnits(units).map((c) => c.length),
    [60, 60, 10],
  );
  const long = buildUnits(
    Array.from({ length: 5 }, (_, i) => [`k${i}`, "x".repeat(2000)]),
  );
  assert.deepEqual(
    chunkUnits(long).map((c) => c.length),
    [2, 2, 1],
  );
});

test("request schema requires every entry", () => {
  const units = buildUnits(flatten(en));
  const { input, schema } = buildRequest(units, ["one", "other"]);
  assert.deepEqual(input["1"], { key: "common.save", text: "Save" });
  assert.deepEqual(input["3"].forms, {
    one: "{{count}} host",
    other: "{{count}} hosts",
  });
  assert.deepEqual(schema.required, ["1", "2", "3", "4"]);
  assert.deepEqual(schema.properties["3"].required, ["one", "other"]);
});

test("reads a streamed completion split across chunks", async () => {
  const enc = new TextEncoder();
  const parts = [
    'data: {"choices":[{"delta":{"content":"{\\"1\\":"}}]}\n\nda',
    'ta: {"choices":[{"delta":{"content":"\\"Hallo\\"}"},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
  ];
  async function* body() {
    for (const p of parts) yield enc.encode(p);
  }
  assert.equal(await readStream(body()), '{"1":"Hallo"}');
});

test("a stream that stops early or reports an error throws", async () => {
  async function* cut() {
    yield 'data: {"choices":[{"delta":{"content":"{"}}]}\n\n';
  }
  await assert.rejects(readStream(cut()), /ended early/);
  async function* bad() {
    yield 'data: {"error":{"message":"boom"}}\n\n';
  }
  await assert.rejects(readStream(bad()), /boom/);
});
