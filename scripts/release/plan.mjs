// Turns the Release Plugin inputs into a matrix: one entry per plugin with
// the repo, branch and the exact commit every job of that release uses.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { github, root } from "../lib.mjs";
import { pickBranch, pickRepos, pluginIdOf } from "./lib.mjs";

const { values } = parseArgs({
  options: {
    plugins: { type: "string" },
    ref: { type: "string", default: "" },
    mode: { type: "string", default: "release" },
  },
});

const sources = JSON.parse(
  fs.readFileSync(path.join(root, "official", "sources.json"), "utf8"),
);
const repos = pickRepos(values.plugins, sources.repositories);
if (values.ref && repos.length > 1) {
  throw new Error("A branch can only be given when releasing one plugin");
}

async function branchesOf(repo) {
  const names = [];
  for (let page = 1; ; page++) {
    const batch = await github(
      `/repos/${repo}/branches?per_page=100&page=${page}`,
    );
    names.push(...batch.map((branch) => branch.name));
    if (batch.length < 100) return names;
  }
}

const include = [];
for (const repo of repos) {
  const branch = pickBranch({
    branches: await branchesOf(repo),
    requested: values.ref,
    mode: values.mode,
  });
  const commit = await github(
    `/repos/${repo}/commits/${encodeURIComponent(branch)}`,
  );
  include.push({
    id: pluginIdOf(repo),
    repo,
    name: repo.split("/")[1],
    branch,
    sha: commit.sha,
  });
  console.log(`${repo}: ${branch} at ${commit.sha}`);
}

const matrix = JSON.stringify({ include });
if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${matrix}\n`);
} else {
  console.log(matrix);
}
