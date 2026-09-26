// Package-name rules (the same ones `qpm publish` checks) and just enough
// semver to validate versions and pick the "latest" dist-tag.

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function parseVersion(version) {
  const m = SEMVER.exec(String(version));
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split(".") : [] };
}

function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (const key of ["major", "minor", "patch"]) if (x[key] !== y[key]) return x[key] - y[key];
  // A release outranks any prerelease of the same version.
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pNum = /^\d+$/.test(p);
    const qNum = /^\d+$/.test(q);
    if (pNum && qNum) return Number(p) - Number(q);
    if (pNum !== qNum) return pNum ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

// Highest release version, or the highest prerelease if there are no releases.
function latestVersion(versions) {
  const releases = versions.filter((v) => parseVersion(v).pre.length === 0);
  const pool = releases.length ? releases : versions;
  return pool.reduce((best, v) => (best === null || compareVersions(v, best) > 0 ? v : best), null);
}

// Empty string if `name` is a valid package name, else the reason it isn't.
function nameProblem(name) {
  if (typeof name !== "string" || name.length === 0 || name.length > 214)
    return "must be 1 to 214 characters long";
  const scoped = /^@([^/]+)\/([^/]+)$/.exec(name);
  if (name.startsWith("@") && !scoped) return "scoped names must look like @scope/name";
  const parts = scoped ? [scoped[1], scoped[2]] : [name];
  for (const part of parts) {
    if (/^[._]/.test(part)) return "must not start with '.' or '_'";
    const bad = /[^a-z0-9\-._~]/.exec(part);
    if (bad) return `contains '${bad[0]}' (use lowercase letters, digits and - . _ ~)`;
  }
  return "";
}

module.exports = { parseVersion, compareVersions, latestVersion, nameProblem };
