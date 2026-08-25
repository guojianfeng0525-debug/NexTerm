import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";

type SqlPosition = "relation" | "type" | "expression" | "none";

export type PostgresCatalogItem = {
  kind: string;
  schema?: string;
  name: string;
  relation?: string;
  dataType?: string;
  signature?: string;
};

export type PostgresCatalogLookup = (request: {
  kind: "relation" | "column" | "function" | "type";
  prefix: string;
  schema?: string;
  relation?: string;
}) => Promise<PostgresCatalogItem[]>;

const KEYWORDS = [
  "SELECT", "FROM", "WHERE", "JOIN", "INNER JOIN", "LEFT JOIN", "RIGHT JOIN", "FULL JOIN", "ON",
  "INSERT INTO", "VALUES", "UPDATE", "SET", "DELETE FROM", "RETURNING", "WITH", "AS", "DISTINCT",
  "GROUP BY", "HAVING", "ORDER BY", "LIMIT", "OFFSET", "UNION", "UNION ALL", "INTERSECT", "EXCEPT",
  "CASE", "WHEN", "THEN", "ELSE", "END", "EXISTS", "IN", "BETWEEN", "LIKE", "ILIKE", "IS NULL",
  "CREATE TABLE", "ALTER TABLE", "DROP TABLE", "CREATE INDEX", "CREATE VIEW", "BEGIN", "COMMIT", "ROLLBACK",
  "EXPLAIN", "EXPLAIN ANALYZE", "VACUUM", "ANALYZE",
];

const FUNCTIONS = [
  ["count", "count(expression)"], ["sum", "sum(expression)"], ["avg", "avg(expression)"],
  ["min", "min(expression)"], ["max", "max(expression)"], ["coalesce", "coalesce(value, fallback)"],
  ["nullif", "nullif(value, comparison)"], ["now", "now()"], ["current_timestamp", "current_timestamp"],
  ["date_trunc", "date_trunc(field, source)"], ["extract", "extract(field FROM source)"],
  ["to_char", "to_char(value, format)"], ["lower", "lower(text)"], ["upper", "upper(text)"],
  ["trim", "trim(text)"], ["length", "length(text)"], ["concat", "concat(values...)"],
  ["regexp_replace", "regexp_replace(source, pattern, replacement)"], ["jsonb_build_object", "jsonb_build_object(key, value...)"],
  ["jsonb_agg", "jsonb_agg(expression)"], ["jsonb_array_elements", "jsonb_array_elements(jsonb)"],
  ["array_agg", "array_agg(expression)"], ["unnest", "unnest(array)"], ["generate_series", "generate_series(start, stop[, step])"],
  ["row_number", "row_number() OVER (...)"], ["rank", "rank() OVER (...)"], ["lag", "lag(value[, offset])"],
  ["lead", "lead(value[, offset])"], ["uuid_generate_v4", "uuid_generate_v4()"],
] as const;

const TYPES = [
  "bigint", "bigserial", "boolean", "bytea", "char", "date", "double precision", "integer", "json", "jsonb",
  "numeric", "real", "serial", "smallint", "text", "time", "timestamp", "timestamptz", "uuid", "varchar", "xml",
];

const SNIPPETS: Completion[] = [
  { label: "select", type: "snippet", detail: "Select rows", apply: "SELECT ${columns}\nFROM ${table};" },
  { label: "insert", type: "snippet", detail: "Insert and return rows", apply: "INSERT INTO ${table} (${columns})\nVALUES (${values})\nRETURNING *;" },
  { label: "cte", type: "snippet", detail: "Common table expression", apply: "WITH ${name} AS (\n  SELECT ${columns}\n  FROM ${table}\n)\nSELECT * FROM ${name};" },
  { label: "create_table", type: "snippet", detail: "Create table", apply: "CREATE TABLE ${table} (\n  id uuid PRIMARY KEY DEFAULT gen_random_uuid()\n);" },
  { label: "join", type: "snippet", detail: "Join relation", apply: "JOIN ${table} AS ${alias}\n  ON ${condition}" },
];

const RELATION_KEYWORDS = /\b(?:from|join|update|into|delete\s+from)\s+([\w."$]*)$/i;
const TYPE_KEYWORDS = /(?:::\s*|\b(?:as|type)\s+)([\w."$]*)$/i;
const EXPRESSION_KEYWORDS = /\b(?:select|where|on|having|group\s+by|order\s+by|set|returning)\b[\s\S]*$/i;

function currentStatement(text: string): string {
  let quote = false;
  let lineComment = false;
  let blockDepth = 0;
  let start = 0;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockDepth > 0) {
      if (char === "/" && next === "*") {
        blockDepth += 1;
        index += 1;
      } else if (char === "*" && next === "/") {
        blockDepth -= 1;
        index += 1;
      }
      continue;
    }
    if (!quote && char === "-" && next === "-") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (!quote && char === "/" && next === "*") {
      blockDepth = 1;
      index += 1;
      continue;
    }
    if (char === "'") {
      if (quote && next === "'") index += 1;
      else quote = !quote;
      continue;
    }
    if (!quote && char === ";") start = index + 1;
  }
  return text.slice(start);
}

export function postgresCompletionPosition(text: string): SqlPosition {
  const statement = currentStatement(text);
  if (/--[^\n]*$/.test(statement) || /\/\*[\s\S]*$/.test(statement) || /'(?:[^']|'')*$/.test(statement)) return "none";
  if (RELATION_KEYWORDS.test(statement)) return "relation";
  if (TYPE_KEYWORDS.test(statement)) return "type";
  return EXPRESSION_KEYWORDS.test(statement) ? "expression" : "expression";
}

function optionsFor(position: SqlPosition): Completion[] {
  if (position === "none") return [];
  const keywords = KEYWORDS.map((label) => ({ label, type: "keyword" as const }));
  if (position === "type") return TYPES.map((label) => ({ label, type: "type" as const }));
  const functions = FUNCTIONS.map(([label, detail]) => ({ label, detail, type: "function" as const }));
  return [...SNIPPETS, ...keywords, ...functions];
}

/** PostgreSQL-aware local completion source. Catalog objects are added by the database workspace later. */
export function postgresCompletionSource(context: CompletionContext): CompletionResult | null {
  const before = context.matchBefore(/[\w$]*/);
  if (!before || (before.from === before.to && !context.explicit)) return null;
  const position = postgresCompletionPosition(context.state.doc.sliceString(0, context.pos));
  const options = optionsFor(position);
  return options.length === 0 ? null : { from: before.from, options, validFor: /^[\w$]*$/ };
}

export function postgresStaticCompletions(text: string): Completion[] {
  return optionsFor(postgresCompletionPosition(text));
}

function relationAtCursor(text: string): { schema?: string; relation: string } | null {
  const alias = /(?:from|join)\s+((?:"[^"]+"|[\w$]+)(?:\.(?:"[^"]+"|[\w$]+))?)(?:\s+(?:as\s+)?([\w$]+))?/gi;
  const target = /([\w$]+)\.[\w$]*$/.exec(text);
  if (!target) return null;
  let match: RegExpExecArray | null;
  let found: { schema?: string; relation: string } | null = null;
  while ((match = alias.exec(text))) {
    const [schema, relation] = match[1].split('.').map((value) => value.replace(/^"|"$/g, ''));
    if (match[2] === target[1] || relation === target[1]) found = { schema: relation ? schema : undefined, relation: relation ?? schema };
  }
  return found;
}

function catalogOption(item: PostgresCatalogItem): Completion {
  const type = item.kind === "column" ? "property" : item.kind === "function" ? "function" : item.kind === "type" ? "type" : "class";
  return { label: item.name, type, detail: item.signature ?? item.dataType ?? item.schema };
}

/** Combines instant static completion with the connected PostgreSQL catalog. */
export async function postgresCatalogCompletionSource(
  context: CompletionContext,
  lookup: PostgresCatalogLookup | undefined,
): Promise<CompletionResult | null> {
  const before = context.matchBefore(/[\w$]*/);
  if (!before || (before.from === before.to && !context.explicit)) return null;
  const text = context.state.doc.sliceString(0, context.pos);
  const position = postgresCompletionPosition(text);
  const staticOptions = optionsFor(position);
  if (!lookup || position === "none") return staticOptions.length ? { from: before.from, options: staticOptions } : null;
  const relation = relationAtCursor(text);
  const kind = relation ? "column" : position === "relation" ? "relation" : "function";
  try {
    const items = await lookup({ kind, prefix: before.text, schema: relation?.schema, relation: relation?.relation });
    return { from: before.from, options: [...items.map(catalogOption), ...staticOptions], validFor: /^[\w$]*$/ };
  } catch {
    return staticOptions.length ? { from: before.from, options: staticOptions, validFor: /^[\w$]*$/ } : null;
  }
}
