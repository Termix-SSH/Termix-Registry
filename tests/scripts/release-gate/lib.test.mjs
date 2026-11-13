import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  checkVitestReport,
  findGhsaTests,
  skipMarkers,
  triageAlerts,
} from "../../../scripts/release-gate/lib.mjs";

function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-"));
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return root;
}

test("finds GHSA tests and skips node_modules and dist", () => {
  const root = tree({
    "src/backend/tests/auth/GHSA-892r-827c-jphx.test.ts": "",
    "tests/frontend/GHSA-q5v9-x2h3-7hv4.test.tsx": "",
    "scripts/GHSA-8q7r-m68w-rm3h.test.ts": "",
    "node_modules/x/GHSA-aaaa-bbbb-cccc.test.ts": "",
    "dist/GHSA-aaaa-bbbb-cccc.test.js": "",
    "tests/backend/GHSA-notes.md": "",
    "tests/backend/other.test.ts": "",
  });
  assert.deepEqual(findGhsaTests(root), [
    "scripts/GHSA-8q7r-m68w-rm3h.test.ts",
    "src/backend/tests/auth/GHSA-892r-827c-jphx.test.ts",
    "tests/frontend/GHSA-q5v9-x2h3-7hv4.test.tsx",
  ]);
});

test("flags tests that would stop running without failing", () => {
  for (const line of [
    'it.skip("x", () => {})',
    'describe.only("x", () => {})',
    'test.todo("x")',
    'it.skipIf(process.env.CI)("x", () => {})',
    'it.runIf(false)("x", () => {})',
    'it.fails("x", () => {})',
    'xit("x", () => {})',
    "  ctx.skip();",
  ]) {
    assert.equal(skipMarkers(line).length, 1, line);
  }
  assert.deepEqual(
    skipMarkers('it("refuses", () => {})\n// it.skip is not allowed'),
    [],
  );
  assert.deepEqual(
    skipMarkers('const skip = list.skip(1); expect(x).toBe("it.only")'),
    [],
  );
});

test("a report must hold every expected file with only passed tests", () => {
  const root = path.resolve("/repo");
  const ok = {
    testResults: [
      {
        name: path.join(root, "a/GHSA-aaaa-bbbb-cccc.test.ts"),
        status: "passed",
        assertionResults: [{ fullName: "refuses", status: "passed" }],
      },
    ],
  };
  assert.deepEqual(
    checkVitestReport(ok, ["a/GHSA-aaaa-bbbb-cccc.test.ts"], root),
    [],
  );

  const missing = checkVitestReport(
    { testResults: [] },
    ["a/GHSA-aaaa-bbbb-cccc.test.ts"],
    root,
  );
  assert.match(missing[0], /did not run/);

  const skipped = structuredClone(ok);
  skipped.testResults[0].assertionResults.push({
    fullName: "other",
    status: "skipped",
  });
  assert.match(
    checkVitestReport(skipped, ["a/GHSA-aaaa-bbbb-cccc.test.ts"], root)[0],
    /skipped/,
  );

  const empty = structuredClone(ok);
  empty.testResults[0].assertionResults = [];
  assert.match(
    checkVitestReport(empty, ["a/GHSA-aaaa-bbbb-cccc.test.ts"], root)[0],
    /no tests/,
  );

  const crashed = structuredClone(ok);
  crashed.testResults[0].status = "failed";
  crashed.testResults[0].message = "Cannot find module";
  assert.match(
    checkVitestReport(crashed, ["a/GHSA-aaaa-bbbb-cccc.test.ts"], root)[0],
    /Cannot find module/,
  );
});

test("only new high and critical alerts block", () => {
  const alert = (number, level, created_at, state = "open") => ({
    number,
    state,
    created_at,
    rule: { security_severity_level: level },
  });
  const { blocking, backlog } = triageAlerts(
    [
      alert(1, "high", "2026-10-11T00:00:00Z"),
      alert(2, "critical", "2026-11-20T00:00:00Z"),
      alert(3, "medium", "2026-11-20T00:00:00Z"),
      alert(4, "high", "2026-11-20T00:00:00Z", "dismissed"),
      alert(5, null, "2026-11-20T00:00:00Z"),
      alert(6, "high", "2026-11-14T00:00:00Z"),
    ],
    "2026-11-14",
  );
  assert.deepEqual(
    blocking.map((a) => a.number),
    [2, 6],
  );
  assert.deepEqual(
    backlog.map((a) => a.number),
    [1],
  );
});
