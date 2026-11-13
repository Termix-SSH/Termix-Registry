// Chain signatures in the plugin indexes. Each registry keeps the ones it has
// in <registry>/signatures.json, keyed "<id>@<version>", so a release keeps
// its signature on every sync without downloading anything. Sync copies
// them into the index next to each release, with the tier's certificates at
// the top.

import fs from "node:fs";
import path from "node:path";
import { allReleases, isSigned } from "../lib.mjs";
import { chainSigned, validCerts } from "./lib.mjs";

const storeFile = (dir) => path.join(dir, "signatures.json");

export function loadChainStore(dir) {
  const file = storeFile(dir);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
}

export function saveChainStore(dir, store) {
  const sorted = Object.fromEntries(
    Object.entries(store).sort(([a], [b]) => a.localeCompare(b)),
  );
  const next = `${JSON.stringify(sorted, null, 2)}\n`;
  const file = storeFile(dir);
  if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === next)
    return false;
  fs.writeFileSync(file, next);
  return true;
}

/** Adds a chain signature to the store if it checks out. */
export function storeSignature(
  store,
  { id, version, sha256, keyId, sig },
  certs,
) {
  const digest = Buffer.from(sha256, "hex");
  if (!chainSigned(digest, { keyId, sig }, certs)) return false;
  const key = `${id}@${version}`;
  const kept =
    (store[key]?.sha256 === sha256 ? store[key].signatures : []) ?? [];
  store[key] = {
    sha256,
    signatures: [
      ...kept.filter((item) => item.keyId !== keyId),
      { keyId, sig },
    ],
  };
  return true;
}

/** The tier's root signed, unrevoked plugin certificates. */
export function indexCerts(tier) {
  return validCerts(tier, "plugins");
}

/** Whether a release has a pre-chain or chain signature this registry accepts. */
export function releaseSigned(entry, legacyKeys, certs) {
  const digest = Buffer.from(entry.sha256 ?? "", "hex");
  if (entry.signature && isSigned(digest, entry.signature, legacyKeys))
    return true;
  return (entry.signatures ?? []).some((item) =>
    chainSigned(digest, item, certs),
  );
}

/**
 * Puts each release's checked chain signatures on it. Signatures whose key
 * lost its certificate (revoked) are dropped.
 */
export function attachChain(plugin, store, certs) {
  const fix = (list) =>
    list?.map((entry) => {
      const stored = store[`${plugin.id}@${entry.version}`];
      const digest = Buffer.from(entry.sha256, "hex");
      const candidates = [
        ...(entry.signatures ?? []),
        ...(stored?.sha256 === entry.sha256 ? stored.signatures : []),
      ];
      const seen = new Set();
      const signatures = candidates.filter((item) => {
        if (seen.has(item.keyId) || !chainSigned(digest, item, certs))
          return false;
        seen.add(item.keyId);
        return true;
      });
      const { signatures: _old, ...rest } = entry;
      return signatures.length > 0 ? { ...rest, signatures } : rest;
    });
  return {
    ...plugin,
    versions: fix(plugin.versions),
    ...(plugin.prereleases ? { prereleases: fix(plugin.prereleases) } : {}),
    ...(plugin.gated ? { gated: fix(plugin.gated) } : {}),
  };
}

/** Every release of every plugin, for scripts that walk the index. */
export function eachRelease(index, fn) {
  for (const plugin of index.plugins ?? []) {
    for (const entry of allReleases(plugin)) fn(plugin, entry);
  }
}
