import assert from "node:assert/strict";
import { test } from "node:test";

import { DEVICES, deviceById, fitScale, isLocalAddress, oriented, previewAddress } from "../brain/devices";

test("Claude Code may preview only addresses on this computer or the local network", () => {
  for (const local of ["http://localhost:3000/", "http://app.localhost:5173/", "http://127.0.0.1:8080/", "http://[::1]:3000/", "http://0.0.0.0:4000/",
    "http://10.0.0.5/", "http://192.168.1.20:5173/", "http://172.16.0.1/", "http://172.31.255.1/", "http://169.254.1.1/", "http://my-pc.local:3000/",
    "http://[fe80::1]/", "http://[fd12:3456::1]/"]) {
    assert.equal(isLocalAddress(local), true, local);
  }
  for (const remote of ["https://example.com/", "https://mail.google.com/", "http://172.32.0.1/", "http://11.0.0.1/", "http://localhost.evil.com/",
    "http://192.169.0.1/", "http://[2001:db8::1]/", "not a url"]) {
    assert.equal(isLocalAddress(remote), false, remote);
  }
});

test("a preview opens web addresses only, and a bare host gets http:// in front", () => {
  assert.equal(previewAddress("localhost:3000"), "http://localhost:3000/");
  assert.equal(previewAddress("  https://example.com/app?x=1 "), "https://example.com/app?x=1");
  assert.equal(previewAddress("192.168.1.20:5173/login"), "http://192.168.1.20:5173/login");
  for (const bad of ["", "   ", null, undefined, 42, "file:///C:/Windows/win.ini", "javascript:alert(1)", "ftp://host/x", "vscode://open", "x".repeat(3000)]) {
    assert.equal(previewAddress(bad), null, `refused: ${String(bad).slice(0, 30)}`);
  }
});

test("devices are found by id only, and every one is complete", () => {
  assert.equal(deviceById("pixel-8")?.name, "Pixel 8");
  assert.equal(deviceById("nope"), undefined);
  assert.equal(deviceById({ id: "pixel-8" }), undefined);
  assert.equal(new Set(DEVICES.map((d) => d.id)).size, DEVICES.length, "ids are unique");
  for (const d of DEVICES) assert.ok(d.width > 0 && d.height > 0 && d.scale > 0, d.id);
});

test("a device turns sideways and shrinks to fit the screen, but is never enlarged", () => {
  const phone = deviceById("iphone-15")!;
  assert.deepEqual(oriented(phone, false), { width: 393, height: 852 });
  assert.deepEqual(oriented(phone, true), { width: 852, height: 393 });
  assert.equal(fitScale(393, 852, { width: 1920, height: 1040 }), 1);
  const scale = fitScale(1024, 1366, { width: 1920, height: 1040 });
  assert.ok(Math.abs(scale - (1040 * 0.9) / 1366) < 1e-9);
  assert.ok(1366 * scale <= 1040 && 1024 * scale <= 1920);
});
