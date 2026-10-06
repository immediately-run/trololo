// Batches and register operations (COLLABORATION_SESSIONS §3.8, §15.5): the file format, the
// total order, and validity as a pure function of the batch, the pinned layout and the contents
// at the batch's recorded base.

import { canonicalJson, cmp, codePointLength, parseRecord, type Json } from './canonical';
import {
  checkGroupValue,
  isProtectedPath,
  layoutFromMarker,
  MARKER_PATH,
  matchPath,
  nonMapGroups,
  resolveGroup,
  type Layout,
} from './layout';
import type { Tree } from './ports';

export { cmp };

export const BATCH_VERSION = 1;
export const LAMPORT_LIMIT = 2 ** 48;
export const CONTROL_PREFIX = '_session/';
export const CONTROL_GROUP = '$value';

export interface Op {
  readonly path: string;
  readonly group: string;
  readonly value: Json;
}

export interface BatchBody {
  readonly v: number;
  readonly actor: string;
  readonly seq: number;
  readonly lamport: number;
  readonly base: string;
  readonly prev: string;
  readonly time: string;
  readonly ops: readonly Op[];
}

/** A batch file as received from the session log. */
export interface Received {
  /** `<actor>/<seq>` taken from the file path — the slot the batch occupies. */
  readonly key: string;
  readonly path: string;
  readonly actor: string;
  readonly seq: number;
  readonly bytes: Uint8Array;
  readonly hash: string;
  /** The parsed body, or null when the file is invalid whatever the base (`shapeError`). */
  readonly body: BatchBody | null;
  readonly shapeError: string | null;
  /** A batch of `_session/` operations only: its validity never depends on a base (§15.5). */
  readonly controlOnly: boolean;
}

/** The position of one operation in the §3.8 order. */
export interface OpRef {
  readonly lamport: number;
  readonly actor: string;
  readonly seq: number;
  readonly index: number;
}

/** `(lamport, actor, seq, index-in-batch)`; the greatest wins. */
export function compareOrder(a: OpRef, b: OpRef): number {
  if (a.lamport !== b.lamport) return a.lamport < b.lamport ? -1 : 1;
  const c = cmp(a.actor, b.actor);
  if (c !== 0) return c;
  if (a.seq !== b.seq) return a.seq < b.seq ? -1 : 1;
  return a.index < b.index ? -1 : a.index > b.index ? 1 : 0;
}

export function opId(actor: string, seq: number, index: number): string {
  return `${actor}/${seq}/${index}`;
}

export function batchKey(actor: string, seq: number): string {
  return `${actor}/${seq}`;
}

export const ACTOR_PATTERN = /^[A-Za-z0-9-]{1,39}\.[0-9a-z]{8}\.[0-9a-z]{8}$/;
const BATCH_PATH = /^batches\/([^/]+)\/([1-9][0-9]{0,14})\.json$/;
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export function batchPath(actor: string, seq: number): string {
  return `batches/${actor}/${seq}.json`;
}

export function parseBatchPath(path: string): { actor: string; seq: number } | null {
  const m = BATCH_PATH.exec(path);
  if (!m || !ACTOR_PATTERN.test(m[1])) return null;
  return { actor: m[1], seq: Number(m[2]) };
}

/** The login part of an actor id (`<login>.<device>.<tab>`). */
export function actorLogin(actor: string): string {
  const dot = actor.indexOf('.');
  return dot < 0 ? actor : actor.slice(0, dot);
}

/** The exact bytes of a batch file: canonical JSON, one trailing newline. */
export function encodeBatch(body: BatchBody): Uint8Array {
  return new TextEncoder().encode(canonicalJson(body as unknown as Json) + '\n');
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Decodes a batch file. Everything checkable without the base is checked here: the path, the
 * envelope fields, the operation shapes, and every `_session/` operation in full.
 */
export function decodeBatch(path: string, bytes: Uint8Array, hash: string): Received {
  const slot = parseBatchPath(path);
  const actor = slot?.actor ?? '';
  const seq = slot?.seq ?? 0;
  const key = batchKey(actor, seq);
  const fail = (shapeError: string): Received => ({
    key, path, actor, seq, bytes, hash, body: null, shapeError, controlOnly: false,
  });
  if (!slot) return fail('path is not batches/<actor>/<seq>.json');

  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return fail('not JSON');
  }
  if (!isObject(raw)) return fail('not an object');
  const { v, actor: a, seq: s, lamport, base, prev, time, ops } = raw;
  if (v !== BATCH_VERSION) return fail('v');
  if (a !== actor || s !== seq) return fail('path does not match actor and seq');
  if (typeof lamport !== 'number' || !Number.isInteger(lamport) || lamport < 0 || lamport >= LAMPORT_LIMIT) {
    return fail('lamport out of range');
  }
  if (typeof base !== 'string' || !SHA.test(base)) return fail('base');
  if (typeof prev !== 'string' || (seq === 1 ? prev !== '' : !/^[0-9a-f]{64}$/.test(prev))) return fail('prev');
  if (typeof time !== 'string') return fail('time');
  if (!Array.isArray(ops)) return fail('ops');
  const known = new Set(['v', 'actor', 'seq', 'lamport', 'base', 'prev', 'time', 'ops']);
  for (const k of Object.keys(raw)) if (!known.has(k)) return fail(`unknown key ${k}`);

  let control = 0;
  for (const op of ops) {
    if (!isObject(op) || typeof op.path !== 'string' || typeof op.group !== 'string' || !('value' in op)) {
      return fail('operation shape');
    }
    if (Object.keys(op).length !== 3) return fail('operation shape');
    if (op.path.startsWith(CONTROL_PREFIX)) {
      const err = checkControlOp(op.path, op.group, op.value);
      if (err) return fail(err);
      control++;
    }
  }
  const body = raw as unknown as BatchBody;
  return { key, path, actor, seq, bytes, hash, body, shapeError: null, controlOnly: ops.length > 0 && control === ops.length };
}

/** `_session/` operations (§15.5): `terms` and `frozen`; locks arrive with phase P3. */
function checkControlOp(path: string, group: string, value: unknown): string | null {
  if (group !== CONTROL_GROUP) return `${path}: group must be ${CONTROL_GROUP}`;
  if (path === '_session/terms') {
    if (!isObject(value) || Object.keys(value).length !== 1 || typeof value.name !== 'string') return 'terms value';
    const n = codePointLength(value.name);
    return n >= 1 && n <= 200 ? null : 'terms name length';
  }
  if (path === '_session/frozen') {
    if (!isObject(value) || Object.keys(value).length !== 2) return 'frozen value';
    if (value.reason !== 'layout' && value.reason !== 'rewrite' && value.reason !== 'integrity') return 'frozen reason';
    return typeof value.at === 'string' && SHA.test(value.at) ? null : 'frozen at';
  }
  return `${path}: unknown control record`;
}

export interface ContentValidity {
  readonly valid: boolean;
  readonly reason?: string;
  /** Record paths this batch creates (it writes every non-map group of a record absent at its base). */
  readonly creates: ReadonlySet<string>;
}

/**
 * Validity of a decoded, non-control-only batch against the pinned layout and the contents at
 * its base (§3.8). Invalid means invalid in its entirety, identically on every replica.
 */
export function contentValidity(body: BatchBody, layout: Layout, baseTree: Tree): ContentValidity {
  const none = new Set<string>();
  const invalid = (reason: string): ContentValidity => ({ valid: false, reason, creates: none });

  // §3.1: a batch based on or after a layout change is invalid.
  if (layoutFromMarker(baseTree.get(MARKER_PATH))?.fingerprint !== layout.fingerprint) {
    return invalid('the layout at the batch base differs from the pinned layout');
  }

  const written = new Map<string, Set<string>>();
  const immutableWritten = new Set<string>();
  for (const op of body.ops) {
    if (op.path.startsWith(CONTROL_PREFIX)) continue;
    if (isProtectedPath(op.path)) return invalid(`${op.path}: protected path`);
    const m = matchPath(layout, op.path);
    if (!m) return invalid(`${op.path}: matches no record set`);
    if (m.set.mergeType !== 'register') return invalid(`${op.path}: not a register record set`);
    const ref = resolveGroup(m.set, op.group);
    if (!ref) return invalid(`${op.path}: unknown group ${op.group}`);
    if (!checkGroupValue(m.set, ref, op.value)) return invalid(`${op.path}#${op.group}: value`);
    let set = written.get(op.path);
    if (!set) written.set(op.path, (set = new Set()));
    set.add(op.group);
    if (ref.kind === 'group' && ref.immutable) immutableWritten.add(op.path);
  }

  const creates = new Set<string>();
  for (const [path, groups] of written) {
    const m = matchPath(layout, path)!;
    const absent = parseRecord(baseTree.get(path)) === null;
    const all = nonMapGroups(m.set).every((g) => groups.has(g));
    if (absent && all) creates.add(path);
    else if (immutableWritten.has(path)) return invalid(`${path}: immutable field outside a create batch`);
  }
  return { valid: true, creates };
}
