import assert from "node:assert/strict";
import test from "node:test";
import {
  assertMarketplaceListingUrl,
  buildMarketplaceSearchUrl,
} from "../dist/marketplace.js";

test("buildMarketplaceSearchUrl encodes supported filters", () => {
  const url = buildMarketplaceSearchUrl({
    query: "desk & chair",
    locationSlug: "denver",
    minPrice: 10,
    maxPrice: 100,
    radiusMiles: 20,
    daysSinceListed: 7,
    conditions: ["new", "used_like_new"],
    deliveryMethod: "local_pick_up",
    sortBy: "price_ascend",
  });

  assert.equal(url.origin, "https://www.facebook.com");
  assert.equal(url.pathname, "/marketplace/denver/search/");
  assert.equal(url.searchParams.get("query"), "desk & chair");
  assert.equal(url.searchParams.get("minPrice"), "10");
  assert.equal(url.searchParams.get("maxPrice"), "100");
  assert.equal(url.searchParams.get("radius"), "20");
  assert.equal(url.searchParams.get("daysSinceListed"), "7");
  assert.equal(url.searchParams.get("itemCondition"), "new,used_like_new");
  assert.equal(url.searchParams.get("deliveryMethod"), "local_pick_up");
  assert.equal(url.searchParams.get("sortBy"), "price_ascend");
});

test("assertMarketplaceListingUrl canonicalizes a Marketplace item URL", () => {
  assert.equal(
    assertMarketplaceListingUrl(
      "https://www.facebook.com/marketplace/item/123456?tracking=value#details",
    ),
    "https://www.facebook.com/marketplace/item/123456/",
  );
});

test("assertMarketplaceListingUrl rejects unsafe or unrelated URLs", () => {
  const rejected = [
    "http://www.facebook.com/marketplace/item/123456/",
    "https://example.com/marketplace/item/123456/",
    "https://facebook.com/marketplace/search/",
    "https://facebook.com/marketplace/item/not-a-number/",
    "https://facebook.com/marketplace/item/123456/messages",
  ];

  for (const url of rejected) {
    assert.throws(() => assertMarketplaceListingUrl(url));
  }
});

test("buildMarketplaceSearchUrl rejects location path injection", () => {
  assert.throws(() =>
    buildMarketplaceSearchUrl({ query: "desk", locationSlug: "../messages" }),
  );
  assert.throws(() =>
    buildMarketplaceSearchUrl({ query: "desk", locationSlug: "Denver?redirect=1" }),
  );
});
