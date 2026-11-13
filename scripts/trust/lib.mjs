// The signing chain, Registry side. A copy of Termix core's
// src/backend/plugins/trust-chain.ts (keep them in step) plus the files in
// trust/: each tier's root.pub, certs.json and revocations.json.
//
// Root keys sign with ssh-keygen -Y sign -n termix-root over the canonical
// JSON of a document's `signed` part. Online keys are raw Ed25519 and sign a
// file's sha256.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { root } from "../lib.mjs";

export const ROOT_NAMESPACE = "termix-root";
export const TIERS = ["official", "community"];
export const CERT_TYPE = "termix-key-cert";
export const REVOCATIONS_TYPE = "termix-revocations";
/** Registry stops writing pre-chain signatures after this. */
export const LEGACY_UNTIL = Date.parse("2027-05-01T00:00:00Z");
/** How long a new online key certificate lasts. */
export const CERT_MONTHS = 12;

const SK_ED25519 = "sk-ssh-ed25519@openssh.com";
const SSH_ED25519 = "ssh-ed25519";
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export const trustDir = (tier) => path.join(root, "trust", tier);

export function canonicalJson(value) {
  if (value === null || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error("canonical JSON only holds whole numbers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  throw new Error(`canonical JSON can't hold a ${typeof value}`);
}

export function onlineKeyId(publicKey) {
  return crypto
    .createHash("sha256")
    .update(Buffer.from(publicKey, "base64"))
    .digest("hex")
    .slice(0, 16);
}

export function rawPublicKey(base64) {
  if (typeof base64 !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(base64)) {
    return null;
  }
  try {
    return crypto.createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, Buffer.from(base64, "base64")]),
      format: "der",
      type: "spki",
    });
  } catch {
    return null;
  }
}

/** Raw base64 public key of an Ed25519 private key. */
export function publicKeyOf(privateKey) {
  return crypto
    .createPublicKey(privateKey)
    .export({ format: "der", type: "spki" })
    .subarray(12)
    .toString("base64");
}

function reader(buf) {
  let offset = 0;
  const bytes = (length) => {
    if (offset + length > buf.length) throw new Error("truncated");
    const out = buf.subarray(offset, offset + length);
    offset += length;
    return out;
  };
  const u32 = () => bytes(4).readUInt32BE(0);
  return {
    bytes,
    u8: () => bytes(1)[0],
    u32,
    string: () => bytes(u32()),
    done: () => offset === buf.length,
  };
}

function sshString(data) {
  const body = typeof data === "string" ? Buffer.from(data) : data;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length, 0);
  return Buffer.concat([length, body]);
}

function parseKeyBlob(blob) {
  const r = reader(blob);
  const type = r.string().toString("latin1");
  const ed25519 = r.string();
  if (ed25519.length !== 32) throw new Error("not an Ed25519 key");
  if (type === SSH_ED25519) {
    if (!r.done()) throw new Error("extra bytes in the key");
    return { type, blob, ed25519 };
  }
  if (type === SK_ED25519) {
    const application = r.string();
    if (!r.done()) throw new Error("extra bytes in the key");
    return { type, blob, ed25519, application };
  }
  throw new Error(`unsupported key type ${type}`);
}

export function parseSshPublicKey(line) {
  const [type, base64] = String(line).trim().split(/\s+/);
  const key = parseKeyBlob(Buffer.from(base64 || "", "base64"));
  if (key.type !== type) throw new Error("key type does not match its data");
  return key;
}

export function sshFingerprint(line) {
  const { blob } = parseSshPublicKey(line);
  return `SHA256:${crypto
    .createHash("sha256")
    .update(blob)
    .digest("base64")
    .replace(/=+$/, "")}`;
}

export function verifySshSignature(
  armored,
  message,
  keys,
  namespace = ROOT_NAMESPACE,
) {
  try {
    const match =
      /^-----BEGIN SSH SIGNATURE-----\s+([A-Za-z0-9+/=\s]+?)\s+-----END SSH SIGNATURE-----$/.exec(
        String(armored).trim(),
      );
    if (!match) return { ok: false, reason: "not an SSH signature" };
    const r = reader(Buffer.from(match[1].replace(/\s+/g, ""), "base64"));
    if (r.bytes(6).toString("latin1") !== "SSHSIG") {
      return { ok: false, reason: "not an SSH signature" };
    }
    if (r.u32() !== 1)
      return { ok: false, reason: "unsupported SSH signature version" };
    const keyBlob = r.string();
    const ns = r.string();
    const reserved = r.string();
    const hashAlg = r.string().toString("latin1");
    const sigBlob = r.string();
    if (!r.done()) return { ok: false, reason: "extra bytes in the signature" };
    if (ns.toString("utf8") !== namespace) {
      return { ok: false, reason: "signature is for another purpose" };
    }
    if (hashAlg !== "sha256" && hashAlg !== "sha512") {
      return { ok: false, reason: "unsupported hash in the signature" };
    }
    const rootKey = keys.find((candidate) => {
      try {
        return parseSshPublicKey(candidate.publicKey).blob.equals(keyBlob);
      } catch {
        return false;
      }
    });
    if (!rootKey)
      return { ok: false, reason: "signed by a key that is not a root" };
    const key = parseKeyBlob(keyBlob);
    const signedData = Buffer.concat([
      Buffer.from("SSHSIG"),
      sshString(ns),
      sshString(reserved),
      sshString(hashAlg),
      sshString(crypto.createHash(hashAlg).update(message).digest()),
    ]);
    const sig = reader(sigBlob);
    const sigType = sig.string().toString("latin1");
    const raw = sig.string();
    if (sigType !== key.type || raw.length !== 64) {
      return { ok: false, reason: "signature does not match the key type" };
    }
    let data = signedData;
    if (key.type === SK_ED25519) {
      const flags = sig.u8();
      const counter = sig.u32();
      if ((flags & 0x01) === 0) {
        return { ok: false, reason: "security key was not touched" };
      }
      const counterBytes = Buffer.alloc(4);
      counterBytes.writeUInt32BE(counter, 0);
      data = Buffer.concat([
        crypto.createHash("sha256").update(key.application).digest(),
        Buffer.from([flags]),
        counterBytes,
        crypto.createHash("sha256").update(signedData).digest(),
      ]);
    }
    if (!sig.done())
      return { ok: false, reason: "extra bytes in the signature" };
    const publicKey = rawPublicKey(key.ed25519.toString("base64"));
    if (!publicKey || !crypto.verify(null, data, publicKey, raw)) {
      return { ok: false, reason: "root signature does not match" };
    }
    return { ok: true, keyId: rootKey.id };
  } catch {
    return { ok: false, reason: "signature could not be read" };
  }
}

export function verifyRootSigned(doc, roots) {
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.signatures)) {
    return { ok: false, reason: "document has no signatures" };
  }
  if (roots.length === 0)
    return { ok: false, reason: "no root key to check with" };
  let message;
  try {
    message = Buffer.from(canonicalJson(doc.signed), "utf8");
  } catch {
    return { ok: false, reason: "document is not plain JSON" };
  }
  let reason = "no root signature";
  for (const entry of doc.signatures) {
    const result = verifySshSignature(entry?.sig, message, roots);
    if (result.ok) return { ok: true, rootId: result.keyId };
    reason = result.reason;
  }
  return { ok: false, reason };
}

/** check: { tier, role, roots, checkDates, now, revokedKeys } */
export function verifyCertificate(cert, check) {
  const body = cert?.signed;
  if (!body || body.type !== CERT_TYPE)
    return { ok: false, reason: "not a key certificate" };
  if (body.tier !== check.tier) {
    return {
      ok: false,
      reason: `certificate is for the ${String(body.tier)} tier`,
    };
  }
  if (body.role !== check.role) {
    return { ok: false, reason: `certificate is for ${String(body.role)}` };
  }
  const publicKey = rawPublicKey(body.publicKey);
  if (!publicKey || onlineKeyId(body.publicKey) !== body.keyId) {
    return { ok: false, reason: "certificate key is not valid" };
  }
  const revoked = check.revokedKeys ?? new Set();
  if (revoked.has(body.keyId)) {
    return { ok: false, reason: `signing key ${body.keyId} is revoked` };
  }
  const roots = check.roots.filter((r) => !revoked.has(r.id));
  const signed = verifyRootSigned(cert, roots);
  if (!signed.ok) return signed;
  if (check.checkDates) {
    const now = check.now ?? Date.now();
    const notBefore = Date.parse(body.notBefore);
    const expires = Date.parse(body.expires);
    if (!Number.isFinite(notBefore) || !Number.isFinite(expires)) {
      return { ok: false, reason: "certificate dates are not valid" };
    }
    if (now < notBefore)
      return { ok: false, reason: "certificate is not valid yet" };
    if (now >= expires) return { ok: false, reason: "certificate has expired" };
  }
  return { ok: true, keyId: body.keyId, publicKey, rootId: signed.rootId };
}

export function verifyRevocationList(
  doc,
  tier,
  roots,
  alreadyRevoked = new Set(),
) {
  const body = doc?.signed;
  if (!body || body.type !== REVOCATIONS_TYPE || body.tier !== tier) {
    return { ok: false, reason: "not a revocation list for this tier" };
  }
  if (!Number.isSafeInteger(body.version) || body.version < 1) {
    return { ok: false, reason: "revocation list has no valid version" };
  }
  const revoked = new Set([
    ...alreadyRevoked,
    ...(Array.isArray(body.keys) ? body.keys : []).map((k) => k?.keyId),
  ]);
  const signed = verifyRootSigned(
    doc,
    roots.filter((r) => !revoked.has(r.id)),
  );
  return signed.ok ? { ok: true, list: body } : signed;
}

/** The two root keys of a tier, from trust/<tier>/root.pub. */
export function loadRoots(tier, dir = trustDir(tier)) {
  const file = path.join(dir, "root.pub");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const [type, data] = line.split(/\s+/);
      const publicKey = `${type} ${data}`;
      return { id: sshFingerprint(publicKey), publicKey };
    });
}

function readJson(file, fallback) {
  return fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf8"))
    : fallback;
}

export function loadCerts(tier, dir = trustDir(tier)) {
  return readJson(path.join(dir, "certs.json"), []);
}

export function loadRevocations(tier, dir = trustDir(tier)) {
  return readJson(path.join(dir, "revocations.json"), null);
}

/** Key ids revoked for a tier; the official list counts for both. */
export function revokedKeys(tier, dir) {
  const base = dir ? path.dirname(dir) : path.join(root, "trust");
  const ids = new Set();
  for (const name of tier === "community" ? TIERS : ["official"]) {
    const list = loadRevocations(name, path.join(base, name));
    for (const key of list?.signed?.keys ?? []) ids.add(key.keyId);
  }
  return ids;
}

/**
 * Root signed, unrevoked certificates of a tier and role. With checkDates,
 * only ones in date now.
 */
export function validCerts(tier, role, { checkDates = false, now, dir } = {}) {
  const roots = loadRoots(tier, dir);
  const revoked = revokedKeys(tier, dir);
  return loadCerts(tier, dir).filter(
    (cert) =>
      verifyCertificate(cert, {
        tier,
        role,
        roots,
        checkDates,
        now,
        revokedKeys: revoked,
      }).ok,
  );
}

/**
 * Signs a digest with an online key after checking a valid, in date
 * certificate for it exists, so a wrong or expired key fails here and not on
 * every server.
 */
export function chainSign(digest, privateKey, { tier, role, now, dir } = {}) {
  const keyId = onlineKeyId(publicKeyOf(privateKey));
  const cert = validCerts(tier, role, { checkDates: true, now, dir }).find(
    (item) => item.signed.keyId === keyId,
  );
  if (!cert) {
    throw new Error(`no valid ${tier} ${role} certificate for key ${keyId}`);
  }
  return {
    keyId,
    sig: crypto.sign(null, digest, privateKey).toString("base64"),
    cert,
  };
}

/** Whether a chain signature over digest checks out against a tier's certs. */
export function chainSigned(digest, signature, certs) {
  const cert = certs.find((item) => item.signed.keyId === signature?.keyId);
  if (!cert || typeof signature?.sig !== "string") return false;
  const key = rawPublicKey(cert.signed.publicKey);
  const sig = Buffer.from(signature.sig, "base64");
  return (
    Boolean(key) && sig.length === 64 && crypto.verify(null, digest, key, sig)
  );
}
