#!/usr/bin/env node
// Translates en.json into every language with the Termix LLM server.
//
//   node translate.mjs --source locales/en.json --out locales/translated
//
// Only strings that are missing, or whose English changed since the last run
// (tracked in translations-lock.json next to en.json), are sent. Existing
// translations, including hand fixes, are kept. --retranslate redoes all.
// Needs TERMIX_LLM_API_KEY. If the server can't be reached it warns and
// exits 0 so a release never blocks on it. TERMIX_LLM_BASE_URL and
// TERMIX_LLM_MODEL point it at another vLLM server.

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import {
  buildLanguageFile,
  buildPrompt,
  buildRequest,
  buildUnits,
  checkUnit,
  chunkUnits,
  existingValue,
  flatten,
  needsWork,
  pluralCategories,
  readStream,
  toJson,
} from "./lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL =
  process.env.TERMIX_LLM_BASE_URL || "https://llm.termix.site/v1";
const MODEL = process.env.TERMIX_LLM_MODEL || "qwen3.6-27b";
const ROUNDS = 3;

const { values: args } = parseArgs({
  options: {
    source: { type: "string" },
    out: { type: "string" },
    languages: { type: "string" },
    lock: { type: "string" },
    only: { type: "string" },
    // The server holds about 14 requests at once and shares them with the
    // bot. More than that makes it drop and redo work.
    concurrency: { type: "string", default: "8" },
    retranslate: { type: "boolean", default: false },
    plan: { type: "boolean", default: false },
  },
});

if (!args.source || !args.out) {
  console.error(
    "usage: translate.mjs --source en.json --out translated/ [--languages file] [--only de,fr] [--retranslate] [--plan]",
  );
  process.exit(1);
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const summary = [];

function warn(message) {
  console.log(
    process.env.GITHUB_ACTIONS
      ? `::warning::${message}`
      : `warning: ${message}`,
  );
  summary.push(`> [!WARNING]\n> ${message}\n`);
}

function writeSummary() {
  if (process.env.GITHUB_STEP_SUMMARY && summary.length) {
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `${summary.join("\n")}\n`,
    );
  }
}

const builtIn = readJson(path.join(here, "languages.json"));
let languages = args.languages ? readJson(args.languages) : builtIn;
const describe = (list) =>
  list
    .map((l) => `${l.code}:${l.file}`)
    .sort()
    .join(",");
if (args.languages && describe(languages) !== describe(builtIn)) {
  warn(
    `${args.languages} differs from the translator's languages.json. Keep them in sync.`,
  );
}
if (args.only) {
  const only = new Set(args.only.split(","));
  languages = languages.filter((l) => only.has(l.code) || only.has(l.file));
}

const glossary = readJson(path.join(here, "glossary.json"));
const lockFile =
  args.lock ?? path.join(path.dirname(args.source), "translations-lock.json");
const lock = fs.existsSync(lockFile) ? readJson(lockFile) : {};
const units = buildUnits(flatten(readJson(args.source)));

// Work out what each language needs.
const jobs = languages.map((language) => {
  const cats = pluralCategories(language.code);
  const file = path.join(args.out, `${language.file}.json`);
  const existing = new Map(fs.existsSync(file) ? flatten(readJson(file)) : []);
  const todo = units.filter((unit) =>
    needsWork(unit, cats, existing, lock[unit.id], args.retranslate),
  );
  return {
    language,
    cats,
    file,
    existing,
    todo,
    results: new Map(),
    failed: new Map(),
  };
});

const total = jobs.reduce((sum, job) => sum + job.todo.length, 0);
console.log(
  `${units.length} strings, ${total} to translate across ${jobs.length} languages`,
);
if (args.plan) {
  for (const job of jobs)
    console.log(`  ${job.language.file}: ${job.todo.length}`);
  process.exit(0);
}

async function post(body) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.TERMIX_LLM_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ...body, stream: true }),
        signal: AbortSignal.timeout(10 * 60 * 1000),
      });
      if (!res.ok)
        throw new Error(
          `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`,
        );
      return await readStream(res.body);
    } catch (error) {
      if (attempt >= 4) throw error;
      await new Promise((r) => setTimeout(r, 2000 * attempt ** 2));
    }
  }
}

async function translateChunk(job, chunk) {
  const { input, schema } = buildRequest(chunk, job.cats);
  const content = await post({
    model: MODEL,
    temperature: 0.2,
    top_p: 0.9,
    max_tokens: 16000,
    // Batch work: the server runs bot triage and reviews first
    priority: 10,
    messages: [
      {
        role: "system",
        content: buildPrompt(job.language, job.cats, glossary),
      },
      { role: "user", content: JSON.stringify(input, null, 1) },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "translations", strict: true, schema },
    },
    chat_template_kwargs: { enable_thinking: false },
  });
  const output = JSON.parse(content);
  const bad = [];
  chunk.forEach((unit, index) => {
    const value = output[String(index + 1)];
    const problem = checkUnit(unit, job.cats, value);
    if (problem) {
      bad.push(unit);
      job.failed.set(unit.id, problem);
    } else {
      job.results.set(unit.id, value);
      job.failed.delete(unit.id);
    }
  });
  return bad;
}

// Round 1 sends chunks, round 2 resends what failed in smaller chunks,
// round 3 sends each remaining string alone.
const queue = [];
for (const job of jobs) {
  for (const chunk of chunkUnits(job.todo))
    queue.push({ job, chunk, round: 1 });
}

// Writes every language, even untouched ones, so stale keys get pruned. Also
// runs every few minutes, so a stopped run keeps what it finished: the next
// run skips strings that already have a value.
function saveLanguages() {
  fs.mkdirSync(args.out, { recursive: true });
  for (const job of jobs) {
    const values = new Map();
    for (const unit of units) {
      const value =
        job.results.get(unit.id) ?? existingValue(unit, job.cats, job.existing);
      if (value != null) values.set(unit.id, value);
    }
    const text = toJson(buildLanguageFile(units, job.cats, values));
    const before = fs.existsSync(job.file)
      ? fs.readFileSync(job.file, "utf8")
      : null;
    if (text !== before) fs.writeFileSync(job.file, text);
  }
}

let done = 0;
let lastLog = 0;
let lastSave = Date.now();
async function worker() {
  while (queue.length) {
    const task = queue.shift();
    let bad;
    try {
      bad = await translateChunk(task.job, task.chunk);
    } catch (error) {
      for (const unit of task.chunk)
        task.job.failed.set(unit.id, error.message);
      bad = task.chunk;
    }
    done += task.chunk.length - bad.length;
    if (bad.length && task.round < ROUNDS) {
      const size = task.round === 1 ? 10 : 1;
      for (const chunk of chunkUnits(bad, size)) {
        queue.push({ job: task.job, chunk, round: task.round + 1 });
      }
    }
    if (Date.now() - lastSave > 5 * 60 * 1000) {
      lastSave = Date.now();
      saveLanguages();
    }
    if (Date.now() - lastLog > 15000) {
      lastLog = Date.now();
      console.log(`  ${done}/${total} translated`);
    }
  }
}

if (total > 0) {
  if (!process.env.TERMIX_LLM_API_KEY) {
    warn("TERMIX_LLM_API_KEY is not set, so translations were skipped.");
    writeSummary();
    process.exit(0);
  }
  try {
    const res = await fetch(`${BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${process.env.TERMIX_LLM_API_KEY}` },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (error) {
    warn(
      `The translation server is not reachable (${error.message}), so translations were skipped.`,
    );
    writeSummary();
    process.exit(0);
  }

  const started = Date.now();
  const concurrency = Math.max(1, Number(args.concurrency) || 8);
  await Promise.all(Array.from({ length: concurrency }, worker));
  console.log(
    `  ${done}/${total} translated in ${Math.round((Date.now() - started) / 1000)}s`,
  );
}

saveLanguages();
const rows = [];
for (const job of jobs) {
  rows.push(
    `| ${job.language.name} | ${job.results.size} | ${job.failed.size} |`,
  );
  for (const [id, problem] of [...job.failed].slice(0, 5)) {
    console.log(`  ${job.language.file} ${id}: ${problem}`);
  }
}

// A string is current once every language took it. Failed ones keep their old
// hash so the next run tries again.
const failedAnywhere = new Set(jobs.flatMap((job) => [...job.failed.keys()]));
const nextLock = {};
for (const unit of units) {
  if (!failedAnywhere.has(unit.id)) nextLock[unit.id] = unit.hash;
  else if (lock[unit.id]) nextLock[unit.id] = lock[unit.id];
}
if (!args.only) fs.writeFileSync(lockFile, toJson(nextLock));

const failures = jobs.reduce((sum, job) => sum + job.failed.size, 0);
if (failures)
  warn(
    `${failures} translations failed checks and stay in English until the next run.`,
  );
summary.push(
  "### Translations\n",
  "| Language | Translated | Failed |",
  "| --- | --- | --- |",
  ...rows,
);
writeSummary();
