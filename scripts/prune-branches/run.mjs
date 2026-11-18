// Deletes released dev branches and stale Dependabot copies in every repo the
// Termix CI App can reach. The signed commits ruleset lets only the App
// delete branches, so nobody can do this by hand.
//
// env: GH_TOKEN (App token: contents write, pull requests read), DRY_RUN=true
// to only list what would go.
import { staleBranches } from "./lib.mjs";

const ORG = "Termix-SSH";
const API = "https://api.github.com";
const dryRun = process.env.DRY_RUN === "true";
// Repos that ship no releases of their own follow another repo's version.
const VERSION_FROM = { Docs: "Termix" };

async function gh(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${process.env.GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      ...init.headers,
    },
  });
  if (res.status === 404) return null;
  if (!res.ok && res.status !== 204) {
    throw new Error(`${init.method ?? "GET"} ${path}: ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

async function all(path) {
  const out = [];
  for (let page = 1; ; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const batch = await gh(`${path}${sep}per_page=100&page=${page}`);
    if (!batch?.length) return out;
    out.push(...batch);
    if (batch.length < 100) return out;
  }
}

/** v1.2.0, 26.11.2 and Mobile's release-2.0.0-tag all give the version. */
const tagVersion = (tag) =>
  String(tag)
    .replace(/^release-/, "")
    .replace(/-tag$/, "")
    .replace(/^v/, "");

const releasedCache = new Map();
async function released(repo) {
  const from = VERSION_FROM[repo] ?? repo;
  if (!releasedCache.has(from)) {
    const latest = await gh(`/repos/${ORG}/${from}/releases/latest`);
    releasedCache.set(from, latest ? tagVersion(latest.tag_name) : null);
  }
  return releasedCache.get(from);
}

// REPOS (comma list) skips the listing, for a dry run with a user token.
const names = (process.env.REPOS ?? "").split(",").filter(Boolean);
if (names.length === 0) {
  // This endpoint wraps its list in an object, so page through it by hand.
  for (let page = 1; ; page++) {
    const res = await gh(
      `/installation/repositories?per_page=100&page=${page}`,
    );
    const list = res?.repositories ?? [];
    names.push(...list.filter((r) => !r.archived).map((r) => r.name));
    if (list.length < 100) break;
  }
}

let deleted = 0;
for (const repo of names.sort()) {
  const branches = (await all(`/repos/${ORG}/${repo}/branches`)).map(
    (b) => b.name,
  );
  if (!branches.some((b) => b.startsWith("dev-") || b.startsWith("deps/"))) {
    continue;
  }
  const openHeads = (await all(`/repos/${ORG}/${repo}/pulls?state=open`)).map(
    (p) => p.head.ref,
  );
  const stale = staleBranches({
    branches,
    released: await released(repo),
    openHeads,
  });
  for (const branch of stale) {
    console.log(`${dryRun ? "would delete" : "deleting"} ${repo} ${branch}`);
    if (!dryRun) {
      await gh(
        `/repos/${ORG}/${repo}/git/refs/heads/${branch
          .split("/")
          .map(encodeURIComponent)
          .join("/")}`,
        { method: "DELETE" },
      );
    }
    deleted++;
  }
}
console.log(`${dryRun ? "would delete" : "deleted"} ${deleted} branch(es)`);
