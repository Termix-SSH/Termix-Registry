// Moves one repo's Dependabot PRs onto its newest dev branch.
// Dependabot only opens PRs against main, but work lands on dev-* and a
// release turns main into the dev tree, so updates merged into main get lost.
//
// Per run and repo: each Dependabot PR gets a mirror PR against dev with the
// same change (package.json edits plus a fresh lockfile, other files as a
// 3-way patch). A green mirror is squash merged and its Dependabot PR closed.
// At most one merge per run, since the lockfile of the others then changes;
// the next run rebuilds the ones that conflict. A repo with no dev branch
// gets its first green Dependabot PR merged as is.
//
// env: REPO (name in Termix-SSH), TARGET_DIR (checkout of it, origin can
// push), GH_TOKEN (App token: contents, pull requests and workflows write),
// READ_TOKEN (any token that can read public PR checks).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  applySpecs,
  decide,
  lockOnlyName,
  mirrorBranch,
  mirrorNote,
  newestDev,
  readNote,
  specChanges,
  staleCopies,
} from "./lib.mjs";

const ORG = "Termix-SSH";
const repo = process.env.REPO;
const dir = path.resolve(process.env.TARGET_DIR ?? "target");
const full = `${ORG}/${repo}`;
if (!/^[A-Za-z0-9._-]+$/.test(repo ?? "")) throw new Error("bad REPO");

function sh(cmd, args, { ok = false, input, token, cwd = dir } = {}) {
  const env = { ...process.env };
  if (token) env.GH_TOKEN = token;
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    input,
    env,
    maxBuffer: 1 << 30,
  });
  if (r.status !== 0 && !ok)
    throw new Error(
      `${cmd} ${args.join(" ")} failed\n${r.stdout}\n${r.stderr}`,
    );
  return r;
}
const git = (...a) => sh("git", a).stdout.trim();
const gh = (args, opts) => sh("gh", args, opts).stdout;
const read = (args) =>
  JSON.parse(
    gh(args, { token: process.env.READ_TOKEN || undefined }) || "null",
  );

const PR_FIELDS =
  "number,title,url,state,body,headRefName,headRefOid,baseRefName,mergeable,statusCheckRollup";

function listDependabot() {
  return read([
    "pr",
    "list",
    "-R",
    full,
    "--author",
    "app/dependabot",
    "--state",
    "open",
    "--limit",
    "100",
    "--json",
    PR_FIELDS,
  ]).map((p) => ({ ...p, headSha: p.headRefOid, checks: p.statusCheckRollup }));
}

function findMirror(branch) {
  const list = read([
    "pr",
    "list",
    "-R",
    full,
    "--head",
    branch,
    "--state",
    "all",
    "--limit",
    "5",
    "--json",
    PR_FIELDS,
  ]).map((p) => ({ ...p, checks: p.statusCheckRollup }));
  return (
    list.find((p) => p.state === "OPEN") ??
    list.find((p) => p.state === "MERGED") ??
    list[0] ??
    null
  );
}

function comment(number, body) {
  gh(["pr", "comment", String(number), "-R", full, "--body", body]);
}

function closePr(number, body) {
  if (body) comment(number, body);
  // Dependabot only deletes its branch when it closes the PR itself.
  gh(["pr", "close", String(number), "-R", full, "--delete-branch"]);
}

function squash(number, branch) {
  // The App is a bypass actor, so the API merges without the review rule.
  gh([
    "api",
    "-X",
    "PUT",
    `repos/${full}/pulls/${number}/merge`,
    "-f",
    "merge_method=squash",
  ]);
  // Merging through the API leaves the head branch behind.
  sh("gh", ["api", "-X", "DELETE", `repos/${full}/git/refs/heads/${branch}`], {
    ok: true,
  });
}

let botIdentity = null;
function identity() {
  if (!botIdentity) {
    const slug = "termix-ci[bot]";
    const id = JSON.parse(gh(["api", `users/${encodeURIComponent(slug)}`])).id;
    botIdentity = {
      name: slug,
      email: `${id}+${slug}@users.noreply.github.com`,
    };
  }
  return botIdentity;
}

/** Recreates the Dependabot change on top of dev. Returns false if dev has it. */
function build(pr, dev, branch) {
  const ref = `pr-${pr.number}`;
  git("fetch", "-q", "--depth=2", "origin", `+pull/${pr.number}/head:${ref}`);
  git(
    "fetch",
    "-q",
    "--depth=1",
    "origin",
    `+refs/heads/${dev}:refs/remotes/origin/${dev}`,
  );
  git("checkout", "-q", "-f", "-B", branch, `origin/${dev}`);
  git("clean", "-fdq");

  const files = git("diff", "--name-only", `${ref}~1`, ref)
    .split("\n")
    .filter(Boolean);
  const hasManifest = files.some((f) => path.basename(f) === "package.json");
  const lockDirs = new Set();
  const lockOnly = [];
  for (const f of files) {
    const base = path.basename(f);
    if (base === "package.json") {
      const file = path.join(dir, f);
      if (!fs.existsSync(file)) continue;
      const next = applySpecs(
        fs.readFileSync(file, "utf8"),
        specChanges(git("diff", "-U0", `${ref}~1`, ref, "--", f)),
      );
      if (next) fs.writeFileSync(file, next);
      lockDirs.add(path.dirname(f));
    } else if (base === "package-lock.json") {
      lockDirs.add(path.dirname(f));
      const name = !hasManifest && lockOnlyName(pr.title);
      if (name) lockOnly.push({ dir: path.dirname(f), name });
    } else {
      const patch = sh("git", [
        "diff",
        "--binary",
        `${ref}~1`,
        ref,
        "--",
        f,
      ]).stdout;
      const r = sh("git", ["apply", "-3", "--index"], {
        input: patch,
        ok: true,
      });
      if (r.status !== 0)
        throw new Error(`${f} does not apply on ${dev}: ${r.stderr}`);
    }
  }
  for (const d of lockDirs) {
    const cwd = path.join(dir, d);
    if (!fs.existsSync(path.join(cwd, "package-lock.json"))) continue;
    const flags = [
      "--package-lock-only",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ];
    sh("npm", ["install", ...flags], { cwd });
    for (const x of lockOnly.filter((x) => x.dir === d))
      sh("npm", ["update", x.name, ...flags], { cwd });
  }

  if (!git("status", "--porcelain")) return false;
  const who = identity();
  git("add", "-A");
  sh("git", [
    "-c",
    `user.name=${who.name}`,
    "-c",
    `user.email=${who.email}`,
    "commit",
    "-q",
    "-m",
    pr.title,
  ]);
  git("push", "-q", "--force", "origin", `HEAD:refs/heads/${branch}`);
  return true;
}

function mirrorBody(pr, dev) {
  return [
    `Brings ${pr.url} onto \`${dev}\`, where work happens before a release.`,
    "",
    "Made by the Dependabot to dev job in Termix-Registry. It merges this PR once every check is green and then closes the Dependabot PR.",
    "",
    mirrorNote(pr.number, pr.headSha),
  ].join("\n");
}

/** Closes mirror PRs whose Dependabot PR is gone (closed, merged or replaced). */
function closeOrphans(prs) {
  const open = new Set(prs.map((p) => p.number));
  const mirrors = read([
    "pr",
    "list",
    "-R",
    full,
    "--state",
    "open",
    "--limit",
    "100",
    "--json",
    "number,body,headRefName",
  ]).filter((p) => p.headRefName.startsWith("deps/"));
  for (const m of mirrors) {
    const note = readNote(m.body);
    if (!note || open.has(note.number)) continue;
    console.log(
      `  mirror #${m.number}: Dependabot PR #${note.number} is closed`,
    );
    gh([
      "pr",
      "close",
      String(m.number),
      "-R",
      full,
      "--delete-branch",
      "--comment",
      `Dependabot closed #${note.number}, so this copy is not needed.`,
    ]);
  }
}

/** Deletes copy branches left behind when their dev branch was released. */
function deleteStaleCopies(heads) {
  for (const branch of staleCopies(heads)) {
    const open = read([
      "pr",
      "list",
      "-R",
      full,
      "--head",
      branch,
      "--state",
      "open",
      "--json",
      "number",
    ]);
    if (open.length) continue;
    console.log(`  deleting ${branch}, its dev branch is gone`);
    gh(["api", "-X", "DELETE", `repos/${full}/git/refs/heads/${branch}`]);
  }
}

function main() {
  const prs = listDependabot().sort((a, b) => a.number - b.number);
  closeOrphans(prs);
  const heads = git("ls-remote", "--heads", "origin")
    .split("\n")
    .map((l) => l.split("refs/heads/")[1])
    .filter(Boolean);
  deleteStaleCopies(heads);
  if (!prs.length) return console.log(`${repo}: no Dependabot PRs`);
  const dev = newestDev(heads);
  console.log(
    `${repo}: ${prs.length} Dependabot PRs, target ${dev ?? "default branch"}`,
  );

  let merged = false;
  for (const pr of prs) {
    const branch = dev && mirrorBranch(dev, pr.headRefName);
    const mirror = dev ? findMirror(branch) : null;
    const step = decide({ pr, dev, mirror });
    console.log(`  #${pr.number} ${pr.title}: ${step.kind}`);
    try {
      if (step.kind === "merge-dependabot") {
        if (merged) continue;
        squash(pr.number, pr.headRefName);
        merged = true;
      } else if (step.kind === "close-dependabot") {
        closePr(pr.number, `Merged into \`${dev}\` in ${step.via.url}.`);
      } else if (step.kind === "merge-mirror") {
        if (merged) continue;
        squash(mirror.number, branch);
        merged = true;
        closePr(pr.number, `Merged into \`${dev}\` in ${mirror.url}.`);
      } else if (step.kind === "build" || step.kind === "rebuild") {
        // dev just moved, the next run builds on the new head
        if (merged) continue;
        const open = mirror?.state === "OPEN" ? mirror : null;
        if (!build(pr, dev, branch)) {
          if (open) closePr(open.number, `\`${dev}\` already has this change.`);
          closePr(pr.number, `\`${dev}\` already has this change.`);
          continue;
        }
        if (open) {
          gh([
            "pr",
            "edit",
            String(open.number),
            "-R",
            full,
            "--body",
            mirrorBody(pr, dev),
          ]);
        } else {
          gh([
            "pr",
            "create",
            "-R",
            full,
            "--base",
            dev,
            "--head",
            branch,
            "--title",
            pr.title,
            "--body",
            mirrorBody(pr, dev),
          ]);
        }
      }
    } catch (err) {
      // One broken PR must not stop the rest of the repo.
      process.exitCode = 1;
      console.error(`  #${pr.number} failed: ${err.message}`);
    }
  }
}

main();
