import assert from "node:assert/strict";
import test from "node:test";
import { cdpEndpoint, cdpPort, sharedBrowserArgs } from "../dist/browser-config.js";

test("shared browser endpoint is loopback-only", () => {
  assert.ok(Number.isInteger(cdpPort));
  assert.equal(cdpEndpoint, `http://127.0.0.1:${cdpPort}`);
  assert.ok(sharedBrowserArgs.includes("--remote-debugging-address=127.0.0.1"));
  assert.ok(sharedBrowserArgs.includes(`--remote-debugging-port=${cdpPort}`));
});
