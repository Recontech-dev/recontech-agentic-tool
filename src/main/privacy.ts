// Keeps the app's data folder private to the person using it. It holds the profiles' Claude sign-ins,
// the encrypted API keys, the brain and the control token. In the user's own folder that is already
// the case; on another drive (the app installed on D:, say) a new folder inherits the drive's rules,
// which on Windows usually let every signed-in user read and change it.

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Well-known SIDs, so the rule works on Windows in any language. */
const SYSTEM = "*S-1-5-18";
const ADMINISTRATORS = "*S-1-5-32-544";

/** True when `dir` is inside the user's own folder, which Windows already keeps private. */
export function underUserFolder(dir: string, userFolder = os.homedir()): boolean {
  const rel = path.relative(path.resolve(userFolder), path.resolve(dir));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * The icacls arguments that leave `dir` (and everything in it) to this user, SYSTEM and the
 * Administrators only: inherited rules are dropped and the three are granted full control.
 */
export function icaclsArgs(dir: string, user: string): string[] {
  return [dir, "/inheritance:r", "/grant:r", `${user}:(OI)(CI)F`, `${SYSTEM}:(OI)(CI)F`, `${ADMINISTRATORS}:(OI)(CI)F`, "/Q"];
}

/** The signed-in Windows user, as DOMAIN\name. */
function windowsUser(): string | null {
  const name = process.env.USERNAME;
  if (!name) return null;
  return process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${name}` : name;
}

/** Left in the folder once it is locked, so later starts do not walk the whole folder again. */
const MARKER = ".private";

/**
 * Makes `dir` private to this user, once. Runs in the background and never throws: a folder it
 * cannot lock stays as it was, the reason is written to the log, and it is tried at the next start.
 */
export function makePrivate(dir: string): Promise<void> {
  const done = () => fs.writeFile(path.join(dir, MARKER), "", () => undefined);
  return new Promise((resolve) => {
    if (!fs.existsSync(dir) || underUserFolder(dir) || fs.existsSync(path.join(dir, MARKER))) return resolve();
    if (process.platform !== "win32") {
      fs.chmod(dir, 0o700, (error) => {
        if (error) console.error(`[privacy] could not make ${dir} private: ${error.message}`);
        else done();
        resolve();
      });
      return;
    }
    const user = windowsUser();
    if (!user) return resolve();
    const icacls = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "icacls.exe");
    execFile(icacls, icaclsArgs(dir, user), { windowsHide: true, timeout: 60_000 }, (error, _stdout, stderr) => {
      if (error) console.error(`[privacy] could not make ${dir} private: ${String(stderr || error.message).trim()}`);
      else done();
      resolve();
    });
  });
}
