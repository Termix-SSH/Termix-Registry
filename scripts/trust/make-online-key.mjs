// Makes a new online signing key, stores it straight in a GitHub
// environment secret and writes the certificate the root must sign to
// trust/pending/. The private key only ever exists in memory and in the
// secret: it is never printed or written to disk.
//
//   node scripts/trust/make-online-key.mjs --tier official --role plugins \
//     --repo Termix-SSH/Termix-Registry --env release --secret TERMIX_PLUGIN_ONLINE_KEY
//
// Then sign it: npm run trust:sign -- --key <root key file>.

import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { root } from "../lib.mjs";
import {
  CERT_MONTHS,
  CERT_TYPE,
  TIERS,
  onlineKeyId,
  publicKeyOf,
} from "./lib.mjs";

const ROLES = { official: ["plugins", "releases"], community: ["plugins"] };

/** The unsigned certificate for a public key, valid from now. */
export function certPayload({ tier, role, publicKey, now = new Date() }) {
  if (!TIERS.includes(tier))
    throw new Error(`tier must be ${TIERS.join(" or ")}`);
  if (!ROLES[tier].includes(role)) {
    throw new Error(
      `a ${tier} key can only be for ${ROLES[tier].join(" or ")}`,
    );
  }
  const expires = new Date(now);
  expires.setUTCMonth(expires.getUTCMonth() + CERT_MONTHS);
  const day = (date) => `${date.toISOString().slice(0, 10)}T00:00:00Z`;
  return {
    signed: {
      type: CERT_TYPE,
      tier,
      role,
      keyId: onlineKeyId(publicKey),
      publicKey,
      notBefore: day(now),
      expires: day(expires),
    },
    signatures: [],
  };
}

function main() {
  const { values } = parseArgs({
    options: {
      tier: { type: "string" },
      role: { type: "string" },
      repo: { type: "string" },
      env: { type: "string" },
      secret: { type: "string" },
    },
  });
  for (const name of ["tier", "role", "repo", "env", "secret"]) {
    if (!values[name]) throw new Error(`Pass --${name}`);
  }
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKey = publicKeyOf(privateKey);
  const payload = certPayload({
    tier: values.tier,
    role: values.role,
    publicKey,
  });

  const secret = privateKey
    .export({ format: "der", type: "pkcs8" })
    .toString("base64");
  const result = spawnSync(
    "gh",
    [
      "secret",
      "set",
      values.secret,
      "--repo",
      values.repo,
      "--env",
      values.env,
    ],
    { input: secret, stdio: ["pipe", "inherit", "inherit"] },
  );
  if (result.status !== 0)
    throw new Error("gh secret set failed, nothing was written");

  const file = path.join(
    root,
    "trust",
    "pending",
    `${values.tier}-${values.role}-${payload.signed.keyId}.json`,
  );
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(
    `Set ${values.secret} in ${values.repo} (${values.env}).\n` +
      `key ${payload.signed.keyId}, public ${publicKey}\n` +
      `expires ${payload.signed.expires}\n` +
      `wrote ${path.relative(root, file)}, sign it with npm run trust:sign`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(import.meta.filename)
) {
  main();
}
