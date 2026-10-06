// Canonical bytes and normalised equality (COLLABORATION_SESSIONS §15.4). Every file the engine
// decides to publish passes through `serializeRecord`, and every "did this group change" question
// (`C_B`, §5.5) passes through `normalizeGroup` + `sameValue`.

import type { FieldType, GroupRef, RecordSet } from './layout';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Compares strings by UTF-16 code unit — the only string order this spec uses (§3.8). */
export function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function codePointLength(s: string): number {
  let n = 0;
  for (const ch of s) {
    void ch;
    n++;
  }
  return n;
}

/**
 * Canonical JSON text: keys sorted by UTF-16 code unit at every level, strings escaped as
 * `JSON.stringify` escapes them, two-space indentation, `\n` line endings, no trailing newline
 * (callers that write a file add it).
 */
export function canonicalJson(value: Json, indent = ''): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  const inner = indent + '  ';
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return '[\n' + value.map((v) => inner + canonicalJson(v, inner)).join(',\n') + '\n' + indent + ']';
  }
  const keys = Object.keys(value).sort(cmp);
  if (keys.length === 0) return '{}';
  return (
    '{\n' +
    keys.map((k) => inner + JSON.stringify(k) + ': ' + canonicalJson(value[k], inner)).join(',\n') +
    '\n' +
    indent +
    '}'
  );
}

/** A record file's text, or null when it does not parse as a JSON object ("Unreadable"). */
export function parseRecord(text: string | undefined): Record<string, Json> | null {
  if (text === undefined) return null;
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, Json>) : null;
  } catch {
    return null;
  }
}

/** A field's normalised value: absent ≡ null; an absent boolean ≡ false. */
export function normalizeField(t: FieldType | undefined, v: Json | undefined): Json {
  if (v === undefined || v === null) {
    return t?.kind === 'scalar' && t.scalar.kind === 'boolean' ? false : null;
  }
  return v;
}

/** The normalised value of one group of a parsed record (null record = absent file). */
export function normalizeGroup(set: RecordSet, ref: GroupRef, record: Record<string, Json> | null): Json {
  if (ref.kind === 'mapEntry') {
    const m = record?.[ref.map];
    if (m === null || typeof m !== 'object' || Array.isArray(m)) return null;
    return Object.prototype.hasOwnProperty.call(m, ref.key) && m[ref.key] === true ? true : null;
  }
  if (ref.fields.length === 1) {
    const f = ref.fields[0];
    return normalizeField(set.fields.get(f), record?.[f]);
  }
  const out: Record<string, Json> = {};
  for (const f of ref.fields) out[f] = normalizeField(set.fields.get(f), record?.[f]);
  return out;
}

/** The normalised value an operation writes (ops are already valid, so only absence folds). */
export function normalizeOpValue(set: RecordSet, ref: GroupRef, value: Json): Json {
  if (ref.kind === 'mapEntry') return value === true ? true : null;
  if (ref.fields.length === 1) return normalizeField(set.fields.get(ref.fields[0]), value);
  const out: Record<string, Json> = {};
  const obj = (value ?? {}) as Record<string, Json>;
  for (const f of ref.fields) out[f] = normalizeField(set.fields.get(f), obj[f]);
  return out;
}

/** Deep equality of two normalised values. */
export function sameValue(a: Json, b: Json): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/** The keys a parsed record's map field lists with value `true`. */
export function mapKeys(record: Record<string, Json> | null, map: string): string[] {
  const m = record?.[map];
  if (m === null || m === undefined || typeof m !== 'object' || Array.isArray(m)) return [];
  return Object.keys(m).filter((k) => m[k] === true);
}

/**
 * The canonical file text of a record: the base object's unknown fields verbatim, the declared
 * fields from `values` (keyed by group name, or `<map>.<key>` for map entries), serialised by the
 * §15.4 rules — booleans written except `deleted` (only when true), null nullable fields omitted,
 * a map listing only `true` keys and omitted when empty, one trailing newline.
 */
export function serializeRecord(
  set: RecordSet,
  base: Record<string, Json> | null,
  values: ReadonlyMap<string, Json>,
): string {
  const out: Record<string, Json> = {};
  if (base) for (const [k, v] of Object.entries(base)) if (!set.fields.has(k)) out[k] = v;

  const put = (field: string, v: Json) => {
    if (v === null) return;
    if (field === 'deleted' && v === false) return;
    out[field] = v;
  };
  for (const [group, fields] of set.groups) {
    const v = values.get(group) ?? null;
    if (fields.length === 1) put(fields[0], normalizeField(set.fields.get(fields[0]), v));
    else {
      const obj = (v ?? {}) as Record<string, Json>;
      for (const f of fields) put(f, normalizeField(set.fields.get(f), obj[f]));
    }
  }
  for (const map of set.maps) {
    const entries: Record<string, Json> = {};
    for (const [g, v] of values) {
      if (v === true && g.startsWith(map + '.') && g.indexOf('.') === map.length) {
        entries[g.slice(map.length + 1)] = true;
      }
    }
    if (Object.keys(entries).length > 0) out[map] = entries;
  }
  return canonicalJson(out) + '\n';
}
