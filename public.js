#!/usr/bin/env node
// Runs the registry and puts it on the internet through localhost.run: a
// random https://<id>.lhr.life address over plain SSH, with no account, no
// download, no port forwarding and no firewall rule. The address is new every
// run, and localhost.run may change it while running (the new one is printed).

const readline = require("readline");
const { spawn } = require("child_process");

const config = require("./lib/config");

const RECONNECT_DELAY_MS = 5000;
const configuredPublicUrl = config.publicUrl;

let ssh = null;
let origin = null;

function announce() {
  const registryUrl = `${origin}/api/registry/`;
  console.log("");
  console.log("Public registry address (a new one is generated every run):");
  console.log(`  ${registryUrl}`);
  console.log("");
  console.log("Point qpm at it on any device with internet access:");
  console.log(`  PowerShell:  $env:QPM_REGISTRY = "${registryUrl}"`);
  console.log(`  cmd:         set QPM_REGISTRY=${registryUrl}`);
  console.log(`  bash:        export QPM_REGISTRY=${registryUrl}`);
  if (!config.requireLogin) {
    console.log("");
    console.log("Warning: anyone who has this address can publish packages. Set");
    console.log('"requireLogin": true in config.json to allow logged-in accounts only.');
  }
  console.log("");
  console.log("Keep this window open; closing it takes the registry offline.");
  console.log("");
}

function connect() {
  ssh = spawn("ssh", [
    "-T",
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ServerAliveInterval=30",
    "-o", "ExitOnForwardFailure=yes",
    "-R", `80:127.0.0.1:${config.port}`,
    "nokey@localhost.run",
  ], { stdio: ["ignore", "pipe", "pipe"] });

  const recent = [];
  const onLine = (line) => {
    recent.push(line);
    if (recent.length > 20) recent.shift();
    const match = /tunneled with tls termination, (https:\/\/\S+)/.exec(line);
    if (!match || match[1] === origin) return;
    origin = match[1];
    // localhost.run doesn't send X-Forwarded-Proto, so tell the registry its
    // https address for tarball links (unless config.json already names one).
    if (!configuredPublicUrl) config.publicUrl = origin;
    announce();
  };
  readline.createInterface({ input: ssh.stdout }).on("line", onLine);
  readline.createInterface({ input: ssh.stderr }).on("line", onLine);

  ssh.on("error", (err) => {
    console.error(`Could not run ssh (${err.message}).`);
    console.error('On Windows, add it under Settings > System > Optional features > "OpenSSH Client".');
    process.exit(1);
  });
  ssh.on("exit", (code) => {
    if (!origin) {
      console.error(`Could not open a tunnel to localhost.run (ssh exit code ${code}):`);
      console.error(recent.join("\n"));
      process.exit(1);
    }
    console.error(`Tunnel closed (ssh exit code ${code}); reconnecting in ${RECONNECT_DELAY_MS / 1000} s...`);
    setTimeout(connect, RECONNECT_DELAY_MS);
  });
}

require("./server"); // starts listening on config.port
process.on("exit", () => ssh && ssh.kill());
process.on("SIGINT", () => process.exit(0));
connect();
