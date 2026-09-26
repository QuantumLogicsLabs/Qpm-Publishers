// HTTP helpers shared by the route handlers: typed errors, JSON responses,
// size-limited body reading and a minimal multipart/form-data parser.

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

const tooLarge = (limit) =>
  new HttpError(413, `Upload is too large (limit ${Math.round(limit / 1024 / 1024)} MB).`);

// Resolves with the whole request body as a Buffer, or rejects with 413 once
// it passes `limit` bytes (the rest of the body is drained and discarded).
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers["content-length"]) > limit) {
      req.resume();
      reject(tooLarge(limit));
      return;
    }
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size <= limit) chunks.push(chunk);
    });
    req.on("end", () => (size > limit ? reject(tooLarge(limit)) : resolve(Buffer.concat(chunks))));
    req.on("error", reject);
  });
}

async function readJson(req, limit = 1024 * 1024) {
  const raw = await readBody(req, limit);
  try {
    return JSON.parse(raw.toString("utf8") || "{}");
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
}

// Splits a multipart/form-data body into text fields and file parts.
function parseMultipart(body, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!match) throw new HttpError(400, "multipart/form-data body has no boundary.");
  const boundary = Buffer.from(`--${(match[1] || match[2]).trim()}`);

  const fields = {};
  const files = {};
  let pos = body.indexOf(boundary);
  while (pos !== -1) {
    pos += boundary.length;
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) break; // closing "--"
    const headerEnd = body.indexOf("\r\n\r\n", pos);
    if (headerEnd === -1) break;
    const next = body.indexOf(boundary, headerEnd + 4);
    if (next === -1) break;

    const headers = body.toString("utf8", pos, headerEnd);
    const content = body.subarray(headerEnd + 4, next - 2); // drop the CRLF before the boundary
    const name = /[;\s]name="([^"]*)"/i.exec(headers)?.[1];
    const filename = /filename="([^"]*)"/i.exec(headers)?.[1];
    if (name !== undefined) {
      if (filename !== undefined) files[name] = { filename, data: content };
      else fields[name] = content.toString("utf8");
    }
    pos = next;
  }
  return { fields, files };
}

// The origin clients used to reach us, for building absolute tarball URLs.
function originOf(req, publicUrl) {
  if (publicUrl) return publicUrl;
  const proto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "localhost").split(",")[0].trim();
  return `${proto}://${host}`;
}

module.exports = { HttpError, sendJson, readBody, readJson, parseMultipart, originOf };
