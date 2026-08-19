/**
 * API documentation helpers: infer field trees from JSON payloads so the UI
 * can show request/response properties (Apifox-style "返回属性").
 */

export interface ApiField {
  name: string;
  type: string;
  required: boolean;
  /** Truncated example value (or '' for containers). */
  example: string;
  children: ApiField[];
}

function typeName(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

/** Infer a field tree from a JSON value. */
export function inferFields(value: unknown, name = ''): ApiField {
  if (Array.isArray(value)) {
    const item = value.length > 0 ? value[0] : undefined;
    return {
      name,
      type: item === undefined ? 'array' : `array<${typeName(item)}>`,
      required: true,
      example: '',
      children:
        item !== undefined && typeof item === 'object' && item !== null
          ? [inferFields(item, '[item]')]
          : [],
    };
  }
  if (value === null) {
    return { name, type: 'null', required: true, example: 'null', children: [] };
  }
  if (typeof value === 'object') {
    const children = Object.entries(value as Record<string, unknown>).map(([k, v]) =>
      inferFields(v, k),
    );
    return { name, type: 'object', required: true, example: '', children };
  }
  const example = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : JSON.stringify(value);
  return {
    name,
    type: typeName(value),
    required: true,
    example: example.length > 80 ? `${example.slice(0, 80)}…` : example,
    children: [],
  };
}

/** Render a flat row list of a field tree with depth-based indentation. */
export function flattenFields(root: ApiField): { field: ApiField; depth: number }[] {
  const out: { field: ApiField; depth: number }[] = [];
  const walk = (node: ApiField, depth: number) => {
    out.push({ field: node, depth });
    for (const child of node.children) {
      walk(child, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}
