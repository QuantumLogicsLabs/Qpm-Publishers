// All registry state is plain files under the data directory:
//
//   users.json                          accounts (scrypt password hashes)
//   tokens.json                         login tokens (stored as SHA-256 hashes)
//   packages/<encoded name>.json        one document per package, all versions
//   tarballs/<encoded name>-<ver>.tgz   the published archives
//
// Every write goes to a temp file first and is then renamed into place, so a
// crash or power loss never leaves a half-written file behind. The server is
// a single Node process using synchronous I/O, so writes never interleave.

const fs = require("fs");
const path = require("path");

class Store {
  constructor(dataDir) {
    this.dir = dataDir;
    this.packagesDir = path.join(dataDir, "packages");
    this.tarballsDir = path.join(dataDir, "tarballs");
    fs.mkdirSync(this.packagesDir, { recursive: true });
    fs.mkdirSync(this.tarballsDir, { recursive: true });
  }

  readJson(file, fallback) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      if (err.code === "ENOENT") return fallback;
      throw err;
    }
  }

  writeAtomic(file, data) {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  }

  writeJson(file, value) {
    this.writeAtomic(file, JSON.stringify(value, null, 2));
  }

  users() {
    return this.readJson(path.join(this.dir, "users.json"), {});
  }

  saveUsers(users) {
    this.writeJson(path.join(this.dir, "users.json"), users);
  }

  tokens() {
    return this.readJson(path.join(this.dir, "tokens.json"), {});
  }

  saveTokens(tokens) {
    this.writeJson(path.join(this.dir, "tokens.json"), tokens);
  }

  // encodeURIComponent keeps "@scope/name" a single, filesystem-safe file name.
  packageFile(name) {
    return path.join(this.packagesDir, `${encodeURIComponent(name)}.json`);
  }

  getPackage(name) {
    return this.readJson(this.packageFile(name), null);
  }

  savePackage(doc) {
    this.writeJson(this.packageFile(doc.name), doc);
  }

  listPackages() {
    return fs
      .readdirSync(this.packagesDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => this.readJson(path.join(this.packagesDir, f), null))
      .filter(Boolean);
  }

  tarballFile(name, version) {
    return path.join(this.tarballsDir, `${encodeURIComponent(name)}-${version}.tgz`);
  }

  saveTarball(name, version, data) {
    this.writeAtomic(this.tarballFile(name, version), data);
  }

  readTarball(name, version) {
    try {
      return fs.readFileSync(this.tarballFile(name, version));
    } catch (err) {
      if (err.code === "ENOENT") return null;
      throw err;
    }
  }
}

module.exports = { Store };
