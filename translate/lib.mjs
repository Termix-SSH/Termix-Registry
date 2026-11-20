// Pure helpers for translate.mjs. No I/O here so they are easy to test.

import { createHash } from "node:crypto";

export const PLURAL_ORDER = ["zero", "one", "two", "few", "many", "other"];
const PLURAL_SUFFIX = new RegExp(`^(.+)_(${PLURAL_ORDER.join("|")})$`);
const PLACEHOLDER = /\{\{\s*[^{}]+?\s*\}\}/g;

/** Nested object -> ordered [dottedKey, value] pairs. */
export function flatten(obj, prefix = "", out = []) {
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      flatten(value, path, out);
    } else if (typeof value === "string") {
      out.push([path, value]);
    } else {
      throw new Error(`${path} must be a string`);
    }
  }
  return out;
}

/** Ordered [dottedKey, value] pairs -> nested object. */
export function unflatten(pairs) {
  const root = {};
  for (const [path, value] of pairs) {
    const parts = path.split(".");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (typeof node[part] !== "object") node[part] = {};
      node = node[part];
    }
    node[parts.at(-1)] = value;
  }
  return root;
}

export function hashText(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return createHash("sha1").update(text).digest("hex").slice(0, 12);
}

/**
 * Groups English strings into units. A plural group (`x_one`, `x_other`)
 * becomes one unit so every language can get its own plural forms.
 */
export function buildUnits(enPairs) {
  const en = new Map(enPairs);
  const units = [];
  const seenPlural = new Set();
  for (const [key, text] of enPairs) {
    // Old style: `x` is the singular of `x_other`, so it joins that group.
    if (en.has(`${key}_other`)) continue;
    const match = key.match(PLURAL_SUFFIX);
    if (match && en.has(`${match[1]}_other`)) {
      const base = match[1];
      if (seenPlural.has(base)) continue;
      seenPlural.add(base);
      const forms = {};
      for (const cat of PLURAL_ORDER) {
        if (en.has(`${base}_${cat}`)) forms[cat] = en.get(`${base}_${cat}`);
      }
      if (!forms.one && en.has(base)) forms.one = en.get(base);
      units.push({ id: base, plural: true, forms, hash: hashText(forms) });
    } else {
      units.push({ id: key, plural: false, text, hash: hashText(text) });
    }
  }
  return units;
}

export function pluralCategories(code) {
  const cats = new Intl.PluralRules(code).resolvedOptions().pluralCategories;
  return PLURAL_ORDER.filter((cat) => cats.includes(cat));
}

/** The keys a unit takes in a language file. */
export function unitKeys(unit, cats) {
  return unit.plural ? cats.map((cat) => `${unit.id}_${cat}`) : [unit.id];
}

/** Reads a unit's current value from a language file, or null if incomplete. */
export function existingValue(unit, cats, existing) {
  if (!unit.plural) return existing.get(unit.id) || null;
  const forms = {};
  for (const cat of cats) {
    const value = existing.get(`${unit.id}_${cat}`);
    if (!value) return null;
    forms[cat] = value;
  }
  return forms;
}

/** Whether a unit needs translating into a language. */
export function needsWork(unit, cats, existing, lockHash, retranslate) {
  if (retranslate) return true;
  if (lockHash !== undefined && lockHash !== unit.hash) return true;
  return existingValue(unit, cats, existing) === null;
}

/** Splits units into request-sized chunks, keeping order. */
export function chunkUnits(units, maxUnits = 60, maxChars = 5000) {
  const chunks = [];
  let current = [];
  let chars = 0;
  for (const unit of units) {
    const size = unit.plural
      ? Object.values(unit.forms).join("").length
      : unit.text.length;
    if (
      current.length &&
      (current.length >= maxUnits || chars + size > maxChars)
    ) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(unit);
    chars += size;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function placeholders(text) {
  return (text.match(PLACEHOLDER) ?? [])
    .map((p) => p.replace(/\s+/g, ""))
    .sort();
}

function edges(text) {
  return [
    text.match(/^\s*/)[0],
    text.match(/\s*$/)[0],
    (text.match(/\n/g) ?? []).length,
  ].join("|");
}

/** Returns a reason the translation is unusable, or null when it is fine. */
export function checkString(english, translated) {
  if (typeof translated !== "string") return "not a string";
  if (english.trim() && !translated.trim()) return "empty";
  if (placeholders(english).join() !== placeholders(translated).join()) {
    return `placeholders ${placeholders(english).join(" ")} vs ${placeholders(translated).join(" ")}`;
  }
  if (edges(english) !== edges(translated))
    return "whitespace or line breaks changed";
  return null;
}

export function checkUnit(unit, cats, value) {
  if (!unit.plural) return checkString(unit.text, value);
  if (!value || typeof value !== "object") return "not an object";
  const allowed = new Set(Object.values(unit.forms).flatMap(placeholders));
  for (const cat of cats) {
    const form = value[cat];
    if (typeof form !== "string" || !form.trim()) return `missing ${cat}`;
    const extra = placeholders(form).filter((p) => !allowed.has(p));
    if (extra.length) return `unknown placeholders ${extra.join(" ")}`;
    const reference = unit.forms[cat] ?? unit.forms.other;
    if (edges(reference) !== edges(form))
      return `${cat}: whitespace or line breaks changed`;
  }
  // `one` can say "One host", but the general form must keep every placeholder.
  const other = placeholders(unit.forms.other);
  const got = placeholders(value.other);
  if (!other.every((p) => got.includes(p)))
    return "other form lost a placeholder";
  return null;
}

/** Builds a language file in English key order. */
export function buildLanguageFile(units, cats, values) {
  const pairs = [];
  for (const unit of units) {
    const value = values.get(unit.id);
    if (value == null) continue;
    if (unit.plural) {
      for (const cat of cats) pairs.push([`${unit.id}_${cat}`, value[cat]]);
    } else {
      pairs.push([unit.id, value]);
    }
  }
  return unflatten(pairs);
}

export function toJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function buildPrompt(language, cats, glossary) {
  return [
    `You translate user interface strings for Termix, a self-hosted server management app (SSH terminal, file manager, remote desktop, tunnels, host metrics, Docker and more). Translate from English into ${language.name}.`,
    "",
    "Input is a JSON object of numbered entries. Return a JSON object with the same numbers.",
    '- An entry with "text": return its translation as a string.',
    `- An entry with "forms" is a plural. Return an object with exactly these plural categories for ${language.name}: ${cats.join(", ")}. Each must be correct for a count in that category. The "other" form must keep every placeholder from the English "other" form, like {{count}}.`,
    '- "key" is the string\'s id in the app. Use it only for context. Never translate or return it.',
    "",
    "Rules:",
    "- Keep {{placeholders}} exactly as written. Do not translate or remove them.",
    "- Keep line breaks, leading and trailing spaces, and Markdown.",
    "- Write short, natural UI text the way a native app in this language would. Use the usual words for common actions like Save, Cancel and Settings.",
    "- Be consistent: translate the same English term the same way everywhere.",
    "- Use a friendly, neutral tone. Address the user the way modern apps in this language do.",
    `- Never translate these names: ${glossary.keep.join(", ")}.`,
    "",
    "Meaning of common terms:",
    ...glossary.terms.map((term) => `- ${term}`),
  ].join("\n");
}

/** Request payload and JSON schema for one chunk. */
export function buildRequest(chunk, cats) {
  const input = {};
  const properties = {};
  const formSchema = {
    type: "object",
    properties: Object.fromEntries(
      cats.map((cat) => [cat, { type: "string" }]),
    ),
    required: cats,
    additionalProperties: false,
  };
  chunk.forEach((unit, index) => {
    const id = String(index + 1);
    input[id] = unit.plural
      ? { key: unit.id, forms: unit.forms }
      : { key: unit.id, text: unit.text };
    properties[id] = unit.plural ? formSchema : { type: "string" };
  });
  return {
    input,
    schema: {
      type: "object",
      properties,
      required: Object.keys(properties),
      additionalProperties: false,
    },
  };
}

/**
 * Reads a streamed chat completion and returns the message text. Streaming
 * keeps bytes flowing, so proxies that cut idle requests (Cloudflare stops
 * at about 100 seconds) never end a long one.
 */
export async function readStream(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let finish = null;
  const take = (line) => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    const event = JSON.parse(data);
    if (event.error) throw new Error(event.error.message ?? "stream error");
    const choice = event.choices?.[0];
    if (choice?.delta?.content) content += choice.delta.content;
    if (choice?.finish_reason) finish = choice.finish_reason;
  };
  for await (const chunk of body) {
    buffer +=
      typeof chunk === "string"
        ? chunk
        : decoder.decode(chunk, { stream: true });
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      take(buffer.slice(0, end).trim());
      buffer = buffer.slice(end + 1);
    }
  }
  take(buffer.trim());
  if (!finish) throw new Error("the stream ended early");
  return content;
}
