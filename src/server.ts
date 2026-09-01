import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { chromium, type BrowserContext, type Locator, type Page } from "playwright";
import { z } from "zod";
import {
  assertMarketplaceListingUrl,
  buildMarketplaceSearchUrl,
  marketplaceOrigin,
} from "./marketplace.js";
import {
  addConversationKeys,
  extractSellerEvidence,
  parseConversationRow,
  parseMessageAccessibilityLine,
  type ConversationRow,
} from "./messages.js";
import { RecentSendGuard } from "./send-guard.js";
import { cdpEndpoint, profilePath } from "./browser-config.js";

const supportedRadii = [1, 2, 5, 10, 20, 40, 60, 80, 100, 250, 500] as const;

let operationQueue = Promise.resolve();
type BrowserSession = {
  context: BrowserContext;
  externallyOwned: boolean;
};
let browserSessionPromise: Promise<BrowserSession> | undefined;
let primaryPage: Page | undefined;
let shuttingDown = false;
const recentSendGuard = new RecentSendGuard(10 * 60 * 1_000);

type ListingSummary = {
  url: string;
  title?: string;
  price?: string;
  details: string[];
  imageAlt?: string;
};

async function createBrowserSession(): Promise<BrowserSession> {
  try {
    const browser = await chromium.connectOverCDP(cdpEndpoint, { timeout: 1_500 });
    const context = browser.contexts()[0];
    if (!context) throw new Error("Shared Chromium did not expose its persistent context.");
    browser.once("disconnected", () => {
      if (!shuttingDown) {
        browserSessionPromise = undefined;
        primaryPage = undefined;
      }
    });
    return { context, externallyOwned: true };
  } catch {
    const context = await chromium.launchPersistentContext(profilePath, {
      headless: false,
      viewport: { width: 1440, height: 900 },
    });
    const browser = context.browser();
    browser?.once("disconnected", () => {
      if (!shuttingDown) {
        browserSessionPromise = undefined;
        primaryPage = undefined;
      }
    });
    return { context, externallyOwned: false };
  }
}

async function getBrowserSession(): Promise<BrowserSession> {
  if (!browserSessionPromise) {
    browserSessionPromise = createBrowserSession();
    browserSessionPromise
      .catch(() => {
        browserSessionPromise = undefined;
        primaryPage = undefined;
      });
  }
  return browserSessionPromise;
}

async function getPrimaryPage(): Promise<Page> {
  const { context, externallyOwned } = await getBrowserSession();
  if (!primaryPage || primaryPage.isClosed()) {
    primaryPage = externallyOwned
      ? await context.newPage()
      : context.pages().find((page) => !page.isClosed()) ?? (await context.newPage());
  }
  return primaryPage;
}

async function withPage<T>(operation: (page: Page) => Promise<T>): Promise<T> {
  const run = operationQueue.then(async () => {
    if (shuttingDown) throw new Error("Marketplace browser session is shutting down.");
    return operation(await getPrimaryPage());
  });
  operationQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function shutdownBrowser(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  const sessionPromise = browserSessionPromise;
  browserSessionPromise = undefined;
  const page = primaryPage;
  primaryPage = undefined;
  const session = await sessionPromise?.catch(() => undefined);
  if (session?.externallyOwned) {
    await page?.close().catch(() => undefined);
  } else {
    await session?.context.close().catch(() => undefined);
  }
}

function jsonResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function errorResult(error: unknown) {
  const rawMessage = error instanceof Error ? error.message : String(error);
  let message = "Marketplace request failed. Check the local Chromium window and try again.";
  if (/existing browser session|processsingleton|profile.*in use/i.test(rawMessage)) {
    message = "The dedicated browser profile is already owned by another Chromium or fb-market-scout process. Close the other login browser or Codex session, then retry from one active MCP session.";
  } else if (/executable doesn't exist|browser.*not found/i.test(rawMessage)) {
    message = "Playwright Chromium is not installed. Run: npx playwright install chromium";
  } else if (/facebook is requesting login/i.test(rawMessage)) {
    message = "Facebook is requesting login or verification. Complete it manually in the shared Chromium window, or run npm run login if that browser is not open.";
  } else if (error instanceof Error && !rawMessage.includes(profilePath)) {
    message = rawMessage;
  }
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

async function isLoginRequired(page: Page): Promise<boolean> {
  const loginFormVisible = await page
    .locator('input[name="email"], form[action*="login"]')
    .first()
    .isVisible()
    .catch(() => false);
  return loginFormVisible || page.url().includes("/login") || page.url().includes("/checkpoint/");
}

async function requireLogin(page: Page): Promise<void> {
  if (await isLoginRequired(page)) {
    throw new Error("Facebook is requesting login.");
  }
}

async function waitForMarketplace(page: Page): Promise<boolean> {
  await page.waitForLoadState("domcontentloaded");
  const foundListing = await page
    .locator('a[href*="/marketplace/item/"]')
    .first()
    .waitFor({ state: "attached", timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  await page.waitForTimeout(500);
  return foundListing;
}

type BrowserConversationRow = ConversationRow & { buttonIndex: number };

async function openBuyingInbox(page: Page): Promise<Locator> {
  await page.goto(`${marketplaceOrigin}/marketplace/inbox/`, { waitUntil: "domcontentloaded" });
  await requireLogin(page);
  await page.keyboard.press("Escape");
  const main = page.locator('[role="main"]');
  const buyingTab = main.getByRole("tab", { name: "Buying", exact: true });
  await buyingTab.waitFor({ timeout: 15_000 });
  if ((await buyingTab.getAttribute("aria-selected")) !== "true") await buyingTab.click();
  await page
    .waitForFunction(() =>
      [...document.querySelectorAll('[role="main"] [role="button"]')].some((button) =>
        (button.textContent ?? "").includes("·"),
      ),
    { timeout: 15_000 })
    .catch(() => undefined);
  return main;
}

async function getConversationRows(main: Locator): Promise<BrowserConversationRow[]> {
  const candidates = await main.getByRole("button").evaluateAll((buttons) =>
    buttons.map((button, buttonIndex) => ({
      buttonIndex,
      lines: (button instanceof HTMLElement ? button.innerText : button.textContent || "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 8),
    })),
  );

  return candidates.flatMap(({ buttonIndex, lines }) => {
    const row = parseConversationRow(lines);
    return row ? [{ ...row, buttonIndex }] : [];
  });
}

function keyedBrowserRows(rows: BrowserConversationRow[]) {
  const keyedRows = addConversationKeys(rows);
  return keyedRows.map((row, index) => ({ ...row, buttonIndex: rows[index]!.buttonIndex }));
}

function marketplaceMessageAnnotations() {
  return {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  };
}

const messageSendAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

async function firstVisible(locator: Locator): Promise<Locator> {
  for (let index = 0; index < (await locator.count()); index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible()) return candidate;
  }
  throw new Error("Facebook message composer is not available for this target.");
}

async function waitForSentMessage(page: Page, message: string, initialArticleCount: number): Promise<boolean> {
  return page
    .waitForFunction(
      ({ expectedMessage, previousCount }) => {
        const articles = [...document.querySelectorAll('[role="log"] [role="article"]')];
        if (articles.length <= previousCount) return false;
        return articles.slice(previousCount).some((article) =>
          (article.textContent ?? "").includes(`by You: ${expectedMessage}`),
        );
      },
      { expectedMessage: message, previousCount: initialArticleCount },
      { timeout: 10_000 },
    )
    .then(() => true)
    .catch(() => false);
}

const server = new McpServer({
  name: "fb-market-scout",
  version: "0.4.0",
});

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

server.registerTool(
  "get_login_status",
  {
    title: "Check Facebook Marketplace login",
    description: "Check whether the dedicated local browser profile can open Facebook Marketplace.",
    annotations: readOnlyAnnotations,
  },
  async () => {
    try {
      return jsonResult(
        await withPage(async (page) => {
          await page.goto(`${marketplaceOrigin}/marketplace/`, { waitUntil: "domcontentloaded" });
          const authenticated = !(await isLoginRequired(page));
          return {
            authenticated,
            marketplaceUrl: page.url().startsWith(`${marketplaceOrigin}/marketplace`),
            message: authenticated
              ? "The local browser profile appears to be authenticated."
              : "Facebook is requesting login or verification. Complete it manually in the shared Chromium window, or run npm run login if that browser is not open.",
          };
        }),
      );
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "search_marketplace",
  {
    title: "Search Facebook Marketplace",
    description: "Search Marketplace and return a limited set of visible, read-only listing summaries.",
    inputSchema: {
      query: z.string().trim().min(1).max(120).describe("Marketplace search terms"),
      location_slug: z
        .string()
        .trim()
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
        .max(80)
        .optional()
        .describe("Optional Facebook Marketplace city slug, such as denver or colorado-springs"),
      min_price: z.number().nonnegative().optional().describe("Optional minimum price"),
      max_price: z.number().nonnegative().optional().describe("Optional maximum price"),
      radius_miles: z
        .union(supportedRadii.map((radius) => z.literal(radius)))
        .optional()
        .describe("Optional radius in miles around the selected Marketplace location"),
      days_since_listed: z
        .union([z.literal(1), z.literal(7), z.literal(30)])
        .optional()
        .describe("Only include items listed in the last 1, 7, or 30 days"),
      conditions: z
        .array(z.enum(["new", "used_like_new", "used_good", "used_fair"]))
        .min(1)
        .max(4)
        .optional()
        .describe("Optional item conditions"),
      delivery_method: z
        .enum(["local_pick_up", "shipping"])
        .optional()
        .describe("Optional delivery method"),
      sort_by: z
        .enum(["creation_time_descend", "distance_ascend", "price_ascend", "price_descend"])
        .optional()
        .describe("Optional result order"),
      limit: z.number().int().min(1).max(20).default(10).describe("Maximum listings to return"),
    },
    annotations: readOnlyAnnotations,
  },
  async ({
    query,
    location_slug,
    min_price,
    max_price,
    radius_miles,
    days_since_listed,
    conditions,
    delivery_method,
    sort_by,
    limit,
  }) => {
    try {
      if (min_price !== undefined && max_price !== undefined && min_price > max_price) {
        throw new Error("min_price cannot be greater than max_price.");
      }

      const searchUrl = buildMarketplaceSearchUrl({
        query,
        locationSlug: location_slug,
        minPrice: min_price,
        maxPrice: max_price,
        radiusMiles: radius_miles,
        daysSinceListed: days_since_listed,
        conditions,
        deliveryMethod: delivery_method,
        sortBy: sort_by,
      });

      const listings = await withPage(async (page) => {
        await page.goto(searchUrl.toString(), { waitUntil: "domcontentloaded" });
        const foundListing = await waitForMarketplace(page);
        await requireLogin(page);

        if (!foundListing) return [];

        return page.locator('a[href*="/marketplace/item/"]').evaluateAll(
          (anchors, resultLimit) => {
            const seen = new Set<string>();
            const results: ListingSummary[] = [];

            for (const anchor of anchors) {
              if (!(anchor instanceof HTMLAnchorElement)) continue;
              const url = new URL(anchor.href);
              const match = url.pathname.match(/^\/marketplace\/item\/\d+/);
              if (!match) continue;
              const canonicalUrl = `${url.origin}${match[0]}/`;
              if (seen.has(canonicalUrl)) continue;

              const details = (anchor.innerText || anchor.getAttribute("aria-label") || "")
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean)
                .slice(0, 8);
              const isPrice = (line: string) => /(?:\$|USD\s*)[\d,.]+/i.test(line);
              const price = details.find(isPrice);
              const title = details.find((line) => !isPrice(line) && !/^listed\b/i.test(line));
              const imageAlt = anchor.querySelector("img")?.getAttribute("alt")?.trim() || undefined;

              seen.add(canonicalUrl);
              results.push({ url: canonicalUrl, title, price, details, imageAlt });
              if (results.length >= resultLimit) break;
            }
            return results;
          },
          limit,
        );
      });

      return jsonResult({
        query,
        filters: {
          locationSlug: location_slug,
          minPrice: min_price,
          maxPrice: max_price,
          radiusMiles: radius_miles,
          daysSinceListed: days_since_listed,
          conditions,
          deliveryMethod: delivery_method,
          sortBy: sort_by,
        },
        count: listings.length,
        message:
          listings.length === 0
            ? "Facebook returned no visible listings. Try broader or fewer filters."
            : undefined,
        listings,
      });
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "get_listing",
  {
    title: "Inspect Facebook Marketplace listing",
    description: "Read the public details currently visible for one Marketplace listing URL.",
    inputSchema: {
      listing_url: z.string().url().describe("HTTPS facebook.com Marketplace item URL"),
    },
    annotations: readOnlyAnnotations,
  },
  async ({ listing_url }) => {
    try {
      const safeUrl = assertMarketplaceListingUrl(listing_url);
      const listing = await withPage(async (page) => {
        await page.goto(safeUrl, { waitUntil: "domcontentloaded" });
        await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
        await requireLogin(page);

        return page.evaluate(() => {
          const meta = (property: string) =>
            document.querySelector<HTMLMetaElement>(`meta[property="${property}"]`)?.content.trim() || undefined;
          const listingRegion = document.querySelector<HTMLElement>('div[role="main"]') ?? document.body;
          const visibleText = listingRegion.innerText
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
            .slice(0, 80);

          return {
            title: meta("og:title") || document.title,
            description: meta("og:description"),
            imageUrl: meta("og:image"),
            visibleText,
          };
        });
      });

      return jsonResult({ url: safeUrl, ...listing });
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "list_marketplace_conversations",
  {
    title: "List Marketplace buying conversations",
    description:
      "List bounded summaries of Facebook Marketplace buying conversations without opening a thread.",
    inputSchema: {
      limit: z.number().int().min(1).max(30).default(15).describe("Maximum conversations to return"),
    },
    annotations: readOnlyAnnotations,
  },
  async ({ limit }) => {
    try {
      const conversations = await withPage(async (page) => {
        const main = await openBuyingInbox(page);
        return keyedBrowserRows(await getConversationRows(main))
          .slice(0, limit)
          .map(({ buttonIndex: _buttonIndex, ...summary }) => summary);
      });
      return jsonResult({ count: conversations.length, conversations });
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "get_marketplace_conversation",
  {
    title: "Read Marketplace buying conversation",
    description:
      "Open one Marketplace buying thread and return bounded structured messages. Opening it may mark the thread as read. This tool cannot send messages.",
    inputSchema: {
      conversation_key: z
        .string()
        .regex(/^[a-f0-9]{16}(?:-\d+)?$/)
        .describe("Conversation key returned by list_marketplace_conversations"),
      message_limit: z.number().int().min(1).max(50).default(30).describe("Maximum recent messages"),
    },
    annotations: marketplaceMessageAnnotations(),
  },
  async ({ conversation_key, message_limit }) => {
    try {
      const conversation = await withPage(async (page) => {
        const main = await openBuyingInbox(page);
        const rows = keyedBrowserRows(await getConversationRows(main));
        const selected = rows.find((row) => row.conversationKey === conversation_key);
        if (!selected) {
          throw new Error(
            "Conversation key was not found. Call list_marketplace_conversations again to refresh it.",
          );
        }

        await main.getByRole("button").nth(selected.buttonIndex).click();
        const log = page.locator('[role="log"]').first();
        await log.waitFor({ timeout: 15_000 });
        await page.waitForTimeout(1_000);

        const thread = await log.evaluate((root, limit) => {
          const accessibilityLines = [...root.querySelectorAll('[role="article"]')]
            .map((article) =>
              (article instanceof HTMLElement ? article.innerText : article.textContent || "")
                .split("\n")
                .map((line) => line.trim())
                .find((line) => line.startsWith("Enter, Message sent ")),
            )
            .filter((line): line is string => Boolean(line))
            .slice(-limit);

          const itemPaths = [...document.querySelectorAll('a[href*="/marketplace/item/"]')]
            .map((anchor) => (anchor instanceof HTMLAnchorElement ? new URL(anchor.href).pathname : ""))
            .filter((pathname) => /^\/marketplace\/item\/\d+\/?$/.test(pathname));
          const counts = new Map<string, number>();
          for (const pathname of itemPaths) counts.set(pathname, (counts.get(pathname) ?? 0) + 1);
          const listingPath = [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0];

          return { accessibilityLines, listingPath };
        }, message_limit);

        const messages = thread.accessibilityLines
          .map(parseMessageAccessibilityLine)
          .filter((message) => message !== undefined);
        const evidence = extractSellerEvidence(messages);
        const listingUrl = thread.listingPath
          ? new URL(thread.listingPath, marketplaceOrigin).toString()
          : undefined;

        return {
          conversationKey: selected.conversationKey,
          participant: selected.participant,
          listingTitle: selected.listingTitle,
          listingUrl,
          openingMayMarkRead: true,
          messageCount: messages.length,
          messages,
          sellerEvidence: evidence,
        };
      });
      return jsonResult(conversation);
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "send_marketplace_listing_message",
  {
    title: "Send one message about a Marketplace listing",
    description:
      "IRREVERSIBLE EXTERNAL ACTION: send exactly one user-approved message to the seller of one Marketplace listing. Never use for bulk or repeated outreach, and never retry automatically.",
    inputSchema: {
      listing_url: z.string().url().describe("HTTPS facebook.com Marketplace item URL"),
      message: z.string().trim().min(1).max(1_000).describe("Exact message text approved by the user"),
      confirm_send: z
        .literal("SEND_THIS_EXACT_MESSAGE")
        .describe("Required explicit confirmation for this exact recipient and message"),
    },
    annotations: messageSendAnnotations,
  },
  async ({ listing_url, message }) => {
    let fingerprint: string | undefined;
    try {
      const safeUrl = assertMarketplaceListingUrl(listing_url);
      fingerprint = recentSendGuard.reserve(safeUrl, message);
      const result = await withPage(async (page) => {
        await page.goto(safeUrl, { waitUntil: "domcontentloaded" });
        await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
        await requireLogin(page);

        const main = page.locator('[role="main"]');
        const composer = await firstVisible(main.locator("textarea"));
        const sendButton = await firstVisible(
          main.locator('[role="button"][aria-label^="Send message to "]'),
        );
        const recipientLabel = await sendButton.getAttribute("aria-label");
        const recipient = recipientLabel?.replace(/^Send message to\s+/, "").trim() || undefined;
        const title = await page
          .locator('meta[property="og:title"]')
          .getAttribute("content")
          .catch(() => undefined);

        await composer.fill(message);
        if ((await composer.inputValue()) !== message) {
          throw new Error("Facebook message composer did not retain the exact approved text.");
        }

        const initialArticleCount = await page.locator('[role="log"] [role="article"]').count();
        await sendButton.click();
        const confirmedInUi = await waitForSentMessage(page, message, initialArticleCount);

        return {
          sendActionPerformed: true,
          confirmedInUi,
          deliveryStatus: confirmedInUi ? "confirmed_in_facebook_ui" : "send_clicked_unconfirmed",
          recipient,
          listingTitle: title,
          listingUrl: safeUrl,
          message,
          retryAttempted: false,
        };
      });
      return jsonResult(result);
    } catch (error) {
      recentSendGuard.release(fingerprint);
      return errorResult(error);
    }
  },
);

server.registerTool(
  "send_marketplace_conversation_message",
  {
    title: "Send one Marketplace conversation message",
    description:
      "IRREVERSIBLE EXTERNAL ACTION: send exactly one user-approved follow-up in one existing Marketplace buying conversation. Never use for bulk or repeated outreach, and never retry automatically.",
    inputSchema: {
      conversation_key: z
        .string()
        .regex(/^[a-f0-9]{16}(?:-\d+)?$/)
        .describe("Conversation key returned by list_marketplace_conversations"),
      message: z.string().trim().min(1).max(1_000).describe("Exact message text approved by the user"),
      confirm_send: z
        .literal("SEND_THIS_EXACT_MESSAGE")
        .describe("Required explicit confirmation for this exact recipient and message"),
    },
    annotations: messageSendAnnotations,
  },
  async ({ conversation_key, message }) => {
    let fingerprint: string | undefined;
    try {
      fingerprint = recentSendGuard.reserve(conversation_key, message);
      const result = await withPage(async (page) => {
        const main = await openBuyingInbox(page);
        const rows = keyedBrowserRows(await getConversationRows(main));
        const selected = rows.find((row) => row.conversationKey === conversation_key);
        if (!selected) {
          throw new Error(
            "Conversation key was not found. Call list_marketplace_conversations again to refresh it.",
          );
        }

        await main.getByRole("button").nth(selected.buttonIndex).click();
        const log = page.locator('[role="log"]').first();
        await log.waitFor({ timeout: 15_000 });
        const composer = await firstVisible(page.locator('[role="textbox"][contenteditable="true"]'));
        const initialArticleCount = await log.locator('[role="article"]').count();

        await composer.fill(message);
        if ((await composer.textContent())?.trim() !== message) {
          throw new Error("Facebook message composer did not retain the exact approved text.");
        }

        await composer.press("Enter");
        const confirmedInUi = await waitForSentMessage(page, message, initialArticleCount);

        return {
          sendActionPerformed: true,
          confirmedInUi,
          deliveryStatus: confirmedInUi ? "confirmed_in_facebook_ui" : "send_submitted_unconfirmed",
          conversationKey: selected.conversationKey,
          recipient: selected.participant,
          listingTitle: selected.listingTitle,
          message,
          retryAttempted: false,
        };
      });
      return jsonResult(result);
    } catch (error) {
      recentSendGuard.release(fingerprint);
      return errorResult(error);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);

process.stdin.once("end", () => void shutdownBrowser().finally(() => process.exit(0)));
process.once("SIGINT", () => void shutdownBrowser().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdownBrowser().finally(() => process.exit(0)));
