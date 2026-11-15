import assert from "node:assert/strict";
import { test } from "node:test";
import { apiProblem } from "../../scripts/lib.mjs";

test("community submissions must target plugin API 2", () => {
  assert.equal(apiProblem("^2.0.0"), null);
  assert.equal(apiProblem(">=2.8.0"), null);
  assert.match(apiProblem("^1.16.0"), /plugin API 1/);
  assert.match(apiProblem("1.x"), /plugin API 1/);
  assert.match(apiProblem("not a range"), /not a semver range/);
});

test("a provenance bundle is listed only when it names the file", async () => {
  const { bundleDescribes } = await import("../../scripts/lib.mjs");
  const sha = "a".repeat(64);
  const bundle = (name, digest, payloadType = "application/vnd.in-toto+json") =>
    JSON.stringify({
      dsseEnvelope: {
        payloadType,
        payload: Buffer.from(
          JSON.stringify({ subject: [{ name, digest: { sha256: digest } }] }),
        ).toString("base64"),
      },
    });
  assert.equal(
    bundleDescribes(bundle("out/p-1.0.0.tmxplug", sha), "p-1.0.0.tmxplug", sha),
    true,
  );
  assert.equal(
    bundleDescribes(
      bundle("p-1.0.0.tmxplug", "b".repeat(64)),
      "p-1.0.0.tmxplug",
      sha,
    ),
    false,
  );
  assert.equal(
    bundleDescribes(bundle("q-1.0.0.tmxplug", sha), "p-1.0.0.tmxplug", sha),
    false,
  );
  assert.equal(
    bundleDescribes(
      bundle("p-1.0.0.tmxplug", sha, "text/plain"),
      "p-1.0.0.tmxplug",
      sha,
    ),
    false,
  );
  assert.equal(bundleDescribes("nope", "p-1.0.0.tmxplug", sha), false);
});
