import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  attachChain,
  loadChainStore,
  releaseSigned,
  saveChainStore,
  storeSignature,
} from "../../../scripts/trust/index-chain.mjs";
import {
  REPRODUCE_FROM,
  compare,
  isReproduced,
  record,
} from "../../../scripts/release/reproduce-check.mjs";
import { makeCert, makeOnlineKey, makeRoot } from "./fixture.mjs";

const root = makeRoot();
const online = makeOnlineKey();
const cert = makeCert(root, online);
const file = Buffer.from("plugin bytes");
const sha256 = crypto.createHash("sha256").update(file).digest("hex");
const sig = crypto
  .sign(null, Buffer.from(sha256, "hex"), online.privateKey)
  .toString("base64");

test("storeSignature keeps only signatures that check out", () => {
  const bytes = Buffer.from(sig, "base64");
  bytes[0] ^= 0xff;
  const flipped = bytes.toString("base64");
  const store = {};
  assert.equal(
    storeSignature(
      store,
      { id: "docker", version: "1.0.0", sha256, keyId: online.keyId, sig },
      [cert],
    ),
    true,
  );
  assert.equal(
    storeSignature(
      store,
      {
        id: "docker",
        version: "1.1.0",
        sha256,
        keyId: online.keyId,
        sig: flipped,
      },
      [cert],
    ),
    false,
  );
  assert.deepEqual(Object.keys(store), ["docker@1.0.0"]);
});

test("attachChain adds stored signatures and drops ones whose key lost its cert", () => {
  const store = {
    "docker@1.0.0": { sha256, signatures: [{ keyId: online.keyId, sig }] },
  };
  const plugin = { id: "docker", versions: [{ version: "1.0.0", sha256 }] };
  const withSig = attachChain(plugin, store, [cert]);
  assert.deepEqual(withSig.versions[0].signatures, [
    { keyId: online.keyId, sig },
  ]);
  const revoked = attachChain(withSig, store, []);
  assert.equal(revoked.versions[0].signatures, undefined);
  const otherFile = attachChain(
    { id: "docker", versions: [{ version: "1.0.0", sha256: "b".repeat(64) }] },
    store,
    [cert],
  );
  assert.equal(otherFile.versions[0].signatures, undefined);
});

test("releaseSigned takes a chain or a pre-chain signature", () => {
  const legacy = crypto.generateKeyPairSync("ed25519");
  const legacySig = crypto
    .sign(null, Buffer.from(sha256, "hex"), legacy.privateKey)
    .toString("base64");
  const keys = [{ key: legacy.publicKey }];
  assert.equal(releaseSigned({ sha256, signature: legacySig }, keys, []), true);
  assert.equal(
    releaseSigned(
      { sha256, signatures: [{ keyId: online.keyId, sig }] },
      [],
      [cert],
    ),
    true,
  );
  assert.equal(
    releaseSigned({ sha256, signature: legacySig }, [], [cert]),
    false,
  );
  assert.equal(releaseSigned({ sha256 }, keys, [cert]), false);
});

test("the store file round trips and reports when it changed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "termix-store-"));
  try {
    const store = {
      "b@1.0.0": { sha256, signatures: [] },
      "a@1.0.0": { sha256, signatures: [] },
    };
    assert.equal(saveChainStore(dir, store), true);
    assert.equal(saveChainStore(dir, loadChainStore(dir)), false);
    assert.deepEqual(Object.keys(loadChainStore(dir)), ["a@1.0.0", "b@1.0.0"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("isReproduced lets older releases through and waits on new ones until recorded", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "termix-repro-"));
  try {
    const before = new Date(REPRODUCE_FROM - 1).toISOString();
    const after = new Date(REPRODUCE_FROM + 1).toISOString();
    assert.equal(
      isReproduced(
        { id: "docker", version: "1.0.0", sha256, publishedAt: before },
        dir,
      ),
      true,
    );
    assert.equal(
      isReproduced(
        { id: "docker", version: "1.1.0", sha256, publishedAt: after },
        dir,
      ),
      false,
    );
    record(
      {
        id: "docker",
        version: "1.1.0",
        sha256,
        run: "https://example.com/run",
      },
      dir,
    );
    assert.equal(
      isReproduced(
        { id: "docker", version: "1.1.0", sha256, publishedAt: after },
        dir,
      ),
      true,
    );
    assert.equal(
      isReproduced(
        {
          id: "docker",
          version: "1.1.0",
          sha256: "c".repeat(64),
          publishedAt: after,
        },
        dir,
      ),
      false,
    );
    assert.throws(
      () => record({ id: "../x", version: "1", sha256 }, dir),
      /bad plugin id/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("compare refuses a rebuild that differs from the published file", async () => {
  const { gzipSync } = await import("node:zlib");
  // A tiny .tmxplug: one tar entry holding manifest.json.
  const manifest = Buffer.from(
    JSON.stringify({ id: "docker", version: "1.1.0" }),
  );
  const header = Buffer.alloc(512);
  header.write("manifest.json");
  header.write("0000644\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(manifest.length.toString(8).padStart(11, "0") + "\0", 124);
  header.write("00000000000\0", 136);
  header.write("        ", 148);
  header.write("0", 156);
  header.write("ustar\u000000", 257);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  const pad = Buffer.alloc((512 - (manifest.length % 512)) % 512);
  const archive = gzipSync(
    Buffer.concat([header, manifest, pad, Buffer.alloc(1024)]),
  );
  const hex = crypto.createHash("sha256").update(archive).digest("hex");
  const release = (digest) => ({
    assets: [{ name: "docker-1.1.0.tmxplug", digest: `sha256:${digest}` }],
  });

  assert.deepEqual(
    compare(archive, "docker-1.1.0.tmxplug", release(hex), "v1.1.0"),
    {
      id: "docker",
      version: "1.1.0",
      sha256: hex,
    },
  );
  assert.throws(
    () =>
      compare(
        archive,
        "docker-1.1.0.tmxplug",
        release("d".repeat(64)),
        "v1.1.0",
      ),
    /did not rebuild/,
  );
  assert.throws(
    () => compare(archive, "docker-1.1.0.tmxplug", release(hex), "v1.2.0"),
    /the tag is/,
  );
  assert.throws(
    () => compare(archive, "other-1.1.0.tmxplug", release(hex), "v1.1.0"),
    /does not match/,
  );
});
