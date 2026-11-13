import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  canonicalJson,
  chainSign,
  chainSigned,
  loadRoots,
  validCerts,
  verifyCertificate,
  verifyRevocationList,
  verifySshSignature,
} from "../../../scripts/trust/lib.mjs";
import { checkTrust } from "../../../scripts/trust/check.mjs";
import { placeSigned, sshKeygen } from "../../../scripts/trust/sign.mjs";
import { certPayload } from "../../../scripts/trust/make-online-key.mjs";
import { nextRevocations } from "../../../scripts/trust/revoke.mjs";
import {
  makeCert,
  makeOnlineKey,
  makeRevocations,
  makeRoot,
  rootSign,
  trustFolder,
} from "./fixture.mjs";

// The root keys Termix core compiles in (trust-chain.ts ROOT_KEYS).
const CORE_ROOTS = {
  official: [
    "SHA256:a549NEiGOOvwpBvYPZno6/bgGsdTarnF+ExL9UmPQRk",
    "SHA256:CtQKKIHB6UaIt2pSOAXwAPpkczI1Bqbual66doeqeoc",
  ],
  community: [
    "SHA256:SF4INojl+/wyBBec06AfBx6Y5QC+Rl8H0r+WfCrVeuI",
    "SHA256:XVcMEf9p+KYrPeK96DWNM1MBibXS+1IMc9eSlzcq8bw",
  ],
};

test("trust/*/root.pub holds the same roots core trusts", () => {
  for (const tier of ["official", "community"]) {
    assert.deepEqual(
      loadRoots(tier).map((r) => r.id),
      CORE_ROOTS[tier],
    );
  }
});

test("the real trust/ folder checks out", () => {
  const { errors } = checkTrust();
  assert.deepEqual(errors, []);
});

test("canonicalJson sorts keys and refuses fractions", () => {
  assert.equal(
    canonicalJson({ b: [1, { d: 1, c: 2 }], a: "x" }),
    '{"a":"x","b":[1,{"c":2,"d":1}]}',
  );
  assert.throws(() => canonicalJson({ a: 0.5 }));
});

test("a signature from real ssh-keygen verifies, and a wrong namespace does not", (t) => {
  const check = spawnSync("ssh-keygen", ["-?"], { encoding: "utf8" });
  if (check.error) return t.skip("ssh-keygen is not installed");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "termix-sshsig-"));
  try {
    const key = path.join(dir, "root");
    spawnSync("ssh-keygen", [
      "-q",
      "-t",
      "ed25519",
      "-N",
      "",
      "-C",
      "test",
      "-f",
      key,
    ]);
    const message = path.join(dir, "doc.json");
    fs.writeFileSync(message, canonicalJson({ a: 1 }));
    for (const ns of ["termix-root", "git"]) {
      const r = spawnSync("ssh-keygen", [
        "-Y",
        "sign",
        "-f",
        key,
        "-n",
        ns,
        message,
      ]);
      assert.equal(r.status, 0);
      const sig = fs.readFileSync(`${message}.sig`, "utf8");
      fs.rmSync(`${message}.sig`);
      const line = fs.readFileSync(`${key}.pub`, "utf8");
      const roots = [
        { id: "root", publicKey: line.split(" ").slice(0, 2).join(" ") },
      ];
      const result = verifySshSignature(sig, fs.readFileSync(message), roots);
      assert.equal(result.ok, ns === "termix-root");
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("certificates check tier, role, dates, key id and root", () => {
  const root = makeRoot();
  const online = makeOnlineKey();
  const roots = [{ id: root.id, publicKey: root.line }];
  const base = {
    tier: "official",
    role: "plugins",
    roots,
    checkDates: true,
    now: Date.parse("2026-12-01"),
  };
  assert.equal(verifyCertificate(makeCert(root, online), base).ok, true);
  assert.equal(
    verifyCertificate(makeCert(root, online, { role: "releases" }), base).ok,
    false,
  );
  assert.equal(
    verifyCertificate(makeCert(root, online, { tier: "community" }), base).ok,
    false,
  );
  assert.equal(
    verifyCertificate(
      makeCert(root, online, { expires: "2026-11-30T00:00:00Z" }),
      base,
    ).reason,
    "certificate has expired",
  );
  assert.equal(verifyCertificate(makeCert(makeRoot(), online), base).ok, false);
  assert.equal(
    verifyCertificate(makeCert(root, online), {
      ...base,
      revokedKeys: new Set([online.keyId]),
    }).ok,
    false,
  );
});

test("chainSign needs an in date certificate for the key and validCerts drops revoked ones", () => {
  const root = makeRoot();
  const online = makeOnlineKey();
  const expired = makeOnlineKey();
  const folder = trustFolder({
    official: [root, makeRoot()],
    certs: {
      official: [
        makeCert(root, online),
        makeCert(root, expired, { expires: "2026-01-02T00:00:00Z" }),
      ],
    },
  });
  try {
    const digest = crypto.createHash("sha256").update("file").digest();
    const signed = chainSign(digest, online.privateKey, {
      tier: "official",
      role: "plugins",
      dir: folder.dir("official"),
    });
    assert.equal(signed.keyId, online.keyId);
    assert.equal(chainSigned(digest, signed, [signed.cert]), true);
    assert.equal(
      chainSigned(
        crypto.createHash("sha256").update("other").digest(),
        signed,
        [signed.cert],
      ),
      false,
    );
    assert.throws(
      () =>
        chainSign(digest, expired.privateKey, {
          tier: "official",
          role: "plugins",
          dir: folder.dir("official"),
        }),
      /no valid official plugins certificate/,
    );
    assert.throws(
      () =>
        chainSign(digest, online.privateKey, {
          tier: "official",
          role: "releases",
          dir: folder.dir("official"),
        }),
      /no valid/,
    );
  } finally {
    folder.cleanup();
  }

  const revokedFolder = trustFolder({
    official: [root],
    certs: { official: [makeCert(root, online)] },
    revocations: {
      official: makeRevocations(root, { keys: [{ keyId: online.keyId }] }),
    },
  });
  try {
    assert.deepEqual(
      validCerts("official", "plugins", { dir: revokedFolder.dir("official") }),
      [],
    );
  } finally {
    revokedFolder.cleanup();
  }
});

test("placeSigned files certificates and only newer revocation lists", () => {
  const a = makeRoot();
  const b = makeRoot();
  const online = makeOnlineKey();
  const folder = trustFolder({ official: [a, b] });
  const dir = folder.dir("official");
  try {
    placeSigned(
      "official",
      [makeCert(a, online), makeRevocations(b, { version: 1 })],
      dir,
    );
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(dir, "certs.json"), "utf8")).length,
      1,
    );
    assert.throws(
      () => placeSigned("official", [makeRevocations(a, { version: 1 })], dir),
      /not newer/,
    );
    assert.throws(
      () => placeSigned("official", [makeCert(makeRoot(), online)], dir),
      /root/,
    );
    // The backup revokes the primary, which then can't sign the next list.
    placeSigned(
      "official",
      [makeRevocations(b, { version: 2, keys: [{ keyId: a.id }] })],
      dir,
    );
    assert.throws(() =>
      placeSigned("official", [makeRevocations(a, { version: 3 })], dir),
    );
  } finally {
    folder.cleanup();
  }
});

test("certPayload and nextRevocations build what the root signs", () => {
  const online = makeOnlineKey();
  const cert = certPayload({
    tier: "official",
    role: "releases",
    publicKey: online.publicKey,
    now: new Date("2026-11-12T10:00:00Z"),
  });
  assert.equal(cert.signed.keyId, online.keyId);
  assert.equal(cert.signed.notBefore, "2026-11-12T00:00:00Z");
  assert.equal(cert.signed.expires, "2027-11-12T00:00:00Z");
  assert.throws(() =>
    certPayload({
      tier: "community",
      role: "releases",
      publicKey: online.publicKey,
    }),
  );

  const first = nextRevocations(null, {
    tier: "official",
    now: new Date("2026-11-12T00:00:00Z"),
  });
  assert.equal(first.signed.version, 1);
  const root = makeRoot();
  const signed = rootSign(first.signed, root);
  const next = nextRevocations(signed, {
    tier: "official",
    keys: ["k1"],
    plugins: ["docker@1.2.0", "evil"],
    reason: "bad",
  });
  assert.equal(next.signed.version, 2);
  assert.deepEqual(next.signed.keys, [{ keyId: "k1", reason: "bad" }]);
  assert.deepEqual(next.signed.versions, [
    { id: "docker", version: "1.2.0", reason: "bad" },
  ]);
  assert.deepEqual(next.signed.plugins, [{ id: "evil", reason: "bad" }]);
  assert.throws(() =>
    nextRevocations(null, { tier: "official", plugins: ["Bad Id"] }),
  );
  const again = nextRevocations(rootSign(next.signed, root), {
    tier: "official",
    keys: ["k1"],
  });
  assert.equal(again.signed.keys.length, 1);
  assert.equal(
    verifyRevocationList(rootSign(again.signed, root), "official", [
      { id: root.id, publicKey: root.line },
    ]).ok,
    true,
  );
});

test("sshKeygen avoids Windows' own ssh-keygen, which refuses keys on exFAT drives", () => {
  const yes = () => true;
  const no = () => false;
  assert.equal(
    sshKeygen({ platform: "win32", env: {}, exists: yes }),
    "C:/Program Files/Git/usr/bin/ssh-keygen.exe",
  );
  assert.equal(
    sshKeygen({ platform: "win32", env: {}, exists: no }),
    "ssh-keygen",
  );
  assert.equal(
    sshKeygen({ platform: "linux", env: {}, exists: yes }),
    "ssh-keygen",
  );
  assert.equal(
    sshKeygen({
      platform: "win32",
      env: { TERMIX_SSH_KEYGEN: "x" },
      exists: yes,
    }),
    "x",
  );
});
