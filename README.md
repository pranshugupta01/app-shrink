# app-shrink

Clean-room micro-app compiler for bloated full-stack Node.js projects.

Point it at an Express or Next.js server. It reads your routes, your
ORM schema and your static assets, then emits a single Hono + SQLite
file that serves the same API - no Docker, no Postgres, no Redis, and
none of the original `node_modules` tree.

A built-in differential verifier boots the original app and the shrunk
service side by side and compares their responses, so you never have
to take the conversion on faith.

## Quick start

```bash
git clone <this repo> && cd app-shrink
npm install
npm run shrink:sample
```

## Install

```bash
npm install            # builds dist/ via the prepare script
npm link               # puts `app-shrink` on your PATH
app-shrink --help
```

## Commands

| Command | Description |
| --- | --- |
| `app-shrink inspect <target>` | Dry run. Prints detected routes, ORM models, static mounts and the source database. |
| `app-shrink build <target>` | Runs the full pipeline and writes the standalone service. |

| Flag | Default | Description |
| --- | --- | --- |
| `--out <dir>` | `./dist-shrunk` | Where the generated service is written. |
| `--db <sqlite|memory>` | `sqlite` | Persist to a SQLite file, or run fully in memory. |
| `--port <number>` | `3000` | Default port baked into the generated service. |
| `--verify` | `false` | Boots both apps and diffs their live responses. |

## Will it work on your app?

The rule that decides everything: the route handler must be an
inline function, in the same file as the route. Anything else
becomes an HTTP 501 stub.
