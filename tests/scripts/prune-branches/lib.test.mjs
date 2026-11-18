import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compareVersions,
  staleBranches,
} from "../../../scripts/prune-branches/lib.mjs";

test("compareVersions orders numbers, not text", () => {
  assert.ok(compareVersions("1.0.10", "1.0.9") > 0);
  assert.ok(compareVersions("26.11.2", "26.9.4") > 0);
  assert.equal(compareVersions("1.4.1", "1.4.1"), 0);
});

test("deletes released dev branches and keeps the next one", () => {
  assert.deepEqual(
    staleBranches({
      branches: ["main", "dev-1.0.1", "dev-1.1.0", "dev-1.2.0"],
      released: "1.1.0",
    }),
    ["dev-1.0.1", "dev-1.1.0"],
  );
});

test("deletes copies whose dev branch is gone or released", () => {
  assert.deepEqual(
    staleBranches({
      branches: [
        "main",
        "dev-1.2.0",
        "deps/dev-1.2.0/npm_and_yarn/a",
        "deps/dev-1.1.0/npm_and_yarn/b",
        "dependabot/npm_and_yarn/c",
      ],
      released: "1.1.0",
    }),
    ["deps/dev-1.1.0/npm_and_yarn/b"],
  );
});

test("keeps anything with an open PR", () => {
  assert.deepEqual(
    staleBranches({
      branches: ["dev-1.0.0", "deps/dev-0.9.0/x"],
      released: "1.0.0",
      openHeads: ["dev-1.0.0", "deps/dev-0.9.0/x"],
    }),
    [],
  );
});

test("a repo with no release keeps its dev branches", () => {
  assert.deepEqual(
    staleBranches({ branches: ["dev-1.0.0"], released: null }),
    [],
  );
});
