// A small JSON Schema validator: enough of draft 2020-12 for our contracts and MCP tool inputs,
// with no dependency. Supported: type, enum, const, required, properties, additionalProperties (boolean),
// items, minItems, minLength, maxLength, pattern, minimum, maximum, oneOf. Anything else in a schema is
// rejected loudly rather than silently ignored, so a contract cannot claim a rule that is not enforced.

export type Schema = { [key: string]: unknown };

const KNOWN = new Set([
  "$schema", "$id", "title", "description", "type", "enum", "const", "required", "properties", "additionalProperties",
  "items", "minItems", "minLength", "maxLength", "pattern", "minimum", "maximum", "oneOf", "default", "examples",
]);

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeOf(value) === type;
}

export function validate(schema: Schema, value: unknown, path = "$"): string[] {
  for (const key of Object.keys(schema)) {
    if (!KNOWN.has(key)) throw new Error(`Unsupported schema keyword "${key}" at ${path}`);
  }
  const errors: string[] = [];

  if (schema.oneOf) {
    const branches = schema.oneOf as Schema[];
    const passing = branches.filter((b) => validate(b, value, path).length === 0).length;
    if (passing !== 1) errors.push(`${path}: must match exactly one of ${branches.length} alternatives (matched ${passing})`);
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
    if (!types.some((t) => matchesType(value, t))) {
      errors.push(`${path}: expected ${types.join(" or ")}, got ${typeOf(value)}`);
      return errors;
    }
  }
  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) errors.push(`${path}: must equal ${JSON.stringify(schema.const)}`);
  if (schema.enum && !(schema.enum as unknown[]).some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    errors.push(`${path}: must be one of ${JSON.stringify(schema.enum)}`);
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`);
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength}`);
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: does not match ${schema.pattern}`);
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${path}: below ${schema.minimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(`${path}: above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) errors.push(`${path}: fewer than ${schema.minItems} items`);
    if (schema.items) value.forEach((item, i) => errors.push(...validate(schema.items as Schema, item, `${path}[${i}]`)));
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, Schema>;
    for (const req of (schema.required ?? []) as string[]) {
      if (!(req in obj)) errors.push(`${path}: missing required "${req}"`);
    }
    for (const [key, v] of Object.entries(obj)) {
      if (props[key]) errors.push(...validate(props[key], v, `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}: unexpected property "${key}"`);
    }
  }
  return errors;
}
