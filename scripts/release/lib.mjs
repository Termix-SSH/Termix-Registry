import crypto from "node:crypto";
import { isSigned, loadPrivateKey, signDigest } from "../lib.mjs";

const DEV_BRANCH = /^dev-(\d+\.\d+\.\d+)$/;

/** Plugin id from a repo like Termix-SSH/Plugin-Wake-On-LAN. */
export function pluginIdOf(repo) {
  return repo
    .split("/")[1]
    .replace(/^Plugin-/, "")
    .toLowerCase();
}

/**
 * Turns "ssh-terminal, Plugin-Docker" into official repos. Unknown names
 * throw, so a typo never releases nothing quietly.
 */
export function pickRepos(input, repositories) {
  const names = String(input ?? "")
    .split(/[\s,]+/)
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  if (names.length === 0) throw new Error("Name at least one plugin");
  const picked = [];
  for (const name of names) {
    const repo = repositories.find(
      (candidate) =>
        pluginIdOf(candidate) === name ||
        candidate.split("/")[1].toLowerCase() === name,
    );
    if (!repo) throw new Error(`${name} is not an official plugin`);
    if (!picked.includes(repo)) picked.push(repo);
  }
  return picked;
}

/**
 * The branch a release runs from: the one asked for, else the plugin's only
 * dev-X.Y.Z branch. Overwrite falls back to main.
 */
export function pickBranch({ branches, requested, mode }) {
  if (requested) {
    if (!branches.includes(requested)) {
      throw new Error(`branch ${requested} does not exist`);
    }
    return requested;
  }
  const dev = branches.filter((name) => DEV_BRANCH.test(name));
  if (dev.length === 1) return dev[0];
  if (dev.length === 0 && mode === "overwrite") return "main";
  if (dev.length === 0) throw new Error("no dev-X.Y.Z branch to release");
  throw new Error(`more than one dev branch (${dev.join(", ")}), pick one`);
}

/**
 * The version to release, same rules as the old per repo workflow.
 * tags are the plugin's git tag names.
 */
export function resolveVersion({
  channel,
  mode,
  branch,
  manifestVersion,
  tags,
}) {
  if (!["stable", "beta"].includes(channel)) {
    throw new Error("channel must be stable or beta");
  }
  if (!["release", "overwrite", "dry-run"].includes(mode)) {
    throw new Error("mode must be release, overwrite or dry-run");
  }
  if (mode === "overwrite") {
    if (channel === "beta") {
      throw new Error(
        "overwrite re-releases a stable version, run it with channel stable",
      );
    }
    return { version: manifestVersion, base: manifestVersion };
  }
  const base = DEV_BRANCH.exec(branch)?.[1];
  if (!base)
    throw new Error(`Run this from a dev-X.Y.Z branch (got ${branch})`);
  if (channel === "beta") {
    const prefix = `v${base}-beta.`;
    const last = tags
      .filter((tag) => tag.startsWith(prefix))
      .map((tag) => tag.slice(prefix.length))
      .filter((n) => /^\d+$/.test(n))
      .map(Number)
      .reduce((max, n) => Math.max(max, n), 0);
    return { version: `${base}-beta.${last + 1}`, base };
  }
  if (tags.includes(`v${base}`)) {
    throw new Error(
      `v${base} is already released. Bump the dev branch or use mode overwrite.`,
    );
  }
  return { version: base, base };
}

/** Swaps only the top level version so the file keeps its formatting. */
export function stampJsonText(text, version, file) {
  const next = text.replace(
    /^(\s{2}"version":\s*")[^"]*(")/m,
    `$1${version}$2`,
  );
  if (JSON.parse(next).version !== version) {
    throw new Error(`Could not stamp the version in ${file}`);
  }
  return next;
}

/** Stamps the lock by hand. Re-resolving it drops bundled deps. */
export function stampLockText(text, version) {
  const lock = JSON.parse(text);
  lock.version = version;
  if (lock.packages?.[""]) lock.packages[""].version = version;
  return JSON.stringify(lock, null, 2) + "\n";
}

/** Puts a section above the first ## heading of a changelog. */
export function insertChangelogSection(text, section) {
  const at = text.search(/^## /m);
  return at < 0
    ? `${text.trimEnd()}\n\n${section}`
    : text.slice(0, at) + section + text.slice(at);
}

/**
 * Signs a .tmxplug the way termix-plugin sign does and checks the result
 * against the registry's published keys, so a wrong key fails here and not
 * in every Termix install.
 */
export function signArtifact(buffer, keyValue, keys) {
  const key = loadPrivateKey(keyValue);
  if (!key) throw new Error("TERMIX_PLUGIN_SIGNING_KEY is not set");
  const digest = crypto.createHash("sha256").update(buffer).digest();
  const signature = signDigest(digest, key);
  if (!isSigned(digest, signature, keys)) {
    throw new Error("the signing key does not match keys/official.pub");
  }
  return { sha256: digest.toString("hex"), signature };
}
