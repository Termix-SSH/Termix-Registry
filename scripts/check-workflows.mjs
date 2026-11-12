// Checks this repo's workflows keep secrets where they belong:
// - a secret other than GITHUB_TOKEN is only read by a job with an environment,
//   or passed by name to one of this repo's reusable workflows (checked itself)
// - no job passes secrets: inherit
// - every npm ci or npm install runs with --ignore-scripts
// - a job holding a signing or App key runs no npm cache or npx
// - a workflow with an environment job has no pull_request_target or workflow_run
// - plugin-release.yml runs only for community plugins: it refuses official
//   repos first thing and reads only the author's own optional secrets
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const SECRET = /secrets\.([A-Za-z0-9_]+)/g;
const COMMUNITY = "plugin-release.yml";
const COMMUNITY_SECRETS = new Set(["TERMIX_PAT", "TERMIX_PLUGIN_SIGNING_KEY"]);
const KEY_SECRETS = new Set([
  "TERMIX_PLUGIN_SIGNING_KEY",
  "TERMIX_COMMUNITY_SIGNING_KEY",
  "CI_APP_PRIVATE_KEY",
]);

function secretsIn(value) {
  const found = new Set();
  for (const match of JSON.stringify(value ?? null).matchAll(SECRET)) {
    if (match[1] !== "GITHUB_TOKEN") found.add(match[1]);
  }
  return found;
}

function triggersOf(doc) {
  const on = doc.on ?? doc[true];
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on;
  return Object.keys(on ?? {});
}

/** Problems found in one workflow file's text. */
export function checkWorkflow(name, text) {
  const problems = [];
  const doc = YAML.parse(text);
  const jobs = doc.jobs ?? {};
  const triggers = triggersOf(doc);
  const topSecrets = secretsIn(doc.env);
  if (topSecrets.size) {
    problems.push(`${name}: workflow env reads ${[...topSecrets].join(", ")}`);
  }

  if (name === COMMUNITY) return [...problems, ...checkCommunity(doc)];

  for (const [id, job] of Object.entries(jobs)) {
    const where = `${name} ${id}`;
    const { secrets: passed, ...rest } = job;
    const read = secretsIn(rest);
    if (passed === "inherit") {
      problems.push(`${where}: secrets: inherit, pass each secret by name`);
    }
    // A call job can't have an environment. The called workflow's own jobs
    // must, and this check covers them when the file is local.
    const localCall = typeof job.uses === "string" && job.uses.startsWith("./");
    if (passed && passed !== "inherit" && !localCall) {
      for (const secret of secretsIn(passed)) read.add(secret);
    }
    if (read.size && !job.environment) {
      problems.push(
        `${where}: reads ${[...read].join(", ")} without an environment`,
      );
    }
    if (job.environment) {
      for (const bad of ["pull_request_target", "workflow_run"]) {
        if (triggers.includes(bad)) {
          problems.push(`${where}: environment job in a ${bad} workflow`);
        }
      }
    }
    if ([...read].some((secret) => KEY_SECRETS.has(secret))) {
      for (const [index, step] of (job.steps ?? []).entries()) {
        const label = `${where} step ${step.name ?? step.uses ?? index + 1}`;
        if (step.with?.cache) problems.push(`${label}: uses a cache`);
        const run = String(step.run ?? "");
        for (const line of run.split("\n")) {
          if (/\bnpx\b/.test(line)) problems.push(`${label}: runs npx`);
        }
      }
    }
    // Every install runs with scripts off. Native modules that need theirs
    // get an npm rebuild of just that package.
    for (const [index, step] of (job.steps ?? []).entries()) {
      const label = `${where} step ${step.name ?? step.uses ?? index + 1}`;
      for (const line of String(step.run ?? "").split("\n")) {
        if (
          /\bnpm (ci|install|i)\b/.test(line) &&
          !/--ignore-scripts/.test(line)
        ) {
          problems.push(`${label}: npm install without --ignore-scripts`);
        }
      }
    }
  }

  return problems;
}

/**
 * The community release runs in authors' repos with their own secrets. It
 * must stop before anything else for Termix-SSH repos, so an official repo
 * never reaches it with a Termix secret.
 */
function checkCommunity(doc) {
  const problems = [];
  const extra = [...secretsIn(doc)].filter(
    (secret) => !COMMUNITY_SECRETS.has(secret),
  );
  if (extra.length) problems.push(`${COMMUNITY}: reads ${extra.join(", ")}`);
  const declared = doc.on?.workflow_call?.secrets ?? {};
  for (const [secret, spec] of Object.entries(declared)) {
    if (spec?.required) {
      problems.push(`${COMMUNITY}: ${secret} must be optional`);
    }
  }
  for (const [id, job] of Object.entries(doc.jobs ?? {})) {
    const first = job.steps?.[0];
    if (
      !first ||
      !String(first.if ?? "").includes(
        "github.repository_owner == 'Termix-SSH'",
      ) ||
      !/exit 1/.test(String(first.run ?? ""))
    ) {
      problems.push(
        `${COMMUNITY} ${id}: first step must refuse Termix-SSH repos`,
      );
    }
  }
  return problems;
}

export function checkWorkflowDir(dir) {
  return fs
    .readdirSync(dir)
    .filter((file) => /\.ya?ml$/.test(file))
    .sort()
    .flatMap((file) =>
      checkWorkflow(file, fs.readFileSync(path.join(dir, file), "utf8")),
    );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir =
    process.argv[2] ??
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      ".github",
      "workflows",
    );
  const problems = checkWorkflowDir(dir);
  for (const problem of problems) console.error(problem);
  if (problems.length) process.exit(1);
  console.log("workflows ok");
}
