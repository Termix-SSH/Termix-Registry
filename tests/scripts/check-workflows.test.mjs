import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkWorkflow,
  checkWorkflowDir,
} from "../../scripts/check-workflows.mjs";

const workflows = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.github/workflows",
);

test("this repo's workflows keep secrets in environments", () => {
  assert.deepEqual(checkWorkflowDir(workflows), []);
});

test("a signing key in a job without an environment fails", () => {
  // The shape plugin-release.yml had: the key next to the plugin's npm ci.
  const text = `
on: workflow_call
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - run: npm ci
      - name: Sign
        env:
          TERMIX_PLUGIN_SIGNING_KEY: \${{ secrets.TERMIX_PLUGIN_SIGNING_KEY }}
        run: npx termix-plugin sign release/*.tmxplug
`;
  const problems = checkWorkflow("x.yml", text);
  assert.ok(problems.some((p) => p.includes("without an environment")));
  assert.ok(problems.some((p) => p.includes("npm install without")));
  assert.ok(problems.some((p) => p.includes("runs npx")));
});

test("secrets: inherit fails", () => {
  const text = `
on: workflow_dispatch
jobs:
  release:
    uses: ./.github/workflows/release-plugin-one.yml
    secrets: inherit
`;
  assert.ok(
    checkWorkflow("x.yml", text).some((p) => p.includes("secrets: inherit")),
  );
});

test("secrets passed by name to a local workflow pass, to a remote one fail", () => {
  const local = `
on: workflow_dispatch
jobs:
  release:
    uses: ./.github/workflows/release-plugin-one.yml
    secrets:
      CI_APP_PRIVATE_KEY: \${{ secrets.CI_APP_PRIVATE_KEY }}
`;
  assert.deepEqual(checkWorkflow("x.yml", local), []);
  const remote = local.replace(
    "./.github/workflows/release-plugin-one.yml",
    "someone/else/.github/workflows/x.yml@main",
  );
  assert.ok(
    checkWorkflow("x.yml", remote).some((p) =>
      p.includes("without an environment"),
    ),
  );
});

test("a key job with an npm cache fails", () => {
  const text = `
on: workflow_dispatch
jobs:
  sync:
    runs-on: ubuntu-latest
    environment: sync
    steps:
      - uses: actions/setup-node@v7
        with:
          cache: npm
      - run: npm ci --ignore-scripts
      - env:
          KEY: \${{ secrets.CI_APP_PRIVATE_KEY }}
        run: echo ok
`;
  assert.deepEqual(
    checkWorkflow("x.yml", text).map((p) => p.includes("uses a cache")),
    [true],
  );
});

test("an environment job in a pull_request_target workflow fails", () => {
  const text = `
on:
  pull_request_target:
jobs:
  go:
    runs-on: ubuntu-latest
    environment: release
    steps:
      - run: echo hi
`;
  assert.ok(
    checkWorkflow("x.yml", text).some((p) => p.includes("pull_request_target")),
  );
});

test("plugin-release.yml refuses official repos and reads no Termix secret", () => {
  // The shape it had: official plugins translated and signed here.
  const text = `
on:
  workflow_call:
    secrets:
      TERMIX_PAT:
        required: false
      TERMIX_LLM_API_KEY:
        required: true
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          token: \${{ secrets.TERMIX_PAT || github.token }}
      - uses: ./translate
        with:
          api-key: \${{ secrets.TERMIX_LLM_API_KEY }}
`;
  assert.deepEqual(checkWorkflow("plugin-release.yml", text), [
    "plugin-release.yml: reads TERMIX_LLM_API_KEY",
    "plugin-release.yml: TERMIX_LLM_API_KEY must be optional",
    "plugin-release.yml release: first step must refuse Termix-SSH repos",
  ]);
});

test("plugin-release.yml may read the author's own optional secrets", () => {
  const text = `
on:
  workflow_call:
    secrets:
      TERMIX_PAT:
        required: false
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - if: \${{ github.repository_owner == 'Termix-SSH' }}
        run: exit 1
      - uses: actions/checkout@v7
        with:
          token: \${{ secrets.TERMIX_PAT || github.token }}
`;
  assert.deepEqual(checkWorkflow("plugin-release.yml", text), []);
});
