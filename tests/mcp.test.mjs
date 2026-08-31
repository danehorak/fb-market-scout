import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function withClient(operation) {
  const client = new Client({ name: "fb-market-scout-test", version: "1.0.0" });
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [path.join(projectRoot, "dist", "server.js")],
      }),
    );
    return await operation(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

test("MCP server exposes only the expected read-only tools", async () => {
  await withClient(async (client) => {
    const { tools } = await client.listTools();

    assert.deepEqual(
      tools.map(({ name }) => name).sort(),
      ["get_listing", "get_login_status", "search_marketplace"],
    );
    for (const tool of tools) {
      assert.equal(tool.annotations?.readOnlyHint, true);
      assert.equal(tool.annotations?.destructiveHint, false);
    }

    const search = tools.find(({ name }) => name === "search_marketplace");
    assert.ok(search?.inputSchema.properties?.radius_miles);
    assert.ok(search?.inputSchema.properties?.location_slug);
    assert.ok(search?.inputSchema.properties?.sort_by);
  });
});

test("get_listing rejects an unsafe URL without opening Chromium", async () => {
  await withClient(async (client) => {
    const result = await client.callTool({
      name: "get_listing",
      arguments: { listing_url: "https://example.com/marketplace/item/123/" },
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? "", /facebook\.com Marketplace item URL/);
  });
});
