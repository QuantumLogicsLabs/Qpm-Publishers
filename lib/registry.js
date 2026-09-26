// Registry routes, in the npm-compatible shape `qpm install` / `qpm publish`
// and the QPM web frontend expect:
//
//   GET  /api/registry/:name               package document (dist-tags, versions, dist.tarball)
//   GET  /api/registry/:name/-/:file.tgz   tarball download
//   POST /api/registry/publish             publish a version (JSON with fileBase64, or multipart "file")
//   GET  /api/registry/search?q=           search names, descriptions and keywords
//   GET  /api/registry/user/my-packages    packages owned by the logged-in user

const { HttpError, sendJson, readBody, parseMultipart, originOf } = require("./http");
const { inspectTarball } = require("./tarball");
const { parseVersion, latestVersion, nameProblem } = require("./semver");

const text = (value) => (typeof value === "string" ? value.trim() : "");
const bareName = (name) => name.split("/").pop();

function keywordList(value) {
  if (typeof value === "string") value = value.split(",");
  if (!Array.isArray(value)) return [];
  return value.map((k) => String(k).trim()).filter(Boolean);
}

// Multipart forms send dependencies as a JSON string; qpm sends an object.
function dependencyMap(value) {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, range]) => typeof range === "string"));
}

const repositoryUrl = (repo) => (typeof repo === "string" ? repo.trim() : text(repo && repo.url));

function createRegistry(store, auth, config) {
  function decode(raw) {
    try {
      return decodeURIComponent(raw);
    } catch {
      throw new HttpError(400, "Malformed URL.");
    }
  }

  function findPackage(rawName) {
    const name = decode(rawName).toLowerCase();
    const doc = store.getPackage(name);
    if (!doc) throw new HttpError(404, `Package "${name}" not found.`);
    return doc;
  }

  function packument({ req, res, params }) {
    const doc = findPackage(params[0]);
    const origin = originOf(req, config.publicUrl);
    const versions = {};
    for (const [version, meta] of Object.entries(doc.versions)) {
      const tarball = `${origin}/api/registry/${doc.name}/-/${bareName(doc.name)}-${version}.tgz`;
      versions[version] = { ...meta, dist: { ...meta.dist, tarball } };
    }
    sendJson(res, 200, {
      name: doc.name,
      description: doc.description,
      "dist-tags": doc["dist-tags"],
      versions,
      time: { created: doc.createdAt, modified: doc.updatedAt, ...doc.time },
      keywords: doc.keywords,
      license: doc.license,
      homepage: doc.homepage,
      repository: doc.repository,
      readme: doc.readme,
      downloads: doc.downloads,
      owner: doc.owner || "anonymous",
    });
  }

  function tarball({ res, params }) {
    const doc = findPackage(params[0]);
    const file = decode(params[1]);
    // qpm asks for "<bare name>-<version>.tgz" (npm style), the web frontend
    // for "<full name>-<version>.tgz"; accept both.
    const stem = file.endsWith(".tgz") ? file.slice(0, -4) : "";
    const version = [`${doc.name}-`, `${bareName(doc.name)}-`]
      .filter((prefix) => stem.startsWith(prefix))
      .map((prefix) => stem.slice(prefix.length))
      .find((v) => Object.hasOwn(doc.versions, v));
    const data = version && store.readTarball(doc.name, version);
    if (!data) throw new HttpError(404, `No tarball "${file}" for ${doc.name}.`);

    doc.downloads = (doc.downloads || 0) + 1;
    store.savePackage(doc);
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": data.length,
      "Content-Disposition": `attachment; filename="${bareName(doc.name)}-${version}.tgz"`,
    });
    res.end(data);
  }

  // Fields + tarball from either qpm's JSON body ({..., fileBase64}) or a
  // multipart form with a "file" part (the web frontend, or curl -F).
  async function readPublishRequest(req) {
    const type = String(req.headers["content-type"] || "");
    const raw = await readBody(req, Math.ceil(config.maxUploadBytes * 1.4) + 1024 * 1024); // base64 is ~4/3 larger
    let fields;
    let file = null;
    if (/^multipart\/form-data/i.test(type)) {
      const parts = parseMultipart(raw, type);
      fields = parts.fields;
      file = parts.files.file ? parts.files.file.data : null;
    } else {
      try {
        fields = JSON.parse(raw.toString("utf8"));
      } catch {
        throw new HttpError(400, "Publish body must be JSON or multipart/form-data.");
      }
      if (!fields || typeof fields !== "object") throw new HttpError(400, "Publish body must be a JSON object.");
      if (typeof fields.fileBase64 === "string" && fields.fileBase64)
        file = Buffer.from(fields.fileBase64.split(",").pop(), "base64"); // tolerate a data: URL prefix
    }
    if (!file || file.length === 0) throw new HttpError(400, "No package tarball was uploaded.");
    if (file.length > config.maxUploadBytes)
      throw new HttpError(413, `Upload is too large (limit ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB).`);
    return { fields, file };
  }

  async function publish({ req, res }) {
    const user = auth.authenticate(req);
    if (!user && config.requireLogin)
      throw new HttpError(401, "This registry only accepts publishes from logged-in users. Run `qpm login` first.");

    const { fields, file } = await readPublishRequest(req);
    let info;
    try {
      info = inspectTarball(file, config.maxUploadBytes * 10);
    } catch (err) {
      throw new HttpError(400, err.message);
    }
    const manifest = info.manifest;

    // package.json inside the tarball is what gets installed, so it is the
    // source of truth; request fields may only repeat its name and version.
    const name = text(manifest.name);
    const version = text(manifest.version);
    if (!name) throw new HttpError(400, 'package.json in the tarball has no "name".');
    if (!version) throw new HttpError(400, 'package.json in the tarball has no "version".');
    const givenName = text(fields.name).toLowerCase();
    if (givenName && givenName !== name)
      throw new HttpError(400, `The request says name "${givenName}", but package.json in the tarball says "${name}".`);
    const givenVersion = text(fields.version);
    if (givenVersion && givenVersion !== version)
      throw new HttpError(400, `The request says version "${givenVersion}", but package.json in the tarball says "${version}".`);

    const problem = nameProblem(name);
    if (problem) throw new HttpError(400, `Invalid package name "${name}": ${problem}.`);
    if (!parseVersion(version)) throw new HttpError(400, `Invalid version "${version}": use semver like 1.0.0.`);

    const now = new Date().toISOString();
    let doc = store.getPackage(name);
    if (doc) {
      if (doc.owner && doc.owner !== (user && user.username))
        throw new HttpError(403, `Package "${name}" belongs to ${doc.owner}. Log in as ${doc.owner} to publish new versions.`);
      if (Object.hasOwn(doc.versions, version))
        throw new HttpError(409, `${name}@${version} is already published. Bump "version" in package.json and publish again.`);
    } else {
      doc = { name, owner: user ? user.username : null, createdAt: now, downloads: 0, "dist-tags": {}, versions: {}, time: {} };
    }

    store.saveTarball(name, version, file);

    const description = text(fields.description) || text(manifest.description);
    doc.versions[version] = {
      name,
      version,
      description,
      main: text(manifest.main) || undefined,
      bin: manifest.bin,
      dependencies: dependencyMap(manifest.dependencies !== undefined ? manifest.dependencies : fields.dependencies),
      dist: {
        shasum: info.shasum,
        integrity: info.integrity,
        fileCount: info.fileCount,
        unpackedSize: info.unpackedSize,
        size: file.length,
      },
      publishedBy: user ? user.username : null,
    };
    doc.time[version] = now;
    doc["dist-tags"] = { ...doc["dist-tags"], latest: latestVersion(Object.keys(doc.versions)) };

    // Package-level details describe the latest version, so publishing an
    // older patch release doesn't overwrite them.
    if (doc["dist-tags"].latest === version) {
      doc.description = description;
      doc.keywords = keywordList(fields.keywords !== undefined ? fields.keywords : manifest.keywords);
      doc.license = text(fields.license) || text(manifest.license);
      doc.homepage = text(fields.homepage) || text(manifest.homepage);
      doc.repository = repositoryUrl(fields.repository) || repositoryUrl(manifest.repository);
      doc.readme = text(fields.readme) ? fields.readme : info.readme || "";
    }
    doc.updatedAt = now;
    store.savePackage(doc);

    console.log(`  published ${name}@${version} ${user ? `by ${user.username}` : "anonymously"}`);
    sendJson(res, 201, {
      message: `Published ${name}@${version}.`,
      package: { name, version, size: file.length, shasum: info.shasum },
    });
  }

  function search({ res, url }) {
    const q = (url.searchParams.get("q") || "").trim().toLowerCase();
    const matches = store
      .listPackages()
      .filter((doc) => !q || [doc.name, doc.description || "", ...(doc.keywords || [])].some((s) => s.toLowerCase().includes(q)));
    matches.sort((a, b) => (b.downloads || 0) - (a.downloads || 0) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
    sendJson(res, 200, {
      objects: matches.slice(0, 50).map((doc) => ({
        name: doc.name,
        description: doc.description || "",
        keywords: doc.keywords || [],
        latest_version: doc["dist-tags"].latest,
        downloads: doc.downloads || 0,
        updated_at: doc.updatedAt,
        owner: doc.owner || "anonymous",
      })),
      total: matches.length,
    });
  }

  function myPackages({ req, res }) {
    const user = auth.authenticate(req);
    if (!user) throw new HttpError(401, "Access denied. Token missing.");
    const packages = store
      .listPackages()
      .filter((doc) => doc.owner === user.username)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .map((doc) => ({
        name: doc.name,
        description: doc.description || "",
        keywords: doc.keywords || [],
        license: doc.license || "",
        latestVersion: doc["dist-tags"].latest,
        downloads: doc.downloads || 0,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
      }));
    sendJson(res, 200, { packages });
  }

  return { packument, tarball, publish, search, myPackages };
}

module.exports = { createRegistry };
