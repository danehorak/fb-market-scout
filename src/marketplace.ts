export const marketplaceOrigin = "https://www.facebook.com";

export type MarketplaceSearchFilters = {
  query: string;
  locationSlug?: string;
  minPrice?: number;
  maxPrice?: number;
  radiusMiles?: number;
  daysSinceListed?: 1 | 7 | 30;
  conditions?: Array<"new" | "used_like_new" | "used_good" | "used_fair">;
  deliveryMethod?: "local_pick_up" | "shipping";
  sortBy?: "creation_time_descend" | "distance_ascend" | "price_ascend" | "price_descend";
};

export function buildMarketplaceSearchUrl(filters: MarketplaceSearchFilters): URL {
  if (filters.locationSlug && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(filters.locationSlug)) {
    throw new Error("location_slug must be a lowercase Facebook Marketplace city slug.");
  }
  const searchPath = filters.locationSlug
    ? `/marketplace/${filters.locationSlug}/search/`
    : "/marketplace/search/";
  const url = new URL(searchPath, marketplaceOrigin);
  url.searchParams.set("query", filters.query);
  if (filters.minPrice !== undefined) url.searchParams.set("minPrice", String(filters.minPrice));
  if (filters.maxPrice !== undefined) url.searchParams.set("maxPrice", String(filters.maxPrice));
  if (filters.radiusMiles !== undefined) url.searchParams.set("radius", String(filters.radiusMiles));
  if (filters.daysSinceListed !== undefined) {
    url.searchParams.set("daysSinceListed", String(filters.daysSinceListed));
  }
  if (filters.conditions?.length) url.searchParams.set("itemCondition", filters.conditions.join(","));
  if (filters.deliveryMethod) url.searchParams.set("deliveryMethod", filters.deliveryMethod);
  if (filters.sortBy) url.searchParams.set("sortBy", filters.sortBy);
  return url;
}

export function assertMarketplaceListingUrl(value: string): string {
  const url = new URL(value);
  const allowedHost = url.hostname === "facebook.com" || url.hostname.endsWith(".facebook.com");
  if (url.protocol !== "https:" || !allowedHost || !/^\/marketplace\/item\/\d+\/?$/.test(url.pathname)) {
    throw new Error("listing_url must be an HTTPS facebook.com Marketplace item URL.");
  }
  url.search = "";
  url.hash = "";
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.toString();
}
