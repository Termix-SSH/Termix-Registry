// Pure helpers for the Dependabot to dev branch job. No network, no git.
import semver from "semver";

export const MARKER = "dependabot-dev";

/** Newest `dev-*` branch by version order, or null. */
export function newestDev(branches) {
  const devs = branches.filter((b) => /^dev-/.test(b));
  devs.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return devs.at(-1) ?? null;
}

/** The branch that carries one Dependabot PR's change onto a dev branch. */
export function mirrorBranch(dev, dependabotHead) {
  return `deps/${dev}/${dependabotHead.replace(/^dependabot\//, "")}`;
}

/** Copy branches whose dev branch is gone (released and deleted). */
export function staleCopies(heads) {
  const live = new Set(heads);
  return heads.filter((h) => {
    const dev = /^deps\/(dev-[^/]+)\//.exec(h)?.[1];
    return dev !== undefined && !live.has(dev);
  });
}

/** Hidden note in the mirror PR body that names the Dependabot PR and commit. */
export function mirrorNote(number, sha) {
  return `<!-- ${MARKER} pr=${number} sha=${sha} -->`;
}

export function readNote(body) {
  const m = String(body ?? "").match(
    new RegExp(`<!-- ${MARKER} pr=(\\d+) sha=([0-9a-f]+) -->`),
  );
  return m ? { number: Number(m[1]), sha: m[2] } : null;
}

const OK = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

/**
 * True when every check finished without failing. A PR with no checks
 * yet is not green, since CI may simply not have started.
 */
export function checksGreen(rollup) {
  const list = (rollup ?? []).filter(Boolean);
  if (!list.length) return false;
  return list.every((c) => {
    if (c.__typename === "StatusContext") return c.state === "SUCCESS";
    return c.status === "COMPLETED" && OK.has(c.conclusion);
  });
}

/** Reads `"name": "spec"` changes out of a package.json diff. */
export function specChanges(diff) {
  const news = {};
  for (const line of String(diff).split("\n")) {
    const m = line.match(/^\+\s+"([^"]+)":\s*"([^"]+)",?\s*$/);
    if (m && m[1] !== "version") news[m[1]] = m[2];
  }
  return news;
}

const SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "overrides",
];

function lowest(spec) {
  try {
    return semver.minVersion(spec.replace(/^npm:.*@/, ""))?.version ?? null;
  } catch {
    return null;
  }
}

/**
 * Applies the new specs to a package.json text. Only names the file
 * already has are changed, and never to a lower version.
 * Returns the new text, or null when nothing changed.
 */
export function applySpecs(text, news) {
  const pkg = JSON.parse(text);
  let changed = false;
  for (const [name, spec] of Object.entries(news)) {
    for (const sec of SECTIONS) {
      const cur = pkg[sec]?.[name];
      if (typeof cur !== "string" || cur === spec) continue;
      const cv = lowest(cur);
      const nv = lowest(spec);
      if (cv && nv && semver.gte(cv, nv)) continue;
      pkg[sec][name] = spec;
      changed = true;
    }
  }
  if (!changed) return null;
  const indent = text.match(/^(\s+)"/m)?.[1] ?? "  ";
  return JSON.stringify(pkg, null, indent) + (text.endsWith("\n") ? "\n" : "");
}

/** Package named in a lockfile only bump title ("bump undici from a to b"). */
export function lockOnlyName(title) {
  return String(title).match(/\bbump (\S+)(?: from| in |$)/)?.[1] ?? null;
}

/**
 * Decides what to do with one Dependabot PR.
 * `mirror` is the mirror PR for the current dev branch, if any.
 */
export function decide({ pr, dev, mirror }) {
  if (!dev) {
    if (pr.mergeable === "MERGEABLE" && checksGreen(pr.checks))
      return { kind: "merge-dependabot" };
    return { kind: "wait" };
  }
  if (!mirror) return { kind: "build" };
  if (mirror.state === "MERGED")
    return { kind: "close-dependabot", via: mirror };
  if (mirror.state === "CLOSED") return { kind: "build" };
  const note = readNote(mirror.body);
  if (!note || note.sha !== pr.headSha) return { kind: "rebuild" };
  if (mirror.mergeable === "CONFLICTING") return { kind: "rebuild" };
  if (mirror.mergeable === "MERGEABLE" && checksGreen(mirror.checks))
    return { kind: "merge-mirror" };
  return { kind: "wait" };
}
