// Signs one official .tmxplug with TERMIX_PLUGIN_SIGNING_KEY and writes
// <file>.sig. Checks the file is the plugin and version we meant to sign.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { loadKeys, readTmxplugFile } from "../lib.mjs";
import { signArtifact } from "./lib.mjs";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    id: { type: "string" },
    version: { type: "string" },
  },
});
const file = positionals[0];
if (!file || !file.endsWith(".tmxplug")) {
  throw new Error("Pass the .tmxplug to sign");
}

const buffer = fs.readFileSync(file);
const raw = readTmxplugFile(buffer, "manifest.json");
if (!raw) throw new Error(`no manifest.json in ${path.basename(file)}`);
const manifest = JSON.parse(raw.toString("utf8"));
if (manifest.id !== values.id || manifest.version !== values.version) {
  throw new Error(
    `${path.basename(file)} is ${manifest.id} ${manifest.version}, expected ${values.id} ${values.version}`,
  );
}
if (path.basename(file) !== `${manifest.id}-${manifest.version}.tmxplug`) {
  throw new Error(`${path.basename(file)} does not match its manifest`);
}

const keys = loadKeys().filter(({ file: name }) => name === "official.pub");
const { sha256, signature } = signArtifact(
  buffer,
  process.env.TERMIX_PLUGIN_SIGNING_KEY,
  keys,
);
fs.writeFileSync(`${file}.sig`, `${signature}\n`);
console.log(`signed ${path.basename(file)}, sha256 ${sha256}`);
