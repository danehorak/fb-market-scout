import assert from "node:assert/strict";
import test from "node:test";
import { classifyManualIntervention } from "../dist/manual-intervention.js";

test("classifyManualIntervention detects Facebook checkpoints", () => {
  assert.equal(
    classifyManualIntervention("https://www.facebook.com/checkpoint/123/", "", false),
    "checkpoint",
  );
});

test("classifyManualIntervention detects human verification", () => {
  assert.equal(
    classifyManualIntervention("https://www.facebook.com/", "Confirm that you're human", false),
    "human_verification",
  );
  assert.equal(
    classifyManualIntervention("https://www.facebook.com/", "", true),
    "human_verification",
  );
});

test("classifyManualIntervention detects login and ignores Marketplace", () => {
  assert.equal(
    classifyManualIntervention("https://www.facebook.com/login/", "Log in", false),
    "login",
  );
  assert.equal(
    classifyManualIntervention("https://www.facebook.com/", "Log in", false, true),
    "login",
  );
  assert.equal(
    classifyManualIntervention("https://www.facebook.com/marketplace/", "Marketplace", false),
    undefined,
  );
});
