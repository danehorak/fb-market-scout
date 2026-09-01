import assert from "node:assert/strict";
import test from "node:test";
import { RecentSendGuard } from "../dist/send-guard.js";

test("RecentSendGuard refuses an immediate duplicate", () => {
  const guard = new RecentSendGuard(600_000);
  guard.reserve("listing-1", "Exact message", 1_000);

  assert.throws(
    () => guard.reserve("listing-1", "Exact message", 2_000),
    /Refusing to repeat the same message/,
  );
  assert.doesNotThrow(() => guard.reserve("listing-1", "Different message", 2_000));
  assert.doesNotThrow(() => guard.reserve("listing-2", "Exact message", 2_000));
});

test("RecentSendGuard allows retry after a failed action is released", () => {
  const guard = new RecentSendGuard(600_000);
  const fingerprint = guard.reserve("listing-1", "Exact message", 1_000);
  guard.release(fingerprint);

  assert.doesNotThrow(() => guard.reserve("listing-1", "Exact message", 2_000));
});

test("RecentSendGuard expires old reservations", () => {
  const guard = new RecentSendGuard(600_000);
  guard.reserve("listing-1", "Exact message", 1_000);

  assert.doesNotThrow(() => guard.reserve("listing-1", "Exact message", 601_000));
});
