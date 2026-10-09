/**
 * Rebuilds each <registry>/index.json.
 *
 * A registry with a sources.json (official) lists every release of the
 * repos in it:
 * - a release counts once it has <id>-<version>.tmxplug and its .sig, the
 *   signature matches keys/<registry>.pub, and the packed manifest matches
 *   the tag
 * - a version whose file changed (a re-released version) is replaced
 * - a version whose release is gone is dropped
 *
 * A registry with a plugins/ folder (community) lists only the versions
 * pinned in plugins/<id>.json, which a person reviewed before merging:
 * - the release's .tmxplug must still have the pinned sha256
 * - the registry signs it with TERMIX_<REGISTRY>_SIGNING_KEY (for example
 *   TERMIX_COMMUNITY_SIGNING_KEY) and keeps that signature on later runs
 * - a plugin whose file is removed is dropped
 *
 * In both, betas (semver prerelease versions) go in prereleases, and only
 * while they are newer than the newest stable.
 *
 * Set GH_TOKEN for the higher GitHub API rate limit.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  download,
  github,
  githubRepo,
  inspectArtifact,
  isSigned,
  keysFor,
  listing,
  loadKeys,
  loadPrivateKey,
  readSubmissions,
  root,
  sha256,
  signDigest,
  splitChannels,
  versionEntry,
} from "./lib.mjs";

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
  const digest = sha256(buffer);
  if (!isSigned(digest, signature, keys)) {
    problems.push(`${where}: signature does not match the registry key`);
    return null;
  }

  const inspected = inspectArtifact(buffer, release, artifact);
  if (typeof inspected === "string") {
    problems.push(`${where}: ${inspected}`);
    return null;
  }
  return {
    manifest: inspected.manifest,
    version: versionEntry({
      ...inspected,
      release,
      artifact,
      buffer,
      digest,
      signature,
    }),
  };
}

/** Keeps the listed copy of an unchanged version, with fresh notes. */
function keep(list, entries) {
  return entries.map(({ version }) => {
    const kept = list?.find(
      (entry) =>
        entry.version === version.version && entry.sha256 === version.sha256,
    );
    if (!kept) return version;
    const { notes, ...rest } = kept;
    return version.notes ? { ...rest, notes: version.notes } : rest;
  });
}

async function officialPlugins(dir, previous, keys, problems) {
  const sources = JSON.parse(
    fs.readFileSync(path.join(dir, "sources.json"), "utf8"),
  );
  const plugins = [];
  for (const repo of sources.repositories) {
    const releases = await github(`/repos/${repo}/releases?per_page=100`);
    const found = [];
    for (const release of releases) {
      if (release.draft) continue;
      const entry = await readRelease(repo, release, keys, problems);
      if (entry) found.push(entry);
    }
    if (found.length === 0) continue;

    const { stable, betas } = splitChannels(found);
    // Listing text follows stable, so a beta can't change what stable users see.
    const latest = (stable[0] ?? found[0]).manifest;
    if (found.some(({ manifest }) => manifest.id !== latest.id)) {
      problems.push(`${repo}: releases use more than one plugin id`);
      continue;
    }

    const old = previous.get(latest.id);
    const versions = keep(old?.versions, stable);
    const prereleases = keep(old?.prereleases, betas);
    plugins.push({
      ...listing(latest, `https://github.com/${repo}`, sources.docsBase),
      versions,
      ...(prereleases.length > 0 ? { prereleases } : {}),
    });
  }
  return plugins;
}

async function readPinned({ repo, id, pin, keys, signer, old, problems }) {
  const where = `${id}@${pin.version}`;
  const release = await github(`/repos/${repo}/releases/tags/v${pin.version}`);
  const artifact = release.assets.find(
    (asset) => asset.name === `${id}-${pin.version}.tmxplug`,
  );
  if (!artifact) {
    problems.push(`${where}: the release has no ${id}-${pin.version}.tmxplug`);
    return null;
  }
  const buffer = await download(artifact.browser_download_url);
  const digest = sha256(buffer);
  if (digest.toString("hex") !== pin.sha256) {
    problems.push(`${where}: the file no longer has the reviewed sha256`);
    return null;
  }
  const inspected = inspectArtifact(buffer, release, artifact);
  if (typeof inspected === "string") {
    problems.push(`${where}: ${inspected}`);
    return null;
  }
  if (inspected.manifest.id !== id) {
    problems.push(`${where}: the manifest id is ${inspected.manifest.id}`);
    return null;
  }

  const listed = [...(old?.versions ?? []), ...(old?.prereleases ?? [])].find(
    (entry) => entry.version === pin.version && entry.sha256 === pin.sha256,
  );
  let signature = listed?.signature;
  if (!signature || !isSigned(digest, signature, keys)) {
    if (!signer) {
      problems.push(`${where}: no signing key set to sign it with`);
      return null;
    }
    signature = signDigest(digest, signer);
  }
  return {
    manifest: inspected.manifest,
    version: versionEntry({
      ...inspected,
      release,
      artifact,
      buffer,
      digest,
      signature,
    }),
  };
}

async function reviewedPlugins(dir, registry, previous, keys, problems) {
  const envName = `TERMIX_${registry.toUpperCase().replace(/-/g, "_")}_SIGNING_KEY`;
  const signer = loadPrivateKey(process.env[envName]);
  const plugins = [];
  for (const { file, submission } of readSubmissions(dir)) {
    const repo = githubRepo(submission.repository);
    if (!repo) {
      problems.push(`${path.basename(file)}: repository is not a GitHub repo`);
      continue;
    }
    const old = previous.get(submission.id);
    const found = [];
    for (const pin of submission.versions ?? []) {
      try {
        const entry = await readPinned({
          repo,
          id: submission.id,
          pin,
          keys,
          signer,
          old,
          problems,
        });
        if (entry) found.push(entry);
      } catch (error) {
        problems.push(`${submission.id}@${pin.version}: ${error.message}`);
      }
    }
    if (found.length === 0) continue;

    const { stable, betas } = splitChannels(found);
    const latest = (stable[0] ?? found[0]).manifest;
    const prereleases = betas.map(({ version }) => version);
    plugins.push({
      ...listing(latest, `https://github.com/${repo}`, null),
      versions: stable.map(({ version }) => version),
      ...(prereleases.length > 0 ? { prereleases } : {}),
    });
  }
  return plugins;
}

async function syncRegistry(dir, allKeys, problems) {
  const indexPath = path.join(dir, "index.json");
  const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  const keys = keysFor(allKeys, index.registry);
  if (keys.length === 0) {
    problems.push(`keys/${index.registry}.pub is missing`);
    return;
  }
  const before = JSON.stringify(index.plugins);
  const previous = new Map(index.plugins.map((plugin) => [plugin.id, plugin]));

  const plugins = fs.existsSync(path.join(dir, "sources.json"))
    ? await officialPlugins(dir, previous, keys, problems)
    : await reviewedPlugins(dir, index.registry, previous, keys, problems);

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
  const problems = [];

  const dirs = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => path.join(root, entry.name))
    .filter(
      (dir) =>
        fs.existsSync(path.join(dir, "index.json")) &&
        (fs.existsSync(path.join(dir, "sources.json")) ||
          fs.existsSync(path.join(dir, "plugins"))),
    );

  for (const dir of dirs) await syncRegistry(dir, keys, problems);

  if (problems.length > 0) {
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
}

await main();
