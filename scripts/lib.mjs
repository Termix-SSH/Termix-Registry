import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

export const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

// DER prefix of an Ed25519 SubjectPublicKeyInfo; the raw key follows.
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function loadKeys() {
  const dir = path.join(root, "keys");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".pub"))
    .map((file) => {
      const raw = Buffer.from(
        fs.readFileSync(path.join(dir, file), "utf8").trim(),
        "base64",
      );
      if (raw.length !== 32)
        throw new Error(`keys/${file} is not a 32-byte key`);
      return {
        file,
        key: crypto.createPublicKey({
          key: Buffer.concat([SPKI_PREFIX, raw]),
          format: "der",
          type: "spki",
        }),
      };
    });
}

/** True when the base64 signature over the raw sha256 matches a key. */
export function isSigned(digest, signature, keys) {
  const sig = Buffer.from(signature, "base64");
  if (sig.length !== 64) return false;
  return keys.some(({ key }) => crypto.verify(null, digest, key, sig));
}

export function compareVersions(a, b) {
  const pa = a.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const pb = b.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Reads one file out of a .tmxplug (a gzipped ustar archive). */
export function readTmxplugFile(buffer, wanted) {
  const tar = zlib.gunzipSync(buffer);
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, length) =>
      header
        .subarray(start, start + length)
        .toString("utf8")
        .replace(/\0.*$/s, "");
    const prefix = field(345, 155);
    const name = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
    const size = Number.parseInt(field(124, 12).trim() || "0", 8);
    const start = offset + 512;
    if (name === wanted) return tar.subarray(start, start + size);
    offset = start + Math.ceil(size / 512) * 512;
  }
  return null;
}

const RELEASE_HEADING =
  /^##\s+\[?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\]?(?:\s+-\s+.+?)?\s*$/;

/**
 * The Markdown under one version's heading in a CHANGELOG.md, or null. A
 * copy of changelogSection in the plugin SDK, which this repo does not use.
 */
export function changelogSection(markdown, version) {
  const lines = markdown.replace(/\r/g, "").split("\n");
  let start = -1;
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith("```")) fence = !fence;
    if (fence || !/^##\s/.test(line)) continue;
    if (start >= 0) return lines.slice(start, i).join("\n").trim() || null;
    const match = RELEASE_HEADING.exec(line.trim());
    if (match && match[1] === version) start = i + 1;
  }
  return start >= 0 ? lines.slice(start).join("\n").trim() || null : null;
}
