import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { chromium, type BrowserContext, type Page } from "playwright";
import { z } from "zod";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const profilePath = path.join(projectRoot, "data", "browser-profile");
const marketplaceOrigin = "https://www.facebook.com";

let contextPromise: Promise<BrowserContext> | undefined;
let operationQueue = Promise.resolve();

type ListingSummary = {
  url: string;
  title?: string;
  price?: string;
  details: string[];
  imageAlt?: string;
};

function getContext(): Promise<BrowserContext> {
  contextPromise ??= chromium
    .launchPersistentContext(profilePath, {
      headless: false,
      viewport: { width: 1440, height: 900 },
    })
    .catch((error: unknown) => {
      contextPromise = undefined;
      throw error;
    });
  return contextPromise;
}

async function withPage<T>(operation: (page: Page) => Promise<T>): Promise<T> {
  const run = operationQueue.then(async () => {
    const context = await getContext();
    const page = context.pages()[0] ?? (await context.newPage());
    return operation(page);
  });
  operationQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function jsonResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

function assertMarketplaceListingUrl(value: string): string {
  const url = new URL(value);
  const allowedHost = url.hostname === "facebook.com" || url.hostname.endsWith(".facebook.com");
  if (url.protocol !== "https:" || !allowedHost || !url.pathname.startsWith("/marketplace/item/")) {
    throw new Error("listing_url must be an HTTPS facebook.com Marketplace item URL.");
  }
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function waitForMarketplace(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded");
  await page.locator('a[href*="/marketplace/item/"]').first().waitFor({
    state: "attached",
    timeout: 20_000,
  }).catch(() => undefined);
  await page.waitForTimeout(500);
}

const server = new McpServer({
  name: "fb-market-scout",
  version: "0.1.0",
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
          const loginFormVisible = await page
            .locator('input[name="email"], form[action*="login"]')
            .first()
            .isVisible()
            .catch(() => false);
          const authenticated = !loginFormVisible && !page.url().includes("/login");
          return {
            authenticated,
            marketplaceUrl: page.url().startsWith(`${marketplaceOrigin}/marketplace`),
            message: authenticated
              ? "The local browser profile appears to be authenticated."
              : "Facebook is requesting login in the local browser profile. Run npm run login.",
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
      min_price: z.number().nonnegative().optional().describe("Optional minimum price"),
      max_price: z.number().nonnegative().optional().describe("Optional maximum price"),
      limit: z.number().int().min(1).max(20).default(10).describe("Maximum listings to return"),
    },
    annotations: readOnlyAnnotations,
  },
  async ({ query, min_price, max_price, limit }) => {
    try {
      if (min_price !== undefined && max_price !== undefined && min_price > max_price) {
        throw new Error("min_price cannot be greater than max_price.");
      }

      const searchUrl = new URL("/marketplace/search/", marketplaceOrigin);
      searchUrl.searchParams.set("query", query);
      if (min_price !== undefined) searchUrl.searchParams.set("minPrice", String(min_price));
      if (max_price !== undefined) searchUrl.searchParams.set("maxPrice", String(max_price));

      const listings = await withPage(async (page) => {
        await page.goto(searchUrl.toString(), { waitUntil: "domcontentloaded" });
        await waitForMarketplace(page);

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

      return jsonResult({ query, count: listings.length, listings });
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

async function shutdown(): Promise<void> {
  const context = await contextPromise?.catch(() => undefined);
  await context?.close().catch(() => undefined);
}

process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));

const transport = new StdioServerTransport();
await server.connect(transport);
