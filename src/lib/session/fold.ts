// The adopted-base chain, the status fold and `Snap` (COLLABORATION_SESSIONS §5.3–§5.5).
//
// This is the incremental implementation: statuses are updated base by base as the chain grows,
// and a batch that arrives after its base was passed gets its status from the closed form of
// §5.5 "Late arrival". `test/oracle/reference.ts` recomputes the same from scratch.

import { compareOrder, type OpRef } from './batch';
import { mapKeys, normalizeGroup, parseRecord, sameValue, type Json } from './canonical';
import { matchPath, nonMapGroups, resolveGroup, type GroupRef, type Layout, type RecordSet } from './layout';
import type { Tree } from './ports';
import type { Vector } from './vectors';

export type Status =
  | { readonly kind: 'pending' }
  | { readonly kind: 'published'; readonly at: number }
  | { readonly kind: 'superseded'; readonly at: number };

const PENDING: Status = { kind: 'pending' };

/** One applied content operation (its batch is valid and its base adopted). */
export interface AppliedOp extends OpRef {
  readonly id: string;
  readonly batch: string;
  readonly path: string;
  readonly group: string;
  readonly set: RecordSet;
  readonly ref: GroupRef;
  /** The normalised value written. */
  readonly value: Json;
  /** The batch writes every non-map group of this record, which was absent at the batch's base. */
  readonly create: boolean;
  /** Chain index of the batch's base. */
  readonly base: number;
}

export interface ChainEntry {
  readonly index: number;
  readonly sha: string;
  readonly message: string;
  readonly tree: Tree;
  /** `V_B` — the publish vector the commit records; empty for a commit that is not a publish. */
  readonly vector: Vector;
  /** `C_B` — `(path, group)` keys that changed relative to `A_B`. Empty for the start base. */
  readonly changed: ReadonlySet<string>;
}

export function groupKey(path: string, group: string): string {
  return path + '\u0000' + group;
}

export interface SnapRecord {
  readonly path: string;
  readonly set: RecordSet;
  readonly id: string | null;
  /** The parsed file at the base, or null when absent or unreadable. */
  readonly base: Record<string, Json> | null;
  /** The file exists at the base, or a non-superseded create batch for it is in the set. */
  readonly exists: boolean;
  /** Some operation of the set names this record. */
  readonly touched: boolean;
  /** Group → normalised value (every non-map group, and every map entry seen on either side). */
  readonly values: ReadonlyMap<string, Json>;
  /** Group → the pending operation whose value `values` carries. */
  readonly from: ReadonlyMap<string, AppliedOp>;
}

export type Board = ReadonlyMap<string, SnapRecord>;

function registerMatch(layout: Layout, path: string) {
  const m = matchPath(layout, path);
  return m && m.set.mergeType === 'register' ? m : null;
}

/** The register records of a tree as a board with no operations — "the contents at P". */
export function contentsOf(layout: Layout, tree: Tree): Board {
  return snap(layout, tree, [], () => PENDING);
}

/**
 * `Snap(P, S)` (§5.5): for each `(path, group)`, the §3.8 winner among the operations of `S` not
 * superseded at P; its value if it is pending at P, else the contents at P. Immutable groups
 * take the least such operation, and keep the base value when the record exists at P.
 */
export function snap(
  layout: Layout,
  tree: Tree,
  ops: readonly AppliedOp[],
  statusAtP: (op: AppliedOp) => Status,
): Board {
  const byPath = new Map<string, AppliedOp[]>();
  for (const op of ops) {
    let list = byPath.get(op.path);
    if (!list) byPath.set(op.path, (list = []));
    list.push(op);
  }
  const paths = new Set<string>(byPath.keys());
  for (const p of tree.keys()) if (registerMatch(layout, p)) paths.add(p);

  const board = new Map<string, SnapRecord>();
  for (const path of paths) {
    const m = registerMatch(layout, path);
    if (!m) continue;
    const set = m.set;
    const base = parseRecord(tree.get(path));
    const pathOps = byPath.get(path) ?? [];

    const createBatches = new Map<string, boolean>();
    for (const op of pathOps) {
      if (!op.create) continue;
      // A create batch makes the record exist only while every operation of it is pending at P:
      // once published, the file at the base speaks (an outside delete of it wins).
      const ok = statusAtP(op).kind === 'pending';
      createBatches.set(op.batch, (createBatches.get(op.batch) ?? true) && ok);
    }
    const exists = base !== null || [...createBatches.values()].some((ok) => ok);

    const groups = new Map<string, GroupRef>();
    for (const g of nonMapGroups(set)) groups.set(g, resolveGroup(set, g)!);
    for (const map of set.maps) for (const k of mapKeys(base, map)) groups.set(`${map}.${k}`, resolveGroup(set, `${map}.${k}`)!);
    for (const op of pathOps) groups.set(op.group, op.ref);

    const values = new Map<string, Json>();
    const from = new Map<string, AppliedOp>();
    for (const [g, ref] of groups) {
      if (!exists) {
        values.set(g, normalizeGroup(set, ref, null));
        continue;
      }
      const immutable = ref.kind === 'group' && ref.immutable;
      if (immutable && base !== null) {
        values.set(g, normalizeGroup(set, ref, base));
        continue;
      }
      let winner: AppliedOp | null = null;
      for (const op of pathOps) {
        if (op.group !== g || statusAtP(op).kind === 'superseded') continue;
        if (winner === null) winner = op;
        else {
          const c = compareOrder(op, winner);
          if (immutable ? c < 0 : c > 0) winner = op;
        }
      }
      if (winner !== null && statusAtP(winner).kind === 'pending') {
        values.set(g, winner.value);
        from.set(g, winner);
      } else {
        values.set(g, normalizeGroup(set, ref, base));
      }
    }
    board.set(path, { path, set, id: m.id, base, exists, touched: pathOps.length > 0, values, from });
  }
  return board;
}

/** `C_B` (§5.5 step 2): every `(path, group)` whose normalised value at `B` differs from `A_B`. */
export function changedGroups(ancestor: Board, atB: Board): Set<string> {
  const changed = new Set<string>();
  const paths = new Set<string>([...ancestor.keys(), ...atB.keys()]);
  for (const path of paths) {
    const a = ancestor.get(path);
    const b = atB.get(path);
    const set = (a ?? b)!.set;
    const groups = new Set<string>([...(a?.values.keys() ?? []), ...(b?.values.keys() ?? [])]);
    for (const g of groups) {
      const ref = resolveGroup(set, g)!;
      const va = a?.values.get(g) ?? normalizeGroup(set, ref, null);
      const vb = b?.values.get(g) ?? normalizeGroup(set, ref, null);
      if (!sameValue(va, vb)) changed.add(groupKey(path, g));
    }
  }
  return changed;
}

/**
 * The incremental fold: the adopted chain and every applied operation's status at the newest
 * adopted base.
 */
export class Fold {
  readonly chain: ChainEntry[] = [];
  private readonly ops = new Map<string, AppliedOp>();
  private readonly statuses = new Map<string, Status>();
  private readonly layout: Layout;

  constructor(layout: Layout, start: { sha: string; message: string; tree: Tree }) {
    this.layout = layout;
    this.chain.push({ index: 0, ...start, vector: new Map(), changed: new Set() });
  }

  get head(): ChainEntry {
    return this.chain[this.chain.length - 1];
  }

  status(op: AppliedOp): Status {
    return this.statuses.get(op.id) ?? PENDING;
  }

  applied(): AppliedOp[] {
    return [...this.ops.values()];
  }

  /** Applies a batch's operations, with the status the fold would have given them (late arrival). */
  apply(batchOps: readonly AppliedOp[]): void {
    for (const op of batchOps) {
      this.ops.set(op.id, op);
      const key = groupKey(op.path, op.group);
      let status: Status = PENDING;
      for (let i = op.base + 1; i < this.chain.length; i++) {
        if (this.chain[i].changed.has(key)) {
          status = { kind: 'superseded', at: i };
          break;
        }
      }
      this.statuses.set(op.id, status);
    }
  }

  /**
   * Adopts the next base `B` (§5.5 steps 1–5). `covered` is the set of batch keys `V_B` covers;
   * every operation of those batches is applied by now (§5.4 a).
   */
  adopt(commit: { sha: string; message: string; tree: Tree }, vector: Vector, covered: ReadonlySet<string>): ChainEntry {
    const p = this.head;
    const inV = this.applied().filter((op) => covered.has(op.batch));
    const ancestor = snap(this.layout, p.tree, inV, (op) => this.status(op));
    const atB = contentsOf(this.layout, commit.tree);
    const changed = changedGroups(ancestor, atB);
    const index = this.chain.length;

    for (const op of this.ops.values()) {
      if (this.status(op).kind !== 'pending') continue;
      if (changed.has(groupKey(op.path, op.group))) this.statuses.set(op.id, { kind: 'superseded', at: index });
      else if (covered.has(op.batch)) this.statuses.set(op.id, { kind: 'published', at: index });
    }
    const entry: ChainEntry = { index, ...commit, vector, changed };
    this.chain.push(entry);
    return entry;
  }

  /** Rolls the chain back to `index` (a freeze at an earlier base): later statuses revert. */
  rollback(index: number): AppliedOp[] {
    this.chain.length = index + 1;
    const removed: AppliedOp[] = [];
    for (const op of [...this.ops.values()]) {
      if (op.base > index) {
        this.ops.delete(op.id);
        this.statuses.delete(op.id);
        removed.push(op);
        continue;
      }
      const s = this.status(op);
      if (s.kind !== 'pending' && s.at > index) this.statuses.set(op.id, PENDING);
    }
    return removed;
  }

  /** Effective state (§5.5): `Snap(B_n, all applied operations)`. */
  effective(): Board {
    return snap(this.layout, this.head.tree, this.applied(), (op) => this.status(op));
  }

  /** `Snap(B_n, ops)` for a subset — what a publisher of those operations writes. */
  snapOf(ops: readonly AppliedOp[]): Board {
    return snap(this.layout, this.head.tree, ops, (op) => this.status(op));
  }
}
