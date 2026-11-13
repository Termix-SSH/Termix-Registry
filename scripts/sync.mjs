/**
 * Rebuilds each <registry>/index.json.
 *
 * A registry with a sources.json (official) lists every release of the
 * repos in it:
 * - a release counts once it has <id>-<version>.tmxplug and its .sig, the
 *   signature checks out (a chain envelope against trust/<registry>/certs.json,
 *   or a pre-chain one against keys/<registry>.pub), and the packed manifest
 *   matches the tag
 * - a release published after the reproducible build check started waits
 *   until official/reproduced/ records a rebuild to the same file
 * - a version whose file changed (a re-released version) is replaced
 * - a version whose release is gone is dropped
 *
 * A registry with a plugins/ folder (community) lists only the versions
 * pinned in plugins/<id>.json, which a person reviewed before merging:
 * - the release's .tmxplug must still have the pinned sha256
 * - the registry signs it with TERMIX_<REGISTRY>_ONLINE_KEY, its root
 *   certified key, and until the move-over ends also with the pre-chain
 *   TERMIX_<REGISTRY>_SIGNING_KEY, and keeps both signatures on later runs
 * - a plugin whose file is removed is dropped
 *
 * In both, betas (semver prerelease versions) go in prereleases, and only
 * while they are newer than the newest stable. A release whose engine.termix
 * the last Termix that doesn't check it can't satisfy goes in gated instead,
 * so those builds never list it.
 *
 * A plugin whose release files all still have the sha256 the index lists
 * (read from the GitHub API digest) is kept as listed without downloading,
 * because every download adds to the count the plugin store shows. Pass
 * --full to download and re-read everything anyway.
 *
 * Official plugins take their demo video link from the manifest on their
 * default branch, so a new video shows up without a release.
 *
 * Chain signatures live in <registry>/signatures.json and are copied next to
 * each release, with the registry's certificates at the top of the index.
 *
 * Set GH_TOKEN for the higher GitHub API rate limit.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  allReleases,
  assetSha256,
  contributesOf,
  engineOf,
  compareVersions,
  download,
  github,
  githubRepo,
  inspectArtifact,
  isPrerelease,
  isSigned,
  keysFor,
  listing,
  loadKeys,
  loadPrivateKey,
  placeReleases,
  readSubmissions,
  root,
  sha256,
  signDigest,
  splitChannels,
  versionEntry,
} from "./lib.mjs";
import {
  attachChain,
  indexCerts,
  loadChainStore,
  releaseSigned,
  saveChainStore,
  storeSignature,
} from "./trust/index-chain.mjs";
import { LEGACY_UNTIL, chainSign } from "./trust/lib.mjs";
import { isReproduced } from "./release/reproduce-check.mjs";

const full = process.argv.includes("--full");

/**
 * The listed plugin when every file it lists is still on GitHub with the same
 * sha256 and nothing new was released, or null when it needs a full read.
 * files is [{ version, asset }] for each release that has a .tmxplug.
 */
function unchanged(old, repository, files, keys, certs) {
  if (full || !old || old.repository !== repository) return null;
  const listed = allReleases(old);
  const newestStable = listed.find(
    (entry) => !isPrerelease(entry.version),
  )?.version;
  let matched = 0;
  for (const { version, asset, publishedAt } of files) {
    const entry = listed.find((item) => item.version === version);
    if (
      !entry &&
      publishedAt &&
      !isReproduced({
        id: old.id,
        version,
        sha256: assetSha256(asset),
        publishedAt,
      })
    ) {
      // Waiting for its rebuild: no reason to read the whole plugin again.
      continue;
    }
    if (!entry) {
      // A beta that stable has passed is left out of the index on purpose.
      if (
        isPrerelease(version) &&
        newestStable &&
        compareVersions(version, newestStable) <= 0
      ) {
        continue;
      }
      return null;
    }
    const sha = assetSha256(asset);
    if (!sha || sha !== entry.sha256) return null;
    if (!releaseSigned(entry, keys, certs)) return null;
    matched++;
  }
  return matched === listed.length ? old : null;
}

/** Reads a .sig asset: { chain } for an envelope, { legacy } for a plain one. */
async function readSig(asset) {
  if (!asset) return {};
  const text = (await download(asset.browser_download_url))
    .toString("utf8")
    .trim();
  if (!text.startsWith("{")) return { legacy: text };
  try {
    const envelope = JSON.parse(text);
    return { chain: { keyId: envelope.keyId, sig: envelope.sig } };
  } catch {
    return {};
  }
}

async function readRelease(repo, release, keys, certs, store, problems) {
  const where = `${repo}@${release.tag_name}`;
  const artifact = release.assets.find((asset) =>
    asset.name.endsWith(".tmxplug"),
  );
  const sigAsset =
    artifact &&
    release.assets.find((asset) => asset.name === `${artifact.name}.sig`);
  if (!artifact || !sigAsset) return null;

  const version = release.tag_name.replace(/^v/, "");
  const published = assetSha256(artifact);
  const pendingId = artifact.name.slice(0, -`-${version}.tmxplug`.length);
  if (
    published &&
    !isReproduced({
      id: pendingId,
      version,
      sha256: published,
      publishedAt: release.published_at,
    })
  ) {
    console.log(`${where}: waiting for its reproducible build check`);
    return null;
  }

  const buffer = await download(artifact.browser_download_url);
  const digest = sha256(buffer);
  const main = await readSig(sigAsset);
  const extra = await readSig(
    release.assets.find(
      (asset) => asset.name === `${artifact.name}.legacy.sig`,
    ),
  );
  const legacy = main.legacy ?? extra.legacy ?? "";
  const chain = main.chain;
  const legacyOk = Boolean(legacy) && isSigned(digest, legacy, keys);
  const chainOk =
    Boolean(chain) &&
    releaseSigned(
      { sha256: digest.toString("hex"), signatures: [chain] },
      [],
      certs,
    );
  if (!legacyOk && !chainOk) {
    problems.push(`${where}: signature does not match the registry keys`);
    return null;
  }

  const inspected = inspectArtifact(buffer, release, artifact);
  if (typeof inspected === "string") {
    problems.push(`${where}: ${inspected}`);
    return null;
  }
  if (chainOk) {
    storeSignature(
      store,
      {
        id: inspected.manifest.id,
        version,
        sha256: digest.toString("hex"),
        ...chain,
      },
      certs,
    );
  }
  return {
    manifest: inspected.manifest,
    version: versionEntry({
      ...inspected,
      release,
      artifact,
      buffer,
      digest,
      signature: legacyOk ? legacy : "",
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
    return {
      ...rest,
      ...(version.engine ? { engine: version.engine } : {}),
      ...(version.notes ? { notes: version.notes } : {}),
    };
  });
}

/**
 * Fills in engine and contributes for entries listed before the index had
 * them. Reads the manifest at each tag through the API, never the .tmxplug.
 */
async function backfill(entry, repo, problems) {
  const releases = allReleases(entry);
  if (entry.contributes && releases.every((r) => r.engine)) return entry;
  const manifests = new Map();
  const manifestAt = async (version) => {
    if (!manifests.has(version)) {
      const file = await github(
        `/repos/${repo}/contents/manifest.json?ref=v${version}`,
      );
      manifests.set(
        version,
        JSON.parse(Buffer.from(file.content, "base64").toString()),
      );
    }
    return manifests.get(version);
  };
  try {
    const fill = async (list) =>
      list &&
      Promise.all(
        list.map(async (r) =>
          r.engine ? r : { ...r, ...engineOf(await manifestAt(r.version)) },
        ),
      );
    const next = {
      ...entry,
      versions: await fill(entry.versions),
      ...(entry.prereleases
        ? { prereleases: await fill(entry.prereleases) }
        : {}),
      ...(entry.gated ? { gated: await fill(entry.gated) } : {}),
    };
    const newest =
      releases.find((r) => !isPrerelease(r.version)) ?? releases[0];
    if (!next.contributes && newest) {
      Object.assign(next, contributesOf(await manifestAt(newest.version)));
    }
    return next;
  } catch (error) {
    problems.push(`${repo}: could not read old manifests (${error.message})`);
    return entry;
  }
}

async function officialPlugins(dir, previous, keys, certs, store, problems) {
  const sources = JSON.parse(
    fs.readFileSync(path.join(dir, "sources.json"), "utf8"),
  );
  const plugins = [];
  const byRepository = new Map(
    [...previous.values()].map((plugin) => [plugin.repository, plugin]),
  );
  for (const repo of sources.repositories) {
    const releases = await github(`/repos/${repo}/releases?per_page=100`);
    const repository = `https://github.com/${repo}`;
    const files = [];
    for (const release of releases) {
      if (release.draft) continue;
      const asset = release.assets.find((item) =>
        item.name.endsWith(".tmxplug"),
      );
      if (asset)
        files.push({
          version: release.tag_name.replace(/^v/, ""),
          asset,
          publishedAt: release.published_at,
        });
    }
    const kept = unchanged(
      byRepository.get(repository),
      repository,
      files,
      keys,
      certs,
    );
    if (kept) {
      plugins.push(
        placeReleases(
          await withMainVideo(
            await backfill(kept, repo, problems),
            repo,
            problems,
          ),
        ),
      );
      continue;
    }

    const found = [];
    for (const release of releases) {
      if (release.draft) continue;
      const entry = await readRelease(
        repo,
        release,
        keys,
        certs,
        store,
        problems,
      );
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
    const listed = old ? allReleases(old) : [];
    const versions = keep(listed, stable);
    const prereleases = keep(listed, betas);
    plugins.push(
      placeReleases(
        await withMainVideo(
          {
            ...listing(latest, repository, sources.docsBase),
            versions,
            ...(prereleases.length > 0 ? { prereleases } : {}),
          },
          repo,
          problems,
        ),
      ),
    );
  }
  return plugins;
}

const YOUTUBE =
  /^https:\/\/(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/)[A-Za-z0-9_-]{11}/;

/**
 * Official plugins take their demo video link from the manifest on their
 * default branch, so a new video shows up without a release. Community
 * plugins keep the link from their reviewed release.
 */
async function withMainVideo(entry, repo, problems) {
  try {
    const file = await github(`/repos/${repo}/contents/manifest.json`);
    const manifest = JSON.parse(Buffer.from(file.content, "base64").toString());
    if (typeof manifest.video === "string" && YOUTUBE.test(manifest.video)) {
      return { ...entry, video: manifest.video };
    }
  } catch (error) {
    problems.push(
      `${repo}: could not read the manifest video (${error.message})`,
    );
  }
  return entry;
}

async function readPinned({
  repo,
  id,
  pin,
  keys,
  signer,
  online,
  certs,
  store,
  old,
  problems,
}) {
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

  const listed = (old ? allReleases(old) : []).find(
    (entry) => entry.version === pin.version && entry.sha256 === pin.sha256,
  );
  const hex = digest.toString("hex");
  const hasChain = releaseSigned(
    {
      sha256: hex,
      signatures: [
        ...(listed?.signatures ?? []),
        ...(store[`${id}@${pin.version}`]?.sha256 === hex
          ? store[`${id}@${pin.version}`].signatures
          : []),
      ],
    },
    [],
    certs,
  );
  if (!hasChain) {
    if (!online) {
      problems.push(`${where}: no online key set to sign it with`);
      return null;
    }
    const { keyId, sig } = chainSign(digest, online, {
      tier: "community",
      role: "plugins",
    });
    storeSignature(
      store,
      { id, version: pin.version, sha256: hex, keyId, sig },
      certs,
    );
  }
  let signature = listed?.signature ?? "";
  if (signature && !isSigned(digest, signature, keys)) signature = "";
  if (!signature && signer && Date.now() < LEGACY_UNTIL) {
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

/** Like unchanged(), for a reviewed submission whose pins all still match. */
async function keptSubmission(old, repo, submission, pins, keys, certs) {
  if (full || !old) return null;
  const listed = allReleases(old);
  if (
    pins.some((pin) => !listed.some((entry) => entry.sha256 === pin.sha256))
  ) {
    return null;
  }
  const files = [];
  for (const pin of pins) {
    const release = await github(
      `/repos/${repo}/releases/tags/v${pin.version}`,
    ).catch(() => null);
    const asset = release?.assets.find(
      (item) => item.name === `${submission.id}-${pin.version}.tmxplug`,
    );
    if (!asset) return null;
    files.push({ version: pin.version, asset });
  }
  return unchanged(old, `https://github.com/${repo}`, files, keys, certs);
}

async function reviewedPlugins(
  dir,
  registry,
  previous,
  keys,
  certs,
  store,
  problems,
) {
  const prefix = `TERMIX_${registry.toUpperCase().replace(/-/g, "_")}`;
  const signer = loadPrivateKey(process.env[`${prefix}_SIGNING_KEY`]);
  const online = loadPrivateKey(process.env[`${prefix}_ONLINE_KEY`]);
  const plugins = [];
  for (const { file, submission } of readSubmissions(dir)) {
    const repo = githubRepo(submission.repository);
    if (!repo) {
      problems.push(`${path.basename(file)}: repository is not a GitHub repo`);
      continue;
    }
    const old = previous.get(submission.id);
    const pins = submission.versions ?? [];
    const kept = await keptSubmission(old, repo, submission, pins, keys, certs);
    if (kept) {
      plugins.push(placeReleases(await backfill(kept, repo, problems)));
      continue;
    }

    const found = [];
    for (const pin of pins) {
      try {
        const entry = await readPinned({
          repo,
          id: submission.id,
          pin,
          keys,
          signer,
          online,
          certs,
          store,
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
    plugins.push(
      placeReleases({
        ...listing(latest, `https://github.com/${repo}`, null),
        versions: stable.map(({ version }) => version),
        ...(prereleases.length > 0 ? { prereleases } : {}),
      }),
    );
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
  const certs = indexCerts(index.registry);
  const store = loadChainStore(dir);

  const found = fs.existsSync(path.join(dir, "sources.json"))
    ? await officialPlugins(dir, previous, keys, certs, store, problems)
    : await reviewedPlugins(
        dir,
        index.registry,
        previous,
        keys,
        certs,
        store,
        problems,
      );
  const plugins = found.map((plugin) => attachChain(plugin, store, certs));
  if (saveChainStore(dir, store)) {
    console.log(
      `${path.relative(root, path.join(dir, "signatures.json"))}: updated`,
    );
  }

  plugins.sort((a, b) => a.id.localeCompare(b.id));
  const ids = new Set();
  for (const plugin of plugins) {
    if (ids.has(plugin.id)) problems.push(`${plugin.id} comes from two repos`);
    ids.add(plugin.id);
  }

  const publicKey = keys[0].publicKey;
  if (
    JSON.stringify(plugins) === before &&
    index.publicKey === publicKey &&
    JSON.stringify(index.certs ?? []) === JSON.stringify(certs)
  ) {
    console.log(`${path.relative(root, indexPath)}: up to date`);
    return;
  }
  const { $schema, registry, name, apiVersion } = index;
  const next = {
    $schema,
    registry,
    name,
    apiVersion,
    publicKey,
    ...(certs.length > 0 ? { certs } : {}),
    updatedAt: new Date().toISOString(),
    plugins,
  };
  fs.writeFileSync(indexPath, `${JSON.stringify(next, null, 2)}\n`);
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
