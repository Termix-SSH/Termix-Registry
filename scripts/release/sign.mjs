// Signs one official .tmxplug. Writes <file>.sig, the chain envelope from
// TERMIX_PLUGIN_ONLINE_KEY and its root certificate, and until the
// move-over ends also <file>.legacy.sig from TERMIX_PLUGIN_SIGNING_KEY for
// Termix versions from before the chain. Checks the file is the plugin and
// version we meant to sign.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { loadKeys, readTmxplugFile, sha256, loadPrivateKey } from "../lib.mjs";
import { signArtifact } from "./lib.mjs";
import { LEGACY_UNTIL, chainSign } from "../trust/lib.mjs";

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

const online = loadPrivateKey(process.env.TERMIX_PLUGIN_ONLINE_KEY);
if (!online) throw new Error("TERMIX_PLUGIN_ONLINE_KEY is not set");
const digest = sha256(buffer);
const { keyId, sig, cert } = chainSign(digest, online, {
  tier: "official",
  role: "plugins",
});
fs.writeFileSync(
  `${file}.sig`,
  `${JSON.stringify({ v: 2, keyId, sig, cert })}\n`,
);

if (Date.now() < LEGACY_UNTIL) {
  const keys = loadKeys().filter(({ file: name }) => name === "official.pub");
  const legacy = signArtifact(
    buffer,
    process.env.TERMIX_PLUGIN_SIGNING_KEY,
    keys,
  );
  fs.writeFileSync(`${file}.legacy.sig`, `${legacy.signature}\n`);
}
console.log(
  `signed ${path.basename(file)} with key ${keyId}, sha256 ${digest.toString("hex")}`,
);
