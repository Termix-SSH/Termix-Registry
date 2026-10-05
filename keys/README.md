# Keys

Each `*.pub` file here holds one base64 Ed25519 public key, the "public key" line that `termix-plugin keygen` prints. CI checks every signature in the index against these files.

These files only help CI catch mistakes. The Termix server never reads them. It only trusts the keys built into `src/backend/plugins/trust.ts`.
