/**
 * Checks every index in this repo.
 *
 * - the index matches registry-index-schema.json
 * - plugin ids and versions are unique, versions newest first
 * - each version's .tmxplug downloads, and its size, sha256 and signature
 *   match (skipped with --offline)
 *
 * Signatures are checked against keys/*.pub. That only catches mistakes
 * early; the Termix server trusts only the keys compiled into it.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { compareVersions, isSigned, loadKeys, root } from "./lib.mjs";

const offline = process.argv.includes("--offline");

const schema = JSON.parse(
  fs.readFileSync(path.join(root, "registry-index-schema.json"), "utf8"),
);
const ajv = new Ajv2020({ allErrors: true });
addFormats(ajv);
const validateSchema = ajv.compile(schema);

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

async function checkArtifact(where, version, keys, problems) {
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
  const signed = isSigned(digest, version.signature, keys);
  if (!signed) {
    problems.push(`${where}: signature does not match any key in keys/`);
  }
}

async function main() {
  const keys = loadKeys();
  const problems = [];
  const indexes = findIndexes();

  for (const file of indexes) {
    const rel = path.relative(root, file);
    const index = JSON.parse(fs.readFileSync(file, "utf8"));

    if (!validateSchema(index)) {
      for (const error of validateSchema.errors ?? []) {
        problems.push(`${rel}${error.instancePath}: ${error.message}`);
      }
      continue;
    }

    const ids = new Set();
    for (const plugin of index.plugins) {
      if (ids.has(plugin.id))
        problems.push(`${rel}: ${plugin.id} is listed twice`);
      ids.add(plugin.id);

      const versions = plugin.versions.map((entry) => entry.version);
      if (new Set(versions).size !== versions.length) {
        problems.push(`${rel}: ${plugin.id} lists a version twice`);
      }
      const sorted = [...versions].sort((a, b) => compareVersions(b, a));
      if (sorted.join() !== versions.join()) {
        problems.push(`${rel}: ${plugin.id} versions must be newest first`);
      }

      if (offline) continue;
      if (keys.length === 0) {
        problems.push("keys/ has no .pub file to check signatures against");
        break;
      }
      for (const version of plugin.versions) {
        await checkArtifact(
          `${rel}: ${plugin.id}@${version.version}`,
          version,
          keys,
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
