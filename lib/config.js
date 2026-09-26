// Settings come from config.json next to server.js, and any environment
// variable of the same meaning overrides it (handy for a one-off run).

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

function readConfigFile() {
  const file = path.join(ROOT, "config.json");
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw new Error(`config.json is not valid JSON: ${err.message}`);
  }
}

const file = readConfigFile();
const env = process.env;
const flag = (value) => /^(1|true|yes|on)$/i.test(String(value));

module.exports = {
  port: Number(env.PORT || file.port) || 8000,
  host: env.HOST || file.host || "0.0.0.0",
  dataDir: path.resolve(ROOT, env.DATA_DIR || file.dataDir || "data"),
  // Base URL clients reach this server at, used in tarball links. Leave empty
  // to derive it from each request's Host header (right for LAN use).
  publicUrl: String(env.PUBLIC_URL || file.publicUrl || "").replace(/\/+$/, ""),
  requireLogin: flag(env.REQUIRE_LOGIN ?? file.requireLogin ?? false),
  maxUploadBytes: (Number(env.MAX_UPLOAD_MB || file.maxUploadMb) || 100) * 1024 * 1024,
  tokenTtlDays: Number(env.TOKEN_TTL_DAYS || file.tokenTtlDays) || 30,
};
