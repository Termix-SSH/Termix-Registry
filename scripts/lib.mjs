import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
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

function parseVersion(version) {
  const [core, ...rest] = String(version).split("+")[0].split("-");
  return {
    core: core.split(".").map((part) => Number.parseInt(part, 10) || 0),
    pre: rest.length ? rest.join("-").split(".") : [],
  };
}

export function isPrerelease(version) {
  return parseVersion(version).pre.length > 0;
}

/** Semver precedence: 1.1.0-beta.2 < 1.1.0-beta.10 < 1.1.0. */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    const diff = (pa.core[i] ?? 0) - (pb.core[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (!pa.pre.length || !pb.pre.length) {
    return pb.pre.length - pa.pre.length;
  }
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return diff;
    } else if (nx !== ny) {
      return nx ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
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

const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;

export async function github(url) {
  const response = await fetch(`https://api.github.com${url}`, {
    headers: {
      Accept: "application/vnd.github+json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response.json();
}

export async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

export function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest();
}

/** Base64 PKCS8 DER (what termix-plugin keygen writes) or a PEM block. */
export function loadPrivateKey(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return null;
  const key = trimmed.startsWith("-----BEGIN")
    ? crypto.createPrivateKey(trimmed)
    : crypto.createPrivateKey({
        key: Buffer.from(trimmed, "base64"),
        format: "der",
        type: "pkcs8",
      });
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("The signing key must be an Ed25519 key");
  }
  return key;
}

/** Ed25519 over the raw sha256, base64, the same as termix-plugin sign. */
export function signDigest(digest, privateKey) {
  return crypto.sign(null, digest, privateKey).toString("base64");
}

/**
 * Reads the manifest and release notes out of a release's .tmxplug and
 * checks they match the tag and file name. Returns { manifest, notes } or
 * a problem string.
 */
export function inspectArtifact(buffer, release, artifact) {
  const raw = readTmxplugFile(buffer, "manifest.json");
  if (!raw) return `no manifest.json in ${artifact.name}`;
  let manifest;
  try {
    manifest = JSON.parse(raw.toString("utf8"));
  } catch {
    return `manifest.json in ${artifact.name} is not valid JSON`;
  }
  if (`v${manifest.version}` !== release.tag_name) {
    return `manifest version is ${manifest.version}`;
  }
  if (artifact.name !== `${manifest.id}-${manifest.version}.tmxplug`) {
    return `${artifact.name} does not match ${manifest.id}`;
  }
  const changelog = readTmxplugFile(buffer, "CHANGELOG.md");
  const notes = changelog
    ? changelogSection(changelog.toString("utf8"), manifest.version)
    : null;
  return { manifest, notes };
}

/** One entry of an index's versions or prereleases list. */
export function versionEntry({
  manifest,
  notes,
  release,
  artifact,
  buffer,
  digest,
  signature,
}) {
  return {
    version: manifest.version,
    api: String(manifest.engine?.api ?? "").match(/\d+/)?.[0] ?? "",
    url: artifact.browser_download_url,
    sha256: digest.toString("hex"),
    signature,
    size: buffer.length,
    capabilities: manifest.capabilities ?? [],
    ...(manifest.dependencies && Object.keys(manifest.dependencies).length
      ? { dependencies: manifest.dependencies }
      : {}),
    releaseNotesUrl: release.html_url,
    ...(notes ? { notes: notes.slice(0, 20_000) } : {}),
    // The asset's upload time, so an overwritten release gets its new date.
    publishedAt: new Date(
      artifact.updated_at ?? release.published_at ?? Date.now(),
    ).toISOString(),
  };
}

/**
 * The manifest's docs link, or the registry's docsBase plus the id when the
 * manifest has none. Only https links get through.
 */
export function docsLink(manifest, docsBase) {
  const candidates = [
    manifest.docs,
    docsBase ? `${docsBase.replace(/\/+$/, "")}/${manifest.id}` : null,
  ];
  for (const value of candidates) {
    if (typeof value !== "string") continue;
    try {
      const url = new URL(value);
      if (url.protocol === "https:")
        return { docs: url.toString().replace(/\/$/, "") };
    } catch {
      // not a URL, try the next one
    }
  }
  return {};
}

/** The listing fields of an index entry, from the newest stable manifest. */
export function listing(manifest, repository, docsBase) {
  return {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    author: manifest.author?.name ?? String(manifest.author ?? ""),
    category: manifest.category,
    repository,
    icon: manifest.icon ?? "Puzzle",
    ...(typeof manifest.video === "string" ? { video: manifest.video } : {}),
    ...(Array.isArray(manifest.features) && manifest.features.length > 0
      ? { features: manifest.features }
      : {}),
    ...docsLink(manifest, docsBase),
  };
}

/** "owner/repo" from an https://github.com/owner/repo link, or null. */
export function githubRepo(url) {
  return (
    String(url ?? "").match(
      /^https:\/\/github\.com\/([A-Za-z0-9-]+\/[A-Za-z0-9._-]+?)(?:\.git)?\/?$/,
    )?.[1] ?? null
  );
}

/** The keys in keys/<registry>.pub, the only ones its index may use. */
export function keysFor(keys, registry) {
  return keys.filter(({ file }) => file === `${registry}.pub`);
}

/** The submissions in <registry>/plugins/*.json, sorted by file name. */
export function readSubmissions(dir) {
  const pluginsDir = path.join(dir, "plugins");
  if (!fs.existsSync(pluginsDir)) return [];
  return fs
    .readdirSync(pluginsDir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => ({
      file: path.join(pluginsDir, file),
      submission: JSON.parse(
        fs.readFileSync(path.join(pluginsDir, file), "utf8"),
      ),
    }));
}

/** Splits found releases into stable and the betas newer than stable. */
export function splitChannels(found) {
  found.sort((a, b) => compareVersions(b.manifest.version, a.manifest.version));
  const stable = found.filter(
    ({ manifest }) => !isPrerelease(manifest.version),
  );
  const newestStable = stable[0]?.manifest.version;
  const betas = found.filter(
    ({ manifest }) =>
      isPrerelease(manifest.version) &&
      (!newestStable || compareVersions(manifest.version, newestStable) > 0),
  );
  return { stable, betas };
}
