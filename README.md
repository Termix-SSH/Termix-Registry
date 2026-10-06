<div align="center">

<img src="https://raw.githubusercontent.com/Termix-SSH/Termix/main/public/icon.svg" width="120" height="120" alt="Termix Logo" />

<h1>Termix Registry</h1>

<p>The index of plugins Termix can install</p>

<p>
  <img src="https://img.shields.io/github/stars/Termix-SSH/Termix-Registry?style=flat&label=Stars&color=F39044&labelColor=1a1a1a" />
  <img src="https://img.shields.io/github/forks/Termix-SSH/Termix-Registry?style=flat&label=Forks&color=F39044&labelColor=1a1a1a" />
  <a href="https://discord.gg/jVQGdvHDrf"><img alt="Discord" src="https://img.shields.io/discord/1347374268253470720?color=F39044&labelColor=1a1a1a" /></a>
  <a href="https://donate.termix.site/"><img alt="Donate" src="https://img.shields.io/badge/Donate-Support%20Termix-F39044?style=flat&labelColor=1a1a1a" /></a>
</p>

</div>

<br />

## Overview

This repository holds the list of plugins [Termix](https://github.com/Termix-SSH/Termix) can install, with a download link, checksum and signature for every version. Each folder holds one registry:

- `official/index.json`: plugins published by the Termix team
- `official/sources.json`: the plugin repositories the index is built from

<br />

## Index Format

Every index follows `registry-index-schema.json`:

```json
{
  "registry": "official",
  "name": "Termix Official Plugins",
  "apiVersion": 1,
  "updatedAt": "2026-10-06T00:00:00.000Z",
  "plugins": [
    {
      "id": "snippets",
      "name": "Snippets",
      "description": "...",
      "author": "Termix",
      "category": "Productivity",
      "repository": "https://github.com/Termix-SSH/Plugin-Snippets",
      "icon": "Play",
      "versions": [
        {
          "version": "1.0.0",
          "api": "1",
          "url": "https://github.com/Termix-SSH/Plugin-Snippets/releases/download/v1.0.0/snippets-1.0.0.tmxplug",
          "sha256": "<64 hex>",
          "signature": "<base64 Ed25519 signature>",
          "size": 123456,
          "capabilities": ["db:own", "network:serve", "ui:surface"],
          "releaseNotesUrl": "https://github.com/Termix-SSH/Plugin-Snippets/releases/tag/v1.0.0",
          "publishedAt": "2026-10-06T00:00:00.000Z"
        }
      ]
    }
  ]
}
```

Versions are listed newest first. `icon` is a [Lucide](https://lucide.dev/icons) icon name, the same as `icon` in the plugin manifest. `dependencies` is listed on a version when its manifest has any. `signature` is an Ed25519 signature over the raw sha256 of the `.tmxplug`, the same bytes as the `.sig` file next to it in the release.

<br />

## Adding a Version

Nobody edits `index.json` by hand. The Sync workflow builds it from the GitHub releases of every repository in `sources.json`:

1. A plugin built from the [Termix Plugin Template](https://github.com/Termix-SSH/Termix-Plugin-Template) runs `.github/workflows/plugin-release.yml` from this repo when a tag like `v1.0.0` is pushed. It tests, builds, packs and signs the plugin, uploads the `.tmxplug` and `.sig` to the release, and tells this repo a release happened.
2. Sync downloads every release, checks its signature against `keys/` and its manifest against the tag, and commits the new index to `main`. It also runs every hour in case a notice was missed.

To re-release a version that is already out, run the plugin's Release workflow by hand, or force push its tag. The release files are replaced and Sync updates that version in place. A version whose release is deleted drops out of the index.

To add a plugin, add its repository to `sources.json`. Its releases must be signed with a key in `keys/`.

`.github/workflows/plugin-ci.yml` runs the same checks without signing, for pushes and pull requests in plugin repos.

Run the checks yourself with `npm ci && npm run validate`, or `npm run validate:offline` to skip the downloads. `npm run sync` rebuilds the index locally; set `GH_TOKEN` to avoid the GitHub rate limit.

<br />

## Signing Key Setup

You only do this once. You need Node.js 22 and the SDK, either with `npm install -g @termix-ssh/plugin-sdk` or by running `node packages/plugin-sdk/cli/index.mjs` from the Termix repo.

1. On a trusted machine, generate the key pair:

   ```bash
   termix-plugin keygen --out ./signing
   ```

   It writes the private key to `signing/termix-plugin-signing.key` and prints the public key and its key id. The private key is never printed.

2. Add the private key as a GitHub Actions secret named `TERMIX_PLUGIN_SIGNING_KEY`. For the Termix-SSH organization, make it an organization secret the plugin repositories can use:

   ```bash
   gh secret set TERMIX_PLUGIN_SIGNING_KEY --org Termix-SSH --visibility all \
     < signing/termix-plugin-signing.key
   ```

3. Keep an offline backup of the key file, like in a password manager or on an encrypted drive, then delete `signing/`. Never commit it.

4. Add the public key to `TRUSTED_PLUGIN_KEYS` in `src/backend/plugins/trust.ts` in Termix:

   ```ts
   { id: "<key id>", publicKey: "<public key>", addedIn: "<next release>" },
   ```

   Only a Termix release with that entry trusts the key.

5. Save the public key here as `keys/official.pub` so CI can check signatures.

6. Plugin repositories tell this one about a release with the `TERMIX_PAT` org secret, a token with contents write access to this repository.

<br />

## Rotating the Key

Termix never trusts a key it reads from an index, only keys built into the server. So a new key needs a Termix release:

1. Generate a new key pair as above.
2. Add the new public key to `TRUSTED_PLUGIN_KEYS` next to the old one and ship a Termix release.
3. Add `keys/<name>.pub` here, then switch `TERMIX_PLUGIN_SIGNING_KEY` to the new private key. New releases are signed with it.
4. Keep the old key in `trust.ts` for one release, so installs that update late still accept plugins signed before the switch. Then remove it from `trust.ts`, and from `keys/` once no listed version uses it.

If the private key leaks, skip the wait: ship a Termix release without the old key, sign every listed version again with the new key and update their `signature` fields.

<br />

## Sponsors

Interested in a paid placement to support development? Email [mail@termix.site](mailto:mail@termix.site).

<!-- SPONSORS:START -->

<div align="center">

<br />

<a href="https://www.digitalocean.com/">
  <img src="https://termix.site/img/sponsors/digitalocean.svg" height="40" alt="DigitalOcean" />
</a>
&nbsp;&nbsp;&nbsp;
<a href="https://crowdin.com/">
  <img src="https://termix.site/img/sponsors/crowdin.svg" height="40" alt="Crowdin" />
</a>
&nbsp;&nbsp;&nbsp;
<a href="https://www.blacksmith.sh/">
  <img src="https://termix.site/img/sponsors/blacksmith.svg" height="40" alt="Blacksmith" />
</a>
&nbsp;&nbsp;&nbsp;
<a href="https://www.cloudflare.com/">
  <img src="https://termix.site/img/sponsors/cloudflare.png" height="40" alt="Cloudflare" />
</a>
&nbsp;&nbsp;&nbsp;
<a href="https://akamai.com/">
  <img src="https://termix.site/img/sponsors/akamai.svg" height="40" alt="Akamai" />
</a>
&nbsp;&nbsp;&nbsp;
<a href="https://aws.amazon.com/">
  <img src="https://termix.site/img/sponsors/aws.png" height="40" alt="AWS" />
</a>
&nbsp;&nbsp;&nbsp;
<a href="https://rackgenius.com/">
  <img src="https://termix.site/img/sponsors/rackgenius.png" height="40" alt="Rack Genius" />
</a>
&nbsp;&nbsp;&nbsp;
<a href="https://ginernet.com/">
  <img src="https://termix.site/img/sponsors/ginernet.png" height="40" alt="Ginernet" />
</a>
&nbsp;&nbsp;&nbsp;
<a href="https://www.hetzner.com/?mtm_campaign=termix&mtm_medium=referral&mtm_content=sponsoring_link">
  <img src="https://termix.site/img/sponsors/hetzner.png" height="40" alt="Hetzner" />
</a>

</div>

<!-- SPONSORS:END -->

<br />

## Support

To report a bug or request a feature, open a [support ticket](https://github.com/Termix-SSH/Support/issues/new/choose). You need to be logged in to GitHub. Please be as detailed as possible, preferably in English.

For discussions and questions, join the [Discord](https://discord.gg/jVQGdvHDrf) server.

<br />

## License

Distributed under the Apache License Version 2.0. See [LICENSE](https://github.com/Termix-SSH/Termix/blob/main/LICENSE) for more information.
