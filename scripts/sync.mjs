/**
 * Rebuilds each <registry>/index.json from the GitHub releases of the repos
 * in <registry>/sources.json.
 *
 * - a release counts once it has <id>-<version>.tmxplug and its .sig, the
 *   signature matches a key in keys/, and the packed manifest matches the tag
 * - a version whose file changed (a re-released version) is replaced
 * - a version whose release is gone is dropped
 *
 * Set GH_TOKEN for the higher GitHub API rate limit.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  changelogSection,
  compareVersions,
  isSigned,
  loadKeys,
  readTmxplugFile,
  root,
} from "./lib.mjs";

const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;

async function github(url) {
  const response = await fetch(`https://api.github.com${url}`, {
    headers: {
      Accept: "application/vnd.github+json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response.json();
}

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function readRelease(repo, release, keys, problems) {
  const where = `${repo}@${release.tag_name}`;
  const artifact = release.assets.find((asset) =>
    asset.name.endsWith(".tmxplug"),
  );
  const sigAsset =
    artifact &&
    release.assets.find((asset) => asset.name === `${artifact.name}.sig`);
  if (!artifact || !sigAsset) return null;

  const buffer = await download(artifact.browser_download_url);
  const signature = (await download(sigAsset.browser_download_url))
    .toString("utf8")
    .trim();
  const digest = crypto.createHash("sha256").update(buffer).digest();
  if (!isSigned(digest, signature, keys)) {
    problems.push(`${where}: signature does not match any key in keys/`);
    return null;
  }

  const raw = readTmxplugFile(buffer, "manifest.json");
  if (!raw) {
    problems.push(`${where}: no manifest.json in ${artifact.name}`);
    return null;
  }
  const manifest = JSON.parse(raw.toString("utf8"));
  if (`v${manifest.version}` !== release.tag_name) {
    problems.push(`${where}: manifest version is ${manifest.version}`);
    return null;
  }
  if (artifact.name !== `${manifest.id}-${manifest.version}.tmxplug`) {
    problems.push(`${where}: ${artifact.name} does not match ${manifest.id}`);
    return null;
  }

  const changelog = readTmxplugFile(buffer, "CHANGELOG.md");
  const notes = changelog
    ? changelogSection(changelog.toString("utf8"), manifest.version)
    : null;

  return {
    manifest,
    version: {
      version: manifest.version,
      api: String(manifest.engine.api).match(/d+/)?.[0] ?? "",
      url: artifact.browser_download_url,
      sha256: digest.toString("hex"),
      signature,
      size: buffer.length,
      capabilities: manifest.capabilities ?? [],
      ...(manifest.dependencies && Object.keys(manifest.dependencies).length
        ? { dependencies: manifest.dependencies }
        : {}),
      releaseNotesUrl: release.html_url,
      ...(notes ? { notes: notes.slice(0, 20_000) } : {}),
      publishedAt: new Date().toISOString(),
    },
  };
}

async function syncRegistry(dir, keys, problems) {
  const indexPath = path.join(dir, "index.json");
  const sources = JSON.parse(
    fs.readFileSync(path.join(dir, "sources.json"), "utf8"),
  );
  const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  const before = JSON.stringify(index.plugins);
  const previous = new Map(index.plugins.map((plugin) => [plugin.id, plugin]));

  const plugins = [];
  for (const repo of sources.repositories) {
    const releases = await github(`/repos/${repo}/releases?per_page=100`);
    const found = [];
    for (const release of releases) {
      if (release.draft || release.prerelease) continue;
      const entry = await readRelease(repo, release, keys, problems);
      if (entry) found.push(entry);
    }
    if (found.length === 0) continue;

    found.sort((a, b) =>
      compareVersions(b.manifest.version, a.manifest.version),
    );
    const latest = found[0].manifest;
    if (found.some(({ manifest }) => manifest.id !== latest.id)) {
      problems.push(`${repo}: releases use more than one plugin id`);
      continue;
    }

    const old = previous.get(latest.id);
    const versions = found.map(({ version }) => {
      const kept = old?.versions.find(
        (entry) =>
          entry.version === version.version && entry.sha256 === version.sha256,
      );
      if (!kept) return version;
      const { notes, ...rest } = kept;
      return version.notes ? { ...rest, notes: version.notes } : rest;
    });

    plugins.push({
      id: latest.id,
      name: latest.name,
      description: latest.description,
      author: latest.author?.name ?? String(latest.author ?? ""),
      category: latest.category,
      repository: `https://github.com/${repo}`,
      icon: latest.icon ?? "Puzzle",
      ...(typeof latest.video === "string" ? { video: latest.video } : {}),
      versions,
    });
  }

  plugins.sort((a, b) => a.id.localeCompare(b.id));
  const ids = new Set();
  for (const plugin of plugins) {
    if (ids.has(plugin.id)) problems.push(`${plugin.id} comes from two repos`);
    ids.add(plugin.id);
  }

  if (JSON.stringify(plugins) === before) {
    console.log(`${path.relative(root, indexPath)}: up to date`);
    return;
  }
  index.plugins = plugins;
  index.updatedAt = new Date().toISOString();
  fs.writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  console.log(
    `${path.relative(root, indexPath)}: ${plugins.length} plugin(s) written`,
  );
}

async function main() {
  const keys = loadKeys();
  if (keys.length === 0) throw new Error("keys/ has no .pub file");
  const problems = [];

  const dirs = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name))
    .filter((dir) => fs.existsSync(path.join(dir, "sources.json")));

  for (const dir of dirs) await syncRegistry(dir, keys, problems);

  if (problems.length > 0) {
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
}

await main();
