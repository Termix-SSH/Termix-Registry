// Fails only on vulnerabilities that have a fixed version newer than the
// installed one. Ones with no fix yet are listed as warnings.
import fs from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

function parts(version) {
  const [main, pre = ""] = String(version).replace(/^v/, "").split(/-(.*)/s);
  const nums = main
    .split("+")[0]
    .split(".")
    .map((n) => Number.parseInt(n, 10) || 0);
  while (nums.length < 3) nums.push(0);
  return { nums, pre };
}

/** Negative when a < b, positive when a > b. Enough semver for fix checks. */
export function compareVersions(a, b) {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < 3; i++) {
    if (x.nums[i] !== y.nums[i]) return x.nums[i] - y.nums[i];
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** Fixed versions newer than the installed one, from the OSV record. */
export function fixesFor(vuln, name, version) {
  const fixes = new Set();
  for (const affected of vuln.affected ?? []) {
    if (affected.package?.name !== name) continue;
    for (const range of affected.ranges ?? []) {
      if (range.type !== "SEMVER" && range.type !== "ECOSYSTEM") continue;
      for (const event of range.events ?? []) {
        if (event.fixed && compareVersions(event.fixed, version) > 0) {
          fixes.add(event.fixed);
        }
      }
    }
  }
  return [...fixes].sort(compareVersions);
}

/** Splits an osv-scanner JSON report into fixable and unfixed findings. */
export function gate(report) {
  const fixable = [];
  const unfixed = [];
  const seen = new Set();
  for (const result of report.results ?? []) {
    for (const pkg of result.packages ?? []) {
      const { name, version } = pkg.package ?? {};
      for (const vuln of pkg.vulnerabilities ?? []) {
        const key = `${name}@${version} ${vuln.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const fixes = fixesFor(vuln, name, version);
        const row = {
          name,
          version,
          id: vuln.id,
          summary: vuln.summary ?? "",
          fixes,
        };
        (fixes.length ? fixable : unfixed).push(row);
      }
    }
  }
  return { fixable, unfixed };
}

// Report text comes from the OSV database, so it can't start a new workflow command.
export function escapeCommand(text) {
  return String(text)
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  const report = JSON.parse(fs.readFileSync(file, "utf8"));
  const { fixable, unfixed } = gate(report);
  const escape = (strings, ...values) =>
    strings.reduce(
      (out, part, i) =>
        out + part + (i < values.length ? escapeCommand(values[i]) : ""),
      "",
    );
  for (const row of unfixed) {
    console.log(
      escape`::warning::${row.name}@${row.version} ${row.id} has no fix yet: ${row.summary}`,
    );
  }
  for (const row of fixable) {
    console.log(
      escape`::error::${row.name}@${row.version} ${row.id} is fixed in ${row.fixes.join(", ")}: ${row.summary}`,
    );
  }
  if (fixable.length) {
    console.log(
      `${fixable.length} known vulnerabilities have a fix. Update the lockfile, or add an override in package.json.`,
    );
    process.exit(1);
  }
  console.log(
    `No fixable vulnerabilities (${unfixed.length} without a fix yet).`,
  );
}
