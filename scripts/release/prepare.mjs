// Run inside a plugin checkout: picks the version, stamps it into the
// manifest, package and lock, and adds a beta changelog section. Writes
// version, tag, prev, base and locales to GITHUB_OUTPUT.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import process from "node:process";
import { parseArgs } from "node:util";
import {
  insertChangelogSection,
  resolveVersion,
  stampJsonText,
  stampLockText,
} from "./lib.mjs";

const { values } = parseArgs({
  options: {
    channel: { type: "string", default: "stable" },
    mode: { type: "string", default: "release" },
    branch: { type: "string" },
  },
});

const git = (...args) =>
  execFileSync("git", args, { encoding: "utf8" }).trim().split("\n");

const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const { version, base } = resolveVersion({
  channel: values.channel,
  mode: values.mode,
  branch: values.branch,
  tags: git("tag", "-l", "v*").filter(Boolean),
});
const prev =
  git("tag", "-l", "v*", "--sort=-v:refname", "--merged", "HEAD").find(
    (tag) => tag && tag !== `v${version}`,
  ) ?? "";
console.log(
  `Releasing ${version} (${values.channel}, ${values.mode}), changes since ${prev || "the start"}`,
);

for (const file of ["manifest.json", "package.json"]) {
  fs.writeFileSync(
    file,
    stampJsonText(fs.readFileSync(file, "utf8"), version, file),
  );
}
if (fs.existsSync("package-lock.json")) {
  fs.writeFileSync(
    "package-lock.json",
    stampLockText(fs.readFileSync("package-lock.json", "utf8"), version),
  );
}

// A beta's notes come from git. Betas never commit, so CHANGELOG.md in git
// stays as it was; this copy only feeds validate and the .tmxplug.
if (values.channel === "beta" && fs.existsSync("CHANGELOG.md")) {
  const log = prev
    ? git(
        "log",
        "--no-merges",
        "--format=- %s",
        `${prev}..HEAD`,
        "--",
        ".",
        ":!package-lock.json",
      )
        .filter(Boolean)
        .slice(0, 100)
    : [];
  const section = [
    `## ${version}`,
    "",
    "### Changed",
    "",
    ...log,
    "- Beta build",
    "",
    "",
  ].join("\n");
  fs.writeFileSync(
    "CHANGELOG.md",
    insertChangelogSection(fs.readFileSync("CHANGELOG.md", "utf8"), section),
  );
}

const localesDir = manifest.locales || "locales";
const locales = fs.existsSync(`${localesDir}/en.json`) ? localesDir : "";

const out = process.env.GITHUB_OUTPUT;
const lines = [
  `version=${version}`,
  `tag=v${version}`,
  `prev=${prev}`,
  `base=${base}`,
  `locales=${locales}`,
];
if (out) fs.appendFileSync(out, lines.join("\n") + "\n");
else console.log(lines.join("\n"));
