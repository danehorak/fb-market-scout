# fb-market-scout

A local, read-only MCP server that uses Playwright and a dedicated persistent Chromium profile to inspect Facebook Marketplace listings.

## Requirements

- Node.js 20 or newer
- Chromium installed through Playwright

With NVM, run `nvm use` in the project directory to select the version pinned in `.nvmrc`.

## Authenticate

```sh
npm install
npx playwright install chromium
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

## Operational notes

- Facebook can change its Marketplace markup without notice. If searches unexpectedly return no listings, confirm the same search works in the opened Chromium window.
- Facebook may include sponsored or out-of-radius recommendations even when filters are present.
- Tool calls are serialized within one MCP process. Chromium closes after every call, allowing other Codex sessions to use the profile afterward; simultaneous calls from separate sessions can still produce a temporary profile-in-use error.
- Re-run `npm run login` if Facebook expires the saved session or requests verification.

## Safety

The MCP surface is intentionally narrow and read-only. Listing URLs are restricted to HTTPS Facebook Marketplace item paths, city slugs are validated before URL construction, result counts and extracted text are bounded, and all tools advertise MCP `readOnlyHint`. Never remove `data/browser-profile/` from `.gitignore` or share that directory.

## License

ISC
