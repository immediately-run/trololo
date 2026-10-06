// The reference oracle (R3-969). It recomputes, from scratch and for one replica's view (the
// commits it was offered and the batch files it holds), everything the engine maintains
// incrementally — by direct transcription of COLLABORATION_SESSIONS §3.8, §5.4, §5.5, §6.2,
// §15.3–§15.6.
//
// Independence rule: this file imports ONLY `layout.ts` and `canonical.ts` from the engine. It
// re-derives batch parsing, validity, vectors, the fold, `Snap`, publish files and trailers itself,
// in a deliberately different shape (no incremental state; a fold that walks every base in order;
// a late-arriving batch is simply "a batch" here). The simulator builds publish commits with this
// oracle, never with the engine's publish code, so a wrong assumption shared by the engine and its
// own tests cannot make the suite pass.

import { createHash } from 'node:crypto';
import {
  canonicalJson,
  mapKeys,
  normalizeGroup,
  parseRecord,
  serializeRecord,
  type Json,
} from '../../src/lib/session/canonical';
import {
  checkGroupValue,
  layoutFromMarker,
  matchPath,
  nonMapGroups,
  resolveGroup,
  type GroupRef,
  type Layout,
  type RecordSet,
} from '../../src/lib/session/layout';

export interface OracleCommit {
  readonly sha: string;
  readonly parent: string | null;
  readonly message: string;
  readonly tree: ReadonlyMap<string, string>;
}

export interface OracleInput {
  readonly layout: Layout;
  readonly sessionId: string;
  /**
   * The main line's first-parent chain from the session's start base, as the replica last read it
   * (just the start base when the head's chain does not reach it).
   */
  readonly offered: readonly OracleCommit[];
  /** Git ancestry, reflexive (the simulated history; §15.5 the stop). */
  readonly isAncestor: (ancestor: string, descendant: string) => boolean;
  /**
   * Every version of a batch file the replica has read, in the order it first read each, with
   * whether its path is log-acknowledged. The first version of a path keeps the slot.
   */
  readonly batches: ReadonlyArray<{ path: string; bytes: Uint8Array; acked: boolean }>;
}

export type OracleStatus = { kind: 'pending' } | { kind: 'published' | 'superseded'; at: number };

export interface OracleRecord {
  readonly exists: boolean;
  readonly values: Readonly<Record<string, Json>>;
}

export interface OracleResult {
  /** The chain the replica may adopt from: `offered`, cut at a freeze's stop (§15.5). */
  readonly offered: string[];
  readonly adopted: string[];
  readonly states: Map<string, 'held' | 'invalid' | 'applied'>;
  readonly statuses: Map<string, OracleStatus>;
  readonly effective: Map<string, OracleRecord>;
  readonly pending: string[];
  readonly holding: Map<string, number>;
  readonly publishVector: Map<string, number>;
  readonly frozen: { reason: string; at: string } | null;
  readonly publishFiles: Map<string, string>;
  readonly trailers: string[];
  /** §15.7 rendering of the effective state, as ids. */
  readonly rendered: {
    columns: Array<{ id: string; cards: string[] }>;
    unsorted: string[];
    archivedColumns: string[];
    deletedColumns: string[];
    archivedCards: string[];
    deletedCards: string[];
    orphans: string[];
  };
}

// ---- small helpers, local on purpose --------------------------------------------------------

const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
const lt = (a: string, b: string) => a < b; // UTF-16 code unit order (§3.8)
const order = (a: string, b: string) => (lt(a, b) ? -1 : lt(b, a) ? 1 : 0);

interface Batch {
  key: string;
  actor: string;
  seq: number;
  hash: string;
  acked: boolean;
  body: {
    lamport: number;
    base: string;
    ops: Array<{ path: string; group: string; value: Json }>;
  } | null;
  controlOnly: boolean;
}

interface Op {
  id: string;
  batch: Batch;
  index: number;
  path: string;
  group: string;
  value: Json;
  set: RecordSet;
  ref: GroupRef;
  baseIndex: number;
  create: boolean;
}

/** §3.8 order: `(lamport, actor, seq, index)`. */
function before(a: Op, b: Op): boolean {
  const la = a.batch.body!.lamport;
  const lb = b.batch.body!.lamport;
  if (la !== lb) return la < lb;
  if (a.batch.actor !== b.batch.actor) return lt(a.batch.actor, b.batch.actor);
  if (a.batch.seq !== b.batch.seq) return a.batch.seq < b.batch.seq;
  return a.index < b.index;
}

// ---- §15.5 batch files ----------------------------------------------------------------------

function readBatch(path: string, bytes: Uint8Array, acked: boolean): Batch | null {
  const m = /^batches\/([A-Za-z0-9-]{1,39}\.[0-9a-z]{8}\.[0-9a-z]{8})\/([1-9][0-9]*)\.json$/.exec(path);
  if (!m) return null;
  const actor = m[1];
  const seq = Number(m[2]);
  const shell: Batch = { key: `${actor}/${seq}`, actor, seq, hash: sha256(bytes), acked, body: null, controlOnly: false };
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return shell;
  }
  if (j === null || typeof j !== 'object' || Array.isArray(j)) return shell;
  const allowed = ['v', 'actor', 'seq', 'lamport', 'base', 'prev', 'time', 'ops'];
  if (Object.keys(j).some((k) => !allowed.includes(k))) return shell;
  if (j.v !== 1 || j.actor !== actor || j.seq !== seq) return shell;
  const lamport = j.lamport;
  if (typeof lamport !== 'number' || !Number.isInteger(lamport) || lamport < 0 || lamport >= 2 ** 48) return shell;
  if (typeof j.base !== 'string' || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(j.base)) return shell;
  if (seq === 1 ? j.prev !== '' : typeof j.prev !== 'string' || !/^[0-9a-f]{64}$/.test(j.prev)) return shell;
  if (typeof j.time !== 'string' || !Array.isArray(j.ops)) return shell;
  let control = 0;
  for (const op of j.ops as unknown[]) {
    if (op === null || typeof op !== 'object' || Array.isArray(op)) return shell;
    const o = op as Record<string, unknown>;
    if (Object.keys(o).length !== 3 || typeof o.path !== 'string' || typeof o.group !== 'string' || !('value' in o)) return shell;
    if (o.path.startsWith('_session/')) {
      if (!controlOpOk(o.path, o.group, o.value)) return shell;
      control++;
    }
  }
  const ops = j.ops as Array<{ path: string; group: string; value: Json }>;
  return { ...shell, body: { lamport, base: j.base, ops }, controlOnly: ops.length > 0 && control === ops.length };
}

function controlOpOk(path: string, group: string, value: unknown): boolean {
  if (group !== '$value' || value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (path === '_session/terms') {
    return Object.keys(v).length === 1 && typeof v.name === 'string' && [...v.name].length >= 1 && [...v.name].length <= 200;
  }
  if (path === '_session/frozen') {
    return (
      Object.keys(v).length === 2 &&
      ['layout', 'rewrite', 'integrity'].includes(v.reason as string) &&
      typeof v.at === 'string' &&
      /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(v.at)
    );
  }
  return false;
}

/** §3.8 validity against the pinned layout and the contents at the batch's base. */
function validAt(batch: Batch, layout: Layout, tree: ReadonlyMap<string, string>): { ok: boolean; creates: Set<string> } {
  const no = { ok: false, creates: new Set<string>() };
  const marker = layoutFromMarker(tree.get('immediately.run.json'));
  if (!marker || marker.fingerprint !== layout.fingerprint) return no;
  const groupsByPath = new Map<string, string[]>();
  const writesImmutable = new Set<string>();
  for (const op of batch.body!.ops) {
    if (op.path.startsWith('_session/')) continue;
    if (op.path === 'immediately.run.json' || op.path.startsWith('.github/')) return no;
    const m = matchPath(layout, op.path);
    if (!m || m.set.mergeType !== 'register') return no;
    const ref = resolveGroup(m.set, op.group);
    if (!ref || !checkGroupValue(m.set, ref, op.value)) return no;
    groupsByPath.set(op.path, [...(groupsByPath.get(op.path) ?? []), op.group]);
    if (ref.kind === 'group' && ref.immutable) writesImmutable.add(op.path);
  }
  const creates = new Set<string>();
  for (const [path, groups] of groupsByPath) {
    const set = matchPath(layout, path)!.set;
    const isCreate = parseRecord(tree.get(path)) === null && nonMapGroups(set).every((g) => groups.includes(g));
    if (isCreate) creates.add(path);
    if (writesImmutable.has(path) && !isCreate) return no;
  }
  return { ok: true, creates };
}

// ---- trailers (§15.6) -------------------------------------------------------------------------

function trailerLines(message: string, name: string): string[] {
  return message
    .split('\n')
    .filter((l) => l.startsWith(name + ':'))
    .map((l) => l.slice(name.length + 1).trim());
}

type Reading = { kind: 'external' } | { kind: 'bad' } | { kind: 'publish'; v: Map<string, number>; digest: string };

function readCommit(message: string, sessionId: string): Reading {
  const sessions = trailerLines(message, 'Collab-Session');
  if (!sessions.includes(sessionId)) return { kind: 'external' };
  const vs = trailerLines(message, 'Collab-Vector');
  const ds = trailerLines(message, 'Collab-Digest');
  if (sessions.length !== 1 || vs.length !== 1 || ds.length !== 1 || !/^[0-9a-f]{64}$/.test(ds[0])) return { kind: 'bad' };
  const v = new Map<string, number>();
  if (vs[0] === '') return { kind: 'bad' };
  for (const part of vs[0].split(';')) {
    const m = /^([A-Za-z0-9-]{1,39}\.[0-9a-z]{8}\.[0-9a-z]{8})=([1-9][0-9]*)$/.exec(part);
    if (!m || v.has(m[1])) return { kind: 'bad' };
    v.set(m[1], Number(m[2]));
  }
  return { kind: 'publish', v, digest: ds[0] };
}

function digestFor(v: Map<string, number>, slots: Map<string, Batch>): string | null {
  const lines: string[] = [];
  for (const actor of [...v.keys()].sort(order)) {
    for (let s = 1; s <= v.get(actor)!; s++) {
      const b = slots.get(`${actor}/${s}`);
      if (!b) return null;
      lines.push(`${actor} ${s} ${b.hash}\n`);
    }
  }
  return sha256(lines.join(''));
}

// ---- Snap (§5.5) ------------------------------------------------------------------------------

interface SnapRec {
  set: RecordSet;
  base: Record<string, Json> | null;
  exists: boolean;
  touched: boolean;
  values: Map<string, Json>;
  pendingFrom: Map<string, Op>;
}

function normalizedOpValue(op: Op): Json {
  const v = op.value;
  if (op.ref.kind === 'mapEntry') return v === true ? true : null;
  if (op.ref.fields.length === 1) {
    const t = op.set.fields.get(op.ref.fields[0]);
    if (v === null) return t?.kind === 'scalar' && t.scalar.kind === 'boolean' ? false : null;
    return v;
  }
  const out: Record<string, Json> = {};
  for (const f of op.ref.fields) {
    const fv = (v as Record<string, Json>)[f];
    const t = op.set.fields.get(f);
    out[f] = fv === null || fv === undefined ? (t?.kind === 'scalar' && t.scalar.kind === 'boolean' ? false : null) : fv;
  }
  return out;
}

/** `Snap(P, S)`, transcribed. `status` gives each op's status at P. */
function Snap(layout: Layout, tree: ReadonlyMap<string, string>, S: Op[], status: (op: Op) => OracleStatus): Map<string, SnapRec> {
  const out = new Map<string, SnapRec>();
  const paths = new Set<string>();
  for (const p of tree.keys()) {
    const m = matchPath(layout, p);
    if (m && m.set.mergeType === 'register') paths.add(p);
  }
  for (const op of S) paths.add(op.path);

  for (const path of [...paths].sort(order)) {
    const set = matchPath(layout, path)!.set;
    const base = parseRecord(tree.get(path));
    const mine = S.filter((op) => op.path === path);
    const notSuperseded = (op: Op) => status(op).kind !== 'superseded';

    // Existence (§15.3): parses at the base, or a create batch for it in S whose operations on it
    // are all pending at P.
    const createBatchKeys = [...new Set(mine.filter((op) => op.create).map((op) => op.batch.key))];
    const liveCreate = createBatchKeys.some((k) => mine.filter((op) => op.batch.key === k).every((op) => status(op).kind === 'pending'));
    const exists = base !== null || liveCreate;

    const groupNames = new Set<string>(nonMapGroups(set));
    for (const map of set.maps) for (const k of mapKeys(base, map)) groupNames.add(`${map}.${k}`);
    for (const op of mine) groupNames.add(op.group);

    const values = new Map<string, Json>();
    const pendingFrom = new Map<string, Op>();
    for (const g of groupNames) {
      const ref = resolveGroup(set, g)!;
      const fromBase = normalizeGroup(set, ref, exists ? base : null);
      if (!exists) {
        values.set(g, fromBase);
        continue;
      }
      const immutable = ref.kind === 'group' && ref.immutable;
      if (immutable && base !== null) {
        values.set(g, fromBase);
        continue;
      }
      const candidates = mine.filter((op) => op.group === g && notSuperseded(op));
      let w: Op | undefined;
      for (const c of candidates) {
        if (!w) w = c;
        else if (immutable ? before(c, w) : before(w, c)) w = c;
      }
      if (w && status(w).kind === 'pending') {
        values.set(g, normalizedOpValue(w));
        pendingFrom.set(g, w);
      } else values.set(g, fromBase);
    }
    out.set(path, { set, base, exists, touched: mine.length > 0, values, pendingFrom });
  }
  return out;
}

// ---- the whole computation ------------------------------------------------------------------

export function oracle(input: OracleInput): OracleResult {
  const { layout, sessionId, offered } = input;

  // Slots: one batch per (actor, seq); the replica keeps the first version it saw.
  const versions: Batch[] = [];
  const slots = new Map<string, Batch>();
  for (const f of input.batches) {
    const b = readBatch(f.path, f.bytes, f.acked);
    if (!b) continue;
    versions.push(b);
    if (!slots.has(b.key)) slots.set(b.key, b);
  }

  const contiguousBy = (ok: (b: Batch) => boolean): Map<string, number> => {
    const v = new Map<string, number>();
    const actors = new Set([...slots.values()].map((b) => b.actor));
    for (const a of actors) {
      let s = 0;
      while (slots.has(`${a}/${s + 1}`) && ok(slots.get(`${a}/${s + 1}`)!)) s++;
      if (s > 0) v.set(a, s);
    }
    return v;
  };
  const holding = contiguousBy(() => true);

  // Frozen (§15.5): every `_session/frozen` operation of a control-only batch that holds its slot,
  // plus the freeze an exhausted log implies — any version read at lamport 2^48 − 1, a slot's losing
  // version included, counts as carrying `{integrity, its base}` after its own operations. The
  // winner: a freeze that stops the chain outranks a layout freeze; then §3.8 order; then the
  // greater `at`. An announcement of an exhausted log (§15.5) is an ordinary control-only batch at the
  // ceiling, so both rules above already cover it.
  type FreezeCand = { lamport: number; actor: string; seq: number; index: number; value: { reason: string; at: string } };
  const cands: FreezeCand[] = [];
  for (const b of slots.values()) {
    if (!b.body) continue;
    const at = { lamport: b.body.lamport, actor: b.actor, seq: b.seq };
    if (b.controlOnly) {
      b.body.ops.forEach((op, index) => {
        if (op.path === '_session/frozen') cands.push({ ...at, index, value: op.value as FreezeCand['value'] });
      });
    }
  }
  for (const b of versions) {
    if (b.body && b.body.lamport === 2 ** 48 - 1) {
      cands.push({ lamport: b.body.lamport, actor: b.actor, seq: b.seq, index: b.body.ops.length, value: { reason: 'integrity', at: b.body.base } });
    }
  }
  const beats = (x: FreezeCand, y: FreezeCand): boolean => {
    const sx = x.value.reason !== 'layout';
    const sy = y.value.reason !== 'layout';
    if (sx !== sy) return sx;
    if (x.lamport !== y.lamport) return x.lamport > y.lamport;
    if (x.actor !== y.actor) return lt(y.actor, x.actor);
    if (x.seq !== y.seq) return x.seq > y.seq;
    if (x.index !== y.index) return x.index > y.index;
    return lt(y.value.at, x.value.at);
  };
  let frozenWin: FreezeCand | null = null;
  for (const c of cands) if (frozenWin === null || beats(c, frozenWin)) frozenWin = c;
  const frozen = frozenWin ? { reason: frozenWin.value.reason, at: frozenWin.value.at } : null;
  const stops = frozen !== null && frozen.reason !== 'layout';

  // §15.5 the stop: under a freeze that stops the chain, the chain ends at its last commit that is an
  // ancestor of the freeze's `at` (the start base when none is), whatever the replica had adopted.
  let reachable = offered;
  if (stops) {
    let j = 0;
    offered.forEach((c, i) => {
      if (input.isAncestor(c.sha, frozen!.at)) j = i;
    });
    reachable = offered.slice(0, j + 1);
  }

  // §5.4 (a), (c): adopt the chain's commits in order while the holding vector dominates each `V_B`.
  const chain: Array<{ commit: OracleCommit; V: Map<string, number> }> = [{ commit: reachable[0], V: new Map() }];
  for (let i = 1; i < reachable.length; i++) {
    const r = readCommit(reachable[i].message, sessionId);
    if (r.kind === 'bad') break;
    const V = r.kind === 'publish' ? r.v : new Map<string, number>();
    if ([...V].some(([a, s]) => (holding.get(a) ?? 0) < s)) break;
    if (r.kind === 'publish' && digestFor(V, slots) !== r.digest) break;
    chain.push({ commit: reachable[i], V });
  }
  const n = chain.length - 1;
  const indexOf = new Map(chain.map((c, i) => [c.commit.sha, i]));

  // Batch states and applied operations.
  const states = new Map<string, 'held' | 'invalid' | 'applied'>();
  const ops: Op[] = [];
  for (const b of slots.values()) {
    if (!b.body) {
      states.set(b.key, 'invalid');
      continue;
    }
    if (b.controlOnly) {
      states.set(b.key, 'applied');
      continue;
    }
    const bi = indexOf.get(b.body.base);
    if (bi === undefined) {
      states.set(b.key, 'held');
      continue;
    }
    const v = validAt(b, layout, chain[bi].commit.tree);
    if (!v.ok) {
      states.set(b.key, 'invalid');
      continue;
    }
    states.set(b.key, 'applied');
    b.body.ops.forEach((op, index) => {
      if (op.path.startsWith('_session/')) return;
      const m = matchPath(layout, op.path)!;
      ops.push({
        id: `${b.actor}/${b.seq}/${index}`,
        batch: b,
        index,
        path: op.path,
        group: op.group,
        value: op.value,
        set: m.set,
        ref: resolveGroup(m.set, op.group)!,
        baseIndex: bi,
        create: v.creates.has(op.path),
      });
    });
  }

  // §5.5: the status fold, base by base. An op has no status before its base is adopted.
  const status = new Map<string, OracleStatus>();
  const statusOf = (op: Op): OracleStatus => status.get(op.id) ?? { kind: 'pending' };
  for (const op of ops) if (op.baseIndex === 0) status.set(op.id, { kind: 'pending' });
  for (let k = 1; k <= n; k++) {
    const P = chain[k - 1].commit;
    const B = chain[k].commit;
    const V = chain[k].V;
    const atP = ops.filter((op) => op.baseIndex <= k - 1);
    const inV = atP.filter((op) => (V.get(op.batch.actor) ?? 0) >= op.batch.seq);
    // 1. Ancestor.
    const A = Snap(layout, P.tree, inV, statusOf);
    // 2. Changed groups.
    const atB = Snap(layout, B.tree, [], () => ({ kind: 'pending' }));
    const C = new Set<string>();
    for (const path of new Set([...A.keys(), ...atB.keys()])) {
      const a = A.get(path);
      const b = atB.get(path);
      const set = (a ?? b)!.set;
      for (const g of new Set([...(a?.values.keys() ?? []), ...(b?.values.keys() ?? [])])) {
        const ref = resolveGroup(set, g)!;
        // A group one side never mentions has its absent value there (a map key not listed).
        const va = a && a.values.has(g) ? a.values.get(g)! : normalizeGroup(set, ref, null);
        const vb = b && b.values.has(g) ? b.values.get(g)! : normalizeGroup(set, ref, null);
        if (canonicalJson(va) !== canonicalJson(vb)) C.add(`${path}\u0000${g}`);
      }
    }
    // 3. and 4. Only operations pending at P change status.
    for (const op of atP) {
      if (statusOf(op).kind !== 'pending') continue;
      const opBaseDescendsFromB = op.baseIndex >= k;
      if (C.has(`${op.path}\u0000${op.group}`) && !opBaseDescendsFromB) status.set(op.id, { kind: 'superseded', at: k });
      else if ((V.get(op.batch.actor) ?? 0) >= op.batch.seq) status.set(op.id, { kind: 'published', at: k });
      // 5. Everything else keeps its status.
    }
    // Operations based on B enter, pending.
    for (const op of ops) if (op.baseIndex === k) status.set(op.id, { kind: 'pending' });
  }

  // Effective state: Snap(B_n, all applied operations).
  const head = chain[n].commit;
  const eff = Snap(layout, head.tree, ops, statusOf);
  const effective = new Map<string, OracleRecord>();
  const pending: string[] = [];
  for (const [path, rec] of eff) {
    effective.set(path, { exists: rec.exists, values: Object.fromEntries([...rec.values].sort(([a], [b]) => order(a, b))) });
    if (!rec.exists) continue;
    for (const [g, op] of rec.pendingFrom) {
      const atBase = normalizeGroup(rec.set, resolveGroup(rec.set, g)!, rec.base);
      if (canonicalJson(rec.values.get(g)!) !== canonicalJson(atBase)) pending.push(op.id);
    }
  }
  pending.sort(order);

  // The publish this replica would make (§6.2): its publish vector on its adopted base.
  const publishVector = contiguousBy((b) => b.acked && (states.get(b.key) === 'applied' || states.get(b.key) === 'invalid'));
  const publishFilesMap = new Map<string, string>();
  const authors = new Set<string>();
  let trailers: string[] = [];
  if (!stops) {
    const S = ops.filter((op) => (publishVector.get(op.batch.actor) ?? 0) >= op.batch.seq);
    const snapP = Snap(layout, head.tree, S, statusOf);
    for (const path of [...snapP.keys()].sort(order)) {
      const rec = snapP.get(path)!;
      if (!rec.exists) continue;
      let differs = rec.base === null;
      for (const [g, op] of rec.pendingFrom) {
        const atBase = normalizeGroup(rec.set, resolveGroup(rec.set, g)!, rec.base);
        if (canonicalJson(rec.values.get(g)!) !== canonicalJson(atBase)) {
          differs = true;
          authors.add(op.batch.actor.split('.')[0]);
        }
      }
      if (differs) publishFilesMap.set(path, serializeRecord(rec.set, rec.base, rec.values));
    }
    const vectorText = [...publishVector.keys()].sort(order).map((a) => `${a}=${publishVector.get(a)}`).join(';');
    trailers = [
      `Collab-Session: ${sessionId}`,
      `Collab-Vector: ${vectorText}`,
      `Collab-Digest: ${digestFor(publishVector, slots)}`,
      ...[...authors].sort(order).map((l) => `Co-authored-by: ${l} <${l}@users.noreply.github.com>`),
    ];
  }

  return {
    rendered: render(eff),
    offered: reachable.map((c) => c.sha),
    adopted: chain.map((c) => c.commit.sha),
    states,
    statuses: new Map(ops.map((op) => [op.id, statusOf(op)])),
    effective,
    pending,
    holding,
    publishVector,
    frozen,
    publishFiles: publishFilesMap,
    trailers,
  };
}

// ---- §15.7 rendering --------------------------------------------------------------------------

function render(eff: Map<string, SnapRec>): OracleResult['rendered'] {
  type Row = { id: string; order: string; archived: boolean; deleted: boolean; column: string | null };
  const cols: Row[] = [];
  const cards: Row[] = [];
  const orphans: string[] = [];
  for (const [path, rec] of eff) {
    if (!rec.exists) {
      if (rec.touched) orphans.push(path);
      continue;
    }
    const id = path.slice(path.lastIndexOf('/') + 1, path.lastIndexOf('.'));
    const flag = (g: string) => rec.values.get(g) === true;
    if (rec.set.name === 'columns') {
      const o = rec.values.get('order');
      cols.push({ id, order: typeof o === 'string' ? o : '', archived: flag('archived'), deleted: flag('deleted'), column: null });
    } else if (rec.set.name === 'cards') {
      const pos = (rec.values.get('position') ?? {}) as { column?: Json; order?: Json };
      cards.push({
        id,
        order: typeof pos.order === 'string' ? pos.order : '',
        archived: flag('archived'),
        deleted: flag('deleted'),
        column: typeof pos.column === 'string' ? pos.column : null,
      });
    }
  }
  const sortRows = (rows: Row[]) => rows.sort((a, b) => order(a.order, b.order) || order(a.id, b.id));
  sortRows(cols);
  sortRows(cards);
  const shown = cols.filter((c) => !c.deleted && !c.archived);
  const live = cards.filter((c) => !c.deleted && !c.archived);
  const shownIds = shown.map((c) => c.id);
  return {
    columns: shown.map((c) => ({ id: c.id, cards: live.filter((x) => x.column === c.id).map((x) => x.id) })),
    unsorted: live.filter((x) => x.column === null || !shownIds.includes(x.column)).map((x) => x.id),
    archivedColumns: cols.filter((c) => c.archived && !c.deleted).map((c) => c.id),
    deletedColumns: cols.filter((c) => c.deleted).map((c) => c.id),
    archivedCards: cards.filter((c) => c.archived && !c.deleted).map((c) => c.id),
    deletedCards: cards.filter((c) => c.deleted).map((c) => c.id),
    orphans: orphans.sort(order),
  };
}
