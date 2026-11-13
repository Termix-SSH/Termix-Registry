// Pure helpers for the release gate (release-gate.yml), kept apart so they
// can be tested without GitHub or vitest.
import fs from "node:fs";
import path from "node:path";

/** CodeQL alerts opened before this day are the old backlog: listed, not blocking. */
export const CODE_SCANNING_BASELINE = "2026-11-14";

const BLOCKING = new Set(["high", "critical"]);
const TEST_FILE =
  /^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}\.test\.(ts|tsx|js|mjs|cjs)$/;
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".git",
  "coverage",
  "release",
]);
// Anything that would let a regression test stop running without failing
const SKIPPERS =
  /\b(?:it|test|describe|suite|bench)\s*\.\s*(?:skip|only|todo|skipIf|runIf|fails)\b|\b(?:xit|xtest|xdescribe)\s*\(|\bctx\s*\.\s*skip\s*\(|\bcontext\s*\.\s*skip\s*\(/;

/** Every GHSA-xxxx-xxxx-xxxx.test.* file under a repo, relative and sorted. */
export function findGhsaTests(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
      } else if (TEST_FILE.test(entry.name)) {
        out.push(
          path
            .relative(root, path.join(dir, entry.name))
            .split(path.sep)
            .join("/"),
        );
      }
    }
  };
  walk(root);
  return out.sort();
}

/** Lines in a test file that skip, focus or mark tests, which the gate refuses. */
export function skipMarkers(text) {
  const hits = [];
  text.split("\n").forEach((line, i) => {
    const code = line
      .replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""')
      .replace(/\/\/.*$/, "");
    if (SKIPPERS.test(code)) hits.push({ line: i + 1, text: line.trim() });
  });
  return hits;
}

/**
 * Checks a vitest JSON report: every expected file ran, every test in it
 * passed and nothing was skipped or left as todo.
 */
export function checkVitestReport(report, expected, root) {
  const problems = [];
  const norm = (p) => path.relative(root, p).split(path.sep).join("/");
  const byFile = new Map();
  for (const r of report?.testResults ?? []) byFile.set(norm(r.name), r);
  for (const file of expected) {
    const result = byFile.get(file);
    if (!result) {
      problems.push(`${file} did not run`);
      continue;
    }
    const tests = result.assertionResults ?? [];
    if (tests.length === 0) problems.push(`${file} has no tests`);
    for (const t of tests) {
      if (t.status !== "passed")
        problems.push(`${file}: "${t.fullName ?? t.title}" ${t.status}`);
    }
    if (
      result.status !== "passed" &&
      tests.every((t) => t.status === "passed")
    ) {
      problems.push(
        `${file} failed: ${String(result.message ?? "").split("\n")[0]}`,
      );
    }
  }
  return problems;
}

/** Splits open code scanning alerts into ones that block the release and the old backlog. */
export function triageAlerts(alerts, since = CODE_SCANNING_BASELINE) {
  const blocking = [];
  const backlog = [];
  for (const a of alerts) {
    if (a.state !== "open") continue;
    if (!BLOCKING.has(a.rule?.security_severity_level)) continue;
    if (String(a.created_at).slice(0, 10) >= since) blocking.push(a);
    else backlog.push(a);
  }
  return { blocking, backlog };
}

export function describeAlert(a) {
  const loc = a.most_recent_instance?.location;
  const where = loc?.path ? `${loc.path}:${loc.start_line ?? 0}` : "repository";
  return `#${a.number} ${a.rule?.security_severity_level} ${a.rule?.id} at ${where} (${a.html_url})`;
}
