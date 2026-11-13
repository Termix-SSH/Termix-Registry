// Checks trust/: each tier has two root keys, every certificate and
// revocation list is signed by a root of its tier, and nothing pending is
// malformed. Warns when a certificate in use expires within 60 days.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  CERT_TYPE,
  REVOCATIONS_TYPE,
  TIERS,
  loadCerts,
  loadRevocations,
  loadRoots,
  revokedKeys,
  trustDir,
  verifyCertificate,
  verifyRevocationList,
} from "./lib.mjs";
import { pendingDir } from "./sign.mjs";

const WARN_DAYS = 60;

export function checkTrust({ now = Date.now(), base } = {}) {
  const errors = [];
  const warnings = [];
  for (const tier of TIERS) {
    const dir = base ? path.join(base, tier) : trustDir(tier);
    const roots = loadRoots(tier, dir);
    if (roots.length !== 2)
      errors.push(`${tier}: root.pub must hold 2 keys, has ${roots.length}`);
    const revoked = revokedKeys(tier, dir);
    const list = loadRevocations(tier, dir);
    if (list) {
      const result = verifyRevocationList(list, tier, roots);
      if (!result.ok) errors.push(`${tier} revocations: ${result.reason}`);
    }
    for (const cert of loadCerts(tier, dir)) {
      const where = `${tier} cert ${cert?.signed?.keyId}`;
      const result = verifyCertificate(cert, {
        tier,
        role: cert?.signed?.role,
        roots,
        checkDates: false,
      });
      if (!result.ok) {
        errors.push(`${where}: ${result.reason}`);
        continue;
      }
      if (revoked.has(cert.signed.keyId)) continue;
      const left = (Date.parse(cert.signed.expires) - now) / 86_400_000;
      if (left < 0) warnings.push(`${where} (${cert.signed.role}) has expired`);
      else if (left < WARN_DAYS) {
        warnings.push(
          `${where} (${cert.signed.role}) expires in ${Math.ceil(left)} days`,
        );
      }
    }
  }
  const pending = base ? path.join(base, "pending") : pendingDir();
  if (fs.existsSync(pending)) {
    for (const name of fs
      .readdirSync(pending)
      .filter((n) => n.endsWith(".json"))) {
      try {
        const doc = JSON.parse(
          fs.readFileSync(path.join(pending, name), "utf8"),
        );
        if (![CERT_TYPE, REVOCATIONS_TYPE].includes(doc?.signed?.type)) {
          errors.push(`pending/${name}: not a certificate or revocation list`);
        }
      } catch {
        errors.push(`pending/${name}: not valid JSON`);
      }
    }
  }
  return { errors, warnings };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(import.meta.filename)
) {
  const { errors, warnings } = checkTrust();
  for (const warning of warnings) console.log(`::warning::${warning}`);
  for (const error of errors) console.error(`::error::${error}`);
  if (errors.length > 0) process.exit(1);
  console.log("trust files ok");
}
