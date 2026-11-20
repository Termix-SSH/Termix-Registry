// Deletes dependabot/ and deps/ branches that no open PR uses. Branches get
// left behind when a person closes a Dependabot PR, since Dependabot only
// cleans up after itself.
//
// With LIST=1 it prints the JSON list of repos (from the App installation)
// that have such branches. With REPO set it prunes that repo.
// env: GH_TOKEN, REPO (name in Termix-SSH), DRY_RUN=1 to only list.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { prunable } from "./lib.mjs";

const ORG = "Termix-SSH";
const UPDATE = /^(dependabot|deps)\//;

function api(path) {
  const r = spawnSync("gh", ["api", "--paginate", "--slurp", path], {
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });
  if (r.status !== 0) throw new Error(`gh api ${path} failed\n${r.stderr}`);
  return JSON.parse(r.stdout).flatMap((page) =>
    Array.isArray(page) ? page : (page.repositories ?? [page]),
  );
}

const updateBranches = (full) =>
  api(`repos/${full}/branches?per_page=100`)
    .map((b) => b.name)
    .filter((n) => UPDATE.test(n));

if (process.env.LIST === "1") {
  const repos = api("installation/repositories?per_page=100")
    .filter((r) => !r.archived)
    .filter((r) => updateBranches(r.full_name).length)
    .map((r) => r.name);
  const line = `repos=${JSON.stringify(repos)}`;
  console.log(line);
  if (process.env.GITHUB_OUTPUT)
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`);
  process.exit(0);
}

const repo = process.env.REPO;
if (!/^[A-Za-z0-9._-]+$/.test(repo ?? "")) throw new Error("bad REPO");
const full = `${ORG}/${repo}`;
const dryRun = process.env.DRY_RUN === "1";

const names = updateBranches(full);
const openHeads = api(`repos/${full}/pulls?state=open&per_page=100`)
  .filter((p) => p.head.repo?.full_name === full)
  .map((p) => p.head.ref);
const branches = names
  .filter((name) => !openHeads.includes(name))
  .map((name) => {
    const [b] = api(`repos/${full}/branches/${encodeURIComponent(name)}`);
    return { name, date: b.commit.commit.committer.date };
  });

let failed = 0;
const stale = prunable(branches, openHeads, Date.now());
for (const name of stale) {
  console.log(`${dryRun ? "would delete" : "deleting"} ${name}`);
  if (dryRun) continue;
  const r = spawnSync(
    "gh",
    ["api", "-X", "DELETE", `repos/${full}/git/refs/heads/${name}`],
    { encoding: "utf8" },
  );
  if (r.status !== 0) {
    failed++;
    console.log(`::warning::${full}: could not delete ${name}`);
  }
}
console.log(`${full}: ${stale.length} stale, ${failed} failed`);
