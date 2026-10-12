// Refuse a commit that contains an API key, a private key or a personal data file.
// Run by the git pre-commit hook; run "node scripts/check-secrets.mjs --all" to scan everything git tracks.
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

const TOKEN = new RegExp([
  "sk-[A-Za-z0-9_-]{20,}", "gsk_[A-Za-z0-9]{20,}", "csk-[A-Za-z0-9]{20,}", "AIza[0-9A-Za-z_-]{35}",
  "gh[pousr]_[A-Za-z0-9]{36,}", "github_pat_[A-Za-z0-9_]{20,}", "AKIA[0-9A-Z]{16}", "xox[baprs]-[A-Za-z0-9-]{10,}",
  "-----BEGIN [A-Z ]*PRIVATE KEY-----",
].join("|"), "g");
const FORBIDDEN_DIRS = new Set([".recontech-agentic-tool", ".agentic-lazy-tool", "memory", "sessions", "profiles", ".claude", "recontech-agentic-tool-model", "agentic-lazy-tool-model"]);
const MAX_BYTES = 10 * 1024 * 1024;
const FORBIDDEN_NAMES = new Set([".env", "config.json", "workspace.json", "notes.jsonl", ".credentials.json", "CLAUDE.md"]);

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).split("\n").filter(Boolean);
const files = process.argv.includes("--all") ? git("ls-files") : git("diff", "--cached", "--name-only", "--diff-filter=ACM");
const problems = [];
for (const name of files) {
  const parts = name.split("/");
  if (parts.slice(0, -1).some((p) => FORBIDDEN_DIRS.has(p)) || FORBIDDEN_NAMES.has(parts.at(-1))) {
    problems.push(`${name}: personal data file`);
    continue;
  }
  // Models, installers and other large files do not belong in the repository.
  try {
    if (statSync(name).size > MAX_BYTES) {
      problems.push(`${name}: larger than ${MAX_BYTES / 1024 / 1024} MB`);
      continue;
    }
  } catch {
    continue;
  }
  let text;
  try {
    text = readFileSync(name, "utf8");
  } catch {
    continue;
  }
  if (text.includes("\u0000")) continue;
  for (const token of text.match(TOKEN) ?? []) {
    // The patterns in this script and in redact.ts describe secrets; they are not secrets.
    if (!/[\\[{]/.test(token)) problems.push(`${name}: looks like a secret (${token.slice(0, 8)}...)`);
  }
}
problems.forEach((p) => console.log(p));
if (problems.length) {
  console.log("\nCommit stopped. Remove these before committing.");
  process.exit(1);
}
console.log(`No secrets found in ${files.length} file(s).`);
