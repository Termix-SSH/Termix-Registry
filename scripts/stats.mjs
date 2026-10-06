/**
 * Rebuilds each <registry>/stats.json: how popular every plugin in
 * <registry>/index.json is. Termix reads it into the plugin store.
 *
 * - downloads: the download_count of every .tmxplug release asset, summed
 *   per version and per plugin. This counts downloads, not installs.
 * - activeInstalls: instances that sent a Usage Statistics report with the
 *   plugin turned on in the last 7 days, from PostHog. Only written when
 *   POSTHOG_PERSONAL_API_KEY and POSTHOG_PROJECT_ID are set. It undercounts
 *   by every instance that turned the report off.
 * - activeInstallsPrevious: the same for the 7 days before, so the store
 *   can tell a plugin that is growing from one that is shrinking.
 *
 * Only these aggregate numbers are written. Nothing per instance is kept.
 *
 * Set GH_TOKEN for the higher GitHub API rate limit.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { root } from "./lib.mjs";

const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const posthog = {
  key: process.env.POSTHOG_PERSONAL_API_KEY,
  project: process.env.POSTHOG_PROJECT_ID,
  host: (process.env.POSTHOG_HOST || "https://us.posthog.com").replace(
    /\/+$/,
    "",
  ),
};

async function github(url) {
  const response = await fetch(`https://api.github.com${url}`, {
    headers: {
      Accept: "application/vnd.github+json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response.json();
}

async function releases(repo) {
  const all = [];
  for (let page = 1; ; page++) {
    const batch = await github(
      `/repos/${repo}/releases?per_page=100&page=${page}`,
    );
    all.push(...batch);
    if (batch.length < 100) return all;
  }
}

function countDownloads(list) {
  const versions = {};
  let total = 0;
  for (const release of list) {
    if (release.draft) continue;
    const version = release.tag_name.replace(/^v/, "");
    const count = release.assets
      .filter((asset) => asset.name.endsWith(".tmxplug"))
      .reduce((sum, asset) => sum + (asset.download_count ?? 0), 0);
    if (count === 0) continue;
    versions[version] = { downloads: count };
    total += count;
  }
  return { downloads: total, versions };
}

async function hogql(query) {
  const response = await fetch(
    `${posthog.host}/api/projects/${posthog.project}/query/`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${posthog.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: { kind: "HogQLQuery", query } }),
    },
  );
  if (!response.ok) {
    throw new Error(`PostHog answered ${response.status}`);
  }
  return (await response.json()).results ?? [];
}

/** Distinct instances per value of an array property, in a day window. */
function activeQuery(property, fromDays, toDays) {
  return `
    SELECT trim(BOTH '"' FROM item) AS value, count(DISTINCT distinct_id)
    FROM events
    ARRAY JOIN JSONExtractArrayRaw(properties, '${property}') AS item
    WHERE event = 'instance_heartbeat'
      AND timestamp > now() - INTERVAL ${fromDays} DAY
      AND timestamp <= now() - INTERVAL ${toDays} DAY
    GROUP BY value`;
}

function toCounts(rows) {
  const counts = new Map();
  for (const [value, count] of rows) {
    if (typeof value === "string" && value) counts.set(value, Number(count));
  }
  return counts;
}

async function activeInstalls() {
  if (!posthog.key || !posthog.project) return null;
  const [current, previous, versions] = await Promise.all([
    hogql(activeQuery("plugins_enabled", 7, 0)),
    hogql(activeQuery("plugins_enabled", 14, 7)),
    hogql(activeQuery("plugin_versions", 7, 0)),
  ]);
  return {
    current: toCounts(current),
    previous: toCounts(previous),
    versions: toCounts(versions),
  };
}

async function buildStats(dir, active, problems) {
  const index = JSON.parse(
    fs.readFileSync(path.join(dir, "index.json"), "utf8"),
  );
  const plugins = {};
  for (const plugin of index.plugins) {
    const repo = plugin.repository?.match(
      /^https:\/\/github\.com\/([^/]+\/[^/]+)$/,
    )?.[1];
    if (!repo) continue;
    let entry;
    try {
      entry = countDownloads(await releases(repo));
    } catch (error) {
      problems.push(`${plugin.id}: ${error.message}`);
      continue;
    }
    if (active) {
      entry.activeInstalls = active.current.get(plugin.id) ?? 0;
      entry.activeInstallsPrevious = active.previous.get(plugin.id) ?? 0;
      for (const [version, counts] of Object.entries(entry.versions)) {
        counts.activeInstalls =
          active.versions.get(`${plugin.id}@${version}`) ?? 0;
      }
    }
    plugins[plugin.id] = entry;
  }
  return plugins;
}

async function main() {
  const problems = [];
  let active = null;
  try {
    active = await activeInstalls();
  } catch (error) {
    // Downloads still get written; the store falls back to them.
    problems.push(`PostHog: ${error.message}`);
  }

  const dirs = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name))
    .filter((dir) => fs.existsSync(path.join(dir, "index.json")));

  for (const dir of dirs) {
    const plugins = await buildStats(dir, active, problems);
    const file = path.join(dir, "stats.json");
    const before = fs.existsSync(file)
      ? JSON.parse(fs.readFileSync(file, "utf8")).plugins
      : null;
    if (JSON.stringify(before) === JSON.stringify(plugins)) {
      console.log(`${path.relative(root, file)}: up to date`);
      continue;
    }
    const stats = {
      updatedAt: new Date().toISOString(),
      activeInstallsSource: active ? "aggregate-telemetry" : null,
      plugins,
    };
    fs.writeFileSync(file, `${JSON.stringify(stats, null, 2)}\n`);
    console.log(
      `${path.relative(root, file)}: ${Object.keys(plugins).length} plugin(s)`,
    );
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`  ${problem}`);
    process.exitCode = 1;
  }
}

await main();
