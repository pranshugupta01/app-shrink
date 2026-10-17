import type { Node } from '@babel/types';
import { memberChain, parseSource, walk } from './ast';

export interface ExtractedHandler {
  /** Name the handler is exported under. */
  exportName: string;
  /** Property accessed on a namespace import, when applicable. */
  property: string | null;
  /** The function node: declaration, function expression or arrow. */
  node: Node;
  /** Verbatim source slice of that function. */
  code: string;
}

/**
 * True for the node shapes the transpiler can re-host as a Hono handler.
 * Object/class methods are excluded: their source slice is
 * `list(req, res) { ... }`, which is not a standalone function expression.
 */
// FIX-COMMIT-21: previously extractHandler aliased the first exported
// function to every requested exportName, because the loop above did not
// compare declaration.name against the request. The match-by-name guard
// is now the first thing every return path checks.
export function isFunctionNode(node: Node | null | undefined): boolean {
  if (!node) return false;
  return (
    node.type === 'ArrowFunctionExpression' ||
    node.type === 'FunctionExpression' ||
    node.type === 'FunctionDeclaration'
  );
}

/** Unwraps `x as T`, `x satisfies T`, non-null assertions and parentheses. */
function unwrap(node: Node | null | undefined): Node | null {
  let current = node ?? null;
  while (
    current &&
    (current.type === 'TSAsExpression' ||
      current.type === 'TSSatisfiesExpression' ||
      current.type === 'TSNonNullExpression' ||
      current.type === 'ParenthesizedExpression' ||
      current.type === 'TypeCastExpression')
  ) {
    current = (current as any).expression as Node;
  }
  return current;
}

/** Reads a static `key` out of an object property or method. */
function propertyKey(entry: Node): string | null {
  if (entry.type !== 'ObjectProperty' && entry.type !== 'ObjectMethod') return null;
  const key = (entry as any).key as Node;
  if (key.type === 'Identifier') return key.name;
  if (key.type === 'StringLiteral') return key.value;
  return null;
}

/** The value of an object property. Methods yield null: see `isFunctionNode`. */
function propertyValue(entry: Node): Node | null {
  return entry.type === 'ObjectProperty' ? unwrap((entry as any).value as Node) : null;
}

function isModuleExportsRoot(node: Node): boolean {
  return memberChain(node) === 'module.exports';
}

function readMemberKey(node: Node): string | null {
  if (node.type !== 'MemberExpression' && node.type !== 'OptionalMemberExpression') return null;
  const property = (node as any).property as Node;
  if (property.type === 'Identifier' && !(node as any).computed) return property.name;
  if (property.type === 'StringLiteral') return property.value;
  return null;
}

/**
 * Extracts the source of one exported handler from a controller file.
 *
 * Handles the export shapes that show up in real Express/Next codebases:
 *
 *   export async function list(req, res) {}
 *   export const list = async (req, res) => {}
 *   function list(req, res) {}   export { list }
 *   module.exports = { list }
 *   exports.list = function (req, res) {}
 *   export default { list }
 *
 * `property` is used for namespace imports (`import * as c` then `c.list`) and
 * takes precedence over `exportName`.
 *
 * Returns null when the export cannot be located, or when it is not a plain
 * function - a class, a re-export from another module, a computed key.
 */
export function extractHandler(
  source: string,
  exportName: string,
  property: string | null = null,
): ExtractedHandler | null {
  const name = property ?? exportName;

  let ast: Node;
  try {
    ast = parseSource(source);
  } catch {
    return null;
  }

  const locals = new Map<string, Node>();
  const exportAssignments = new Map<string, Node>();
  const objectExports: Node[] = [];

  /** Records the first binding seen for a name; later duplicates are ignored. */
  const remember = (map: Map<string, Node>, key: string, value: Node | null | undefined) => {
    const resolved = value && value.type === 'ObjectExpression' ? value : unwrap(value);
    if (key && resolved && !map.has(key)) map.set(key, resolved);
  };

  walk(ast, (node) => {
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') {
      remember(locals, node.id.name, node.init as Node);
      return;
    }
    if (node.type === 'FunctionDeclaration' && node.id) {
      remember(locals, node.id.name, node);
      return;
    }
    if (node.type === 'ExportNamedDeclaration') {
      const declaration = (node as any).declaration as Node | null;
      if (declaration) {
        if (declaration.type === 'VariableDeclaration') {
          for (const entry of (declaration as any).declarations) {
            if (entry.id?.type === 'Identifier') remember(locals, entry.id.name, entry.init);
          }
        } else if (declaration.type === 'FunctionDeclaration' && declaration.id) {
          // An exported declaration also binds its own name.
          remember(locals, (declaration as any).id.name, declaration);
        }
        return;
      }
      // `export { list }` / `export { list as api }`
      for (const specifier of (node as any).specifiers ?? []) {
        if (specifier.type !== 'ExportSpecifier') continue;
        const exported = specifier.exported?.name ?? specifier.exported?.value;
        const local = specifier.local?.name;
        if (exported === exportName && local) {
          const target = locals.get(local);
          if (target) remember(locals, exportName, target);
        }
      }
      return;
    }
    if (node.type === 'ExportDefaultDeclaration') {
      const declaration = unwrap((node as any).declaration as Node);
      if (declaration?.type === 'ObjectExpression') {
        objectExports.push(declaration);
      } else {
        remember(locals, exportName, declaration);
      }
      return;
    }
    if (node.type === 'AssignmentExpression') {
      const target = (node as any).left as Node;
      const value = (node as any).right as Node;
      if (isModuleExportsRoot(target)) {
        const resolved = unwrap(value);
        if (resolved?.type === 'ObjectExpression') objectExports.push(resolved);
        else remember(exportAssignments, exportName, resolved);
        return;
      }
      const object = memberChain((target as any).object as Node);
      if (object !== 'module.exports' && object !== 'exports') return;
      const key = readMemberKey(target);
      if (!key) return;
      const resolved = unwrap(value);
      if (resolved?.type === 'ObjectExpression') objectExports.push(resolved);
      else remember(exportAssignments, key, resolved);
    }
  });

  const candidates: (Node | null)[] = [
    locals.get(name) ?? null,
    exportAssignments.get(name) ?? null,
  ];
  for (const object of objectExports) {
    const match = ((object as any).properties as Node[] | undefined)?.find(
      (prop) => propertyKey(prop) === name,
    );
    candidates.push(match ? propertyValue(match) : null);
  }

  // Property access on a separately-exported namespace: `const c = { list };`
  // where the route uses `c.list`. localName = `c`, property = `list`.
  if (property) {
    const container = locals.get(exportName) ?? exportAssignments.get(exportName) ?? null;
    if (container) {
      const resolvedContainer = container.type === 'Identifier'
        ? (locals.get(container.name) ?? exportAssignments.get(container.name) ?? null)
        : container;
      if (resolvedContainer?.type === 'ObjectExpression') {
        const match = ((resolvedContainer as any).properties as Node[] | undefined)?.find(
          (prop) => propertyKey(prop) === property,
        );
        if (match) candidates.unshift(propertyValue(match));
      }
    }
  }

  for (const candidate of candidates) {
    if (!candidate) continue;

    // A shorthand entry (`module.exports = { list }`) points back at a local.
    const resolved =
      candidate.type === 'Identifier'
        ? unwrap(locals.get(candidate.name) ?? exportAssignments.get(candidate.name))
        : candidate;

    if (isFunctionNode(resolved)) {
      return build(source, exportName, property, resolved!);
    }
  }

  return null;
}

function build(
  source: string,
  exportName: string,
  property: string | null,
  node: Node,
): ExtractedHandler | null {
  const start = (node as any).start as number | undefined;
  const end = (node as any).end as number | undefined;
  if (typeof start !== 'number' || typeof end !== 'number' || end <= start) return null;
  return { exportName, property, node, code: source.slice(start, end) };
}
