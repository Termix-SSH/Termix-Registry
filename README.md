<div align="center">

<img src="https://termix.site/img/logo.svg" width="120" alt="Termix Logo" />

<h1>Termix Registry</h1>

<p>The list of plugins you can install in Termix</p>

<p>
  <img src="https://img.shields.io/github/stars/Termix-SSH/Termix-Registry?style=flat&label=Stars&color=F39044&labelColor=1a1a1a" />
  <img src="https://img.shields.io/github/forks/Termix-SSH/Termix-Registry?style=flat&label=Forks&color=F39044&labelColor=1a1a1a" />
  <a href="https://discord.gg/jVQGdvHDrf"><img alt="Discord" src="https://img.shields.io/discord/1347374268253470720?color=F39044&labelColor=1a1a1a" /></a>
  <a href="https://donate.termix.site/"><img alt="Donate" src="https://img.shields.io/badge/Donate-Support%20Termix-F39044?style=flat&labelColor=1a1a1a" /></a>
  <a href="https://scorecard.dev/viewer/?uri=github.com/Termix-SSH/Termix-Registry"><img alt="OpenSSF Scorecard" src="https://img.shields.io/ossf-scorecard/github.com/Termix-SSH/Termix-Registry?label=OpenSSF%20Scorecard&style=flat&color=F39044&labelColor=1a1a1a" /></a>
</p>

</div>

<br />

## Overview

This is the plugin registry for [Termix](https://github.com/Termix-SSH/Termix), self-hosted, plugin-based server management. It has two lists:

- `official/index.json`: the official Termix plugins. Each is built from its own `Plugin-<Name>` repo and released and signed by this repo. Termix reads it to show the plugins you can install from the Plugins tab.
- `community/index.json`: plugins made by anyone and reviewed by a person before they are listed. Admins turn it on in Termix under Plugins, Registries.

Want to build your own plugin? Start from the [plugin template](https://github.com/Termix-SSH/Termix-Plugin-Template). You can also host your own registry and add it to Termix by its URL. See [host your own registry](https://docs.termix.site/develop/registries#host-your-own-registry).

<br />

## Submit a plugin

The community registry is open for submissions. Release your plugin with the template's Release workflow, then open a pull request that adds `community/plugins/<id>.json`. See [CONTRIBUTING.md](CONTRIBUTING.md) for the steps and what reviewers check.

<br />

## Releasing official plugins

Maintainers run the Release Plugin workflow here with one plugin id or a comma list. Each plugin is built from its only `dev-X.Y.Z` branch with no secrets, then a person approves the `release` environment and the run signs it, merges the branch into `main`, tags and releases it. The signing key and the CI App key live only in this repo's environments, so plugin repos hold no secrets.

Before anything is signed, the release gate (`release-gate.yml`) runs on the same commit: zizmor on the workflows, osv-scanner on the lockfile, every `GHSA-*.test.*` regression test (none may be skipped), the authorization matrix, and a check for new high or critical CodeQL alerts. If one fails, nothing is published. Core's Release uses the same gate.

Once published, the release is built again from its tag on a separate machine with no keys. The index lists it only when that rebuild gives the same file, byte for byte.

<br />

## Signing keys

Termix trusts only offline root keys, two per registry, kept in `trust/<registry>/root.pub`. They sign the certificates of the online keys the workflows use (`trust/<registry>/certs.json`, one year each) and the revocation lists (`trust/<registry>/revocations.json`). The [Signing keys](https://docs.termix.site/install/signing-keys) page covers how it works, the yearly renewal and what to do if a key leaks. The `trust:new-key`, `trust:revoke`, `trust:sign` and `trust:check` npm scripts do the work.

<br />

## Sponsors

For a paid sponsor spot, email [mail@termix.site](mailto:mail@termix.site).

<!-- SPONSORS:START -->

<div align="center">

<br />

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
&nbsp;&nbsp;&nbsp;
<a href="https://emberswan.com/">
  <img src="https://termix.site/img/sponsors/emberswan.png" height="40" alt="Ember Swan" />
</a>

</div>

<!-- SPONSORS:END -->

<br />

## Support

Problems with the registry itself (a plugin missing from a list, a broken index) go in this repo's [issues](https://github.com/Termix-SSH/Termix-Registry/issues). A bug in a plugin goes in that plugin's own repo, and problems with Termix itself go in the [Termix repo](https://github.com/Termix-SSH/Termix/issues/new/choose).

Add as much detail as you can, in English if possible.

For discussions and questions, join the [Discord](https://discord.gg/jVQGdvHDrf) server.

<br />

## License

Apache License 2.0. See [LICENSE](LICENSE).
