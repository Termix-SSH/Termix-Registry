// Writes the next revocation list of a tier to trust/pending/ for a root to
// sign. Every entry already on the list stays on it.
//
//   node scripts/trust/revoke.mjs --tier official --init
//   node scripts/trust/revoke.mjs --tier official --key <keyId> --reason "leaked"
//   node scripts/trust/revoke.mjs --tier official --plugin docker@1.2.0 --reason "bad build"
//   node scripts/trust/revoke.mjs --tier official --plugin docker --reason "removed"
//
// --key takes an online key id or a root fingerprint (SHA256:...).

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { root } from "../lib.mjs";
import { REVOCATIONS_TYPE, TIERS, loadRevocations } from "./lib.mjs";

const ID = /^[a-z0-9][a-z0-9-]*$/;

/** The next list body: the current one plus the new entries. */
export function nextRevocations(
  current,
  { tier, keys = [], plugins = [], reason, now = new Date() },
) {
  if (!TIERS.includes(tier))
    throw new Error(`tier must be ${TIERS.join(" or ")}`);
  const body = current?.signed;
  const next = {
    type: REVOCATIONS_TYPE,
    tier,
    version: (body?.version ?? 0) + 1,
    issued: now.toISOString().replace(/\.\d+Z$/, "Z"),
    keys: [...(body?.keys ?? [])],
    plugins: [...(body?.plugins ?? [])],
    versions: [...(body?.versions ?? [])],
  };
  const why = reason ? { reason } : {};
  for (const keyId of keys) {
    if (!next.keys.some((key) => key.keyId === keyId))
      next.keys.push({ keyId, ...why });
  }
  for (const spec of plugins) {
    const [id, version] = spec.split("@");
    if (!ID.test(id ?? "")) throw new Error(`${spec} is not a plugin id`);
    if (version) {
      if (!next.versions.some((v) => v.id === id && v.version === version)) {
        next.versions.push({ id, version, ...why });
      }
    } else if (!next.plugins.some((p) => p.id === id)) {
      next.plugins.push({ id, ...why });
    }
  }
  return { signed: next, signatures: [] };
}

function main() {
  const { values } = parseArgs({
    options: {
      tier: { type: "string" },
      init: { type: "boolean" },
      key: { type: "string", multiple: true },
      plugin: { type: "string", multiple: true },
      reason: { type: "string" },
    },
  });
  const current = loadRevocations(values.tier);
  if (!values.init && !values.key && !values.plugin) {
    throw new Error("Pass --init, --key or --plugin");
  }
  if (values.init && current)
    throw new Error(`${values.tier} already has a list`);
  const payload = nextRevocations(current, {
    tier: values.tier,
    keys: values.key ?? [],
    plugins: values.plugin ?? [],
    reason: values.reason,
  });
  const file = path.join(
    root,
    "trust",
    "pending",
    `${values.tier}-revocations-v${payload.signed.version}.json`,
  );
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(
    `wrote ${path.relative(root, file)}, sign it with npm run trust:sign`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(import.meta.filename)
) {
  main();
}
