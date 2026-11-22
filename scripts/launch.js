#!/usr/bin/env node
// Entry point used when FigConn is installed as a Claude Code plugin.
// Plugin installs are a plain git checkout without node_modules, so install
// runtime dependencies on first start (and again whenever package-lock.json
// changes), then start the MCP server.
// stdout is reserved for MCP JSON-RPC, so npm's output goes to stderr.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const lock = join(root, "package-lock.json");
const marker = join(root, "node_modules", ".figconn-lock-hash");
const hash = existsSync(lock) ? createHash("sha256").update(readFileSync(lock)).digest("hex") : "no-lock";
const installed = existsSync(join(root, "node_modules", "@modelcontextprotocol", "sdk")) &&
  existsSync(marker) && readFileSync(marker, "utf8").trim() === hash;

if (!installed) {
  console.error("[figconn] installing dependencies (first run)…");
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const args = existsSync(lock) ? ["ci", "--omit=dev", "--no-audit", "--no-fund"] : ["install", "--omit=dev", "--no-audit", "--no-fund"];
  const r = spawnSync(npm, args, { cwd: root, stdio: ["ignore", 2, 2], shell: process.platform === "win32" });
  if (r.status !== 0) {
    console.error(`[figconn] dependency install failed (exit ${r.status}). Run \`npm install\` in ${root} manually.`);
    process.exit(1);
  }
  writeFileSync(marker, hash);
}

await import(pathToFileURL(join(root, "server", "index.js")).href);
