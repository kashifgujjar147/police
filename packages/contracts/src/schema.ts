// Shared validation schemas (TS §8.1, §22.1). In-repo validator with a Zod-like surface;
// see docs/DECISIONS_AND_ASSUMPTIONS.md (DEC-04) for why Zod itself is not used in this build.
export type Issue = { path: string; code: string; message: string };

export interface Schema<T> {
  readonly _t?: T;
  readonly isOptional?: boolean;
  parse(value: unknown, path: string, issues: Issue[]): T;
  json(): Record<string, unknown>;
}
export type Infer<S> = S extends Schema<infer T> ? T : never;

const add = (issues: Issue[], path: string, code: string, message: string) => {
  issues.push({ path, code, message });
};

function string(o: { min?: number; max?: number; pattern?: RegExp; trim?: boolean } = {}): Schema<string> {
  const max = o.max ?? 500;
  return {
    parse(v, p, i) {
      if (typeof v !== 'string') { add(i, p, 'TYPE', 'must be a string'); return '' ; }
      const s = o.trim === false ? v : v.trim();
      if (s.length < (o.min ?? 0)) add(i, p, 'TOO_SHORT', `must be at least ${o.min} characters`);
      if (s.length > max) add(i, p, 'TOO_LONG', `must be at most ${max} characters`);
      if (o.pattern && !o.pattern.test(s)) add(i, p, 'FORMAT', 'has an invalid format');
      return s;
    },
    json: () => ({ type: 'string', minLength: o.min, maxLength: max, pattern: o.pattern?.source }),
  };
}
function number(o: { min?: number; max?: number; int?: boolean } = {}): Schema<number> {
  return {
    parse(v, p, i) {
      if (typeof v !== 'number' || !Number.isFinite(v)) { add(i, p, 'TYPE', 'must be a number'); return 0; }
      if (o.int && !Number.isInteger(v)) add(i, p, 'TYPE', 'must be an integer');
      if (o.min !== undefined && v < o.min) add(i, p, 'TOO_SMALL', `must be ≥ ${o.min}`);
      if (o.max !== undefined && v > o.max) add(i, p, 'TOO_LARGE', `must be ≤ ${o.max}`);
      return v;
    },
    json: () => ({ type: o.int ? 'integer' : 'number', minimum: o.min, maximum: o.max }),
  };
}
function boolean(): Schema<boolean> {
  return {
    parse(v, p, i) { if (typeof v !== 'boolean') { add(i, p, 'TYPE', 'must be true or false'); return false; } return v; },
    json: () => ({ type: 'boolean' }),
  };
}
function enumOf<const T extends readonly string[]>(values: T): Schema<T[number]> {
  return {
    parse(v, p, i) {
      if (typeof v !== 'string' || !values.includes(v)) { add(i, p, 'ENUM', `must be one of: ${values.join(', ')}`); return values[0] as T[number]; }
      return v as T[number];
    },
    json: () => ({ type: 'string', enum: [...values] }),
  };
}
function array<T>(item: Schema<T>, o: { min?: number; max?: number } = {}): Schema<T[]> {
  const max = o.max ?? 500;
  return {
    parse(v, p, i) {
      if (!Array.isArray(v)) { add(i, p, 'TYPE', 'must be a list'); return []; }
      if (v.length < (o.min ?? 0)) add(i, p, 'TOO_SHORT', `needs at least ${o.min} item(s)`);
      if (v.length > max) { add(i, p, 'TOO_LONG', `at most ${max} items`); return []; }
      return v.map((x, n) => item.parse(x, `${p}[${n}]`, i));
    },
    json: () => ({ type: 'array', items: item.json(), maxItems: max }),
  };
}
function optional<T>(inner: Schema<T>): Schema<T | undefined> {
  return {
    isOptional: true,
    parse(v, p, i) { return v === undefined || v === null ? undefined : inner.parse(v, p, i); },
    json: () => inner.json(),
  };
}
type Shape = Record<string, Schema<unknown>>;
type ObjOut<S extends Shape> = { [K in keyof S]: Infer<S[K]> };
function object<S extends Shape>(shape: S): Schema<ObjOut<S>> {
  return {
    parse(v, p, i) {
      const out: Record<string, unknown> = {};
      if (typeof v !== 'object' || v === null || Array.isArray(v)) { add(i, p, 'TYPE', 'must be an object'); return out as ObjOut<S>; }
      const src = v as Record<string, unknown>;
      for (const k of Object.keys(src)) {
        // Unknown fields rejected (TS §8.1); operator-style keys rejected (NoSQL-injection guard, TS §22.1).
        if (!(k in shape)) add(i, p ? `${p}.${k}` : k, 'UNKNOWN_FIELD', 'is not an accepted field');
      }
      for (const [k, sch] of Object.entries(shape)) {
        const child = p ? `${p}.${k}` : k;
        if (src[k] === undefined || src[k] === null) {
          if (!sch.isOptional) add(i, child, 'REQUIRED', 'is required');
          continue;
        }
        const val = sch.parse(src[k], child, i);
        if (val !== undefined) out[k] = val;
      }
      return out as ObjOut<S>;
    },
    json: () => ({
      type: 'object', additionalProperties: false,
      properties: Object.fromEntries(Object.entries(shape).map(([k, x]) => [k, x.json()])),
      required: Object.entries(shape).filter(([, x]) => !x.isOptional).map(([k]) => k),
    }),
  };
}
/** Free-form JSON object (settings, labels). Keys are still guarded against operator injection. */
function json(maxDepth = 6): Schema<Record<string, unknown>> {
  const walk = (v: unknown, p: string, i: Issue[], d: number): void => {
    if (d > maxDepth) { add(i, p, 'TOO_DEEP', 'is nested too deeply'); return; }
    if (Array.isArray(v)) { v.forEach((x, n) => walk(x, `${p}[${n}]`, i, d + 1)); return; }
    if (typeof v === 'object' && v !== null) {
      for (const [k, x] of Object.entries(v)) {
        if (k.startsWith('$') || k.includes('.') || k === '__proto__' || k === 'constructor') add(i, `${p}.${k}`, 'UNSAFE_KEY', 'key is not allowed');
        walk(x, `${p}.${k}`, i, d + 1);
      }
    }
  };
  return {
    parse(v, p, i) {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) { add(i, p, 'TYPE', 'must be an object'); return {}; }
      walk(v, p, i, 0);
      return v as Record<string, unknown>;
    },
    json: () => ({ type: 'object' }),
  };
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export const s = {
  string, number, boolean, enum: enumOf, array, optional, object, json,
  id: () => string({ min: 1, max: 64, pattern: ID }),
  uuid: () => string({ min: 36, max: 36, pattern: UUID }),
  iso: (): Schema<string> => {
    const base = string({ max: 30, pattern: ISO });
    return {
      parse(v, p, i) { const x = base.parse(v, p, i); if (x && Number.isNaN(Date.parse(x))) add(i, p, 'FORMAT', 'is not a valid timestamp'); return x; },
      json: () => ({ type: 'string', format: 'date-time' }),
    };
  },
  date: () => string({ min: 10, max: 10, pattern: /^\d{4}-\d{2}-\d{2}$/ }),
  time: () => string({ min: 5, max: 5, pattern: /^([01]\d|2[0-3]):[0-5]\d$/ }),
  lat: () => number({ min: -90, max: 90 }),
  lon: () => number({ min: -180, max: 180 }),
};

export function validate<T>(schema: Schema<T>, value: unknown): { ok: true; value: T } | { ok: false; issues: Issue[] } {
  const issues: Issue[] = [];
  const out = schema.parse(value, '', issues);
  return issues.length ? { ok: false, issues } : { ok: true, value: out };
}
