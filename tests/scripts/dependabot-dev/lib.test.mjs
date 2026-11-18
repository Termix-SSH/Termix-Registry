import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applySpecs,
  checksGreen,
  decide,
  lockOnlyName,
  mirrorBranch,
  mirrorNote,
  newestDev,
  readNote,
  specChanges,
  staleCopies,
} from "../../../scripts/dependabot-dev/lib.mjs";

test("staleCopies finds copies whose dev branch is gone", () => {
  assert.deepEqual(
    staleCopies([
      "main",
      "dev-1.3.0",
      "deps/dev-1.3.0/npm_and_yarn/a",
      "deps/dev-1.2.0/npm_and_yarn/b",
      "dependabot/npm_and_yarn/c",
    ]),
    ["deps/dev-1.2.0/npm_and_yarn/b"],
  );
});

const pass = {
  __typename: "CheckRun",
  status: "COMPLETED",
  conclusion: "SUCCESS",
};
const fail = {
  __typename: "CheckRun",
  status: "COMPLETED",
  conclusion: "FAILURE",
};
const running = {
  __typename: "CheckRun",
  status: "IN_PROGRESS",
  conclusion: null,
};

test("newestDev sorts by version, not text", () => {
  assert.equal(newestDev(["main", "dev-1.9.0", "dev-1.10.0"]), "dev-1.10.0");
  assert.equal(newestDev(["main"]), null);
});

test("mirror branch and note round trip", () => {
  assert.equal(
    mirrorBranch("dev-1.2.0", "dependabot/npm_and_yarn/vitest-5.1.0"),
    "deps/dev-1.2.0/npm_and_yarn/vitest-5.1.0",
  );
  assert.deepEqual(readNote(`text\n${mirrorNote(12, "abc123")}`), {
    number: 12,
    sha: "abc123",
  });
  assert.equal(readNote("nothing"), null);
});

test("checksGreen needs every check done and none failed", () => {
  assert.equal(checksGreen([pass, { ...pass, conclusion: "SKIPPED" }]), true);
  assert.equal(checksGreen([pass, fail]), false);
  assert.equal(checksGreen([pass, running]), false);
  assert.equal(checksGreen([]), false);
  assert.equal(
    checksGreen([{ __typename: "StatusContext", state: "PENDING" }]),
    false,
  );
});

test("specs only move existing names up", () => {
  const pkg = `{\n  "devDependencies": {\n    "vitest": "^4.1.0",\n    "jsdom": "^32.0.0"\n  }\n}\n`;
  const news = specChanges(
    [
      '-    "vitest": "^4.1.0",',
      '+    "vitest": "^5.1.0",',
      '+    "jsdom": "^31.0.0",',
      '+    "left-pad": "^1.0.0"',
    ].join("\n"),
  );
  const out = JSON.parse(applySpecs(pkg, news));
  assert.equal(out.devDependencies.vitest, "^5.1.0");
  assert.equal(out.devDependencies.jsdom, "^32.0.0");
  assert.equal(out.devDependencies["left-pad"], undefined);
  assert.equal(applySpecs(pkg, { jsdom: "^31.0.0" }), null);
});

test("lockfile only titles name the package", () => {
  assert.equal(
    lockOnlyName("chore(deps): bump undici from 6.29.0 to 6.29.1"),
    "undici",
  );
  assert.equal(lockOnlyName("chore(deps): bump undici"), "undici");
});

test("decide", () => {
  const pr = {
    number: 3,
    headSha: "aaa",
    mergeable: "MERGEABLE",
    checks: [pass],
  };
  assert.equal(decide({ pr, dev: null }).kind, "merge-dependabot");
  assert.equal(
    decide({ pr: { ...pr, checks: [fail] }, dev: null }).kind,
    "wait",
  );
  assert.equal(decide({ pr, dev: "dev-1.0.0", mirror: null }).kind, "build");
  const body = mirrorNote(3, "aaa");
  const mirror = {
    state: "OPEN",
    body,
    mergeable: "MERGEABLE",
    checks: [pass],
  };
  assert.equal(decide({ pr, dev: "dev-1.0.0", mirror }).kind, "merge-mirror");
  assert.equal(
    decide({ pr, dev: "dev-1.0.0", mirror: { ...mirror, checks: [fail] } })
      .kind,
    "wait",
  );
  assert.equal(
    decide({
      pr,
      dev: "dev-1.0.0",
      mirror: { ...mirror, mergeable: "CONFLICTING" },
    }).kind,
    "rebuild",
  );
  assert.equal(
    decide({ pr: { ...pr, headSha: "bbb" }, dev: "dev-1.0.0", mirror }).kind,
    "rebuild",
  );
  assert.equal(
    decide({ pr, dev: "dev-1.0.0", mirror: { ...mirror, state: "MERGED" } })
      .kind,
    "close-dependabot",
  );
});
