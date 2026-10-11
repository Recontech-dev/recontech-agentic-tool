// Where the app keeps its data. Always outside every project, so nothing here can be committed with one.

import * as os from "node:os";
import * as path from "node:path";

export function home(): string {
  return process.env.ALT_HOME || path.join(os.homedir(), ".agentic-lazy-tool");
}

export const memoryDir = () => path.join(home(), "memory");
export const sessionIndexFile = () => path.join(home(), "brain", "sessions.json");
export const workspaceFile = () => path.join(home(), "workspace.json");
export const profilesDir = () => path.join(home(), "profiles");

// Claude Code keeps its login and its session transcripts here unless CLAUDE_CONFIG_DIR says otherwise.
// ALT_CLAUDE_HOME exists for tests, so they never read the real sessions on the machine.
export const defaultClaudeDir = () => process.env.ALT_CLAUDE_HOME || path.join(os.homedir(), ".claude");
