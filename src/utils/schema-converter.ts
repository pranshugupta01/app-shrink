/**
 * Prisma -> raw SQLite DDL conversion.
 *
 * The converter is intentionally dialect-aware but conservative: anything it
 * cannot translate with confidence is emitted as TEXT so the generated schema
 * is always valid and never blocks the pipeline.
 */

export type SqliteType = 'INTEGER' | 'REAL' | 'TEXT' | 'BLOB' | 'DATETIME';

export interface FieldDef {
  name: string;
  /** Prisma type as written (`String`, `Int`, `DateTime`, or a model name). */
  prismaType: string;
  columnName: string;
  columnType: SqliteType;
  isOptional: boolean;
  isArray: boolean;
  isId: boolean;
  isUnique: boolean;
  isUpdatedAt: boolean;
  /** Set when the field points at another model. */
  relation?: { model: string; fields: string[]; references: string[] };
  /** Serialised `@default(...)` expression, already dialect-safe. */
  defaultExpr?: string;
  /** Raw Prisma default, kept for the query shim (uuid/cuid/now handling). */
  prismaDefault?: { fn: string; args: string };
}

/** A Prisma @@index or @@unique declaration, captured at the model level. */
interface ModelIndex {
  columns: string[];
  unique: boolean;
}

export interface ModelDef {
  name: string;
  tableName: string;
  fields: FieldDef[];
  /** Composite unique constraints from `@@unique([...])`. */
  uniqueGroups: string[][];
}

export interface ParsedSchema {
  models: ModelDef[];
  sql: string;
  /** `provider` from the datasource block. */
  provider: string;
  /** Resolved `url` from the datasource block, if static. */
  url: string | null;
}

const SCALAR_TYPES = new Set([
  'String',
  'Int',
  'BigInt',
  'Float',
  'Decimal',
  'Boolean',
  'DateTime',
  'Json',
  'Bytes',
  'Unsupported',
]);

const TYPE_MAP: Record<string, SqliteType> = {
  String: 'TEXT',
  Int: 'INTEGER',
  BigInt: 'INTEGER',
  Float: 'REAL',
  Decimal: 'REAL',
  Boolean: 'INTEGER',
  // Prisma stores DateTime as epoch milliseconds. DATETIME is kept (rather than
  // TEXT) so the column retains numeric affinity and those values survive as
  // integers instead of being coerced into text such as "1792183570690.0".
  DateTime: 'DATETIME',
  Json: 'TEXT',
  Bytes: 'BLOB',
  Unsupported: 'TEXT',
};

export function mapPrismaType(prismaType: string): SqliteType {
  return TYPE_MAP[prismaType] ?? 'TEXT';
}

interface RawField {
  name: string;
  type: string;
  attrs: string;
}

function parseFields(block: string): RawField[] {
  const fields: RawField[] = [];
  for (const rawLine of block.split('\n')) {
    const line = rawLine.replace(/\/\/.*$/, '').trim();
    if (!line || line.startsWith('@@') || line.startsWith('//')) continue;
    const match = line.match(/^(\w+)\s+([\w[\]?]+)\s*(.*)$/);
    if (!match) continue;
    fields.push({ name: match[1], type: match[2], attrs: match[3].trim() });
  }
  return fields;
}

function parseDefault(attrs: string): { sqlite?: string; prisma?: { fn: string; args: string } } {
  const fn = attrs.match(/@default\(\s*([A-Za-z_]+)\s*\(\s*([^)]*)\s*\)\s*\)/);
  if (fn) {
    const name = fn[1];
    const args = fn[2].trim();
    switch (name) {
      case 'now':
        return { prisma: { fn: 'now', args } };
      case 'uuid':
      case 'cuid':
      case 'ulid':
      case 'nanoid':
        return { prisma: { fn: name, args } };
      case 'autoincrement':
        return { prisma: { fn: 'autoincrement', args } };
      case 'dbgenerated':
        return { sqlite: undefined, prisma: { fn: 'dbgenerated', args } };
      default:
        return { prisma: { fn: name, args } };
    }
  }

  const literal = attrs.match(/@default\(\s*([^)]*?)\s*\)/);
  if (!literal) return {};
  const value = literal[1].trim();
  if (value === 'true') return { sqlite: '1' };
  if (value === 'false') return { sqlite: '0' };
  if (value === 'null') return {};
  if (/^-?\d+(\.\d+)?$/.test(value)) return { sqlite: value };
  if (value.startsWith('"') && value.endsWith('"')) return { sqlite: `'${value.slice(1, -1).replace(/'/g, "''")}'` };
  if (value.startsWith('[') || value.startsWith('{')) {
    return { sqlite: `'${value.replace(/'/g, "''")}'` };
  }
  return {};
}

function parseRelation(attrs: string): { model: string; fields: string[]; references: string[] } | undefined {
  const match = attrs.match(/@relation\(\s*(?:name:\s*"[^"]*"\s*,?\s*)?([^)]*)\)/);
  if (!match) return undefined;
  const body = match[1];
  const fields = body.match(/fields:\s*\[([^\]]*)\]/);
  const references = body.match(/references:\s*\[([^\]]*)\]/);
  if (!fields || !references) return undefined;
  const split = (s: string) =>
    s
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
  return { model: '', fields: split(fields[1]), references: split(references[1]) };
}

function quoteIdentifier(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

/** Strips `@@map`/`@map` string arguments. */
function mapName(segment: string, keyword: string): string | null {
  const match = segment.match(new RegExp(`${keyword}\\(\\s*"([^"]+)"\\s*\\)`));
  return match ? match[1] : null;
}

export function parsePrismaSchema(source: string): ParsedSchema {
  const provider = source.match(/provider\s*=\s*"([^"]+)"/)?.[1] ?? 'postgresql';
  const url = source.match(/url\s*=\s*"([^"]+)"/)?.[1] ?? null;

  const models: ModelDef[] = [];
  const modelRe = /\bmodel\s+(\w+)\s*\{/g;
  let match: RegExpExecArray | null;
  const modelBodies: { name: string; body: string }[] = [];

  while ((match = modelRe.exec(source))) {
    const name = match[1];
    const open = source.indexOf('{', match.index);
    let depth = 0;
    let i = open;
    for (; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    modelBodies.push({ name, body: source.slice(open + 1, i) });
    modelRe.lastIndex = i;
  }

  const declaredModels = new Set(modelBodies.map((m) => m.name));
  const relationOwners: { model: ModelDef; field: FieldDef; relation: RawField }[] = [];

  for (const { name, body } of modelBodies) {
    const tableName = mapName(body, '@@map') ?? name;
    const fields: FieldDef[] = [];
    const uniqueGroups: string[][] = [];

    for (const raw of parseFields(body)) {
      const isArray = raw.type.endsWith('[]');
      const baseType = raw.type.replace(/[?[\]]/g, '');
      const isOptional = raw.type.includes('?');
      const defaultParsed = parseDefault(raw.attrs);
      const relation = SCALAR_TYPES.has(baseType) ? undefined : parseRelation(raw.attrs);

      if (relation && declaredModels.has(baseType)) relation.model = baseType;

      const field: FieldDef = {
        name: raw.name,
        prismaType: baseType,
        columnName: mapName(raw.attrs, '@map') ?? raw.name,
        columnType: mapPrismaType(baseType),
        isOptional,
        isArray,
        isId: /@id\b/.test(raw.attrs),
        isUnique: /@unique\b/.test(raw.attrs),
        isUpdatedAt: /@updatedAt\b/.test(raw.attrs),
        relation,
        defaultExpr: defaultParsed.sqlite,
        prismaDefault: defaultParsed.prisma,
      };
      fields.push(field);
      if (relation && relation.fields.length > 0) {
        relationOwners.push({ model: { name, tableName, fields, uniqueGroups }, field, relation: raw });
      }
    }

    const groupRe = /@@unique\(\s*\[([^\]]*)\]\s*\)/g;
    let group: RegExpExecArray | null;
    while ((group = groupRe.exec(body))) {
      uniqueGroups.push(
        group[1]
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean),
      );
    }

    models.push({ name, tableName, fields, uniqueGroups });
  }

  // Re-resolve relations now that every model is known.
  for (const model of models) {
    for (const field of model.fields) {
      if (field.relation && !field.relation.model) {
        field.relation = undefined;
      }
    }
    for (const field of model.fields) {
      if (field.relation) continue;
      if (SCALAR_TYPES.has(field.prismaType)) continue;
      if (declaredModels.has(field.prismaType)) continue;
      field.prismaType = 'String';
      field.columnType = 'TEXT';
    }
  }

  return { models, sql: modelsToSql(models), provider, url };
}

export function modelsToSql(models: ModelDef[]): string {
  const statements: string[] = [];

  for (const model of models) {
    const columns: string[] = [];
    const constraints: string[] = [];

    for (const field of model.fields) {
      // Only scalar-typed fields map to storage. Relation fields never own a
      // column in Prisma - the owning scalar (`userId`) carries the FK instead.
      if (!SCALAR_TYPES.has(field.prismaType)) continue;

      const isAutoincrement =
        field.prismaDefault?.fn === 'autoincrement' && field.columnType === 'INTEGER';
      const parts = [quoteIdentifier(field.columnName)];

      if (field.isId && isAutoincrement) {
        parts.push('INTEGER PRIMARY KEY AUTOINCREMENT');
        columns.push(parts.join(' '));
        continue;
      }

      parts.push(field.columnType);
      if (field.isId) parts.push('PRIMARY KEY');
      if (field.isUnique && !field.isId) parts.push('UNIQUE');
      if (!field.isOptional && !field.isId) parts.push('NOT NULL');

      if (field.defaultExpr) {
        parts.push(`DEFAULT ${field.defaultExpr}`);
      }

      columns.push(parts.join(' '));
    }

    for (const field of model.fields) {
      if (!field.relation || field.relation.fields.length === 0) continue;
      const target = models.find((m) => m.name === field.relation!.model);
      if (!target) continue;
      const localCols = field.relation.fields
        .map((name) => {
          const f = model.fields.find((x) => x.name === name);
          return quoteIdentifier(f?.columnName ?? name);
        })
        .join(', ');
      const remoteCols = field.relation.references
        .map((name) => {
          const f = target.fields.find((x) => x.name === name);
          return quoteIdentifier(f?.columnName ?? name);
        })
        .join(', ');
      constraints.push(
        `FOREIGN KEY (${localCols}) REFERENCES ${quoteIdentifier(target.tableName)} (${remoteCols}) ON DELETE CASCADE ON UPDATE CASCADE`,
      );
    }

    for (const group of model.uniqueGroups) {
      const cols = group
        .map((name) => {
          const f = model.fields.find((x) => x.name === name);
          return quoteIdentifier(f?.columnName ?? name);
        })
        .join(', ');
      if (cols) constraints.push(`UNIQUE (${cols})`);
    }

    const body = [...columns, ...constraints].map((line) => `  ${line}`).join(',\n');
    statements.push(`CREATE TABLE IF NOT EXISTS ${quoteIdentifier(model.tableName)} (\n${body}\n);`);
  }

  return statements.join('\n\n');
}

/** Serialises the parsed models into the runtime metadata block embedded in server.ts. */
export function modelsToRuntimeMetadata(models: ModelDef[]): string {
  const out: Record<string, unknown> = {};
  for (const model of models) {
    const fields: Record<string, unknown> = {};
    for (const field of model.fields) {
      if (!SCALAR_TYPES.has(field.prismaType)) continue;
      fields[field.columnName] = {
        name: field.name,
        type: field.columnType,
        prismaType: field.prismaType,
        optional: field.isOptional,
        pk: field.isId,
        autoIncrement: field.prismaDefault?.fn === 'autoincrement',
        defaultFn: field.prismaDefault?.fn ?? null,
        updatedAt: field.isUpdatedAt,
      };
    }
    out[model.name] = { table: model.tableName, fields };
  }
  return JSON.stringify(out, null, 2);
}
