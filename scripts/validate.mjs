/**
 * Checks every index in this repo.
 *
 * - the index matches registry-index-schema.json
 * - plugin ids and versions are unique, versions newest first
 * - gated holds exactly the releases the last unchecking Termix can't run
 * - each version's .tmxplug exists, and its size, sha256 and signature
 *   match (skipped with --offline). Read from the GitHub API digest when
 *   there is one, so the download count stays untouched
 * - reviewed registries (a plugins/ folder): every submission matches
 *   community-submission-schema.json, and every listed version is one a
 *   submission pins
 * - no plugin id is in two registries
 * - publicKey, when set, is the key in keys/<registry>.pub
 *
 * - certs, when set, are the root signed certificates in trust/<registry>/
 *
 * Signatures are checked against keys/<registry>.pub (pre-chain) and the
 * registry's certificates (chain). That only catches mistakes early; the
 * Termix server trusts only the root keys compiled into it.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  allReleases,
  assetSha256,
  compareVersions,
  findReleaseAsset,
  isPrerelease,
  keysFor,
  loadKeys,
  needsNewerCore,
  readSubmissions,
  root,
} from "./lib.mjs";
import { indexCerts, releaseSigned } from "./trust/index-chain.mjs";

const offline = process.argv.includes("--offline");

const schema = JSON.parse(
  fs.readFileSync(path.join(root, "registry-index-schema.json"), "utf8"),
);
const ajv = new Ajv2020({ allErrors: true });
addFormats(ajv);
const validateSchema = ajv.compile(schema);
const validateSubmission = ajv.compile(
  JSON.parse(
    fs.readFileSync(
      path.join(root, "community-submission-schema.json"),
      "utf8",
    ),
  ),
);

function findIndexes() {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .filter(
      (entry) => !["node_modules", "keys", "scripts"].includes(entry.name),
    )
    .map((entry) => path.join(root, entry.name, "index.json"))
    .filter((file) => fs.existsSync(file));
}

async function checkArtifact(where, version, keys, certs, problems) {
  // Through the API first, so validating does not add to the download count.
  const asset = await findReleaseAsset(version.url);
  const sha = assetSha256(asset);
  if (asset && sha) {
    if (asset.size !== version.size) {
      problems.push(
        `${where}: size is ${asset.size}, index says ${version.size}`,
      );
    }
    if (sha !== version.sha256) {
      problems.push(`${where}: sha256 does not match the file`);
      return;
    }
    if (!releaseSigned(version, keys, certs)) {
      problems.push(`${where}: signature does not match the registry keys`);
    }
    return;
  }

  const response = await fetch(version.url);
  if (!response.ok) {
    problems.push(`${where}: download failed with ${response.status}`);
    return;
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length !== version.size) {
    problems.push(
      `${where}: size is ${buffer.length}, index says ${version.size}`,
    );
  }
  const digest = crypto.createHash("sha256").update(buffer).digest();
  if (digest.toString("hex") !== version.sha256) {
    problems.push(`${where}: sha256 does not match the file`);
    return;
  }
  if (!releaseSigned(version, keys, certs)) {
    problems.push(`${where}: signature does not match the registry keys`);
  }
}

/** Submissions are well formed and the index lists only pinned files. */
function checkSubmissions(dir, index, problems) {
  const pinned = new Map();
  for (const { file, submission } of readSubmissions(dir)) {
    const rel = path.relative(root, file);
    if (!validateSubmission(submission)) {
      for (const error of validateSubmission.errors ?? []) {
        problems.push(`${rel}${error.instancePath}: ${error.message}`);
      }
      continue;
    }
    if (path.basename(file) !== `${submission.id}.json`) {
      problems.push(`${rel}: the file must be named ${submission.id}.json`);
    }
    const names = submission.versions.map((entry) => entry.version);
    if (new Set(names).size !== names.length) {
      problems.push(`${rel}: lists a version twice`);
    }
    const sorted = [...names].sort((a, b) => compareVersions(b, a));
    if (sorted.join() !== names.join()) {
      problems.push(`${rel}: versions must be newest first`);
    }
    pinned.set(
      submission.id,
      new Map(
        submission.versions.map((entry) => [entry.version, entry.sha256]),
      ),
    );
  }

  const rel = path.relative(root, path.join(dir, "index.json"));
  for (const plugin of index.plugins) {
    const pins = pinned.get(plugin.id);
    if (!pins) {
      problems.push(`${rel}: ${plugin.id} has no submission`);
      continue;
    }
    for (const entry of allReleases(plugin)) {
      if (pins.get(entry.version) !== entry.sha256) {
        problems.push(
          `${rel}: ${plugin.id}@${entry.version} is not a reviewed file`,
        );
      }
    }
  }
}

async function main() {
  const allKeys = loadKeys();
  const problems = [];
  const indexes = findIndexes();
  // Which index lists each plugin id, so no id is in two registries.
  const owners = new Map();
  for (const file of indexes) {
    const index = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const plugin of index.plugins ?? []) {
      const list = owners.get(plugin.id) ?? [];
      owners.set(plugin.id, [...list, path.relative(root, file)]);
    }
  }
  const takenElsewhere = (id, rel) =>
    (owners.get(id) ?? []).find((other) => other !== rel);

  for (const file of indexes) {
    const rel = path.relative(root, file);
    const index = JSON.parse(fs.readFileSync(file, "utf8"));

    if (!validateSchema(index)) {
      for (const error of validateSchema.errors ?? []) {
        problems.push(`${rel}${error.instancePath}: ${error.message}`);
      }
      continue;
    }

    const dir = path.dirname(file);
    if (fs.existsSync(path.join(dir, "plugins"))) {
      checkSubmissions(dir, index, problems);
    }
    for (const { file: sub, submission } of readSubmissions(dir)) {
      const other = takenElsewhere(submission.id, rel);
      if (other) {
        problems.push(
          `${path.relative(root, sub)}: ${submission.id} is taken in ${other}`,
        );
      }
    }
    const keys = keysFor(allKeys, index.registry);
    const certs = indexCerts(index.registry);
    if (JSON.stringify(index.certs ?? []) !== JSON.stringify(certs)) {
      problems.push(
        `${rel}: certs are not the valid ones in trust/${index.registry}/`,
      );
    }
    if (index.publicKey && !keys.some((k) => k.publicKey === index.publicKey)) {
      problems.push(
        `${rel}: publicKey is not the key in keys/${index.registry}.pub`,
      );
    }

    const ids = new Set();
    for (const plugin of index.plugins) {
      if (ids.has(plugin.id))
        problems.push(`${rel}: ${plugin.id} is listed twice`);
      ids.add(plugin.id);
      const other = takenElsewhere(plugin.id, rel);
      if (other) problems.push(`${rel}: ${plugin.id} is also in ${other}`);

      const prereleases = plugin.prereleases ?? [];
      const gated = plugin.gated ?? [];
      if (allReleases(plugin).length === 0) {
        problems.push(`${rel}: ${plugin.id} has no releases`);
      }
      for (const entry of allReleases(plugin)) {
        if (needsNewerCore(entry) !== gated.includes(entry)) {
          problems.push(
            `${rel}: ${plugin.id}@${entry.version} ${
              gated.includes(entry) ? "does not belong" : "belongs"
            } in gated`,
          );
        }
      }
      const every = allReleases(plugin).map((entry) => entry.version);
      if (new Set(every).size !== every.length) {
        problems.push(`${rel}: ${plugin.id} lists a version in two lists`);
      }
      for (const [list, entries] of [
        ["versions", plugin.versions],
        ["prereleases", prereleases],
        ["gated", gated],
      ]) {
        const names = entries.map((entry) => entry.version);
        if (new Set(names).size !== names.length) {
          problems.push(`${rel}: ${plugin.id} lists a version twice`);
        }
        const sorted = [...names].sort((a, b) => compareVersions(b, a));
        if (sorted.join() !== names.join()) {
          problems.push(`${rel}: ${plugin.id} ${list} must be newest first`);
        }
        for (const name of list === "gated" ? [] : names) {
          if (isPrerelease(name) !== (list === "prereleases")) {
            problems.push(
              `${rel}: ${plugin.id}@${name} belongs in ${
                list === "versions" ? "prereleases" : "versions"
              }`,
            );
          }
        }
      }
      const newestStable = plugin.versions[0]?.version;
      for (const entry of prereleases) {
        if (newestStable && compareVersions(entry.version, newestStable) <= 0) {
          problems.push(
            `${rel}: ${plugin.id}@${entry.version} is older than stable ${newestStable}`,
          );
        }
      }

      if (offline) continue;
      if (keys.length === 0) {
        problems.push(`keys/${index.registry}.pub is missing`);
        break;
      }
      for (const version of allReleases(plugin)) {
        await checkArtifact(
          `${rel}: ${plugin.id}@${version.version}`,
          version,
          keys,
          certs,
          problems,
        );
      }
    }
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  console.log(`ok  ${indexes.length} index file(s)`);
}

await main();
