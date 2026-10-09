# Keys

Each `*.pub` file here holds one base64 Ed25519 public key, the "public key" line that `termix-plugin keygen` prints. Each index is checked against the key with its name: `official/index.json` against `official.pub`, `community/index.json` against `community.pub`.

- `official.pub`: signs official plugin releases. The private key is the `TERMIX_PLUGIN_SIGNING_KEY` secret of the plugin repos.
- `community.pub`: signs community plugins after review. The private key is this repo's `TERMIX_COMMUNITY_SIGNING_KEY` secret, used only by the sync job.

These files only help CI catch mistakes. The Termix server never reads them. It only trusts the keys built into `src/backend/plugins/trust.ts`.
