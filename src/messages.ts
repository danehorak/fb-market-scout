import { createHash } from "node:crypto";

export type ConversationRow = {
  participant: string;
  listingTitle: string;
  preview?: string;
  updatedAt?: string;
};

export type ConversationSummary = ConversationRow & {
  conversationKey: string;
};

export type MarketplaceMessage = {
  sender: string;
  sentAt: string;
  text: string;
  isFromYou: boolean;
};

export function parseConversationRow(lines: string[]): ConversationRow | undefined {
  if (lines.length < 2 || !lines[1]?.startsWith("·")) return undefined;
  const participant = lines[0]?.trim();
  const listingTitle = lines[1].replace(/^·\s*/, "").trim();
  if (!participant || !listingTitle) return undefined;

  return {
    participant,
    listingTitle,
    preview: lines[2]?.trim() || undefined,
    updatedAt: lines[3]?.trim() || undefined,
  };
}

export function addConversationKeys(rows: ConversationRow[]): ConversationSummary[] {
  const occurrences = new Map<string, number>();
  return rows.map((row) => {
    const baseKey = createHash("sha256")
      .update(`${row.participant}\0${row.listingTitle}`)
      .digest("hex")
      .slice(0, 16);
    const occurrence = (occurrences.get(baseKey) ?? 0) + 1;
    occurrences.set(baseKey, occurrence);
    return {
      ...row,
      conversationKey: occurrence === 1 ? baseKey : `${baseKey}-${occurrence}`,
    };
  });
}

export function parseMessageAccessibilityLine(line: string): MarketplaceMessage | undefined {
  const match = line.match(/^Enter, Message sent (.+?) by ([^:]+): (.*)$/s);
  if (!match) return undefined;
  const [, sentAt, sender, text] = match;
  if (!sentAt || !sender || !text) return undefined;
  return {
    sender: sender.trim(),
    sentAt: sentAt.trim(),
    text: text.trim(),
    isFromYou: sender.trim().toLowerCase() === "you",
  };
}

export function extractSellerEvidence(messages: MarketplaceMessage[]) {
  const sellerMessages = messages.filter((message) => !message.isFromYou);
  return {
    availabilityCandidates: sellerMessages.filter((message) =>
      /\b(?:available|sold|pending|on hold|no longer available)\b/i.test(message.text),
    ),
    productDetailCandidates: sellerMessages.filter((message) =>
      /\b(?:model|serial|manufactur(?:e|ed|er|ing)?|(?:19|20)\d{2})\b/i.test(message.text),
    ),
  };
}
