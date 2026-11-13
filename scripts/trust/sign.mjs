// Signs everything waiting in trust/pending/ for the tier of the given root
// key, with ssh-keygen (it asks for the key's passphrase once), checks each
// signature against trust/<tier>/root.pub and moves the result into place:
// certificates into certs.json, a revocation list into revocations.json.
//
//   npm run trust:sign -- --key <root key file>
//
// ssh-keygen reads the key file where it is; no copy is made.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { root } from "../lib.mjs";
import {
  CERT_TYPE,
  REVOCATIONS_TYPE,
  ROOT_NAMESPACE,
  TIERS,
  canonicalJson,
  loadCerts,
  loadRevocations,
  loadRoots,
  sshFingerprint,
  trustDir,
  verifyRevocationList,
  verifyRootSigned,
} from "./lib.mjs";

export const pendingDir = (base = root) => path.join(base, "trust", "pending");

const GIT_SSH_KEYGEN = "C:/Program Files/Git/usr/bin/ssh-keygen.exe";

/**
 * Windows' own ssh-keygen refuses a key on a drive formatted exFAT or
 * FAT (those keep no file permissions), so on Windows the one from Git for
 * Windows is used when it is there. TERMIX_SSH_KEYGEN picks another.
 */
export function sshKeygen({
  platform = process.platform,
  env = process.env,
  exists = fs.existsSync,
} = {}) {
  if (env.TERMIX_SSH_KEYGEN) return env.TERMIX_SSH_KEYGEN;
  if (platform === "win32" && exists(GIT_SSH_KEYGEN)) return GIT_SSH_KEYGEN;
  return "ssh-keygen";
}

/** Pending documents of a tier, oldest revocation list first. */
export function pendingFor(tier, dir = pendingDir()) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => ({
      file: path.join(dir, name),
      doc: JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")),
    }))
    .filter(({ doc }) => doc?.signed?.tier === tier)
    .sort((a, b) => (a.doc.signed.version ?? 0) - (b.doc.signed.version ?? 0));
}

/**
 * Puts signed documents into a tier's files. Each must verify against the
 * tier's roots; a revocation list must be newer than the current one.
 */
export function placeSigned(tier, signed, dir = trustDir(tier)) {
  const roots = loadRoots(tier, dir);
  let certs = loadCerts(tier, dir);
  let revocations = loadRevocations(tier, dir);
  const placed = [];
  for (const doc of signed) {
    const check = verifyRootSigned(doc, roots);
    if (!check.ok) throw new Error(`${doc.signed.type}: ${check.reason}`);
    if (doc.signed.type === CERT_TYPE) {
      certs = [
        ...certs.filter((cert) => cert.signed.keyId !== doc.signed.keyId),
        doc,
      ];
      placed.push(`certificate for ${doc.signed.role} key ${doc.signed.keyId}`);
    } else if (doc.signed.type === REVOCATIONS_TYPE) {
      const current = revocations?.signed?.version ?? 0;
      if (doc.signed.version <= current) {
        throw new Error(
          `revocation list v${doc.signed.version} is not newer than v${current}`,
        );
      }
      const revokedRoots = new Set(
        (revocations?.signed?.keys ?? []).map((key) => key.keyId),
      );
      const result = verifyRevocationList(doc, tier, roots, revokedRoots);
      if (!result.ok) throw new Error(`revocation list: ${result.reason}`);
      revocations = doc;
      placed.push(`revocation list v${doc.signed.version}`);
    } else {
      throw new Error(`unknown document type ${doc.signed.type}`);
    }
  }
  fs.writeFileSync(
    path.join(dir, "certs.json"),
    `${JSON.stringify(certs, null, 2)}\n`,
  );
  if (revocations) {
    fs.writeFileSync(
      path.join(dir, "revocations.json"),
      `${JSON.stringify(revocations, null, 2)}\n`,
    );
  }
  return placed;
}

function main() {
  const { values } = parseArgs({ options: { key: { type: "string" } } });
  if (!values.key) throw new Error("Pass --key <root key file>");
  const pub = `${values.key}.pub`;
  if (!fs.existsSync(pub)) throw new Error(`${pub} not found next to the key`);
  const fingerprint = sshFingerprint(fs.readFileSync(pub, "utf8"));
  const tier = TIERS.find((name) =>
    loadRoots(name).some((r) => r.id === fingerprint),
  );
  if (!tier)
    throw new Error(`${fingerprint} is not a root key in trust/*/root.pub`);

  const pending = pendingFor(tier);
  if (pending.length === 0) {
    console.log(`Nothing waiting for the ${tier} root.`);
    return;
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "termix-sign-"));
  try {
    const files = pending.map(({ doc }, i) => {
      const file = path.join(temp, `doc-${i}.json`);
      fs.writeFileSync(file, canonicalJson(doc.signed));
      return file;
    });
    console.log(
      `Signing ${files.length} ${tier} document(s) with ${fingerprint}.`,
    );
    const result = spawnSync(
      sshKeygen(),
      ["-Y", "sign", "-f", values.key, "-n", ROOT_NAMESPACE, ...files],
      { stdio: "inherit" },
    );
    if (result.status !== 0) throw new Error("ssh-keygen did not sign");
    const signed = pending.map(({ doc }, i) => ({
      signed: doc.signed,
      signatures: [
        ...(doc.signatures ?? []),
        { keyId: fingerprint, sig: fs.readFileSync(`${files[i]}.sig`, "utf8") },
      ],
    }));
    for (const line of placeSigned(tier, signed))
      console.log(`  placed ${line}`);
    for (const { file } of pending) fs.rmSync(file);
    console.log("Done. Commit trust/ and push.");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(import.meta.filename)
) {
  main();
}
