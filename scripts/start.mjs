// Start the app from the project folder. Some terminals (including VS Code's) set
// ELECTRON_RUN_AS_NODE, which would make Electron run as plain Node, so it is removed here.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const electron = createRequire(import.meta.url)("electron");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
spawn(electron, ["."], { stdio: "inherit", env }).on("exit", (code) => process.exit(code ?? 0));
