// Accounts and login tokens. Passwords are hashed with scrypt; tokens are
// random 256-bit strings the server only keeps as SHA-256 hashes, so a leaked
// tokens.json can't be replayed. Routes match the original QPM backend
// (POST /api/auth/signup, POST /api/auth/login, GET /api/auth/me), which is
// what `qpm login` / `qpm whoami` and the QPM web frontend call.

const crypto = require("crypto");
const { HttpError, sendJson, readJson } = require("./http");

const DAY_MS = 24 * 60 * 60 * 1000;

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

const tokenKey = (token) => crypto.createHash("sha256").update(token).digest("hex");

const publicUser = (u) => ({ id: u.id, username: u.username, email: u.email, bio: u.bio, createdAt: u.createdAt });

function createAuth(store, config) {
  function issueToken(username) {
    const token = crypto.randomBytes(32).toString("hex");
    const now = Date.now();
    const tokens = store.tokens();
    for (const [key, entry] of Object.entries(tokens)) if (entry.expiresAt < now) delete tokens[key];
    tokens[tokenKey(token)] = { username, createdAt: new Date(now).toISOString(), expiresAt: now + config.tokenTtlDays * DAY_MS };
    store.saveTokens(tokens);
    return token;
  }

  // The user behind the request's Bearer token, or null if it sent none.
  // A token that was sent but is unknown or expired is an error rather than
  // "anonymous", so nobody publishes unowned packages by accident.
  function authenticate(req) {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || "");
    if (!m) return null;
    const entry = store.tokens()[tokenKey(m[1])];
    if (!entry || entry.expiresAt < Date.now()) throw new HttpError(401, "Invalid or expired token. Log in again.");
    const user = store.users()[entry.username];
    if (!user) throw new HttpError(401, "The account for this token no longer exists.");
    return user;
  }

  async function signup({ req, res }) {
    const body = await readJson(req);
    const username = String(body.username || "").trim().toLowerCase();
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");

    if (!username || !email || !password) throw new HttpError(400, "Username, email, and password are required.");
    if (!/^[a-z0-9][a-z0-9._-]{0,38}$/.test(username))
      throw new HttpError(400, "Username must be 1-39 characters: lowercase letters, digits, '.', '_' or '-'.");
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new HttpError(400, "That doesn't look like an email address.");
    if (password.length < 6) throw new HttpError(400, "Password must be at least 6 characters long.");

    const users = store.users();
    if (users[username]) throw new HttpError(409, "Username is already taken.");
    if (Object.values(users).some((u) => u.email === email))
      throw new HttpError(409, "An account with this email already exists.");

    const salt = crypto.randomBytes(16).toString("hex");
    const user = {
      id: crypto.randomUUID(),
      username,
      email,
      bio: String(body.bio || ""),
      salt,
      passwordHash: hashPassword(password, salt),
      createdAt: new Date().toISOString(),
    };
    users[username] = user;
    store.saveUsers(users);
    console.log(`  new account: ${username}`);

    sendJson(res, 201, { message: "User registered successfully", token: issueToken(username), user: publicUser(user) });
  }

  async function login({ req, res }) {
    const body = await readJson(req);
    const id = String(body.emailOrUsername || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (!id || !password) throw new HttpError(400, "Email/Username and password are required.");

    const users = store.users();
    const user = id.includes("@") ? Object.values(users).find((u) => u.email === id) : users[id];
    const ok =
      user &&
      crypto.timingSafeEqual(Buffer.from(hashPassword(password, user.salt), "hex"), Buffer.from(user.passwordHash, "hex"));
    if (!ok) throw new HttpError(401, "Invalid credentials.");

    sendJson(res, 200, { message: "Login successful", token: issueToken(user.username), user: publicUser(user) });
  }

  function me({ req, res }) {
    const user = authenticate(req);
    if (!user) throw new HttpError(401, "Access denied. Token missing.");
    sendJson(res, 200, { user: publicUser(user) });
  }

  return { authenticate, signup, login, me };
}

module.exports = { createAuth };
