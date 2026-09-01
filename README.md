# fb-market-scout

A local MCP server that uses Playwright and a dedicated persistent Chromium profile to inspect Facebook Marketplace listings and buying conversations. It can send one explicitly approved message to a listing seller or existing Marketplace conversation, but cannot modify listing content. Opening a conversation can cause Facebook to mark it as read.

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
- `list_marketplace_conversations`
- `get_marketplace_conversation`
- `send_marketplace_listing_message`
- `send_marketplace_conversation_message`

`search_marketplace` supports an optional Marketplace city slug; minimum and maximum prices; listing age; item condition; local pickup or shipping; newest, nearest, or price sorting; and a radius of 1, 2, 5, 10, 20, 40, 60, 80, 100, 250, or 500 miles. Without a city slug, searches use the location saved in the browser profile. Facebook treats radius filtering as a search preference and may occasionally include recommendations from outside it.

The tools do not expose cookies or profile files and do not provide actions for buying, selling, saving, or modifying listing content.

### Marketplace messages

`list_marketplace_conversations` returns bounded summaries from the Marketplace Buying inbox. It does not open individual threads.

`get_marketplace_conversation` accepts a conversation key from the list tool and returns recent rendered messages with sender attribution. It also returns seller-only evidence candidates containing availability language and likely product details such as model, serial, manufacturing, or year information. These candidates are quotations to evaluate, not guaranteed factual conclusions. Opening the conversation may mark it as read in Facebook, so this tool intentionally does not advertise MCP `readOnlyHint` even though it cannot send, react to, archive, or delete messages.

Message content returned by the MCP server becomes part of the Codex or ChatGPT conversation that invoked the tool. The server does not save a separate message archive, but you should treat model conversation history and logs as private data.

### Sending messages

`send_marketplace_listing_message` sends one message using an exact Marketplace listing URL. `send_marketplace_conversation_message` sends one follow-up using a current conversation key from the list tool.

Both are irreversible external actions. Before calling either tool, review the exact recipient, listing, and message text with the user. Each call requires `confirm_send` to equal `SEND_THIS_EXACT_MESSAGE`, is marked destructive and non-idempotent in MCP metadata, and performs exactly one send action. The server never retries automatically. If Facebook does not visibly confirm delivery, the result reports an unconfirmed send action and must not be retried until the Facebook thread is checked manually. A running MCP process also refuses the same target-and-message combination for 10 minutes after a send action.

These tools intentionally provide no bulk-recipient input and no automatic outreach workflow. Use listing and conversation-reading tools to identify missing information, draft one concise question, obtain approval for that exact text, and only then send it.

## Operational notes

- Facebook can change its Marketplace markup without notice. If searches unexpectedly return no listings, confirm the same search works in the opened Chromium window.
- Facebook may include sponsored or out-of-radius recommendations even when filters are present.
- Tool calls are serialized within one MCP process. Chromium closes after every call, allowing other Codex sessions to use the profile afterward; simultaneous calls from separate sessions can still produce a temporary profile-in-use error.
- Re-run `npm run login` if Facebook expires the saved session or requests verification.

## Safety

The MCP surface is intentionally narrow. Listing URLs are restricted to HTTPS Facebook Marketplace item paths, city slugs are validated before URL construction, and result counts and extracted text are bounded. Search, listing, login-status, and conversation-list tools advertise MCP `readOnlyHint`; conversation reading is non-destructive but does not use that hint because Facebook may mark an opened thread as read. The two send tools are explicitly destructive and non-idempotent. Never remove `data/browser-profile/` from `.gitignore` or share that directory.

## License

ISC
