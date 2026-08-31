import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { chromium, type Page } from "playwright";
import { z } from "zod";
import {
  assertMarketplaceListingUrl,
  buildMarketplaceSearchUrl,
  marketplaceOrigin,
} from "./marketplace.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const profilePath = path.join(projectRoot, "data", "browser-profile");
const supportedRadii = [1, 2, 5, 10, 20, 40, 60, 80, 100, 250, 500] as const;

let operationQueue = Promise.resolve();

type ListingSummary = {
  url: string;
  title?: string;
  price?: string;
  details: string[];
  imageAlt?: string;
};

async function withPage<T>(operation: (page: Page) => Promise<T>): Promise<T> {
  const run = operationQueue.then(async () => {
    const context = await chromium.launchPersistentContext(profilePath, {
      headless: false,
      viewport: { width: 1440, height: 900 },
    });
    try {
      const page = context.pages()[0] ?? (await context.newPage());
      return await operation(page);
    } finally {
      await context.close().catch(() => undefined);
    }
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

const transport = new StdioServerTransport();
await server.connect(transport);
