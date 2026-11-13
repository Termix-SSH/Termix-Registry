// Throwaway root chains for tests: roots sign real SSHSIG like ssh-keygen.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  canonicalJson,
  onlineKeyId,
  publicKeyOf,
} from "../../../scripts/trust/lib.mjs";

function sshString(data) {
  const body = typeof data === "string" ? Buffer.from(data) : data;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length, 0);
  return Buffer.concat([length, body]);
}

export function makeRoot() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(12);
  const blob = Buffer.concat([sshString("ssh-ed25519"), sshString(raw)]);
  const line = `ssh-ed25519 ${blob.toString("base64")}`;
  const id = `SHA256:${crypto.createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
  const sign = (message) => {
    const signedData = Buffer.concat([
      Buffer.from("SSHSIG"),
      sshString("termix-root"),
      sshString(""),
      sshString("sha512"),
      sshString(crypto.createHash("sha512").update(message).digest()),
    ]);
    const sigBlob = Buffer.concat([
      sshString("ssh-ed25519"),
      sshString(crypto.sign(null, signedData, privateKey)),
    ]);
    const version = Buffer.alloc(4);
    version.writeUInt32BE(1, 0);
    const body = Buffer.concat([
      Buffer.from("SSHSIG"),
      version,
      sshString(blob),
      sshString("termix-root"),
      sshString(""),
      sshString("sha512"),
      sshString(sigBlob),
    ]).toString("base64");
    return `-----BEGIN SSH SIGNATURE-----\n${body.match(/.{1,70}/g).join("\n")}\n-----END SSH SIGNATURE-----\n`;
  };
  return { id, line, sign };
}

export function makeOnlineKey() {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKey = publicKeyOf(privateKey);
  return { privateKey, publicKey, keyId: onlineKeyId(publicKey) };
}

export function rootSign(signed, root) {
  return {
    signed,
    signatures: [
      { keyId: root.id, sig: root.sign(Buffer.from(canonicalJson(signed))) },
    ],
  };
}

export function makeCert(root, online, overrides = {}) {
  return rootSign(
    {
      type: "termix-key-cert",
      tier: "official",
      role: "plugins",
      keyId: online.keyId,
      publicKey: online.publicKey,
      notBefore: "2026-01-01T00:00:00Z",
      expires: "2099-01-01T00:00:00Z",
      ...overrides,
    },
    root,
  );
}

export function makeRevocations(root, overrides = {}) {
  return rootSign(
    {
      type: "termix-revocations",
      tier: "official",
      version: 1,
      issued: "2026-11-12T00:00:00Z",
      keys: [],
      plugins: [],
      versions: [],
      ...overrides,
    },
    root,
  );
}

/** A temp trust/ folder with official and community subfolders. */
export function trustFolder({
  official = [],
  community = [],
  certs = {},
  revocations = {},
} = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "termix-trust-"));
  for (const [tier, roots] of [
    ["official", official],
    ["community", community],
  ]) {
    const dir = path.join(base, tier);
    fs.mkdirSync(dir);
    fs.writeFileSync(
      path.join(dir, "root.pub"),
      roots.map((r) => r.line).join("\n") + "\n",
    );
    fs.writeFileSync(
      path.join(dir, "certs.json"),
      JSON.stringify(certs[tier] ?? []),
    );
    if (revocations[tier]) {
      fs.writeFileSync(
        path.join(dir, "revocations.json"),
        JSON.stringify(revocations[tier]),
      );
    }
  }
  return {
    base,
    dir: (tier) => path.join(base, tier),
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}
