# fb-market-scout

A local, read-only MCP server that uses Playwright and a dedicated persistent Chromium profile to inspect Facebook Marketplace listings.

## Requirements

- Node.js 20 or newer
- Chromium installed through Playwright

## Authenticate

```sh
npm install
npm run login
```

Log into Facebook in the Chromium window, confirm Marketplace loads, and then close the window. The session is stored under `data/browser-profile`, which is ignored by Git and must never be shared.

Only one process can use the profile at a time. Close the login browser before starting the MCP server.

## Run locally

```sh
npm run typecheck
npm run build
npm run mcp
```

The server uses stdio, so a successful direct run waits silently for an MCP client.

## Add to Codex

Run this from a shell where `node --version` reports 20 or newer:

```sh
codex mcp add fb-market-scout -- /Users/dane/.nvm/versions/node/v20.20.2/bin/node /Users/dane/Code/Facebook-Marketplace-MCP/dist/server.js
```

Then start a new Codex session and ask it to call `get_login_status`. The server exposes these read-only tools:

- `get_login_status`
- `search_marketplace`
- `get_listing`

The tools do not expose cookies or profile files and do not provide actions for messaging, buying, selling, saving, or modifying Facebook data.
