// Reads an uploaded .tgz: checks it really is a gzip'd tar, pulls out the
// package's own package.json (the source of truth for name, version and
// dependencies) and README, and computes npm-style checksums.

const crypto = require("crypto");
const zlib = require("zlib");

const BLOCK = 512;

// A NUL-terminated string field of a tar header.
function field(buf, start, length) {
  const nul = buf.indexOf(0, start);
  const end = nul === -1 || nul > start + length ? start + length : nul;
  return buf.toString("utf8", start, end);
}

// Throws an Error with a user-facing message if the archive is unusable.
function inspectTarball(tgz, maxUnpackedBytes) {
  let tar;
  try {
    tar = zlib.gunzipSync(tgz, { maxOutputLength: maxUnpackedBytes });
  } catch (err) {
    throw new Error(
      err.code === "ERR_BUFFER_TOO_LARGE"
        ? "The tarball unpacks to more than the allowed size."
        : "The uploaded file isn't a valid .tgz (gzip) archive."
    );
  }

  let manifestText = null;
  let readme = null;
  let fileCount = 0;
  let unpackedSize = 0;
  let topLevelPackageJson = false;
  let longName = null;

  for (let pos = 0; pos + BLOCK <= tar.length; ) {
    const header = tar.subarray(pos, pos + BLOCK);
    if (header.every((b) => b === 0)) break; // end-of-archive marker

    const size = parseInt(field(header, 124, 12).trim() || "0", 8);
    if (!Number.isFinite(size) || size < 0) throw new Error("The tarball is corrupt.");
    const type = header[156] === 0 ? "0" : String.fromCharCode(header[156]);
    const prefix = field(header, 345, 155);
    let name = prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100);

    const dataStart = pos + BLOCK;
    if (dataStart + size > tar.length) throw new Error("The tarball is truncated.");
    const data = tar.subarray(dataStart, dataStart + size);
    pos = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    // GNU long names and PAX "path" records rename the entry that follows.
    if (type === "L") {
      longName = field(data, 0, data.length);
      continue;
    }
    if (type === "x") {
      const m = /(?:^|\n)\d+ path=([^\n]*)/.exec(data.toString("utf8"));
      if (m) longName = m[1];
      continue;
    }
    if (longName !== null) {
      name = longName;
      longName = null;
    }
    if (type !== "0" && type !== "7") continue; // regular files only

    fileCount++;
    unpackedSize += size;
    // npm tarballs wrap everything in one root folder (normally "package/").
    const parts = name.split("/").filter((p) => p && p !== ".");
    if (parts.length === 1 && parts[0] === "package.json") topLevelPackageJson = true;
    const rel = parts.slice(1).join("/");
    if (rel === "package.json" && manifestText === null) manifestText = data.toString("utf8");
    else if (readme === null && parts.length === 2 && /^readme(\.|$)/i.test(rel)) readme = data.toString("utf8");
  }

  if (manifestText === null) {
    throw new Error(
      topLevelPackageJson
        ? "package.json is at the top of the tarball, but the files must be inside a package/ folder. Publish with `qpm publish` (or build the .tgz with `qpm pack`)."
        : "The tarball has no package/package.json."
    );
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestText.replace(/^﻿/, ""));
  } catch {
    throw new Error("package.json inside the tarball isn't valid JSON.");
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
    throw new Error("package.json inside the tarball must be a JSON object.");

  return {
    manifest,
    readme,
    fileCount,
    unpackedSize,
    shasum: crypto.createHash("sha1").update(tgz).digest("hex"),
    integrity: `sha512-${crypto.createHash("sha512").update(tgz).digest("base64")}`,
  };
}

module.exports = { inspectTarball };
