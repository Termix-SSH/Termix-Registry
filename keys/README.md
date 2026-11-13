# Keys

The keys from before the root chain. Each `*.pub` file holds one base64 Ed25519 public key. Each index is checked against the key with its name: `official/index.json` against `official.pub`, `community/index.json` against `community.pub`.

- `official.pub`: signed official plugin releases. The private key is the `TERMIX_PLUGIN_SIGNING_KEY` secret of the `release` environment.
- `community.pub`: signs community plugins after review. The private key is the `TERMIX_COMMUNITY_SIGNING_KEY` secret of the `sync` environment.

Releases are still signed with these until 2027-05-01, so Termix versions from before 26.11.2 keep getting updates. Termix 26.11.2 and newer only accept them for plugins that were already installed, until that date. New signatures come from the online keys in [`../trust`](../trust), which the offline root keys vouch for. After 2027-05-01, stop signing with these keys and delete both secrets.
