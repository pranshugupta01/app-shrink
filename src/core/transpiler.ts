import { promises as fs } from 'node:fs';
import path from 'node:path';
import _generate from '@babel/generator';
import _traverse from '@babel/traverse';
import * as t from '@babel/types';
import { AnalysisResult, RouteDef } from './analyzer';
import { memberChain, walk } from '../utils/ast';
import { extractHandler } from '../utils/ast-extractor';
import { resolveModule } from '../utils/resolver';
import { modelsToRuntimeMetadata } from '../utils/schema-converter';
import {
  HandlerJob,
  HandlerRewriteRequest,
  LlmRoute,
  buildHandlerPrompt,
  readHandlerJobOutput,
  renderPrompt,
  rewriteHandler,
  writeHandlerJobs,
} from './llm-transpiler';
import {
  ROUTES_PLACEHOLDER,
  STATIC_PLACEHOLDER,
  StaticMount,
  renderBoilerplate,
  renderStaticMounts,
} from '../templates/hono-boilerplate';

const generate: typeof import('@babel/generator').default =
  ((_generate as any).default ?? _generate) as any;
const traverse: typeof import('@babel/traverse').default =
  ((_traverse as any).default ?? _traverse) as any;

export const DEFAULT_DB_FILE = 'app.db';

/**
 * Everything needed to turn an *imported* controller into an inline handler.
 * The host-agent handoff lives here: jobs out via `emitJobsDir`, answers back
 * in via `useJobsDir`, so the tool works with no model access of its own.
 */
export interface ImportedHandlerOptions {
  /** Project root, used to resolve tsconfig aliases. */
  rootDir: string;
  /** Chosen model route, or null when nothing is reachable. */
  llmRoute: LlmRoute | null;
  /** Directory to write unfilled handler jobs into, for a host agent. */
  emitJobsDir?: string;
  /** Directory holding the host agent's filled-in handler jobs. */
  useJobsDir?: string;
}

export interface TranspileOptions {
  analysis: AnalysisResult;
  outDir: string;
  port: number;
  version: string;
  /** Static frontends copied by the packer, already normalised to `dist-shrunk/public`. */
  staticMounts: StaticMount[];
  hasPublic: boolean;
  /** Omit to keep the old inline-only behaviour. */
  imported?: ImportedHandlerOptions;
}

export interface TranspileResult {
  serverFile: string;
  schemaFile: string;
  packageFile: string;
  routeCount: number;
  warnings: string[];
  transpiledRoutes: number;
  stubbedRoutes: number;
  /** Routes rewritten by a model or a host agent rather than by the AST. */
  llmRoutes: number;
  /** Job files written for a host agent to complete. */
  jobFiles: string[];
}

interface ResponseMatch {
  kind: 'json' | 'text';
  body: t.Node | null;
  status: t.Node | null;
}

function isResResolved(node: t.Node | null | undefined): boolean {
  return !!node && node.type === 'CallExpression' && memberChain(node.callee as t.Node) === 'res.status';
}

function matchResponse(node: t.Node | null | undefined): ResponseMatch | null {
  if (!node || node.type !== 'CallExpression') return null;
  const callee = node.callee;
  if (callee.type !== 'MemberExpression' && callee.type !== 'OptionalMemberExpression') return null;
  const property = callee.property.type === 'Identifier' ? callee.property.name : null;
  if (!property) return null;

  const receiverChain = memberChain(callee.object as t.Node);
  const receiverIsStatusCall = isResResolved(callee.object as t.Node);

  if (receiverChain !== 'res' && !receiverIsStatusCall) {
    const nextChain = memberChain(node.callee as t.Node);
    if (nextChain === 'NextResponse.json' || nextChain === 'Response.json') {
      const init = node.arguments[1];
      let status: t.Node | null = null;
      if (init && init.type === 'ObjectExpression') {
        const property2 = init.properties.find(
          (entry) =>
            entry.type === 'ObjectProperty' &&
            ((entry.key.type === 'Identifier' && entry.key.name === 'status') ||
              (entry.key.type === 'StringLiteral' && entry.key.value === 'status')),
        );
        if (property2 && property2.type === 'ObjectProperty') status = property2.value as t.Node;
      }
      return { kind: 'json', body: (node.arguments[0] as t.Node) ?? null, status };
    }
    return null;
  }

  const status = receiverIsStatusCall
    ? ((((callee.object as any).arguments ?? [])[0] as t.Node) ?? null)
    : null;

  switch (property) {
    case 'json':
      return { kind: 'json', body: (node.arguments[0] as t.Node) ?? null, status };
    case 'send':
      return { kind: 'text', body: (node.arguments[0] as t.Node) ?? null, status };
    case 'end':
      return { kind: 'text', body: null, status };
    case 'sendStatus':
      return { kind: 'text', body: null, status: (node.arguments[0] as t.Node) ?? null };
    default:
      return null;
  }
}

function buildResponseExpression(match: ResponseMatch): t.Expression {
  const ctx = t.identifier('c');
  const member = (name: string) => t.memberExpression(ctx, t.identifier(name));

  const args: t.Expression[] = [((match.body ?? t.nullLiteral()) as t.Expression)];
  if (match.status) args.push(match.status as t.Expression);

  return match.kind === 'json'
    ? t.callExpression(member('json'), args)
    : t.callExpression(member('body'), args);
}

/** Rewrites `req.X` / `request.X` / `prisma.X` access into Hono context access. */
function applyRequestTransforms(
  arrow: t.ArrowFunctionExpression,
  framework: RouteDef['framework'],
): t.ArrowFunctionExpression {
  const isNext = framework === 'next-app' || framework === 'next-pages';
  const requestNames = isNext ? ['request'] : ['req'];

  const ctxMember = (...names: string[]) =>
    names.reduce<t.Expression>((acc, name) => t.memberExpression(acc, t.identifier(name)), t.identifier('c'));

  // Babel refuses to traverse a bare expression, so host it in a File and read
  // the (possibly replaced) node back out afterwards.
  const file = t.file(t.program([t.expressionStatement(arrow)]));

  traverse(file as any, {
    ExpressionStatement(path: any) {
      const match = matchResponse(path.node.expression as t.Node);
      if (!match) return;
      // The replacement must still be traversed: the response body can contain
      // `req.params.x` / `req.query.x` / `prisma.*` reads, and skipping the new
      // node would emit those verbatim into the generated service.
      path.replaceWith(t.returnStatement(buildResponseExpression(match)));
    },
    ReturnStatement(path: any) {
      const match = matchResponse(path.node.argument as t.Node);
      if (!match) return;
      path.node.argument = buildResponseExpression(match);
    },
    CallExpression(path: any) {
      const chain = memberChain(path.node.callee as t.Node);
      if (!chain) return;

      // Next.js `await request.json()`
      if (chain === 'request.json' || chain === 'req.json') {
        path.replaceWith(t.awaitExpression(t.callExpression(ctxMember('req', 'json'), [])));
        path.skip();
        return;
      }

      // Next.js `request.nextUrl.searchParams.get('x')`
      if (chain === 'request.nextUrl.searchParams.get' || chain === 'req.nextUrl.searchParams.get') {
        const key = path.node.arguments[0] as t.Node;
        path.replaceWith(
          key ? t.callExpression(ctxMember('req', 'query'), [key as t.Expression]) : t.nullLiteral(),
        );
        path.skip();
        return;
      }

      // Express `req.header('x')` / `req.get('x')`
      if (chain === 'req.header' || chain === 'req.get') {
        const key = path.node.arguments[0] as t.Node;
        if (key) {
          path.replaceWith(t.callExpression(ctxMember('req', 'header'), [key as t.Expression]));
          path.skip();
        }
        return;
      }

      // Express `res.redirect(url)`
      if (chain === 'res.redirect') {
        const target = path.node.arguments[0] as t.Node;
        if (target) {
          const status = path.node.arguments[1] as t.Node | undefined;
          path.replaceWith(
            status
              ? t.callExpression(ctxMember('redirect'), [target as t.Expression, status as t.Expression])
              : t.callExpression(ctxMember('redirect'), [target as t.Expression]),
          );
          path.skip();
        }
      }
    },
    MemberExpression(path: any) {
      const chain = memberChain(path.node as t.Node);
      if (!chain) return;

      for (const requestName of requestNames) {
        // req.params.id -> c.req.param('id')
        if (chain.startsWith(`${requestName}.params.`)) {
          const key = chain.slice(`${requestName}.params.`.length);
          path.replaceWith(t.callExpression(ctxMember('req', 'param'), [t.stringLiteral(key)]));
          path.skip();
          return;
        }
        // req.query.completed -> c.req.query('completed')
        if (chain.startsWith(`${requestName}.query.`)) {
          const key = chain.slice(`${requestName}.query.`.length);
          path.replaceWith(t.callExpression(ctxMember('req', 'query'), [t.stringLiteral(key)]));
          path.skip();
          return;
        }
        // req.headers['x'] / req.headers.x -> c.req.header('x')
        if (chain.startsWith(`${requestName}.headers.`)) {
          const key = chain.slice(`${requestName}.headers.`.length);
          path.replaceWith(t.callExpression(ctxMember('req', 'header'), [t.stringLiteral(key)]));
          path.skip();
          return;
        }
        // req.body -> __body (hoisted, promise-safe)
        if (chain === `${requestName}.body`) {
          path.replaceWith(t.identifier('__body'));
          path.skip();
          return;
        }
        // req.method -> c.req.method
        if (chain === `${requestName}.method`) {
          path.replaceWith(ctxMember('req', 'method'));
          path.skip();
          return;
        }
        if (chain === `${requestName}.path` || chain === `${requestName}.url`) {
          path.replaceWith(ctxMember('req', 'path'));
          path.skip();
          return;
        }
      }
    },
    Identifier(path: any) {
      if (path.node.name !== 'prisma') return;
      const parent = path.parent;
      if (
        parent &&
        (parent.type === 'MemberExpression' || parent.type === 'OptionalMemberExpression') &&
        parent.object === path.node
      ) {
        path.replaceWith(t.identifier('db'));
        path.skip();
      }
    },
  });

  const statement = file.program.body[0];
  if (statement && statement.type === 'ExpressionStatement' && statement.expression.type === 'ArrowFunctionExpression') {
    return statement.expression;
  }

  // A response rewrite can turn the hosting statement into a `return`, so fall
  // back to locating the arrow anywhere in the file.
  let found: t.ArrowFunctionExpression | null = null;
  walk(file as any, (node) => {
    if (!found && node.type === 'ArrowFunctionExpression') {
      found = node as t.ArrowFunctionExpression;
    }
  });
  return found ?? arrow;
}

export interface TranspiledHandler {
  method: string;
  path: string;
  code: string;
  stubReason?: string;
}

function transpileRoute(route: RouteDef): TranspiledHandler {
  const handler = route.handler;
  const isFunction =
    handler &&
    (handler.type === 'ArrowFunctionExpression' ||
      handler.type === 'FunctionExpression' ||
      handler.type === 'FunctionDeclaration');

  if (!handler || !isFunction) {
    return {
      method: route.method,
      path: route.path,
      code: '',
      stubReason: handler
        ? `handler for ${route.method} ${route.path} is a named reference, not an inline function`
        : `handler for ${route.method} ${route.path} could not be located`,
    };
  }

  const body =
    (handler as t.FunctionDeclaration | t.FunctionExpression | t.ArrowFunctionExpression).body.type ===
    'BlockStatement'
      ? ((handler as any).body as t.BlockStatement)
      : t.blockStatement([t.returnStatement((handler as any).body as t.Expression)]);

  const cloned = t.cloneNode(body, true);
  const arrow = t.arrowFunctionExpression([t.identifier('c')], cloned, true);

  const transformed = applyRequestTransforms(arrow, route.framework);
  const transformedBody = transformed.body as t.BlockStatement;

  // The rewrite turns `req.body` into a bare `__body` identifier; only hoist the
  // parsed body when the handler actually reads it.
  let usedBody = false;
  walk(transformedBody, (child) => {
    if (child.type === 'Identifier' && (child as t.Identifier).name === '__body') usedBody = true;
  });

  if (usedBody) {
    transformedBody.body.unshift(
      t.variableDeclaration('const', [
        t.variableDeclarator(
          t.identifier('__body'),
          t.awaitExpression(
            t.callExpression(
              t.memberExpression(
                t.callExpression(
                  t.memberExpression(
                    t.memberExpression(t.identifier('c'), t.identifier('req')),
                    t.identifier('json'),
                  ),
                  [],
                ),
                t.identifier('catch'),
              ),
              [t.arrowFunctionExpression([], t.objectExpression([]))],
            ),
          ),
        ),
      ]),
    );
  }

  // Guarantee a response even when every branch is conditional.
  const last = transformedBody.body[transformedBody.body.length - 1];
  if (!last || last.type !== 'ReturnStatement') {
    transformedBody.body.push(
      t.returnStatement(
        t.callExpression(t.memberExpression(t.identifier('c'), t.identifier('body')), [
          t.nullLiteral(),
          t.numericLiteral(200),
        ]),
      ),
    );
  }

  const code = generate(transformed as any, { comments: false, compact: false, jsescOption: { minimal: true } })
    .code;

  return { method: route.method, path: route.path, code };
}

/** Stable, human-readable job id so `--use-jobs` matches `--emit-jobs` runs. */
export function jobIdFor(route: RouteDef): string {
  const slug = `${route.method}-${route.path}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'route';
}

interface ImportedOutcome {
  handler: TranspiledHandler;
  /** Present when the handler still needs a host agent to complete it. */
  job?: HandlerJob;
  /** True when a model or a host agent produced the code. */
  usedLlm: boolean;
  /** True when the provider itself failed, so the caller stops retrying it. */
  providerFailed?: boolean;
}

/**
 * Turns an imported controller into an inline handler.
 *
 * Order of preference: a host agent's finished job, then a model rewrite, then
 * the AST transpiler running over the extracted function, and only then a 501.
 */
async function transpileImportedRoute(
  route: RouteDef,
  analysis: AnalysisResult,
  context: ImportedHandlerOptions,
): Promise<ImportedOutcome> {
  const id = jobIdFor(route);
  const stub = (reason: string): TranspiledHandler => ({
    method: route.method,
    path: route.path,
    code: '',
    stubReason: reason,
  });

  if (context.useJobsDir) {
    const filled = await readHandlerJobOutput(context.useJobsDir, id);
    if (filled) {
      return {
        handler: { method: route.method, path: route.path, code: filled },
        usedLlm: true,
      };
    }
  }

  const ref = route.handlerRef;
  if (!ref) return { handler: stub(`handler for ${route.method} ${route.path} could not be located`), usedLlm: false };

  if (!ref.importSpecifier) {
    return {
      handler: stub(
        `${route.method} ${route.path} uses '${ref.localName}' but no import binding for it was found`,
      ),
      usedLlm: false,
    };
  }

  const resolved = await resolveModule(ref.importSpecifier, {
    fromFile: route.sourceFile,
    rootDir: context.rootDir,
  });
  if (!resolved) {
    return {
      handler: stub(`${route.method} ${route.path}: cannot resolve '${ref.importSpecifier}'`),
      usedLlm: false,
    };
  }

  let source: string;
  try {
    source = await fs.readFile(resolved, 'utf8');
  } catch {
    return {
      handler: stub(`${route.method} ${route.path}: cannot read '${ref.importSpecifier}'`),
      usedLlm: false,
    };
  }

  const extracted = extractHandler(source, ref.localName, ref.property);
  if (!extracted) {
    const name = ref.property ? `${ref.localName}.${ref.property}` : ref.localName;
    return {
      handler: stub(`${route.method} ${route.path}: '${name}' is not an exported function in ${ref.importSpecifier}`),
      usedLlm: false,
    };
  }

  const handlerName = ref.property ?? ref.localName;
  const sourceFile = path.relative(context.rootDir, resolved) || resolved;
  const request: HandlerRewriteRequest = {
    method: route.method,
    path: route.path,
    framework: route.framework,
    params: route.params,
    usesBody: route.usesBody,
    usesQuery: route.usesQuery,
    sourceFile,
    handlerName,
    handlerSource: extracted.code,
    schemaSql: analysis.schemaSql,
    models: analysis.models,
  };

  let providerFailed = false;
  if (context.llmRoute) {
    const outcome = await rewriteHandler(request, context.llmRoute);
    if (outcome.ok) {
      return {
        handler: { method: route.method, path: route.path, code: outcome.code },
        usedLlm: true,
      };
    }
    providerFailed = outcome.transport;
  }

  // The AST path re-hosts the extracted function body, which covers the common
  // `req`/`res` + `prisma` controller shapes without a model.
  const fallback = transpileRoute({ ...route, handler: extracted.node });
  const job = context.emitJobsDir
    ? {
        id,
        method: route.method,
        path: route.path,
        framework: route.framework,
        sourceFile,
        handlerName,
        schemaSql: analysis.schemaSql,
        handlerSource: extracted.code,
        prompt: renderPrompt(buildHandlerPrompt(request)),
      }
    : undefined;

  if (!fallback.stubReason) {
    return { handler: fallback, job, usedLlm: false, providerFailed };
  }

  return {
    handler: stub(
      `${route.method} ${route.path}: '${handlerName}' in ${sourceFile} could not be transpiled`,
    ),
    job,
    usedLlm: false,
    providerFailed,
  };
}

function renderRouteBlock(routes: TranspiledHandler[]): string {
  const lines: string[] = [];
  for (const route of routes) {
    if (route.stubReason) {
      lines.push(`// stub: ${route.stubReason}`);
      lines.push(
        `app.${route.method.toLowerCase()}('${route.path}', (c) => c.json({ error: 'Not implemented', reason: ${JSON.stringify(
          route.stubReason,
        )} }, 501));`,
      );
    } else {
      lines.push(`app.${route.method.toLowerCase()}('${route.path}', ${route.code});`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// COMMIT-25-PROVIDER-DROP: a provider that *detected* but is
// *unreachable* (not logged in, HTTP error, missing model) used to
// retry on every imported route, so a build with 10 jobs and a
// broken provider would sit on ten 120s timeouts. We now pass
// `activeRoute` into the loop and reset it to null on the first
// transport failure, so the remaining routes fall back to AST
// transpilation immediately.

export async function transpile(options: TranspileOptions): Promise<TranspileResult> {
  const { analysis, outDir, port, version } = options;
  await fs.mkdir(outDir, { recursive: true });

  const warnings: string[] = [];
  const imported = options.imported;
  const handlers: TranspiledHandler[] = [];
  const jobs: HandlerJob[] = [];
  let llmRoutes = 0;
  // Dropped to null the moment the provider proves unreachable, so a broken
  // login costs one failed call rather than one per imported handler.
  let activeRoute = imported?.llmRoute ?? null;

  for (const route of analysis.routes) {
    const handler = route.handler;
    const isInline =
      !!handler &&
      (handler.type === 'ArrowFunctionExpression' ||
        handler.type === 'FunctionExpression' ||
        handler.type === 'FunctionDeclaration');

    if (isInline || !imported) {
      handlers.push(transpileRoute(route));
      continue;
    }

    const outcome = await transpileImportedRoute(route, analysis, {
      ...imported,
      llmRoute: activeRoute,
    });
    handlers.push(outcome.handler);
    if (outcome.job) jobs.push(outcome.job);
    if (outcome.usedLlm) llmRoutes += 1;
    if (outcome.providerFailed && activeRoute) {
      warnings.push(`${activeRoute.label} could not be reached; remaining handlers use AST transpilation`);
      activeRoute = null;
    }
  }

  const stubbed = handlers.filter((h) => h.stubReason).length;
  for (const handler of handlers) {
    if (handler.stubReason) warnings.push(handler.stubReason);
  }

  const jobFiles =
    imported?.emitJobsDir && jobs.length > 0
      ? (await writeHandlerJobs(imported.emitJobsDir, jobs)).map((job) => job.jsonFile)
      : [];

  const schemaSql = analysis.schemaSql || '-- no schema could be extracted from the source project\n';
  const appName = path.basename(analysis.targetDir);

  let server = renderBoilerplate({
    version,
    sourceDir: analysis.targetDir,
    appName,
    modelsJson: modelsToRuntimeMetadata(analysis.models),
    schemaSql,
    defaultPort: port,
    dbFile: DEFAULT_DB_FILE,
  });

  server = server.replace(
    ROUTES_PLACEHOLDER,
    renderRouteBlock(handlers) || '// no API routes were detected in the source project\n',
  );
  server = server.replace(
    STATIC_PLACEHOLDER,
    renderStaticMounts(options.staticMounts, options.hasPublic),
  );

  const serverFile = path.join(outDir, 'server.ts');
  const schemaFile = path.join(outDir, 'schema.sql');
  const packageFile = path.join(outDir, 'package.json');

  await fs.writeFile(serverFile, server, 'utf8');
  await fs.writeFile(
    schemaFile,
    `-- Generated by app-shrink v${version}\n-- Source: ${analysis.targetDir}\n\n${schemaSql}\n`,
    'utf8',
  );

  const manifest = {
    name: `${appName}-shrunk`,
    version: '1.0.0',
    private: true,
    type: 'module' as const,
    description: `Shrunk micro-service generated by app-shrink from ${path.relative(process.cwd(), analysis.targetDir) || '.'}`,
    main: 'server.ts',
    scripts: {
      start: 'node server.ts',
    },
    dependencies: {
      hono: '^4.6.14',
      '@hono/node-server': '^1.13.7',
      'better-sqlite3': '^11.7.0',
    },
  };
  await fs.writeFile(packageFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  return {
    serverFile,
    schemaFile,
    packageFile,
    routeCount: analysis.routes.length,
    warnings,
    transpiledRoutes: handlers.length - stubbed,
    stubbedRoutes: stubbed,
    llmRoutes,
    jobFiles,
  };
}
