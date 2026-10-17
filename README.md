# app-shrink

Clean-room micro-app compiler for bloated full-stack Node.js projects.

Point it at an Express or Next.js server. It reads your routes, your ORM schema
and your static assets, then emits **one Hono + SQLite file** that serves the
same API — no Docker, no Postgres, no Redis, and none of the original 111 MB
`node_modules` tree (the output needs three runtime packages). A built-in
differential verifier boots the original app and the shrunk service side by side
and compares their responses, so you never have to take the conversion on faith.

## Quick start

```bash
git clone <this repo> && cd app-shrink
npm install
npm run shrink:sample
```

That converts the bundled Express + Prisma app and prints the benchmark table
(probe lines trimmed below - the real run lists all 10):

```
[1/4] 🔍 Inspecting: ./examples/sample-todo-app...
      seeded shrunk database from examples/sample-todo-app/prisma/dev.db
      ↳ Detected 10 API endpoint(s) across 3 file(s)
      ↳ Found schema (2 models: User, Todo)
[2/4] 💾 Compiling Schema -> SQLite DDL... Done.
      ↳ 2 table(s), 14 column(s) written to schema.sql
[3/4] ⚡ Transpiling handlers -> Hono micro-server... Done.
      ↳ 10 handler(s) transpiled
      ↳ Packed 3 static asset(s) (1.2 KB) -> public/
[4/4] 🧪 Running differential runtime verifier...
      ↳ Boot time: 382ms (vs 691ms original)
      ↳ GET /healthz: 200 (Parity 100%)
      ↳ GET /api/todos: 200 (Parity 100%)
      ... 10 probes, all 100%

========================================================
                        RESULTS
========================================================
Original Footprint:    ~111.4 MB
Shrunk App Footprint:  ~29 KB (-100%)
Idle Memory (RSS): *   ~225.4 MB RAM (vs 224.5 MB original) (+0%)
Idle Heap (V8): *      ~12.6 MB heap (vs 11.9 MB original) (+7%)
Cold Start:            382ms (vs 691ms original)
Response Parity:       100%
Output Generated:      dist-shrunk/server.ts
Build Time:            3.3s
========================================================
      * RSS is what the OS charges the process and is dominated by the Node runtime,
        ~170 MB before any app code loads; macOS reclaims those pages unpredictably.
        V8 heap is what the app itself allocated. See "Reading the results" in README.md.
```

The "seeded shrunk database" line lands out of order because the whole pipeline
runs inside step 1's `await` - the CLI prints its own progress column afterwards,
so anything a sub-command logs arrives first.

## Install

**Use it as a command on your machine** (recommended):

```bash
npm install            # builds dist/ via the prepare script
npm link               # puts `app-shrink` and `app-shrink-mcp` on your PATH
app-shrink --help
```

**Or run it without installing:**

```bash
npm run shrink -- ./examples/sample-todo-app --verify
npm run inspect -- ./examples/sample-todo-app
```

`npm run shrink -- <target> [flags]` and `npm run inspect -- <target>` forward
everything after `--` straight to the CLI, so they behave exactly like
`app-shrink build <target>` / `app-shrink inspect <target>`.

**Or install it from a tarball / npm:**

```bash
npm pack                        # -> app-shrink-0.1.0.tgz
npm install -g ./app-shrink-0.1.0.tgz
app-shrink build /path/to/repo --out ./dist-shrunk --verify

npx app-shrink build /path/to/repo --verify   # once published to npm
```

Requires **Node >= 22.18** to run the *generated* service (`node server.ts`).
Older runtimes work if you run the output through `tsx`.

## Commands

| Command | Description |
| --- | --- |
| `app-shrink inspect <target>` | Dry run. Prints detected routes, ORM models, static mounts and the source database. **Writes nothing.** |
| `app-shrink build <target>` | Runs the full pipeline and writes the standalone service. |

| Flag | Default | Description |
| --- | --- | --- |
| `--out <dir>` | `./dist-shrunk` | Where the generated service is written. |
| `--db <sqlite\|memory>` | `sqlite` | Persist to a SQLite file, or run fully in memory. |
| `--port <number>` | `3000` | Default port baked into the generated service. |
| `--verify` | `false` | Boots both apps and diffs their live responses. |
| `--api-key <key>` | `$OPENAI_API_KEY` | Model key. Only needed if you have no local provider. |
| `--base-url <url>` | provider default | OpenAI-compatible endpoint override. |
| `--model <name>` | provider default | Model name override. |
| `--no-llm` | `false` | Never call a model; AST transpilation and job files only. |
| `--emit-jobs <dir>` | — | Write imported handlers as job files for your IDE agent. |
| `--use-jobs <dir>` | — | Read the handler files your IDE agent wrote. |

Everything from `--emit-jobs` onwards exists so the tool never *needs* a key —
see [Works with any IDE](#works-with-any-ide).

## Shrinking your own project

```bash
# 1. Dry run first - safe, read-only. Does it understand your code?
app-shrink inspect ./my-express-app

# 2. Convert it. --verify proves the result against the original.
app-shrink build ./my-express-app --out ./my-shrunk --verify

# 3. Run what it produced.
cd my-shrunk
npm install     # no-op after --verify; needed for a plain build
node server.ts
curl localhost:3000/api/todos
```

## Will it work on your app?

Routes are found either way. **Inline handlers** are transpiled by the AST
rewriter, entirely offline:

```js
// ✅ converted by the AST rewriter
router.get('/:id', (req, res) => {
  res.json({ id: Number(req.params.id) });
});
```

**Imported handlers** now resolve too — the import specifier is traced back to
the controller file, the exact function is sliced out of its AST, and that
source is rewritten into an inline Hono handler:

```js
// ✅ also converted: resolved, extracted, then rewritten
const controller = require('../controllers/items');
router.get('/', controller.list);
```

Resolution covers relative specifiers, extension-less imports, `.js` → `.ts`
stem retries, `/index.*` barrels, and `tsconfig.json` `paths` aliases. Bare
package specifiers deliberately do **not** resolve — a handler re-exported from
`node_modules` is not something app-shrink can slice.

Each imported handler is rewritten by, in order of preference: a finished
[`--use-jobs`](#works-with-any-ide) file, then a model, then the AST rewriter
over the extracted function. Only if all three fail does the route fall back to
a stub.

`build` always prints the honest coverage counter. Full coverage, with the
extra line you get when handlers came from other files:

```
↳ 11 handler(s) transpiled
↳ 10 imported handler(s) rewritten by a model or your IDE agent
```

Partial coverage, which is the signal to act on:

```
↳ 2 handler(s) transpiled, 2 stubbed
```

Stubbed routes are registered but return
`501 {"error":"Not implemented","reason":"..."}`, and `--verify` shows the
parity drop per route.

**Supported:** Express routers (`app.get/post/put/patch/delete`), Next.js App
and Pages routers, nested `app.use('/prefix', router)` mounting, imported
controller functions, Prisma schemas, SQLite databases, static asset
directories.

**Not supported:** Mongoose / TypeORM / Sequelize / Knex, Postgres / MySQL /
MongoDB, sessions, cookies, auth middleware, file uploads, background jobs.

Targets on Postgres still *build* — you get working routes and an empty SQLite
database, but no data carries over and `--verify` can't replay the original.

## Works with any IDE

Rewriting an imported controller is the one step that needs judgement, and you
are already running a model in your editor. app-shrink never requires an API key
of its own — it either finds a model, or hands the work to whatever agent is
driving it, over plain files.

### 1. It finds a provider on its own

Checked in this order, first hit wins:

| Order | Provider | Needs |
| --- | --- | --- |
| 1 | `--api-key` | an explicit key |
| 2 | `$OPENAI_API_KEY` | a key in the environment |
| 3 | `$ANTHROPIC_API_KEY` | a key in the environment |
| 4 | Ollama on `:11434` | a local daemon, no key |
| 5 | `claude -p` / `codex exec` | **only an existing login** |
| 6 | — | nothing; falls back to AST transpilation |

Rank 5 is the interesting one: if `claude` or `codex` is on your `PATH` and
logged in, the build reuses that session. The build prints which route it
picked:

```
Using claude cli (reuses your existing login) to rewrite imported handlers
Using ollama (llama3.1) to rewrite imported handlers
No model provider found and no job directory set - imported handlers fall back
  to AST transpilation (pass --emit-jobs to hand them to your IDE agent)
```

A provider that is *detected* but *unreachable* (not logged in, HTTP error) is
dropped after the first failure and the rest of the run falls back to AST
transpilation with a warning — it will not sit on ten timeouts.

### 2. Or your agent answers the handlers

`--emit-jobs` writes one job file per imported handler and, with `--no-llm`, no
model is called at all:

```bash
app-shrink build ./my-express-app --emit-jobs ./jobs --no-llm
```

```
jobs/
├── get-api-todos-id.json       # prompt + original controller source
├── get-api-todos-id.out.ts     # ← your agent writes the replacement here
└── ...                         # one pair per imported handler
```

Read the `.json`, write the sibling `.out.ts`. Nothing else is required: no
protocol, no server, no IPC. That is the whole reason this works in an IDE
app-shrink knows nothing about. Then feed the answers back:

```bash
app-shrink build ./my-express-app --use-jobs ./jobs --verify
```

`--use-jobs` takes precedence over the model, so a job you already answered is
never re-sent to a provider. Job ids are stable per `METHOD /path`, so they
survive a rebuild.

### 3. Or connect it over MCP

`app-shrink-mcp` is a dependency-free MCP stdio server exposing five tools:
`shrink_inspect`, `shrink_build`, `shrink_list_handler_jobs`,
`shrink_get_handler_job`, `shrink_write_handler`. Register it with any
MCP-capable client:

```json
{
  "mcpServers": {
    "app-shrink": { "command": "app-shrink-mcp" }
  }
}
```

After `npm link` that works as-is; without installing, point at the built file:

```json
{
  "mcpServers": {
    "app-shrink": {
      "command": "node",
      "args": ["/absolute/path/to/app-shrink/dist/bin/mcp.js"]
    }
  }
}
```

Protocol frames go to stdout, every log line to stderr, so the transport stays
clean. `shrink_build` with `emitJobs` + `shrink_write_handler` drives the same
loop as the file handoff, without the agent having to parse a filesystem.

### 4. Or install the skill

[skills/app-shrink/SKILL.md](skills/app-shrink/SKILL.md) is a plain
`SKILL.md` with YAML frontmatter — the layout the major agent CLIs already read.
Copy or symlink the directory into wherever your agent looks for skills, e.g.

```bash
ln -s "$PWD/skills/app-shrink" ~/.claude/skills/app-shrink   # Claude Code
ln -s "$PWD/skills/app-shrink" ~/.trae/skills/app-shrink     # Trae (global)
```

It is published in the npm tarball too, so after `npm i -g` it lives at
`$(npm root -g)/app-shrink/skills/app-shrink`. The skill is instructions only —
it tells the agent to inspect first, build with `--verify`, and never hand-edit
generated output.

## Headline results

Measured on the bundled sample app:

| Metric | Original | Shrunk | |
| --- | --- | --- | --- |
| **Disk / dependency footprint** | 111.4 MB | **29 KB** | **-100%** |
| **Cold start** (spawn → first `200`) | 555 ms | **383 ms** | **-31%** |
| **Response parity** | — | **100%** | **10/10** differential probes |

The original figure is the whole source repo *including* its `node_modules`; the
shrunk figure is `server.ts` + `schema.sql` + `package.json` + `public/`,
measured before `--verify` installs the three runtime dependencies. Cold start
and boot timings are wall-clock on a shared machine, so they move by tens of
milliseconds between runs - the shrunk service measured 382-398 ms against
555-691 ms for the original.

Memory is deliberately *not* claimed as a win — it is dominated by the Node
runtime itself and is not measurable reliably on macOS. See
[Reading the results](#reading-the-results).

## Generated output

```
dist-shrunk/
├── server.ts      # single-file Hono service (routes, query engine, bootstrap)
├── schema.sql     # SQLite DDL translated from the ORM schema
├── package.json   # only hono, @hono/node-server, better-sqlite3
└── public/        # static assets copied from the source app
```

`server.ts` embeds a small Prisma-like query engine (`findMany` / `findUnique` /
`create` / `update` / `delete` / `count` / `upsert` / `createMany` /
`updateMany` / `deleteMany`, plus `$queryRaw` and `$executeRaw`). `where`,
`orderBy` and `select` clauses are compiled into parameterized SQL, and the
driver is resolved via `createRequire`, falling back from `better-sqlite3` to
`node:sqlite` when the native module is unavailable.

The service is emitted as ESM TypeScript, so the launcher depends on the Node
version:

| Node | How to run it |
| --- | --- |
| >= 22.18 / >= 23.6 / >= 24 | `node server.ts` (native type stripping) |
| older | a TypeScript runner such as `tsx` |

## How it works

| Phase | Module | Responsibility |
| --- | --- | --- |
| 1 | `src/core/analyzer.ts` | Parses the target with Babel, resolves `app.use()` mount prefixes, extracts route handlers and their AST, detects the ORM schema, static assets and the source database. |
| 2 | `src/utils/schema-converter.ts` | Translates the Prisma schema into SQLite DDL plus runtime model metadata. |
| 3 | `src/core/transpiler.ts` | Rewrites Express `req`/`res` access into Hono `c` calls, replaces ORM calls with the embedded client, and renders `src/templates/hono-boilerplate.ts`. |
| 4 | `src/core/packer.ts` | Copies static assets into `public/` and records the mount points for static serving. |

Three modules support the imported-handler path: `src/utils/resolver.ts` turns
an import specifier into a file on disk, `src/utils/ast-extractor.ts` slices one
exported function out of that file, and `src/core/llm-transpiler.ts` builds the
prompt, talks to the provider chain, and reads and writes the job files.

`src/core/verifier.ts` then drives the optional differential verification pass.

## Verification

The verifier never trusts the transpiler. For every discovered route it sends
the same request to both apps and compares status codes and JSON shapes,
ignoring inherently volatile keys (`createdAt`, `updatedAt`, `deletedAt`,
`timestamp`). It also measures cold start (spawn to first `200`), idle memory,
and on-disk footprint.

Two details make the run non-destructive and repeatable:

- Ports are claimed by probing with `net.createServer().listen(0)` instead of
  hardcoding them, so a busy port cannot cause `EADDRINUSE`.
- Because `POST` / `PUT` / `DELETE` probes mutate the source database, it is
  snapshotted (including `-wal` / `-shm` sidecars) up front and restored
  afterwards. Spawned servers are always torn down with `SIGTERM`, escalating to
  `SIGKILL`, on both the success and failure paths.

### Reading the results

Two memory figures are reported, and they answer different questions.

- **Idle Memory (RSS)** is `process.memoryUsage().rss`, read inside the process
  that owns the listening socket. It is what the OS charges the process, but it
  is dominated by Node's own runtime baseline — a bare `node -e ""` already
  reports ~170 MB on macOS — and macOS reclaims and compresses those pages
  unpredictably, so the same binary can read anywhere from ~110 MB to ~230 MB
  between runs. Small RSS gaps are noise, in either direction.
- **Idle Heap (V8)** is `process.memoryUsage().heapUsed`, read after a forced
  collection so it reflects retained memory instead of whatever garbage happened
  to be uncollected. This is what the application itself allocated.

Attribution matters as much as the metric. When the original app is booted
through a TypeScript toolchain, several processes answer (`npx` → `tsx` → app),
so memory is charged to the process listening on the app's port, resolved via
`lsof`; ranking by heap would instead pick the toolchain's transformer, whose
V8 heap is larger than the app's. RSS is always sampled *before* any collection,
because a forced `gc()` hands pages back to the OS and a resident reading taken
afterwards reports a fraction of steady state.

## Troubleshooting

**`ERR_MODULE_NOT_FOUND: Cannot find package 'hono'`** — the generated service
imports `hono` and `@hono/node-server`, so it needs those on its own resolution
path.

`--verify` handles this: it installs the generated service's three dependencies
into `--out` the first time, because otherwise the service cannot boot and there
would be nothing to verify. A build *without* `--verify` writes `package.json`
but does not install it:

```bash
cd dist-shrunk && npm install
```

Building into a directory *inside* the app-shrink checkout hides this, because
Node then resolves `hono` from the CLI's own `node_modules`. Build outside the
repo to see the real behaviour.

**Routes return `501 {"error":"Not implemented"}`** — the handler is imported
and all three rewrite strategies failed: no finished job in `--use-jobs`, no
reachable provider, and the extracted function could not be transpiled by AST.
The build logs a `Warning:` line per route naming the reason. Check that the
import resolves (bare package specifiers deliberately do not — see
[Will it work on your app?](#will-it-work-on-your-app)), then supply a provider
or answer the job yourself with `--emit-jobs`.

**`Unknown file extension ".ts"` when running `server.ts`** — your Node predates
native type stripping. Use `npx tsx server.ts`, or upgrade to Node >= 22.18.

**Verification reports "the source app did not become healthy"** — the original
app has to boot for `--verify` to work. If it needs Postgres, Redis or other
services, start them first or build without `--verify`.

**Memory reads `n/a`** — instrumentation needs Node >= 18.18 (`--import`) and
`lsof` for process attribution.

## Sample apps

`examples/sample-todo-app` is a deliberately conventional Express + Prisma
project: `routes/todos.ts`, `routes/users.ts`, a `prisma/schema.prisma` with
`User` and `Todo` models, and a static frontend in `public/`. Every handler is
inline, so it converts with the AST rewriter alone. The datasource uses
`provider = "sqlite", url = "file:./dev.db"`, so it runs and verifies without any
external database daemon.

```bash
npm run setup:sample     # install deps, push the schema, seed rows
npm run inspect:sample   # dry run: routes, models, static mounts
npm run shrink:sample    # full pipeline + differential verification
```

`examples/sample-controller-app` is the cross-file counterpart: 11 routes split
across `routes/todos.ts`, `routes/users.ts` and `server.ts`, with the handlers
living in `controllers/todos.ts` and `controllers/users.ts`. It mixes named
imports (`import { listTodos }`) with namespace access
(`todoController.countTodos`), which is what exercises the resolver, the
extractor and the model/agent fallback:

```bash
tsx bin/cli.ts build ./examples/sample-controller-app --out ./dist-shrunk-ctrl --verify
```

## Development

```bash
npm run dev        # run the CLI from TypeScript sources via tsx
npm run mcp        # run the MCP stdio server from source
npm run typecheck  # tsc --noEmit
npm test           # vitest run: resolver, ast-extractor, analyzer, transpiler
```
