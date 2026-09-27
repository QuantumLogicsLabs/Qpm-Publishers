# QuantumPackages

A self-contained package registry for **qpm**, the Quantum Package Manager. It receives
`qpm publish`, serves `qpm install`, and handles `qpm login` / `qpm whoami`.

- **No npm dependencies and no database.** It needs only Node.js 18 or newer.
- **Everything is stored as files** in `data/`: package documents, `.tgz` archives, accounts and tokens.
- **Same API as the original QPM backend**, so the QPM web frontend works against it too.

## 1. Run it on the server device

1. Install Node.js 18+ from <https://nodejs.org>.
2. Copy this whole `QuantumPackages` folder to the device.
3. Double-click `start.bat`, or run:

   ```bash
   node server.js
   ```

The server prints the addresses other devices can use:

```
QuantumPackages registry listening on 0.0.0.0:8000
  data folder:   C:\QuantumPackages\data
  publishing:    open (anonymous publishes allowed)

Point qpm at this registry by setting QPM_REGISTRY to:
  this machine:   http://localhost:8000/api/registry/   (qpm's default, nothing to set)
  other devices:  http://192.168.1.20:8000/api/registry/
```

If it lists several addresses, use the one on your Wi-Fi or Ethernet network (usually
`192.168.x.x`). Others, such as `172.x.x.x`, are often virtual adapters (WSL, Hyper-V, Docker).

**Windows firewall.** Other devices can't connect until port 8000 is allowed. Run this
once in an administrator terminal:

```powershell
netsh advfirewall firewall add rule name="QuantumPackages" dir=in action=allow protocol=TCP localport=8000
```

To keep the registry running after you log off, run `node server.js` as a scheduled task
("At startup") or as a service (for example with NSSM).

## 2. Point qpm at it (on every client device)

Use the "other devices" address the server printed:

```powershell
setx QPM_REGISTRY "http://192.168.1.20:8000/api/registry/"   # permanent; open a new terminal afterwards
$env:QPM_REGISTRY = "http://192.168.1.20:8000/api/registry/"  # this PowerShell window only
```

On the server device itself you don't need to set anything, because qpm's default is
`http://localhost:8000/api/registry/`.

## 3. Create an account (optional)

Publishing works without an account. An account locks a package name to you, so no one
else can publish new versions of it. qpm has no sign-up command, so create the account
with one request:

```powershell
Invoke-RestMethod -Method Post -Uri http://192.168.1.20:8000/api/auth/signup -ContentType application/json `
  -Body '{"username":"saad","email":"you@example.com","password":"choose-a-password"}'
```

Or use curl:

```bash
curl -X POST http://192.168.1.20:8000/api/auth/signup -H "Content-Type: application/json" \
  -d '{"username":"saad","email":"you@example.com","password":"choose-a-password"}'
```

Then log in from qpm:

```powershell
qpm login     # asks for username/email and password, saves a token in ~/.qpmrc
qpm whoami    # prints the account qpm is using
```

## 4. Publish and install

```powershell
cd my-package
qpm init                 # creates package.json (skip if you already have one)
qpm publish --dry-run    # lists the files that would be uploaded
qpm publish              # uploads it

cd ..\some-project
qpm i my-package         # installs it (plus its dependencies) into node_modules
```

### Publishing rules

- **Version:** each published version is permanent. To publish again, bump `version` in `package.json`.
- **Ownership:** a package published while logged in belongs to that account, and only that account can publish new versions of it. A package published anonymously has no owner, so anyone can publish new versions of it.
- **Source of truth:** the registry reads `package.json` from inside the uploaded tarball. The name, version and dependencies it serves come from that file.
- **Tarball layout:** the files must be inside a `package/` folder, which `qpm publish` and `qpm pack` handle for you.
- **`latest`:** always points at the highest release version, so publishing an older patch release doesn't move it.

## Configuration

Edit `config.json`. Each setting can also be overridden with an environment variable.

| config.json | Env variable | Default | Meaning |
|---|---|---|---|
| `port` | `PORT` | `8000` | Port to listen on. |
| `host` | `HOST` | `0.0.0.0` | `0.0.0.0` accepts connections from other devices; `127.0.0.1` accepts this machine only. |
| `dataDir` | `DATA_DIR` | `./data` | Where packages, accounts and tokens are stored (relative to this folder). |
| `publicUrl` | `PUBLIC_URL` | *(empty)* | Base URL used in tarball links. Leave empty on a LAN; set it (e.g. `https://packages.example.com`) when behind a reverse proxy. |
| `requireLogin` | `REQUIRE_LOGIN` | `false` | `true` rejects anonymous publishes. |
| `maxUploadMb` | `MAX_UPLOAD_MB` | `100` | Largest tarball accepted. |
| `tokenTtlDays` | `TOKEN_TTL_DAYS` | `30` | How long a `qpm login` stays valid. |

## Data and backups

```
data/
  users.json                        accounts (scrypt-hashed passwords)
  tokens.json                       login tokens (stored only as SHA-256 hashes)
  packages/<name>.json              one document per package, with every version
  tarballs/<name>-<version>.tgz     the published archives
```

- **Backup:** copy `data/` while the server is stopped.
- **Move to a new device:** copy the whole folder, including `data/`.
- **Scoped names:** `@scope/name` is stored URL-encoded as `%40scope%2Fname`.

## API

| Method | Path | Used by |
|---|---|---|
| GET | `/api/registry/<name>` | `qpm install`: package document with `dist-tags`, `versions`, `dist.tarball` |
| GET | `/api/registry/<name>/-/<file>.tgz` | `qpm install`: tarball download (counts downloads) |
| POST | `/api/registry/publish` | `qpm publish` (JSON with `fileBase64`), web frontend / `curl -F file=@x.tgz` (multipart) |
| GET | `/api/registry/search?q=` | search by name, description, keywords |
| GET | `/api/registry/user/my-packages` | packages owned by the logged-in user |
| POST | `/api/auth/signup` | create an account, returns a token |
| POST | `/api/auth/login` | `qpm login` |
| GET | `/api/auth/me` | `qpm whoami`; `qpm publish` checks the login with it |
| GET | `/api/health` | status check |

Errors are JSON: `{"error": "..."}`.

## Exposing it to the internet

### Quick: a random public address

Double-click `start-public.bat`, or run:

```bash
node public.js     # or: npm run public
```

This starts the registry and opens a free [localhost.run](https://localhost.run) tunnel
over SSH. There's no account, download, port forwarding or firewall rule. It prints an
address like this:

```
Public registry address (a new one is generated every run):
  https://a922c662904f8a.lhr.life/api/registry/
```

Set `QPM_REGISTRY` to that address on any device with internet access. Keep the window
open, because closing it takes the registry offline. The address changes on every run,
and localhost.run may also change it while the registry is running (the new one is
printed when that happens). The tunnel needs the `ssh` command, which Windows 10 and 11
include as the "OpenSSH Client" optional feature.

Anyone who has the address can use the registry, so consider setting `requireLogin` to
`true` first.

### Permanent: your own domain

The server speaks plain HTTP. That's fine on a home or office network, but for a
permanent address on the internet:

1. Put it behind a reverse proxy that adds HTTPS, such as Caddy or nginx.
2. Set `publicUrl` to the public `https://` address.
3. Consider setting `requireLogin` to `true`.
