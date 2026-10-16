---
name: app-shrink
description: Shrink a Node.js, Express, or Next.js app into one Hono plus SQLite file and verify it against the original. Use when asked to shrink, compact, or convert a Node API into a self-hosted service.
---

# app-shrink

Convert a bloated full-stack Node.js project into a single-file Hono + SQLite
service, then prove the conversion with a differential verifier. Work in this
order — never skip step 1 or step 3.

## 1. Inspect before building

```bash
app-shrink inspect <target>
```

Read-only. Reports detected routes, ORM models, static mounts and the source
database. Use it to decide whether the target is worth converting and to see how
many routes exist before you judge the output.

## 2. Build

```bash
app-shrink build <target> --out ./dist-shrunk --verify
```

Always pass `--verify` unless the original app needs external services
(Postgres, Redis) that are not running — verification boots both apps and diffs
every route, so it is the only trustworthy signal. Watch three numbers:

- `N handler(s) transpiled` / `N stubbed` — stubs return
  `501 {"error":"Not implemented"}` and are the failure mode to eliminate.
- `Response Parity` — below 100% means at least one route disagrees.
- `Idle Memory (RSS)` vs `Idle Heap (V8)` — RSS is dominated by the Node runtime
  (~170 MB before app code loads on macOS) and is not a win to claim. Quote heap
  when reporting memory.

Report the raw numbers. Do not round a 92% parity up or describe a build with
stubs as working.

## Imported controllers

Handlers that live in another file (`router.get('/', controller.list)`,
`import { getTodos } from '../controllers/todos'`) are resolved across files and
rewritten into inline handlers. Resolution order, per route:

1. A finished job in `--use-jobs` (an agent or model already answered it).
2. A model rewrite — provider chosen automatically, see below.
3. AST transpilation of the extracted controller node.
4. `501 Not implemented` — only when both 1–3 failed.

Provider order is credential-free first: `--api-key` → `OPENAI_API_KEY` →
`ANTHROPIC_API_KEY` → local Ollama on `:11434` →
`claude -p` / `codex exec` reusing an existing login → none. With no provider
available, the build still succeeds using AST transpilation; check parity before
trusting it.

## Answering handlers yourself (works in any IDE)

If you are the agent and you want higher-fidelity handlers than AST
transpilation produces, do the rewrites yourself instead of relying on a model:

```bash
app-shrink build <target> --emit-jobs ./jobs --no-llm
```

That writes one `<job-id>.json` per imported handler. For each job, read it and
write the replacement to the sibling `<job-id>.out.ts`:

- The file must contain **only** a bare `async (c) => { ... }` expression.
- No markdown fences, no `import` / `export`, no prose, no variable assignment.
- Use only what the job's `prompt` describes: `c.req.param/query/json`,
  `c.json(value, status)`, the synchronous Prisma-shaped `db` client, `sqlite`.
- Preserve the original status codes, JSON key names and key order exactly.

Then re-run with the answers:

```bash
app-shrink build <target> --use-jobs ./jobs --verify
```

The build reports `N imported handler(s) rewritten by a model or your IDE agent`
and should report `0 stubbed`.

## MCP server

`app-shrink-mcp` speaks MCP over stdio for the same workflow without shelling
out. Register it as a stdio server and prefer it when available:

| Tool | Purpose |
| --- | --- |
| `shrink_inspect` | Routes, models and static assets for a target. |
| `shrink_build` | Full pipeline; accepts `emitJobs` / `useJobs` / `verify`. |
| `shrink_list_handler_jobs` | Which jobs are open and which are answered. |
| `shrink_get_handler_job` | The prompt and original controller source for one job. |
| `shrink_write_handler` | Write the rewritten handler for one job. |

The job `id` is stable per `METHOD /path`, so it survives re-runs.

## Rules

- Never hand-edit the generated `dist-shrunk/server.ts`; it is overwritten on
  every build. Fix the input controller or the job answer and rebuild.
- Do not claim a win from RSS. Use `Idle Heap (V8)` and `Cold Start`.
- A build is not done until `--verify` reports parity and the stub count is 0.
- Unsupported and out of scope: Mongoose / TypeORM / Sequelize / Knex,
  Postgres / MySQL / MongoDB data migration, sessions, cookies, auth middleware,
  file uploads, background jobs. Say so instead of inventing a workaround.
- The generated service needs Node >= 22.18 for `node server.ts`, or any
  TypeScript runner (`tsx`) on older runtimes.
