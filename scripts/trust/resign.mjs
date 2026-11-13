// Gives every release a registry lists a chain signature from the tier's
// online key, signed over the sha256 the index already holds (nothing is
// downloaded). Servers then move their installed plugins over on their own.
// Run after a new online key is certified, or to fill in older releases.
//
//   TERMIX_PLUGIN_ONLINE_KEY=... node scripts/trust/resign.mjs --tier official
//   TERMIX_COMMUNITY_ONLINE_KEY=... node scripts/trust/resign.mjs --tier community

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { loadPrivateKey, root } from "../lib.mjs";
import {
  eachRelease,
  indexCerts,
  loadChainStore,
  saveChainStore,
  storeSignature,
} from "./index-chain.mjs";
import { chainSign } from "./lib.mjs";

const ENV = {
  official: "TERMIX_PLUGIN_ONLINE_KEY",
  community: "TERMIX_COMMUNITY_ONLINE_KEY",
};

/** Signs what is missing a signature by this key. Returns how many it added. */
export function resign(tier, privateKey, dir = path.join(root, tier)) {
  const index = JSON.parse(
    fs.readFileSync(path.join(dir, "index.json"), "utf8"),
  );
  const certs = indexCerts(tier);
  const store = loadChainStore(dir);
  let added = 0;
  eachRelease(index, (plugin, entry) => {
    const digest = Buffer.from(entry.sha256, "hex");
    const { keyId, sig } = chainSign(digest, privateKey, {
      tier,
      role: "plugins",
    });
    const have = store[`${plugin.id}@${entry.version}`];
    if (
      have?.sha256 === entry.sha256 &&
      have.signatures.some((s) => s.keyId === keyId)
    ) {
      return;
    }
    if (
      storeSignature(
        store,
        {
          id: plugin.id,
          version: entry.version,
          sha256: entry.sha256,
          keyId,
          sig,
        },
        certs,
      )
    ) {
      added++;
    }
  });
  saveChainStore(dir, store);
  return added;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(import.meta.filename)
) {
  const { values } = parseArgs({ options: { tier: { type: "string" } } });
  if (!ENV[values.tier])
    throw new Error("Pass --tier official or --tier community");
  const key = loadPrivateKey(process.env[ENV[values.tier]]);
  if (!key) throw new Error(`${ENV[values.tier]} is not set`);
  const added = resign(values.tier, key);
  console.log(`${values.tier}: signed ${added} release(s)`);
}
