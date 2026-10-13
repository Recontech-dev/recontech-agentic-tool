import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";

import { icaclsArgs, underUserFolder } from "../main/privacy";

test("only a data folder outside the user's own folder needs locking", () => {
  const user = path.resolve("/Users/earl");
  assert.equal(underUserFolder(path.join(user, ".recontech-agentic-tool"), user), true);
  assert.equal(underUserFolder(user, user), true);
  assert.equal(underUserFolder(path.resolve("/Recontech Agentic Tool Data"), user), false);
  assert.equal(underUserFolder(path.resolve("/Users/earl-other/data"), user), false);
});

test("the data folder is left to this user, SYSTEM and the Administrators, with nothing inherited", () => {
  const args = icaclsArgs("D:\Recontech Agentic Tool Data", "MKT\Admin");
  assert.equal(args[0], "D:\Recontech Agentic Tool Data");
  assert.ok(args.includes("/inheritance:r"));
  assert.deepEqual(args.filter((a) => a.endsWith(":(OI)(CI)F")), ["MKT\Admin:(OI)(CI)F", "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"]);
});
