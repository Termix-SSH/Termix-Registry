/**
 * Checks the community submissions a pull request adds or changes, and
 * writes what a reviewer needs to $GITHUB_STEP_SUMMARY.
 *
 * Env:
 * - BASE_REF: the branch the PR goes into (default origin/main)
 * - HEAD_REF: the PR's commit. Unset reads the working tree, for local runs
 * - PR_AUTHOR: the GitHub login that opened the PR
 * - GH_TOKEN: for the GitHub API and gh attestation verify
 *
 * The PR's files are only read as data. The workflow runs this script from
 * the base branch, so a PR can't change what checks it.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import Ajv2020 from "ajv/dist/2020.js";
import {
  compareVersions,
  download,
  github,
  githubRepo,
  inspectArtifact,
  readSubmissions,
  root,
  sha256,
} from "./lib.mjs";

const REGISTRY_DIR = "community";
const SIGNER_WORKFLOW =
  "Termix-SSH/Termix-Registry/.github/workflows/plugin-release.yml";

const baseRef = process.env.BASE_REF || "origin/main";
const headRef = process.env.HEAD_REF || null;
const author = (process.env.PR_AUTHOR || "").toLowerCase();

const ajv = new Ajv2020({ allErrors: true });
const validateSubmission = ajv.compile(
  JSON.parse(
    fs.readFileSync(
      path.join(root, "community-submission-schema.json"),
      "utf8",
    ),
  ),
);

function git(...args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** A file's text at a ref, or the working tree when ref is null. */
function readAt(ref, file) {
  try {
    return ref
      ? git("show", `${ref}:${file}`)
      : fs.readFileSync(path.join(root, file), "utf8");
  } catch {
    return null;
  }
}

function changedFiles() {
  const pattern = `${REGISTRY_DIR}/plugins/`;
  const files = headRef
    ? git("diff", "--name-only", `${baseRef}...${headRef}`, "--", pattern)
    : git("diff", "--name-only", baseRef, "--", pattern) +
      git("ls-files", "--others", "--exclude-standard", "--", pattern);
  return [...new Set(files.split("\n").filter(Boolean))].filter((file) =>
    file.endsWith(".json"),
  );
}

function parse(text) {
  try {
    return text === null ? null : JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Fetches a pinned release file and the facts a reviewer needs. */
async function readVersion(repo, id, pin) {
  const release = await github(`/repos/${repo}/releases/tags/v${pin.version}`);
  const artifact = release.assets.find(
    (asset) => asset.name === `${id}-${pin.version}.tmxplug`,
  );
  if (!artifact) {
    throw new Error(
      `release v${pin.version} has no ${id}-${pin.version}.tmxplug`,
    );
  }
  const buffer = await download(artifact.browser_download_url);
  const inspected = inspectArtifact(buffer, release, artifact);
  if (typeof inspected === "string") throw new Error(inspected);
  const commit = await github(`/repos/${repo}/commits/v${pin.version}`);
  return {
    release,
    buffer,
    sha256: sha256(buffer).toString("hex"),
    manifest: inspected.manifest,
    commit: commit.sha,
  };
}

/** gh attestation verify, returning the run that built the file. */
function verifyProvenance(repo, buffer, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "termix-submission-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, buffer);
  try {
    const out = execFileSync(
      "gh",
      [
        "attestation",
        "verify",
        file,
        "--repo",
        repo,
        "--signer-workflow",
        SIGNER_WORKFLOW,
        "--format",
        "json",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const results = JSON.parse(out);
    const predicate = results[0]?.verificationResult?.statement?.predicate;
    return {
      ok: true,
      commit:
        predicate?.buildDefinition?.resolvedDependencies?.[0]?.digest
          ?.gitCommit ?? null,
      run: predicate?.runDetails?.metadata?.invocationId ?? null,
    };
  } catch (error) {
    const detail = String(error.stderr || error.message).trim();
    return {
      ok: false,
      detail: detail.includes("404")
        ? "no attestation found"
        : detail.split("\n").pop(),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function officialIds() {
  const index = parse(readAt(null, "official/index.json"));
  return new Set((index?.plugins ?? []).map((plugin) => plugin.id));
}

async function checkFile(file, problems, lines) {
  const name = path.basename(file);
  const head = parse(readAt(headRef, file));
  const base = parse(readAt(baseRef, file));
  const fail = (message) => problems.push(`${file}: ${message}`);

  if (head === null) {
    lines.push(`### ${name}`, "", "Removes this plugin from the registry.", "");
    if (base && !base.maintainers?.some((m) => m.toLowerCase() === author)) {
      lines.push(`PR author @${author} is not a maintainer of it.`, "");
    }
    return;
  }
  if (head === undefined) return fail("is not valid JSON");
  if (!validateSubmission(head)) {
    for (const error of validateSubmission.errors ?? []) {
      fail(`${error.instancePath || "/"} ${error.message}`);
    }
    return;
  }
  if (name !== `${head.id}.json`) fail(`must be named ${head.id}.json`);

  const allowed = (base ?? head).maintainers.map((m) => m.toLowerCase());
  if (!author) {
    fail("PR_AUTHOR is not set");
  } else if (!allowed.includes(author)) {
    fail(
      base
        ? `@${author} is not a maintainer of this plugin`
        : `@${author} must be in maintainers`,
    );
  }
  if (base && base.id !== head.id) fail("the id can't change");
  if (base && base.repository !== head.repository) {
    lines.push("> [!WARNING]", "> This PR changes the repository.", "");
  }
  if (officialIds().has(head.id)) fail(`${head.id} is an official plugin id`);
  for (const other of readSubmissions(path.join(root, REGISTRY_DIR))) {
    if (other.submission.id === head.id && path.basename(other.file) !== name) {
      fail(`${head.id} is already submitted in ${path.basename(other.file)}`);
    }
  }

  const basePins = new Map(
    (base?.versions ?? []).map((pin) => [pin.version, pin.sha256]),
  );
  for (const pin of head.versions) {
    const old = basePins.get(pin.version);
    if (old && old !== pin.sha256) {
      fail(`${pin.version} was already reviewed with another sha256`);
    }
  }
  const sorted = head.versions
    .map((pin) => pin.version)
    .sort((a, b) => compareVersions(b, a));
  if (sorted.join() !== head.versions.map((pin) => pin.version).join()) {
    fail("versions must be newest first");
  }

  const repo = githubRepo(head.repository);
  const fresh = head.versions.filter((pin) => !basePins.has(pin.version));
  const previousPin = base?.versions?.[0] ?? null;
  let previousManifest = null;
  if (previousPin && fresh.length > 0) {
    try {
      previousManifest = (await readVersion(repo, head.id, previousPin))
        .manifest;
    } catch {
      // Only used to point out new capabilities.
    }
  }

  lines.push(
    `### ${head.id}`,
    "",
    `Repository: ${head.repository}`,
    `Maintainers: ${head.maintainers.map((m) => `@${m}`).join(", ")}`,
    "",
  );
  if (fresh.length === 0) {
    lines.push("No new versions.", "");
    return;
  }

  for (const pin of fresh) {
    const where = `${head.id}@${pin.version}`;
    let found;
    try {
      found = await readVersion(repo, head.id, pin);
    } catch (error) {
      fail(`${pin.version}: ${error.message}`);
      continue;
    }
    const { manifest } = found;
    if (found.sha256 !== pin.sha256) {
      fail(`${pin.version}: the release file has sha256 ${found.sha256}`);
    }
    if (manifest.id !== head.id) {
      fail(`${pin.version}: the manifest id is ${manifest.id}`);
    }
    if (
      manifest.repository &&
      githubRepo(manifest.repository)?.toLowerCase() !== repo.toLowerCase()
    ) {
      fail(`${pin.version}: the manifest repository is ${manifest.repository}`);
    }
    if (!manifest.engine?.api)
      fail(`${pin.version}: manifest has no engine.api`);

    const provenance = verifyProvenance(
      repo,
      found.buffer,
      `${head.id}-${pin.version}.tmxplug`,
    );
    if (!provenance.ok) {
      fail(
        `${pin.version}: no build provenance from the Termix release workflow (${provenance.detail})`,
      );
    }

    const compare = previousPin
      ? `https://github.com/${repo}/compare/v${previousPin.version}...v${pin.version}`
      : `https://github.com/${repo}/tree/v${pin.version}`;
    const capabilities = manifest.capabilities ?? [];
    const before = new Set(previousManifest?.capabilities ?? []);
    const shownCapabilities = capabilities.map((capability) =>
      previousManifest && !before.has(capability)
        ? `\`${capability}\` (new)`
        : `\`${capability}\``,
    );

    lines.push(
      `#### ${where}`,
      "",
      `- Name: ${manifest.name}`,
      `- Description: ${manifest.description}`,
      `- Release: ${found.release.html_url}`,
      `- Tag commit: https://github.com/${repo}/commit/${found.commit}`,
      `- ${previousPin ? `Changes since ${previousPin.version}` : "Source"}: ${compare}`,
      provenance.ok
        ? `- Built by: ${provenance.run ?? "the Termix release workflow"}${
            provenance.commit ? ` from ${provenance.commit}` : ""
          }`
        : "- Built by: unknown, no provenance",
      `- Size: ${(found.buffer.length / 1024).toFixed(0)} KB`,
      `- API: ${manifest.engine?.api ?? "missing"}`,
      `- Capabilities: ${shownCapabilities.join(", ") || "none"}`,
      "",
    );
  }
}

async function main() {
  const problems = [];
  const lines = ["## Community submission check", ""];
  const files = changedFiles();
  if (files.length === 0) {
    lines.push("This PR changes no submissions.");
  }
  for (const file of files) {
    try {
      await checkFile(file, problems, lines);
    } catch (error) {
      problems.push(`${file}: ${error.message}`);
    }
  }

  if (problems.length > 0) {
    lines.push("### Problems", "", ...problems.map((p) => `- ${p}`), "");
  } else if (files.length > 0) {
    lines.push(
      "All checks passed. A maintainer still reviews the source before merging.",
    );
  }
  const summary = `${lines.join("\n")}\n`;
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  }
  console.log(summary);
  if (problems.length > 0) process.exit(1);
}

await main();
