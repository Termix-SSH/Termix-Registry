// Pure rules for the branch cleanup job. No network.

/** dev-26.11.2 beats dev-26.9.4, dev-1.0.10 beats dev-1.0.9. */
export function compareVersions(a, b) {
  const pa = String(a)
    .split(/[.-]/)
    .map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b)
    .split(/[.-]/)
    .map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

const DEV = /^dev-(\d+(?:\.\d+)*)$/;
const COPY = /^deps\/(dev-\d+(?:\.\d+)*)\//;

/**
 * Branches safe to delete: dev branches whose version is already released
 * and Dependabot copies whose dev branch is gone or released. A branch with
 * an open PR is always kept.
 * released: the newest released version ("26.11.2"), or null if none.
 */
export function staleBranches({ branches, released, openHeads = [] }) {
  const open = new Set(openHeads);
  const live = new Set(branches);
  const done = (version) =>
    released != null && compareVersions(version, released) <= 0;
  return branches.filter((name) => {
    if (open.has(name)) return false;
    const dev = DEV.exec(name);
    if (dev) return done(dev[1]);
    const copy = COPY.exec(name);
    if (copy) {
      const base = copy[1];
      return !live.has(base) || done(base.slice("dev-".length));
    }
    return false;
  });
}
