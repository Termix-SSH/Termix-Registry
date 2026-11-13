// The reproducible build check, two halves (see reproduce.yml):
//   --repo R --tag T --dir D   compares the rebuilt .tmxplug in D with the
//                              published one's sha256 (API digest, no download)
//   --record --id --version --sha256 --run
//                              writes official/reproduced/<id>.json
// Sync reads the records through isReproduced.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { assetSha256, github, readTmxplugFile, root, sha256 } from "../lib.mjs";

/** Releases published from now on are listed only once rebuilt. */
export const REPRODUCE_FROM = Date.parse("2026-11-13T00:00:00Z");

export const reproducedDir = (base = root) =>
  path.join(base, "official", "reproduced");

export function readReproduced(id, base) {
  const file = path.join(reproducedDir(base), `${id}.json`);
  return fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf8"))
    : { versions: {} };
}

/** Whether a release may be listed: rebuilt to the same file, or older than the check. */
export function isReproduced({ id, version, sha256: hex, publishedAt }, base) {
  const published = Date.parse(publishedAt ?? "");
  if (Number.isFinite(published) && published < REPRODUCE_FROM) return true;
  return readReproduced(id, base).versions?.[version]?.sha256 === hex;
}

export function record(
  { id, version, sha256: hex, run, now = new Date() },
  base,
) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id ?? "")) throw new Error("bad plugin id");
  if (!/^[0-9a-f]{64}$/.test(hex ?? "")) throw new Error("bad sha256");
  const data = readReproduced(id, base);
  const versions = {
    ...data.versions,
    [version]: { sha256: hex, run, at: now.toISOString() },
  };
  const sorted = Object.fromEntries(
    Object.entries(versions).sort(([a], [b]) => a.localeCompare(b)),
  );
  fs.mkdirSync(reproducedDir(base), { recursive: true });
  fs.writeFileSync(
    path.join(reproducedDir(base), `${id}.json`),
    `${JSON.stringify({ id, versions: sorted }, null, 2)}\n`,
  );
}

/** Checks a rebuilt file against the release. Returns what it found. */
export function compare(buffer, name, release, tag) {
  const raw = readTmxplugFile(buffer, "manifest.json");
  if (!raw) throw new Error(`no manifest.json in ${name}`);
  const manifest = JSON.parse(raw.toString("utf8"));
  if (`v${manifest.version}` !== tag) {
    throw new Error(
      `the rebuild is version ${manifest.version}, the tag is ${tag}`,
    );
  }
  if (name !== `${manifest.id}-${manifest.version}.tmxplug`) {
    throw new Error(`${name} does not match its manifest`);
  }
  const asset = release.assets?.find((item) => item.name === name);
  const published = assetSha256(asset);
  if (!published) throw new Error(`${tag} has no ${name} with a sha256`);
  const rebuilt = sha256(buffer).toString("hex");
  if (rebuilt !== published) {
    throw new Error(
      `${name} did not rebuild to the same file: published ${published}, rebuilt ${rebuilt}`,
    );
  }
  return { id: manifest.id, version: manifest.version, sha256: rebuilt };
}

async function main() {
  const { values } = parseArgs({
    options: {
      repo: { type: "string" },
      tag: { type: "string" },
      dir: { type: "string" },
      record: { type: "boolean" },
      id: { type: "string" },
      version: { type: "string" },
      sha256: { type: "string" },
      run: { type: "string" },
    },
  });
  if (values.record) {
    record(values);
    console.log(`recorded ${values.id} ${values.version}`);
    return;
  }
  const files = fs
    .readdirSync(values.dir)
    .filter((name) => name.endsWith(".tmxplug"));
  if (files.length !== 1)
    throw new Error(`expected one .tmxplug in ${values.dir}`);
  const release = await github(
    `/repos/${values.repo}/releases/tags/${encodeURIComponent(values.tag)}`,
  );
  const found = compare(
    fs.readFileSync(path.join(values.dir, files[0])),
    files[0],
    release,
    values.tag,
  );
  console.log(
    `${files[0]} rebuilt to the published file, sha256 ${found.sha256}`,
  );
  const out = process.env.GITHUB_OUTPUT;
  if (out) {
    fs.appendFileSync(
      out,
      `id=${found.id}\nversion=${found.version}\nsha256=${found.sha256}\n`,
    );
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(import.meta.filename)
) {
  main().catch((error) => {
    console.error(`::error::${error.message}`);
    process.exit(1);
  });
}
