---
name: shrink-skill
description: Orchestrate app-shrink to convert an Express or Next.js backend into a single-file Hono + SQLite service. Use when the user asks to shrink, compact, or convert a Node API and the AST-driven CLI is available.
---

# shrink-skill

An orchestrator over the existing `app-shrink` CLI. You never write
the shrunk service by hand — you drive the CLI and let its
verifier tell you when parity is 100%. The CLI's resolver, AST
extractor, and LLM provider chain are the deterministic ground
truth; your job is to fill the job files and read the verifier.

## The loop

Run these steps in order. Stop only when the verifier reports 100% parity.

### 1. Inspect

```bash
app-shrink inspect <target>
```

If the analyzer cannot resolve a route, the CLI prints a
`Warning:` line. Note every route, every model, and every
warning. Do not start a build if `inspect` is empty.

### 2. Emit jobs

```bash
app-shrink build <target> --out ./dist-shrunk --emit-jobs ./jobs --no-llm
```

`--no-llm` keeps you out of the provider chain — you are the
provider. Every imported controller now has a `jobs/<id>.json`
with the route, the SQLite DDL, the original controller source,
and the full system + user prompt.

### 3. Fill the jobs

For each `<id>.json` in `./jobs`:

- read the prompt and the original source,
- write a bare `async (c) => { ... }` to `./jobs/<id>.out.ts`,
- no fences, no imports, no exports, no prose, no variable assignment,
- use only the runtime API listed in the job's `prompt` section
  (c.req.param/query/json, c.json, the synchronous Prisma-shaped
  db client, sqlite).

If the controller is trivial, copy the AST path: a one-to-one
translation of `req.x` -> `c.req.x` and `res.json(v)` -> `c.json(v)`
is almost always correct.

### 4. Build with the answers

```bash
app-shrink build <target> --out ./dist-shrunk --use-jobs ./jobs --verify
```

The build inserts your handlers in place of the imported
controllers and boots the original app and the shrunk service
side by side. It prints:

```
↳ N handler(s) transpiled
↳ M imported handler(s) rewritten by a model or your IDE agent
GET /api/...: 200 (Parity 100%)
...
Response Parity: 100%
```

### 5. Iterate only if parity < 100%

If parity is below 100%, the verifier has already told you which
route failed and what the response mismatch was. Do not ask the
user for help. Do not stop. Re-read the failing job, fix the
corresponding `out.ts`, and re-run step 4. Loop until parity
reaches 100%.

The loop is bounded in practice: most projects have a handful
of imported handlers, and the verifier diffs status codes and
JSON shapes, so the failure mode is usually a missing await,
an off-by-one in a `Number(...)` cast, or a wrong column name.
Fix the handler, do not regenerate the whole job.

## Rules

- Never hand-edit `dist-shrunk/server.ts`. It is overwritten on
  every build. Fix the input controller or the `.out.ts` answer
  and rebuild.
- Do not claim a memory win from RSS. Quote `Idle Heap (V8)` and
  `Cold Start`. RSS is dominated by the Node runtime.
- A build is not done until `--verify` reports parity and the
  stub counter is 0.
- Unsupported and out of scope: Mongoose / TypeORM / Sequelize /
  Knex, Postgres / MySQL / MongoDB data migration, sessions,
  cookies, auth middleware, file uploads, background jobs.
  Say so instead of inventing a workaround.

## Aligned files

- `skills/app-shrink/SKILL.md` — the portable, npm-shipped
  version of the same workflow.
- `bin/mcp.ts` — the MCP server exposing this loop as tools
  (`shrink_inspect`, `shrink_build`, `shrink_list_handler_jobs`,
  `shrink_get_handler_job`, `shrink_write_handler`).
- `bin/cli.ts` — the CLI the skill drives.
