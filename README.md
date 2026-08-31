# fb-market-scout

A local, read-only MCP server that uses Playwright and a dedicated persistent Chromium profile to inspect Facebook Marketplace listings.

## Requirements

- Node.js 20 or newer
- Chromium installed through Playwright

With NVM, run `nvm use` in the project directory to select the version pinned in `.nvmrc`.

## Authenticate

```sh
npm install
npm run login
```

Log into Facebook in the Chromium window, confirm Marketplace loads, and then close the window. The session is stored under `data/browser-profile`, which is ignored by Git and must never be shared.

Only one process can use the profile at a time. Close the login browser before calling an MCP tool. The server opens Chromium for each tool call and closes it afterward so an idle Codex chat does not keep the profile locked.

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
codex mcp add fb-market-scout -- "$(nvm which 20)" "$(pwd)/dist/server.js"
```

Then start a new Codex session and ask it to call `get_login_status`. The server exposes these read-only tools:

- `get_login_status`
- `search_marketplace`
- `get_listing`

`search_marketplace` supports an optional Marketplace city slug; minimum and maximum prices; listing age; item condition; local pickup or shipping; newest, nearest, or price sorting; and a radius of 1, 2, 5, 10, 20, 40, 60, 80, 100, 250, or 500 miles. Without a city slug, searches use the location saved in the browser profile. Facebook treats radius filtering as a search preference and may occasionally include recommendations from outside it.

The tools do not expose cookies or profile files and do not provide actions for messaging, buying, selling, saving, or modifying Facebook data.
