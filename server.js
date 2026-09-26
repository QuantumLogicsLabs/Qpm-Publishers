#!/usr/bin/env node
// QuantumPackages: a self-contained package registry for qpm.
//
// No npm dependencies and no database: copy this folder to any machine with
// Node.js 18+ and run `node server.js` (or start.bat). Packages, accounts and
// tokens are stored as files under ./data (see lib/store.js).

const http = require("http");
const os = require("os");

const config = require("./lib/config");
const { Store } = require("./lib/store");
const { createAuth } = require("./lib/auth");
const { createRegistry } = require("./lib/registry");
const { HttpError, sendJson, originOf } = require("./lib/http");

const store = new Store(config.dataDir);
const auth = createAuth(store, config);
const registry = createRegistry(store, auth, config);

function info({ req, res }) {
  const registryUrl = `${originOf(req, config.publicUrl)}/api/registry/`;
  sendJson(res, 200, {
    service: "QuantumPackages registry",
    registry: registryUrl,
    usage: `Point qpm here with QPM_REGISTRY=${registryUrl}, then qpm login / qpm publish / qpm install.`,
  });
}

function health({ res }) {
  sendJson(res, 200, {
    status: "ok",
    service: "QuantumPackages registry",
    packages: store.listPackages().length,
    requireLogin: config.requireLogin,
    timestamp: new Date().toISOString(),
  });
}

// [method, path pattern, handler]; capture groups become ctx.params. Paths
// are matched still percent-encoded, so "@scope%2fname" stays one segment.
const routes = [
  ["GET", /^\/$/, info],
  ["GET", /^\/api\/health$/, health],
  ["POST", /^\/api\/auth\/signup$/, auth.signup],
  ["POST", /^\/api\/auth\/login$/, auth.login],
  ["GET", /^\/api\/auth\/me$/, auth.me],
  ["GET", /^\/api\/registry\/search$/, registry.search],
  ["GET", /^\/api\/registry\/user\/my-packages$/, registry.myPackages],
  ["POST", /^\/api\/registry\/publish$/, registry.publish],
  ["GET", /^\/api\/registry\/((?:@[^/]+\/)?[^/]+)\/-\/([^/]+)$/, registry.tarball],
  ["GET", /^\/api\/registry\/((?:@[^/]+\/)?[^/]+)$/, registry.packument],
];

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  res.on("finish", () => {
    console.log(`${new Date().toISOString()}  ${req.method} ${req.url}  ${res.statusCode}  ${Date.now() - started}ms`);
  });

  // Let a browser frontend on another origin call the API.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
    const route = routes.find(([method, pattern]) => method === req.method && pattern.test(path));
    if (!route) {
      const pathExists = routes.some(([, pattern]) => pattern.test(path));
      throw new HttpError(pathExists ? 405 : 404, pathExists ? `${req.method} is not allowed here.` : `Nothing at ${path}.`);
    }
    await route[2]({ req, res, url, params: route[1].exec(path).slice(1) });
  } catch (err) {
    if (!(err instanceof HttpError)) console.error(err);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const status = err instanceof HttpError ? err.status : 500;
    sendJson(res, status, { error: status === 500 ? "Internal registry error." : err.message });
  }
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${config.port} is already in use. Change "port" in config.json or set PORT.`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  const lanAddresses = Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && a.family === "IPv4" && !a.internal)
    .map((a) => a.address);

  console.log(`QuantumPackages registry listening on ${config.host}:${config.port}`);
  console.log(`  data folder:   ${config.dataDir}`);
  console.log(`  publishing:    ${config.requireLogin ? "logged-in users only" : "open (anonymous publishes allowed)"}`);
  console.log("");
  console.log("Point qpm at this registry by setting QPM_REGISTRY to:");
  const isQpmDefault = config.port === 8000;
  console.log(`  this machine:   http://localhost:${config.port}/api/registry/${isQpmDefault ? "   (qpm's default, nothing to set)" : ""}`);
  for (const address of lanAddresses) console.log(`  other devices:  http://${address}:${config.port}/api/registry/`);
  console.log("");
});
