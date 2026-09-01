import assert from "node:assert/strict";
import test from "node:test";
import {
  addConversationKeys,
  extractSellerEvidence,
  parseConversationRow,
  parseMessageAccessibilityLine,
} from "../dist/messages.js";

test("parseConversationRow extracts a Marketplace inbox summary", () => {
  assert.deepEqual(
    parseConversationRow([
      "Seller Name",
      "· Example Listing",
      "Yes, it is available",
      "10:30 AM",
    ]),
    {
      participant: "Seller Name",
      listingTitle: "Example Listing",
      preview: "Yes, it is available",
      updatedAt: "10:30 AM",
    },
  );
  assert.equal(parseConversationRow(["Unrelated button"]), undefined);
});

test("addConversationKeys is stable and disambiguates duplicate rows", () => {
  const row = { participant: "Seller Name", listingTitle: "Example Listing" };
  const [first, second] = addConversationKeys([row, row]);

  assert.match(first.conversationKey, /^[a-f0-9]{16}$/);
  assert.equal(second.conversationKey, `${first.conversationKey}-2`);
  assert.equal(addConversationKeys([row])[0].conversationKey, first.conversationKey);
});

test("parseMessageAccessibilityLine preserves sender attribution", () => {
  assert.deepEqual(
    parseMessageAccessibilityLine(
      "Enter, Message sent Tuesday 9:15 AM by Seller Name: It is still available.",
    ),
    {
      sender: "Seller Name",
      sentAt: "Tuesday 9:15 AM",
      text: "It is still available.",
      isFromYou: false,
    },
  );
  assert.equal(
    parseMessageAccessibilityLine("Enter, Message sent 9:16 AM by You: Thanks")?.isFromYou,
    true,
  );
});

test("extractSellerEvidence excludes claims made by the buyer", () => {
  const seller = {
    sender: "Seller Name",
    sentAt: "9:15 AM",
    text: "It is still available and was manufactured in 2020, model ZX-10.",
    isFromYou: false,
  };
  const buyer = {
    sender: "You",
    sentAt: "9:14 AM",
    text: "Is it available, and is the model ZX-10?",
    isFromYou: true,
  };
  const evidence = extractSellerEvidence([buyer, seller]);

  assert.deepEqual(evidence.availabilityCandidates, [seller]);
  assert.deepEqual(evidence.productDetailCandidates, [seller]);
});
