// Moving the app's data from where earlier versions kept it (the Windows drive) to where it belongs
// now (the drive the app runs from). Nothing is lost if the move fails part way: the old folder is
// only retired once the copy is complete, and until then the app keeps using it.

import * as fs from "node:fs";
import * as path from "node:path";

export type Moved = { moved: true; leftBehind?: string } | { moved: false; problem?: string };

const same = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/** `file` moved from under `from` to the same place under `to`; anything else as it was. */
function rebase(file: unknown, from: string, to: string): unknown {
  if (typeof file !== "string" || !file) return file;
  const rel = path.relative(from, file);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? path.join(to, rel) : same(file, from) ? to : file;
}

/**
 * Copy the data folder `from` to `to` and retire `from`. Does nothing when there is nothing to move
 * or `to` already exists (the data is there already; merging two folders could lose sign-ins).
 */
export function moveData(from: string, to: string): Moved {
  if (same(from, to) || !fs.existsSync(from) || fs.existsSync(to)) return { moved: false };
  try {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(from, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
  } catch (error) {
    // A half copy must not be mistaken for the data later on.
    fs.rmSync(to, { recursive: true, force: true });
    return { moved: false, problem: (error as Error).message };
  }
  // The workspace names folders inside the data folder (each profile's sign-in, the sorting model).
  const workspaceFile = path.join(to, "workspace.json");
  try {
    const workspace = JSON.parse(fs.readFileSync(workspaceFile, "utf8"));
    for (const profile of workspace.profiles ?? []) profile.configDir = rebase(profile.configDir, from, to);
    if (workspace.sorting) workspace.sorting.modelDir = rebase(workspace.sorting.modelDir, from, to);
    fs.writeFileSync(workspaceFile, JSON.stringify(workspace, null, 2), "utf8");
  } catch {
    // No workspace yet, or one that the app will recover from on its own.
  }
  // Renamed first, which either fully succeeds or does nothing, then removed.
  const retired = `${from}-moved-${Date.now()}`;
  try {
    fs.renameSync(from, retired);
  } catch {
    return { moved: true, leftBehind: from };
  }
  try {
    fs.rmSync(retired, { recursive: true, force: true });
  } catch {
    return { moved: true, leftBehind: retired };
  }
  return { moved: true };
}
