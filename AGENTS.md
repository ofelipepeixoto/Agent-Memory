# agentmemory — Agent Instructions

## Architecture

agentmemory is a persistent memory system for AI coding agents, built on iii-engine's three primitives (Worker/Function/Trigger). Everything goes through `registerFunction`/`registerTrigger`/`sdk.trigger()` — never bypass iii-engine with standalone SQLite or in-process alternatives.

- **Engine**: iii-sdk (WebSocket to iii-engine on port 49134)
- **State**: File-based SQLite via iii-engine's StateModule (`./data/state_store.db`)
- **Build**: TypeScript → ESM via tsdown, output to `dist/`
- **Test**: vitest (`npm test` excludes integration tests)

## Consistency Rules

**When adding or removing MCP tools, you MUST update ALL of the following:**
1. `src/mcp/tools-registry.ts` — tool definition + `getAllTools()` array
2. `src/mcp/server.ts` — handler case in the `mcp::tools::call` switch
3. `src/triggers/api.ts` — REST endpoint registration
4. `src/index.ts` — function registration + endpoint count in the log line
5. `test/mcp-standalone.test.ts` — tool count assertion
6. `README.md` — tool counts (search for "MCP tools")
7. `plugin/.claude-plugin/plugin.json` — tool count in description

**When adding REST endpoints, you MUST update:**
1. `src/triggers/api.ts` — endpoint registration
2. `src/index.ts` — endpoint count in the log line
3. `README.md` — endpoint count (search for "REST endpoints" and "endpoints on port")

**When bumping version, you MUST update ALL of the following:**
1. `package.json` — version field
2. `src/version.ts` — VERSION constant and type union
3. `src/types.ts` — ExportData version union
4. `src/functions/export-import.ts` — supportedVersions set
5. `test/export-import.test.ts` — version assertion
6. `plugin/.claude-plugin/plugin.json` — version field

**When adding new KV scopes:**
1. `src/state/schema.ts` — add to the KV object
2. `src/types.ts` — add the corresponding interface

**When adding new audit operations:**
1. `src/types.ts` — add to AuditEntry.operation union type

## Code Patterns

### Function Registration
```typescript
sdk.registerFunction(
  "mem::your-function",
  async (data: { ... }) => {
    // validate inputs
    // do work via kv.get/kv.set/kv.list
    // record audit via recordAudit()
    return { success: true, ... };
  },
);
```

### REST Endpoint Registration
```typescript
sdk.registerFunction("api::your-endpoint", async (req: ApiRequest) => {
  const denied = checkAuth(req, secret);
  if (denied) return denied;
  const body = req.body as Record<string, unknown>;
  // validate + whitelist fields (never pass raw body to sdk.trigger)
  const result = await sdk.trigger({
    function_id: "mem::your-function",
    payload: { ... },
  });
  return { status_code: 200, body: result };
});
sdk.registerTrigger({
  type: "http",
  function_id: "api::your-endpoint",
  config: { api_path: "/agentmemory/your-path", http_method: "POST" },
});
```

### MCP Tool Handler
```typescript
case "memory_your_tool": {
  // validate args with typeof checks
  // parse CSV args: args.field.split(",").map(t => t.trim()).filter(Boolean)
  const result = await sdk.trigger({
    function_id: "mem::your-function",
    payload: { ... },
  });
  return { status_code: 200, body: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] } };
}
```

### Hook Scripts
Hook scripts in `src/hooks/` are standalone Node.js scripts (no iii-sdk import). They read JSON from stdin, make HTTP calls to the REST API, and exit. Always use `try/catch` with `AbortSignal.timeout()` for best-effort calls.

## Coding Standards

- TypeScript, ESM only (`"type": "module"`)
- No code comments explaining WHAT — use clear naming instead
- Use `fingerprintId()` for content-addressable dedup, `generateId()` for unique IDs
- Parallel operations where possible (`Promise.all` for independent kv writes/reads)
- Input validation at system boundaries (MCP handlers, REST endpoints)
- REST endpoints must whitelist fields — never pass raw request body to `sdk.trigger()`
- Use `recordAudit()` for state-changing operations
- Timestamps: capture once with `new Date().toISOString()` and reuse

## Testing

- All tests must pass before PR: `npm test` (950+ tests)
- Mock pattern: `vi.mock("iii-sdk")` with mock `sdk.trigger`, `kv.get/set/list`
- Test files go in `test/` with `.test.ts` extension
- Follow existing patterns in `test/crystallize.test.ts` for function tests

## Current Stats (v0.9.16)

- 53 MCP tools (8 visible by default, `AGENTMEMORY_TOOLS=all` for all)
- 124 REST endpoints
- 6 MCP resources, 3 MCP prompts
- 12 hooks, 4 skills
- 50+ iii functions
- 950+ tests

## Cursor Cloud specific instructions

The update script runs `npm install --legacy-peer-deps` on startup. Everything below is context the script does NOT handle.

- **Always install with `--legacy-peer-deps`.** No lockfile is committed (`package-lock.json` is gitignored), so a plain `npm install` fails with `ERESOLVE`: `@anthropic-ai/claude-agent-sdk` peer-requires `@anthropic-ai/sdk >=0.93.0` while the repo pins `^0.39.0`. CI works around this the same way (see `.github/workflows/ci.yml`).
- **`iii-engine` is a native binary, not an npm package.** It is pinned to `v0.11.2` (do not bump — v0.11.6+ uses an incompatible worker model). `iii-sdk` on npm is only the client. The engine binary is not part of the update script; `npm start` auto-installs it to `~/.local/bin/iii` on first run in a non-interactive shell. To pre-install manually: `curl -fsSL "https://github.com/iii-hq/iii/releases/download/iii/v0.11.2/iii-x86_64-unknown-linux-gnu.tar.gz" | tar -xz -C ~/.local/bin && chmod +x ~/.local/bin/iii`.
- **Run the full stack (engine + worker + viewer):** `npm start` (i.e. `node dist/cli.mjs`) after `npm run build`. Ensure `~/.local/bin` is on `PATH` and run non-interactively (set `CI=1`) so the CLI skips the global-install / console-install prompts. REST API is on `:3111`; the viewer is on REST port + 2 (usually `:3113`, but it shifts to `:3114` when `:3113` is taken). Query `GET /agentmemory/livez` to read the actual `viewerPort`. Stop with `node dist/cli.mjs stop`.
- **Hot-reload worker dev:** `npm run dev` (`tsx src/index.ts`) requires an engine already running on `ws://localhost:49134` — it does not start one.
- **"Lint" = the TypeScript build.** There is no ESLint; `npm run build` (tsdown) is the type/compile gate.
- **Tests:** `npm test` runs the full vitest suite (excludes `test/integration.test.ts`). `npm run test:integration` needs a live server on `:3111`.
- **No API keys needed to boot.** With no LLM/embedding provider configured it degrades to BM25-only search, so purely semantic queries (no keyword overlap) can return 0 hits. Install the optional `@xenova/transformers` for free local embeddings if you need the vector leg.
- **State** persists under `./data/` (gitignored); safe to delete for a clean slate.
