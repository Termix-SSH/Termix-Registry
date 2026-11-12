import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compareVersions,
  escapeCommand,
  fixesFor,
  gate,
} from "../../.github/actions/supply-chain/osv-gate.mjs";

function vuln(id, name, events) {
  return {
    id,
    summary: `${id} summary`,
    affected: [{ package: { name }, ranges: [{ type: "SEMVER", events }] }],
  };
}

function report(name, version, vulns) {
  return {
    results: [
      { packages: [{ package: { name, version }, vulnerabilities: vulns }] },
    ],
  };
}

test("versions compare like semver", () => {
  assert.ok(compareVersions("1.4.3", "1.4.0") > 0);
  assert.ok(compareVersions("14.0.2", "12.0.0") > 0);
  assert.ok(compareVersions("1.0.0-beta.1", "1.0.0") < 0);
  assert.equal(compareVersions("v2.0.0", "2.0.0"), 0);
});

test("a vulnerability with a newer fixed version fails the gate", () => {
  const result = gate(
    report("qs", "6.16.0", [
      vuln("GHSA-a", "qs", [{ introduced: "0" }, { fixed: "6.16.1" }]),
    ]),
  );
  assert.equal(result.fixable.length, 1);
  assert.deepEqual(result.fixable[0].fixes, ["6.16.1"]);
});

test("a fix only in a newer major still counts as a fix", () => {
  const result = gate(
    report("glob", "12.0.0", [
      vuln("GHSA-b", "glob", [{ introduced: "9.0.0" }, { fixed: "14.0.2" }]),
    ]),
  );
  assert.equal(result.fixable.length, 1);
});

test("a vulnerability with no fix is only a warning", () => {
  const result = gate(
    report("deepmerge", "4.3.1", [
      vuln("GHSA-c", "deepmerge", [{ introduced: "0" }]),
    ]),
  );
  assert.equal(result.fixable.length, 0);
  assert.equal(result.unfixed.length, 1);
});

test("fixes for older branches or other packages are ignored", () => {
  const record = {
    id: "GHSA-d",
    affected: [
      {
        package: { name: "undici" },
        ranges: [
          {
            type: "SEMVER",
            events: [{ introduced: "6.0.0" }, { fixed: "6.29.1" }],
          },
        ],
      },
      {
        package: { name: "other" },
        ranges: [
          {
            type: "SEMVER",
            events: [{ introduced: "0" }, { fixed: "99.0.0" }],
          },
        ],
      },
    ],
  };
  assert.deepEqual(fixesFor(record, "undici", "8.12.2"), []);
});

test("report text can't start a workflow command", () => {
  assert.equal(escapeCommand("a\n::error::b%"), "a%0A::error::b%25");
});
