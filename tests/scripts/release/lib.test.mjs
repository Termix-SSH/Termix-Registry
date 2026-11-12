import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import { isSigned } from "../../../scripts/lib.mjs";
import {
  insertChangelogSection,
  pickBranch,
  pickRepos,
  pluginIdOf,
  resolveVersion,
  signArtifact,
  stampJsonText,
  stampLockText,
} from "../../../scripts/release/lib.mjs";

const repos = [
  "Termix-SSH/Plugin-SSH-Terminal",
  "Termix-SSH/Plugin-Wake-On-LAN",
  "Termix-SSH/Plugin-Docker",
];

test("plugin ids come from the repo name", () => {
  assert.equal(pluginIdOf("Termix-SSH/Plugin-Wake-On-LAN"), "wake-on-lan");
});

test("pickRepos takes ids or repo names and refuses unknown ones", () => {
  assert.deepEqual(pickRepos("ssh-terminal, Plugin-Docker docker", repos), [
    "Termix-SSH/Plugin-SSH-Terminal",
    "Termix-SSH/Plugin-Docker",
  ]);
  assert.throws(() => pickRepos("ssh-termnal", repos), /not an official/);
  assert.throws(() => pickRepos(" , ", repos), /at least one/);
});

test("pickBranch uses the only dev branch", () => {
  const branches = ["main", "dev-1.2.0", "feature"];
  assert.equal(pickBranch({ branches, mode: "release" }), "dev-1.2.0");
  assert.equal(
    pickBranch({ branches, requested: "feature", mode: "release" }),
    "feature",
  );
  assert.throws(
    () => pickBranch({ branches, requested: "nope", mode: "release" }),
    /does not exist/,
  );
  assert.throws(
    () =>
      pickBranch({
        branches: ["main", "dev-1.0.0", "dev-1.1.0"],
        mode: "release",
      }),
    /more than one/,
  );
  assert.throws(
    () => pickBranch({ branches: ["main"], mode: "release" }),
    /no dev/,
  );
  assert.equal(pickBranch({ branches: ["main"], mode: "overwrite" }), "main");
});

test("resolveVersion follows the release rules", () => {
  const base = {
    mode: "release",
    branch: "dev-1.2.0",
    manifestVersion: "1.1.0",
  };
  assert.deepEqual(
    resolveVersion({ ...base, channel: "stable", tags: ["v1.1.0"] }),
    {
      version: "1.2.0",
      base: "1.2.0",
    },
  );
  assert.throws(
    () => resolveVersion({ ...base, channel: "stable", tags: ["v1.2.0"] }),
    /already released/,
  );
  assert.equal(
    resolveVersion({
      ...base,
      channel: "beta",
      tags: ["v1.2.0-beta.2", "v1.2.0-beta.10", "v1.1.0-beta.40"],
    }).version,
    "1.2.0-beta.11",
  );
  assert.throws(
    () =>
      resolveVersion({ ...base, branch: "main", channel: "stable", tags: [] }),
    /dev-X\.Y\.Z/,
  );
  assert.equal(
    resolveVersion({ ...base, mode: "overwrite", channel: "stable", tags: [] })
      .version,
    "1.1.0",
  );
  assert.throws(
    () =>
      resolveVersion({ ...base, mode: "overwrite", channel: "beta", tags: [] }),
    /overwrite/,
  );
  assert.throws(
    () => resolveVersion({ ...base, mode: "go", channel: "stable", tags: [] }),
    /mode must be/,
  );
});

test("stamping keeps formatting and the lock in step", () => {
  const text =
    '{\n  "name": "x",\n  "version": "1.0.0",\n  "dependencies": { "a": { "version": "9.9.9" } }\n}\n';
  const stamped = stampJsonText(text, "1.2.0", "package.json");
  assert.equal(
    stamped,
    text.replace('"version": "1.0.0"', '"version": "1.2.0"'),
  );
  assert.throws(
    () => stampJsonText('{"version":"1"}', "2", "x.json"),
    /Could not stamp/,
  );
  const lock = JSON.parse(
    stampLockText(
      JSON.stringify({ version: "1", packages: { "": { version: "1" } } }),
      "2",
    ),
  );
  assert.equal(lock.version, "2");
  assert.equal(lock.packages[""].version, "2");
});

test("insertChangelogSection puts the beta section first", () => {
  assert.equal(
    insertChangelogSection("# Changelog\n\n## 1.0.0\n", "## 1.1.0-beta.1\n\n"),
    "# Changelog\n\n## 1.1.0-beta.1\n\n## 1.0.0\n",
  );
});

test("signArtifact signs with the key and refuses one that is not published", () => {
  const pair = crypto.generateKeyPairSync("ed25519");
  const other = crypto.generateKeyPairSync("ed25519");
  const pem = pair.privateKey.export({ format: "pem", type: "pkcs8" });
  const buffer = Buffer.from("a plugin");
  const { sha256, signature } = signArtifact(buffer, pem, [
    { key: pair.publicKey },
  ]);
  assert.ok(
    isSigned(Buffer.from(sha256, "hex"), signature, [{ key: pair.publicKey }]),
  );
  assert.throws(
    () => signArtifact(buffer, pem, [{ key: other.publicKey }]),
    /does not match/,
  );
  assert.throws(() => signArtifact(buffer, "", []), /not set/);
});
