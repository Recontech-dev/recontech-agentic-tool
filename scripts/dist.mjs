// Build the Windows installer with every temporary file and download cache inside this project
// folder (.build-tmp, ignored by git), so packaging never fills the Windows drive.
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const tmp = join(root, ".build-tmp");
const cache = join(tmp, "cache");
mkdirSync(join(tmp, "temp"), { recursive: true });
mkdirSync(cache, { recursive: true });

const env = {
  ...process.env,
  TEMP: join(tmp, "temp"),
  TMP: join(tmp, "temp"),
  ELECTRON_BUILDER_CACHE: join(cache, "electron-builder"),
  ELECTRON_CACHE: join(cache, "electron"),
  electron_config_cache: join(cache, "electron"),
};
const cli = createRequire(import.meta.url).resolve("electron-builder/cli.js");
const result = spawnSync(process.execPath, [cli, "--win", "--publish", "never"], { cwd: root, env, stdio: "inherit" });
// The temporary files go; the download cache stays so the next build does not download again.
rmSync(join(tmp, "temp"), { recursive: true, force: true });
process.exit(result.status ?? 1);
