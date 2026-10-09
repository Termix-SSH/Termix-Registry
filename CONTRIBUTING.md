# Submitting a plugin

This repo holds two plugin lists:

- `official/`: the plugins made by the Termix team. Not open to submissions.
- `community/`: plugins made by anyone, reviewed by a person before they are listed.

Termix can't install community plugins yet. That comes in a later update. The community registry is open now so it is ready when that update ships. Until then, people can install your plugin from a `.tmxplug` file with plugin developer mode on.

The full guide is at [docs.termix.site/develop/community-registry](https://docs.termix.site/develop/community-registry).

## Before you submit

- Your plugin is in a public GitHub repo with an open source license.
- It was made from the [plugin template](https://github.com/Termix-SSH/Termix-Plugin-Template), or uses the same `.github/workflows/release.yml`.
- `npm test`, `npm run typecheck`, `npm run validate` and `npm run build` pass.
- The id in `manifest.json` is not used by an official plugin or another submission.
- `manifest.json` has a clear `name`, `description` and `author`, `repository` set to your repo, and a `docs` link or a README that explains how to use it.

## Submit

1. Run the Release workflow in your plugin repo (stable or beta). It builds the `.tmxplug`, publishes it as a GitHub release and records where it was built (GitHub build provenance). No secrets are needed.
2. Open the workflow run. Its summary shows the version and the `sha256` of the file.
3. Fork this repo and add `community/plugins/<id>.json`:

   ```json
   {
     "$schema": "../../community-submission-schema.json",
     "id": "my-plugin",
     "repository": "https://github.com/you/termix-plugin-my-plugin",
     "maintainers": ["you"],
     "versions": [{ "version": "1.0.0", "sha256": "<from the run summary>" }]
   }
   ```

   `maintainers` are the GitHub usernames allowed to send updates. You must be one of them.

4. Open a pull request. The Check submission job downloads your release, checks the `sha256`, the manifest and the build provenance, and writes a summary for the reviewer.
5. A maintainer reviews the source at your release tag. Once it is merged, your plugin is listed in `community/index.json` within a few minutes.

## Updates

Every version is reviewed. Release the new version, then open a PR that adds it to the top of `versions`. Only a listed maintainer can open it. The reviewer sees what changed since your last listed version, and any new capabilities.

A version that was listed can't be swapped for another file. If you overwrite a release after it was reviewed, it drops out of the registry until you submit it again under a new version.

## What reviewers check

- The source at the release tag does what the name and description say, and nothing else.
- No obfuscated or minified source, and no code downloaded and run at runtime.
- No network calls, tracking or telemetry the user did not ask for. Anything like that is off by default and explained in the docs.
- Capabilities and permissions are the fewest the plugin needs.
- `package.json` scripts and dependencies don't fetch or run anything unexpected during install or build.
- Secrets and credentials are only used for what the plugin is for, and never sent anywhere else.
- The name and icon don't pretend to be an official plugin.

A plugin can be removed from the registry if it breaks these rules later, stops working, or its repo goes away.

## Removing your plugin

Open a PR that deletes `community/plugins/<id>.json`.

## Questions

Ask in the [Discord](https://discord.gg/jVQGdvHDrf) or open an issue in this repo.
