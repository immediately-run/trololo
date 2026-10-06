// The bundle marker's `layout` (COLLABORATION_SESSIONS §15.3): the record sets, their merge
// types, and the type tokens their fields use. A session pins the parsed value at its start base
// (§3.1); every validity question afterwards is asked against the pinned value.

import { isValidKey } from './fracKey';
import { canonicalJson, codePointLength, type Json } from './canonical';

export const MARKER_PATH = 'immediately.run.json';

/** A scalar type token (§15.3 table). */
export type Scalar =
  | { kind: 'string'; min: number; max: number }
  | { kind: 'id' }
  | { kind: 'fracKey' }
  | { kind: 'boolean' }
  | { kind: 'date' }
  | { kind: 'timestamp' }
  | { kind: 'login' }
  | { kind: 'labelName' };

export type FieldType =
  | { kind: 'scalar'; scalar: Scalar; nullable: boolean }
  | { kind: 'map'; key: Scalar };

export type MergeType = 'register' | 'turn-taking' | 'rich-text';

export interface RecordSet {
  readonly name: string;
  readonly match: string;
  readonly matcher: RegExp;
  /** The type the file-name stem must satisfy (`id: "filename"`), or null for a single-file set. */
  readonly idType: Scalar | null;
  readonly mergeType: MergeType;
  readonly fields: ReadonlyMap<string, FieldType>;
  /** Group name → its fields; a field in no declared group is its own group. Map fields excluded. */
  readonly groups: ReadonlyMap<string, readonly string[]>;
  readonly maps: ReadonlySet<string>;
  /** Groups only a create batch may write (a group holding any immutable field). */
  readonly immutableGroups: ReadonlySet<string>;
  readonly mediaType?: string;
  readonly maxBytes?: number;
}

export interface Layout {
  readonly version: number;
  readonly recordSets: readonly RecordSet[];
  /** The canonical bytes of the parsed `layout` value: what "deep inequality" (§3.1) compares. */
  readonly fingerprint: string;
}

export class LayoutError extends Error {}

const SCALARS: Record<string, Scalar> = {
  id: { kind: 'id' },
  fracKey: { kind: 'fracKey' },
  boolean: { kind: 'boolean' },
  date: { kind: 'date' },
  timestamp: { kind: 'timestamp' },
  login: { kind: 'login' },
  labelName: { kind: 'labelName' },
};

function parseScalar(token: string): Scalar {
  const str = /^string:(\d+)\.\.(\d+)$/.exec(token);
  if (str) {
    const min = Number(str[1]);
    const max = Number(str[2]);
    if (min > max) throw new LayoutError(`string range ${token} is empty`);
    return { kind: 'string', min, max };
  }
  const s = SCALARS[token];
  if (!s) throw new LayoutError(`unknown type token "${token}"`);
  return s;
}

/** Parses one field type token: `T`, `T|null`, or `map<K,true>`. */
export function parseFieldType(token: string): FieldType {
  const map = /^map<([^,<>]+),true>$/.exec(token);
  if (map) return { kind: 'map', key: parseScalar(map[1]) };
  if (token.endsWith('|null')) {
    return { kind: 'scalar', scalar: parseScalar(token.slice(0, -'|null'.length)), nullable: true };
  }
  return { kind: 'scalar', scalar: parseScalar(token), nullable: false };
}

function globToRegExp(glob: string): RegExp {
  let src = '^';
  for (const ch of glob) {
    if (ch === '*') src += '[^/]*';
    else src += ch.replace(/[\\^$.|?+()[\]{}]/g, '\\$&');
  }
  return new RegExp(src + '$');
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseRecordSet(name: string, raw: unknown): RecordSet {
  if (!isObject(raw)) throw new LayoutError(`record set ${name} is not an object`);
  const { match, id, mergeType, fields, groups, maps, immutable, mediaType, maxBytes } = raw;
  if (typeof match !== 'string' || match === '') throw new LayoutError(`${name}: match`);
  if (mergeType !== 'register' && mergeType !== 'turn-taking' && mergeType !== 'rich-text') {
    throw new LayoutError(`${name}: mergeType`);
  }
  if (id !== undefined && id !== 'filename') throw new LayoutError(`${name}: id must be "filename"`);

  const fieldMap = new Map<string, FieldType>();
  if (fields !== undefined) {
    if (!isObject(fields)) throw new LayoutError(`${name}: fields`);
    for (const [f, tok] of Object.entries(fields)) {
      if (typeof tok !== 'string') throw new LayoutError(`${name}.${f}: type token`);
      if (f.includes('.') || f.startsWith('$')) throw new LayoutError(`${name}.${f}: field name`);
      fieldMap.set(f, parseFieldType(tok));
    }
  }
  if (mergeType === 'register' && fieldMap.size === 0) throw new LayoutError(`${name}: no fields`);

  const mapSet = new Set<string>();
  if (maps !== undefined) {
    if (!Array.isArray(maps)) throw new LayoutError(`${name}: maps`);
    for (const m of maps) {
      if (typeof m !== 'string' || fieldMap.get(m)?.kind !== 'map') {
        throw new LayoutError(`${name}: map field ${String(m)} is not declared as map<K,true>`);
      }
      mapSet.add(m);
    }
  }
  for (const [f, t] of fieldMap) {
    if (t.kind === 'map' && !mapSet.has(f)) throw new LayoutError(`${name}.${f}: map type not in maps`);
  }

  const groupMap = new Map<string, string[]>();
  const grouped = new Set<string>();
  if (groups !== undefined) {
    if (!isObject(groups)) throw new LayoutError(`${name}: groups`);
    for (const [g, list] of Object.entries(groups)) {
      if (!Array.isArray(list) || list.length === 0) throw new LayoutError(`${name}: group ${g}`);
      if (fieldMap.has(g) || g.includes('.') || g.startsWith('$')) {
        throw new LayoutError(`${name}: group name ${g} collides with a field or is reserved`);
      }
      for (const f of list) {
        if (typeof f !== 'string' || !fieldMap.has(f) || mapSet.has(f) || grouped.has(f)) {
          throw new LayoutError(`${name}: group ${g} lists ${String(f)}`);
        }
        grouped.add(f);
      }
      groupMap.set(g, [...(list as string[])]);
    }
  }
  for (const f of fieldMap.keys()) {
    if (!grouped.has(f) && !mapSet.has(f)) groupMap.set(f, [f]);
  }

  const immutableGroups = new Set<string>();
  if (immutable !== undefined) {
    if (!Array.isArray(immutable)) throw new LayoutError(`${name}: immutable`);
    for (const f of immutable) {
      if (typeof f !== 'string' || !fieldMap.has(f) || mapSet.has(f)) {
        throw new LayoutError(`${name}: immutable ${String(f)}`);
      }
      for (const [g, list] of groupMap) if (list.includes(f)) immutableGroups.add(g);
    }
  }

  return {
    name,
    match,
    matcher: globToRegExp(match),
    idType: id === 'filename' ? SCALARS.id : null,
    mergeType,
    fields: fieldMap,
    groups: groupMap,
    maps: mapSet,
    immutableGroups,
    mediaType: typeof mediaType === 'string' ? mediaType : undefined,
    maxBytes: typeof maxBytes === 'number' ? maxBytes : undefined,
  };
}

/** Parses a marker's `layout` value. Throws `LayoutError` on any malformed part. */
export function parseLayout(raw: unknown): Layout {
  if (!isObject(raw)) throw new LayoutError('layout is not an object');
  if (typeof raw.version !== 'number') throw new LayoutError('layout.version');
  if (!isObject(raw.recordSets)) throw new LayoutError('layout.recordSets');
  const recordSets = Object.entries(raw.recordSets).map(([n, rs]) => parseRecordSet(n, rs));
  return { version: raw.version, recordSets, fingerprint: canonicalJson(raw as Json) };
}

/** The layout a marker file declares, or null when the file is absent, unparseable or has none. */
export function layoutFromMarker(text: string | undefined): Layout | null {
  if (text === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isObject(parsed) || parsed.layout === undefined) return null;
    return parseLayout(parsed.layout);
  } catch {
    return null;
  }
}

/** Paths outside every session (§4.2). */
export function isProtectedPath(path: string): boolean {
  return path === MARKER_PATH || path.startsWith('.github/') || path.startsWith('_session/');
}

export interface PathMatch {
  readonly set: RecordSet;
  /** The record id (file-name stem), or null for a single-file set. */
  readonly id: string | null;
}

/** The record set a bundle-relative path belongs to, if any; the first declared match wins. */
export function matchPath(layout: Layout, path: string): PathMatch | null {
  if (isProtectedPath(path)) return null;
  for (const set of layout.recordSets) {
    if (!set.matcher.test(path)) continue;
    if (set.idType === null) return { set, id: null };
    const file = path.slice(path.lastIndexOf('/') + 1);
    const dot = file.lastIndexOf('.');
    const stem = dot > 0 ? file.slice(0, dot) : file;
    if (!checkScalar(set.idType, stem)) return null;
    return { set, id: stem };
  }
  return null;
}

/** The group an operation's `group` names: a declared group, or `<map>.<key>` split at the first `.`. */
export type GroupRef =
  | { kind: 'group'; name: string; fields: readonly string[]; immutable: boolean }
  | { kind: 'mapEntry'; map: string; key: string };

export function resolveGroup(set: RecordSet, group: string): GroupRef | null {
  const fields = set.groups.get(group);
  if (fields) return { kind: 'group', name: group, fields, immutable: set.immutableGroups.has(group) };
  const dot = group.indexOf('.');
  if (dot <= 0) return null;
  const map = group.slice(0, dot);
  const key = group.slice(dot + 1);
  const t = set.fields.get(map);
  if (!set.maps.has(map) || t?.kind !== 'map' || !checkScalar(t.key, key)) return null;
  return { kind: 'mapEntry', map, key };
}

/** Every non-map group of a record set — what a create batch must write (§3.8, §15.3). */
export function nonMapGroups(set: RecordSet): string[] {
  return [...set.groups.keys()];
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const LOGIN = /^[A-Za-z0-9-]{1,39}$/;
const ID = /^[0-9a-z]{12}$/;

function isRealDate(s: string): boolean {
  const m = DATE.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  return d <= days;
}

export function checkScalar(s: Scalar, v: unknown): boolean {
  switch (s.kind) {
    case 'string':
      if (typeof v !== 'string') return false;
      {
        const n = codePointLength(v);
        return n >= s.min && n <= s.max;
      }
    case 'id':
      return typeof v === 'string' && ID.test(v);
    case 'fracKey':
      return typeof v === 'string' && isValidKey(v);
    case 'boolean':
      return typeof v === 'boolean';
    case 'date':
      return typeof v === 'string' && isRealDate(v);
    case 'timestamp':
      return typeof v === 'string' && TIMESTAMP.test(v);
    case 'login':
      return typeof v === 'string' && LOGIN.test(v);
    case 'labelName':
      if (typeof v !== 'string') return false;
      {
        const n = codePointLength(v);
        // eslint-disable-next-line no-control-regex
        return n >= 1 && n <= 40 && !/[\u0000-\u001f\u007f-\u009f]/.test(v);
      }
  }
}

/** Whether `value` is a valid operation value for `ref` (§3.8 "Operation"). */
export function checkGroupValue(set: RecordSet, ref: GroupRef, value: unknown): boolean {
  if (ref.kind === 'mapEntry') return value === true || value === null;
  if (ref.fields.length === 1) return checkFieldValue(set.fields.get(ref.fields[0])!, value);
  if (!isObject(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== ref.fields.length) return false;
  for (const f of ref.fields) {
    if (!Object.prototype.hasOwnProperty.call(value, f)) return false;
    if (!checkFieldValue(set.fields.get(f)!, value[f])) return false;
  }
  return true;
}

function checkFieldValue(t: FieldType, v: unknown): boolean {
  if (t.kind === 'map') return false;
  if (v === null) return t.nullable;
  return checkScalar(t.scalar, v);
}
