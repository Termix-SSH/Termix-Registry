// Release gate checks, run by release-gate.yml and the plugin publish job.
//   ghsa-list --dir <repo>                 list GHSA regression tests, refuse skipped ones
//   ghsa-report --dir <repo> --report <f>  check the vitest JSON report of that run
//   code-scanning --repo <o/r> [--ref <branch>]...  refuse new high or critical CodeQL alerts
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  CODE_SCANNING_BASELINE,
  checkVitestReport,
  describeAlert,
  findGhsaTests,
  skipMarkers,
  triageAlerts,
} from "./lib.mjs";

function args(argv) {
  const out = { ref: [] };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, "");
    const value = argv[++i];
    if (key === "ref") out.ref.push(value);
    else out[key] = value;
  }
  return out;
}

function fail(message) {
  console.error(`::error::${message}`);
  process.exitCode = 1;
}

function ghsaList(opts) {
  const root = path.resolve(opts.dir ?? ".");
  const files = findGhsaTests(root);
  for (const file of files) {
    for (const hit of skipMarkers(
      fs.readFileSync(path.join(root, file), "utf8"),
    )) {
      fail(
        `${file}:${hit.line} skips or focuses a test (${hit.text}). Regression tests must always run.`,
      );
    }
  }
  if (opts.out)
    fs.writeFileSync(opts.out, files.join("\n") + (files.length ? "\n" : ""));
  console.log(
    files.length
      ? `GHSA regression tests:\n${files.join("\n")}`
      : "No GHSA regression tests in this repo.",
  );
}

function ghsaReport(opts) {
  const root = path.resolve(opts.dir ?? ".");
  const expected = findGhsaTests(root);
  let report;
  try {
    report = JSON.parse(fs.readFileSync(opts.report, "utf8"));
  } catch {
    fail(
      `No vitest report at ${opts.report}, so the GHSA tests did not finish.`,
    );
    return;
  }
  const problems = checkVitestReport(report, expected, root);
  for (const p of problems) fail(p);
  if (!problems.length)
    console.log(`All ${expected.length} GHSA regression test files passed.`);
}

async function listAlerts(repo, ref, token) {
  const alerts = [];
  for (let page = 1; page < 50; page++) {
    const url = new URL(
      `https://api.github.com/repos/${repo}/code-scanning/alerts`,
    );
    url.searchParams.set("state", "open");
    url.searchParams.set("tool_name", "CodeQL");
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));
    if (ref) url.searchParams.set("ref", `refs/heads/${ref}`);
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(
        `GitHub answered ${res.status} for ${repo} code scanning alerts. The token needs code scanning alerts read access.`,
      );
    }
    const batch = await res.json();
    alerts.push(...batch);
    if (batch.length < 100) break;
  }
  return alerts;
}

async function codeScanning(opts) {
  const token = process.env.GH_TOKEN;
  if (!token) return fail("GH_TOKEN is not set.");
  const refs = opts.ref.length ? opts.ref : [""];
  const seen = new Map();
  let analysed = 0;
  for (const ref of refs) {
    const alerts = await listAlerts(opts.repo, ref, token);
    if (alerts === null) {
      console.log(
        `::warning::No CodeQL analysis for ${ref || "the default branch"} of ${opts.repo}.`,
      );
      continue;
    }
    analysed++;
    for (const a of alerts) seen.set(a.number, a);
  }
  if (!analysed)
    return fail(
      `${opts.repo} has no CodeQL analysis at all. Turn on code scanning default setup.`,
    );
  const { blocking, backlog } = triageAlerts([...seen.values()]);
  if (backlog.length) {
    console.log(
      `::warning::${backlog.length} open high or critical CodeQL alert(s) from before ${CODE_SCANNING_BASELINE} still need triage (fix or dismiss with a reason).`,
    );
  }
  for (const a of blocking)
    fail(
      `Open CodeQL alert ${describeAlert(a)}. Fix it or dismiss it with a reason, then run again.`,
    );
  if (!blocking.length)
    console.log(`No new high or critical CodeQL alerts in ${opts.repo}.`);
}

const [command, ...rest] = process.argv.slice(2);
const opts = args(rest);
if (command === "ghsa-list") ghsaList(opts);
else if (command === "ghsa-report") ghsaReport(opts);
else if (command === "code-scanning") {
  await codeScanning(opts).catch((err) => fail(err.message));
} else {
  fail(
    `Unknown command ${command ?? ""}. Use ghsa-list, ghsa-report or code-scanning.`,
  );
}
