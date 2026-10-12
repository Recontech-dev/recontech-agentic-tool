// Where the app keeps its data. Always outside every project, so nothing here can be committed with one.

import * as os from "node:os";
import * as path from "node:path";

/** Where the data goes on the Windows drive, in the user's folder. */
export const userHome = () => path.join(os.homedir(), ".recontech-agentic-tool");

/**
 * Where earlier versions kept the data, newest name last: in the user's folder, and (under the app's
 * old name, Agentic Lazy Tool) beside the app on its own drive.
 */
export function earlierHomes(execPath = process.execPath, systemDrive = process.env.SystemDrive || "C:"): string[] {
  const homes = [path.join(os.homedir(), ".agentic-lazy-tool")];
  const drive = appDrive(execPath, systemDrive);
  if (drive) homes.push(path.win32.join(drive, "Agentic Lazy Tool Data"));
  return homes;
}

/** The drive the app runs from, when that is a drive other than Windows' own. */
function appDrive(execPath: string, systemDrive: string): string | null {
  if (process.platform !== "win32" && !/^[A-Za-z]:/.test(execPath)) return null;
  const drive = path.win32.parse(execPath).root.toUpperCase();
  return /^[A-Z]:\\$/.test(drive) && drive !== `${systemDrive.toUpperCase().replace(/\\$/, "")}\\` ? drive : null;
}

/**
 * Where the data goes when nothing else says so. An app run from another drive than Windows' own
 * (installed on D:, say) keeps its data on that drive too: beside the app's folder rather than in
 * it, so uninstalling never removes it. Elsewhere it stays in the user's folder.
 */
export function defaultHome(execPath = process.execPath, systemDrive = process.env.SystemDrive || "C:"): string {
  const drive = appDrive(execPath, systemDrive);
  return drive ? path.win32.join(drive, "Recontech Agentic Tool Data") : userHome();
}

export function home(): string {
  return process.env.ALT_HOME || defaultHome();
}

export const memoryDir = () => path.join(home(), "memory");
export const sessionIndexFile = () => path.join(home(), "brain", "sessions.json");
export const workspaceFile = () => path.join(home(), "workspace.json");
export const profilesDir = () => path.join(home(), "profiles");
/** The empty folder a contained free terminal works in, away from every project. */
export const containerDir = () => path.join(home(), "free-container");

// Claude Code keeps its login and its session transcripts here unless CLAUDE_CONFIG_DIR says otherwise.
// ALT_CLAUDE_HOME exists for tests, so they never read the real sessions on the machine.
export const defaultClaudeDir = () => process.env.ALT_CLAUDE_HOME || path.join(os.homedir(), ".claude");
