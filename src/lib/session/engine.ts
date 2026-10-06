// The session engine (COLLABORATION_SESSIONS §15.6): the façade the app calls. It holds what one
// replica has received and adopted, and derives everything else from the pure modules beside it.
// No platform import: the app injects history (`HistoryPort`), hashing, the clock and randomness,
// and moves batch files between `takeOutbox()` / `acknowledge()` / `receive()` and the session space.

import {
  actorLogin,
  batchKey,
  batchPath,
  BATCH_VERSION,
  cmp,
  contentValidity,
  CONTROL_PREFIX,
  decodeBatch,
  LAMPORT_LIMIT,
  encodeBatch,
  opId,
  parseBatchPath,
  type BatchBody,
  type Op,
  type Received,
} from './batch';
import { normalizeGroup, normalizeOpValue, sameValue, serializeRecord, type Json } from './canonical';
import { ControlState, frozenOp, stopsChain, termsOp, type FreezeReason, type Frozen } from './control';
import { boardView, type BoardView } from './effective';
import { Fold, type AppliedOp, type Board, type Status } from './fold';
import { keyForDrop, rebalancedKeys, type RandomInt } from './fracKey';
import { layoutFromMarker, MARKER_PATH, matchPath, resolveGroup, type Layout, type RecordSet } from './layout';
import type { ChainCommit, Clock, Hash, HistoryPort, LogEntry } from './ports';
import {
  buildTrailers,
  commitMessage,
  publishAuthors,
  publishFiles,
  readTrailers,
  vectorDigest,
} from './publish';
import { contiguous, covered, dominates, type Vector } from './vectors';

export interface EngineOptions {
  readonly sessionId: string;
  /** The layout pinned at session start (§3.1), from `session.json`. */
  readonly layout: Layout;
  /** The session's start base. */
  readonly start: ChainCommit;
  /** `<login>.<device>.<tab>` (§15.5). */
  readonly actor: string;
  /** The bundle's history verbs (§16): `sync` reads the main line, and the freeze stop (§15.5) asks `isAncestor`. */
  readonly history: HistoryPort;
  readonly hash: Hash;
  readonly clock: Clock;
  readonly random: RandomInt;
}

export type BatchState = 'held' | 'invalid' | 'applied';

export interface OutgoingBatch {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface PendingOp {
  readonly id: string;
  readonly actor: string;
  readonly path: string;
  readonly group: string;
  readonly value: Json;
}

export interface SupersededOp extends PendingOp {
  /** The base at which the outside change won. */
  readonly at: string;
}

export interface PublishPlan {
  readonly parent: string;
  readonly vector: Vector;
  /** Path → canonical text. */
  readonly files: ReadonlyMap<string, string>;
  readonly trailers: readonly string[];
  readonly message: string;
  /** §6.3: a publish is needed iff the files are non-empty. */
  readonly needed: boolean;
}

export class FrozenError extends Error {}
export class NotReadyError extends Error {}
/** This replica keeps a batch at the lamport ceiling of §3.8's [0, 2^48) range, so no further batch can be issued. */
export class LamportExhausted extends Error {
  constructor() {
    super('the lamport space is exhausted; restart the session');
  }
}
/** A move would need a key longer than the budget (§3.4): propose `rebalance`, never do it silently. */
export class RebalanceNeeded extends Error {
  readonly column: string | null;
  constructor(column: string | null) {
    super('the list needs an attended rebalancing');
    this.column = column;
  }
}

const ID_DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';
/** How far `sync` walks first parents looking for a known commit before calling it a rewrite. */
const MAX_WALK = 10_000;

export class SessionEngine {
  readonly sessionId: string;
  readonly layout: Layout;
  readonly actor: string;
  private readonly history: HistoryPort;
  private readonly hash: Hash;
  private readonly clock: Clock;
  private readonly random: RandomInt;

  private readonly slots = new Map<string, Map<number, Received>>();
  private readonly acked = new Set<string>();
  private readonly states = new Map<string, BatchState>();
  private readonly reasons = new Map<string, string>();
  private readonly control: ControlState;
  private readonly fold: Fold;
  /** The main line's first-parent chain from the start base, as of the last sync — never cut by a stop. */
  private offered: ChainCommit[];
  /**
   * The head `offered` was last walked from. It differs from `offered`'s tip only when the head's chain
   * does not reach the start base; remembering it keeps a poll of that head from walking again.
   */
  private walkedHead: string | null = null;
  /**
   * Index on `offered` past which a rewrite or integrity freeze stops adoption (§15.5 the stop),
   * cached under the winning freeze's `at` and the chain's tip.
   */
  private stopKey = '';
  private stopIndex = Infinity;
  private lamportMax = -1;
  private ownSeq = 0;
  private ownPrev = '';
  private logRead = false;
  private readonly freezeIssued = new Set<FreezeReason>();
  private deferredFreezes: Frozen[] = [];
  /** A second version was read before the log was read in full: announce once it is (§15.5). */
  private announcePending = false;
  /** The start-base freeze has been written by this replica (§15.5 "Announcing it"). */
  private announced = false;
  /** The last stop computed on a refused ancestry question; a poll of an unchanged head settles again to retry it. */
  private stopUnanswered = false;
  private outbox: OutgoingBatch[] = [];
  private readonly dismissed = new Set<string>();
  private lock: Promise<unknown> = Promise.resolve();

  constructor(o: EngineOptions) {
    this.sessionId = o.sessionId;
    this.layout = o.layout;
    this.actor = o.actor;
    this.history = o.history;
    this.hash = o.hash;
    this.clock = o.clock;
    this.random = o.random;
    this.offered = [o.start];
    this.fold = new Fold(o.layout, o.start);
    this.control = new ControlState(o.start.sha);
  }

  /** Serialises every mutation: inputs arrive from several async sources. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  // ---- inputs ------------------------------------------------------------------------------

  /** The session log has been read once in full; batches may now be issued (§3.8). */
  markLogRead(): Promise<void> {
    return this.exclusive(async () => {
      this.logRead = true;
      // Conditions found while reading (an integrity failure, a layout change) freeze now.
      const deferred = this.deferredFreezes;
      this.deferredFreezes = [];
      for (const f of deferred) await this.freeze(f.reason, f.at);
      if (this.announcePending) await this.announce();
      await this.settle();
    });
  }

  /** A batch file read from the session log (acknowledged by having been read). */
  receive(path: string, bytes: Uint8Array): Promise<void> {
    return this.exclusive(async () => {
      const hash = await this.hash(bytes);
      await this.ingest(path, bytes, hash, true);
      await this.settle();
    });
  }

  /** The space write of one of this replica's batches has resolved (§15.5). */
  acknowledge(path: string): void {
    const slot = parseBatchPath(path);
    if (slot) this.acked.add(batchKey(slot.actor, slot.seq));
  }

  /** Offers the next first-parent commit of the main line. */
  offer(commit: ChainCommit): Promise<void> {
    return this.exclusive(async () => {
      this.pushOffered(commit);
      this.walkedHead = null;
      await this.settle();
    });
  }

  /** Reads the main line through the history verbs and offers every new first-parent commit. */
  sync(): Promise<void> {
    return this.exclusive(async () => {
      if (!this.logRead) return; // a freeze may be needed, and nothing can be written yet
      const history = this.history;
      const head = await history.head();
      if (head === this.walkedHead || head === this.offered[this.offered.length - 1].sha) {
        if (this.stopUnanswered) await this.settle(); // nothing new to walk, but the stop is still to be asked
        return;
      }
      // Walk the head's first-parent chain (§5.3) back to a commit we were already offered.
      const known = new Map(this.offered.map((c, i) => [c.sha, i]));
      const fresh: LogEntry[] = [];
      let k = -1;
      let cursor: string | null = head;
      walk: while (cursor !== null && fresh.length < MAX_WALK) {
        const page = await history.log(cursor, 100);
        if (page.length === 0) break;
        for (const e of page) {
          if (fresh.length >= MAX_WALK) break walk;
          const i = known.get(e.sha);
          if (i !== undefined) {
            k = i;
            break walk;
          }
          fresh.push(e);
          cursor = e.parent;
        }
      }
      const adopted = this.fold.chain.length - 1;
      if (k < adopted) {
        // §15.7: the head no longer has our adopted base on its first-parent chain — a rewrite
        // (a force-push, or a merge whose first parent skips it). Freeze at the last adopted base
        // still on the chain (unless a stop is already in force) and, in every case, drop what the
        // rewrite removed. Where the chain then stops is the §15.5 stop, computed in `settle`.
        const m = Math.max(k, 0);
        await this.freeze('rewrite', this.fold.chain[m].sha);
        this.rollbackTo(m);
      }
      if (k < 0) {
        // Not even the start base is on the chain within reach: nothing new can follow it.
        this.offered = this.offered.slice(0, 1);
      } else {
        this.offered = this.offered.slice(0, k + 1); // forget unadopted commits a rewrite removed
        for (const e of fresh.reverse()) {
          this.pushOffered({ sha: e.sha, parent: e.parent, message: e.message, tree: await history.read(e.sha) });
        }
      }
      this.walkedHead = head;
      await this.settle();
    });
  }

  // ---- outputs -----------------------------------------------------------------------------

  /** Batch files waiting to be written to the session space (journal them first, §15.5). */
  takeOutbox(): OutgoingBatch[] {
    const out = this.outbox;
    this.outbox = [];
    return out;
  }

  get adoptedBase(): string {
    return this.fold.head.sha;
  }

  /** Commits adopted so far, start base first. */
  adoptedChain(): string[] {
    return this.fold.chain.map((e) => e.sha);
  }

  /** Commits offered so far (adopted or queued), start base first; none past a freeze's stop (§15.5). */
  offeredChain(): readonly ChainCommit[] {
    return this.offered.slice(0, Math.min(this.offered.length, this.stopIndex + 1));
  }

  frozen(): Frozen | null {
    return this.control.frozen();
  }

  termsName(): string | null {
    return this.control.termsName();
  }

  batchState(path: string): BatchState | undefined {
    const s = parseBatchPath(path);
    return s ? this.states.get(batchKey(s.actor, s.seq)) : undefined;
  }

  /** Why a batch was ignored (§15.9 S13), for the session panel; undefined unless invalid. */
  invalidReason(path: string): string | undefined {
    const s = parseBatchPath(path);
    return s ? this.reasons.get(batchKey(s.actor, s.seq)) : undefined;
  }

  /** Every batch received, with whether it is acknowledged — the replica's view of the log. */
  received(): Array<{ path: string; bytes: Uint8Array; acked: boolean }> {
    const out = [];
    for (const seqs of this.slots.values()) {
      for (const r of seqs.values()) out.push({ path: r.path, bytes: r.bytes, acked: this.acked.has(r.key) });
    }
    return out.sort((a, b) => cmp(a.path, b.path));
  }

  /** §3.8: per actor, the highest seq received with every lower seq also received. */
  holdingVector(): Vector {
    return contiguous(this.slots, () => true);
  }

  /** §3.8: per actor, the longest prefix of acknowledged batches that are applied or invalid. */
  publishVector(): Vector {
    return contiguous(this.slots, (actor, seq) => {
      const key = batchKey(actor, seq);
      const s = this.states.get(key);
      return this.acked.has(key) && (s === 'applied' || s === 'invalid');
    });
  }

  /** Status of every applied content operation at the newest adopted base. */
  statuses(): Map<string, Status> {
    const out = new Map<string, Status>();
    for (const op of this.fold.applied()) out.set(op.id, this.fold.status(op));
    return out;
  }

  effectiveBoard(): Board {
    return this.fold.effective();
  }

  view(): BoardView {
    return boardView(this.layout, this.fold.effective(), this.fold.head.tree);
  }

  /** Effective-pending operations (§5.5): pending winners whose value differs from the base. */
  pending(): PendingOp[] {
    const out: PendingOp[] = [];
    for (const rec of this.fold.effective().values()) {
      if (!rec.exists) continue;
      for (const [g, op] of rec.from) {
        // Satisfied (IM-10): equal to the base, or to the absent value for a record new at the base.
        if (sameValue(op.value, normalizeGroup(rec.set, resolveGroup(rec.set, g)!, rec.base))) continue;
        out.push({ id: op.id, actor: op.actor, path: op.path, group: op.group, value: op.value });
      }
    }
    return out.sort((a, b) => cmp(a.path, b.path) || cmp(a.group, b.group));
  }

  /** Effective-pending operations grouped by author login (the session panel's counts). */
  pendingByAuthor(): Map<string, PendingOp[]> {
    const out = new Map<string, PendingOp[]>();
    for (const p of this.pending()) {
      const l = actorLogin(p.actor);
      out.set(l, [...(out.get(l) ?? []), p]);
    }
    return out;
  }

  /** The recoverable view (§5.5 step 3): superseded operations not dismissed here. */
  superseded(): SupersededOp[] {
    const out: SupersededOp[] = [];
    for (const op of this.fold.applied()) {
      const s = this.fold.status(op);
      if (s.kind !== 'superseded' || this.dismissed.has(op.id)) continue;
      out.push({ id: op.id, actor: op.actor, path: op.path, group: op.group, value: op.value, at: this.fold.chain[s.at].sha });
    }
    return out.sort((a, b) => cmp(a.id, b.id));
  }

  /**
   * What "Restart session" offers for re-application (§3.1, §15.7): the effective-pending
   * operations, and for a record that exists only through a pending create, every group of that
   * create — a satisfied default included — so that re-applying it is again a valid create batch.
   */
  restartOffer(): PendingOp[] {
    const out = new Map(this.pending().map((p) => [p.id, p]));
    for (const rec of this.fold.effective().values()) {
      if (!rec.exists || rec.base !== null) continue;
      for (const op of rec.from.values()) {
        out.set(op.id, { id: op.id, actor: op.actor, path: op.path, group: op.group, value: op.value });
      }
    }
    return [...out.values()].sort((a, b) => cmp(a.path, b.path) || cmp(a.group, b.group));
  }

  /** The publish of this replica's publish vector on its adopted base (§6.2), or null when frozen by a rewrite or an integrity failure. */
  publishPlan(message = 'Publish session changes'): Promise<PublishPlan | null> {
    return this.exclusive(async () => {
      if (stopsChain(this.frozen())) return null;
      const vector = this.publishVector();
      const keys = new Set(covered(vector).map(([a, s]) => batchKey(a, s)));
      const ops = this.fold.applied().filter((op) => keys.has(op.batch));
      const board = this.fold.snapOf(ops);
      const files = publishFiles(board);
      const digest = (await vectorDigest(vector, (a, s) => this.slots.get(a)?.get(s)?.hash, this.hash))!;
      const trailers = buildTrailers(this.sessionId, vector, digest, publishAuthors(board));
      return {
        parent: this.fold.head.sha,
        vector,
        files,
        trailers,
        message: commitMessage(message, trailers),
        needed: files.size > 0,
      };
    });
  }

  // ---- operations exposed to the app (§15.6) -----------------------------------------------

  /** Issues one batch of raw operations. The typed helpers below are what the app uses. */
  issue(ops: readonly Op[]): Promise<OutgoingBatch> {
    return this.exclusive(async () => {
      const b = await this.issueUnlocked(ops);
      await this.settle();
      return b;
    });
  }

  setTerms(name: string): Promise<OutgoingBatch> {
    return this.issue([termsOp(name)]);
  }

  newId(): string {
    let id = '';
    for (let i = 0; i < 12; i++) id += ID_DIGITS[this.random(36)];
    return id;
  }

  createColumn(name: string, index?: number): Promise<OutgoingBatch> {
    const id = this.newId();
    const keys = this.columnKeys(null);
    const order = this.dropKey(keys, index ?? keys.length, null);
    return this.issue([
      { path: `columns/${id}.json`, group: 'name', value: name },
      { path: `columns/${id}.json`, group: 'order', value: order },
      { path: `columns/${id}.json`, group: 'archived', value: false },
      { path: `columns/${id}.json`, group: 'deleted', value: false },
    ]);
  }

  renameColumn(id: string, name: string): Promise<OutgoingBatch> {
    return this.issue([{ path: `columns/${id}.json`, group: 'name', value: name }]);
  }

  moveColumn(id: string, index: number): Promise<OutgoingBatch> {
    const order = this.dropKey(this.columnKeys(id), index, null);
    return this.issue([{ path: `columns/${id}.json`, group: 'order', value: order }]);
  }

  archiveColumn(id: string, archived: boolean): Promise<OutgoingBatch> {
    return this.issue([{ path: `columns/${id}.json`, group: 'archived', value: archived }]);
  }

  deleteColumn(id: string, deleted: boolean): Promise<OutgoingBatch> {
    return this.issue([{ path: `columns/${id}.json`, group: 'deleted', value: deleted }]);
  }

  /** One create batch (§3.8): every non-map group, plus any labels. */
  createCard(c: { title: string; column: string; index?: number; due?: string | null; labels?: string[] }): Promise<OutgoingBatch> {
    const id = this.newId();
    const path = `cards/${id}.json`;
    const keys = this.cardKeys(c.column, null);
    const order = this.dropKey(keys, c.index ?? keys.length, c.column);
    return this.issue([
      { path, group: 'title', value: c.title },
      { path, group: 'position', value: { column: c.column, order } },
      { path, group: 'due', value: c.due ?? null },
      { path, group: 'archived', value: false },
      { path, group: 'deleted', value: false },
      { path, group: 'created', value: this.clock().toISOString() },
      { path, group: 'createdBy', value: actorLogin(this.actor) },
      ...(c.labels ?? []).map((l) => ({ path, group: `labels.${l}`, value: true })),
    ]);
  }

  renameCard(id: string, title: string): Promise<OutgoingBatch> {
    return this.issue([{ path: `cards/${id}.json`, group: 'title', value: title }]);
  }

  /** One `position` write with a key between the drop neighbours (§3.4, §15.7). */
  moveCard(id: string, column: string, index: number): Promise<OutgoingBatch> {
    const order = this.dropKey(this.cardKeys(column, id), index, column);
    return this.issue([{ path: `cards/${id}.json`, group: 'position', value: { column, order } }]);
  }

  setLabel(id: string, label: string, on: boolean): Promise<OutgoingBatch> {
    return this.issue([{ path: `cards/${id}.json`, group: `labels.${label}`, value: on ? true : null }]);
  }

  setDue(id: string, due: string | null): Promise<OutgoingBatch> {
    return this.issue([{ path: `cards/${id}.json`, group: 'due', value: due }]);
  }

  archiveCard(id: string, archived: boolean): Promise<OutgoingBatch> {
    return this.issue([{ path: `cards/${id}.json`, group: 'archived', value: archived }]);
  }

  /** Delete writes a tombstone; restore clears it (§15.3). */
  deleteCard(id: string, deleted: boolean): Promise<OutgoingBatch> {
    return this.issue([{ path: `cards/${id}.json`, group: 'deleted', value: deleted }]);
  }

  /** Attended rebalancing (§3.4): fresh evenly spaced keys for a column's cards, or for the columns. */
  rebalance(column: string | null): Promise<OutgoingBatch> {
    const v = this.view();
    if (column === null) {
      const cols = v.columns;
      const keys = rebalancedKeys(cols.length);
      return this.issue(cols.map((c, i) => ({ path: c.path, group: 'order', value: keys[i] })));
    }
    const cards = v.columns.find((c) => c.id === column)?.cards ?? [];
    const keys = rebalancedKeys(cards.length);
    return this.issue(cards.map((c, i) => ({ path: c.path, group: 'position', value: { column, order: keys[i] } })));
  }

  /** Re-apply a superseded operation: a new operation with the old value, at the current base. */
  reapply(id: string): Promise<OutgoingBatch> {
    const op = this.fold.applied().find((o) => o.id === id);
    if (!op || this.fold.status(op).kind !== 'superseded') throw new Error(`${id} is not superseded`);
    if (op.ref.kind === 'group' && op.ref.immutable) throw new Error('an immutable field cannot be re-applied');
    return this.issue([{ path: op.path, group: op.group, value: op.value }]);
  }

  /** Dismiss hides a superseded operation from this replica's recoverable view. */
  dismiss(id: string): void {
    this.dismissed.add(id);
  }

  // ---- internals ---------------------------------------------------------------------------

  private columnKeys(except: string | null): string[] {
    return this.view()
      .columns.filter((c) => c.id !== except)
      .map((c) => c.order ?? '');
  }

  private cardKeys(column: string, except: string | null): string[] {
    const col = this.view().columns.find((c) => c.id === column);
    return (col?.cards ?? []).filter((c) => c.id !== except).map((c) => c.order ?? '');
  }

  private dropKey(sorted: string[], index: number, column: string | null): string {
    const k = keyForDrop(sorted, Math.max(0, Math.min(index, sorted.length)), this.random);
    if (k === null) throw new RebalanceNeeded(column);
    return k;
  }

  private pushOffered(commit: ChainCommit): void {
    const last = this.offered[this.offered.length - 1];
    if (commit.parent !== last.sha) throw new Error(`offered ${commit.sha} does not follow ${last.sha}`);
    this.offered.push(commit);
  }

  private slot(actor: string, seq: number): Received | undefined {
    return this.slots.get(actor)?.get(seq);
  }

  private async ingest(path: string, bytes: Uint8Array, hash: string, acked: boolean): Promise<void> {
    const r = decodeBatch(path, bytes, hash);
    if (!parseBatchPath(path)) return; // not a batch file: occupies no slot
    // §15.5 "An exhausted log": a well-formed version at the ceiling — kept or not — implies the
    // start-base freeze; nobody who keeps it can write one.
    if (r.body && r.body.lamport === LAMPORT_LIMIT - 1) this.control.imply();
    const existing = this.slot(r.actor, r.seq);
    if (existing) {
      if (existing.hash === hash) {
        if (acked) this.acked.add(r.key);
        return;
      }
      // A second version of a slot: an integrity failure, implied on every replica that reads both
      // and announced by this one, which can still write — a losing version does not raise its lamport.
      this.control.imply();
      await this.announce();
      return;
    }
    let seqs = this.slots.get(r.actor);
    if (!seqs) this.slots.set(r.actor, (seqs = new Map()));
    seqs.set(r.seq, r);
    if (acked) this.acked.add(r.key);
    // Lamport accounting (§15.5): every slot counts once, by the version that keeps it; a second
    // version returned above without raising ours, so its reader can still announce.
    if (r.body) this.lamportMax = Math.max(this.lamportMax, r.body.lamport);
    if (!r.body) {
      this.states.set(r.key, 'invalid');
      this.reasons.set(r.key, r.shapeError ?? 'invalid');
    } else {
      this.states.set(r.key, 'held');
    }
    // §3.8 integrity: `prev` must be the hash of the same actor's previous batch.
    const before = this.slot(r.actor, r.seq - 1);
    const after = this.slot(r.actor, r.seq + 1);
    if ((r.body && before && r.body.prev !== before.hash) || (after?.body && after.body.prev !== r.hash)) {
      await this.freeze('integrity', this.fold.head.sha);
    }
  }

  private adoptedIndex(sha: string): number | undefined {
    for (let i = this.fold.chain.length - 1; i >= 0; i--) if (this.fold.chain[i].sha === sha) return i;
    return undefined;
  }

  /**
   * Recomputes the §15.5 stop when the winning freeze or the chain has changed, and rolls the adopted
   * chain back past it. True when it rolled back.
   */
  private async restop(): Promise<boolean> {
    const f = this.frozen();
    const key = stopsChain(f) ? `${f!.at} ${this.offered[this.offered.length - 1].sha}` : '';
    if (key !== this.stopKey) {
      if (key === '') {
        this.stopIndex = Infinity;
        this.stopKey = key;
        this.stopUnanswered = false;
      } else {
        const s = await this.stopOn(f!.at);
        this.stopIndex = s.index;
        // An answer built on a refused ancestry question is used now and asked again next time.
        if (s.answered) this.stopKey = key;
        this.stopUnanswered = !s.answered;
      }
    }
    if (this.stopIndex >= this.fold.chain.length - 1) return false;
    this.rollbackTo(this.stopIndex);
    return true;
  }

  /**
   * §15.5 the stop: the last commit of the offered chain that is an ancestor of `at`, or the start
   * base when none is. Ancestry is closed under first parents, so the ancestors form a prefix of the
   * chain and a binary search over `isAncestor` finds its end. `answered` is false when the port
   * refused a question, which then counted as "not an ancestor".
   */
  private async stopOn(at: string): Promise<{ index: number; answered: boolean }> {
    const chain = this.offered;
    const exact = chain.findIndex((c) => c.sha === at);
    if (exact >= 0) return { index: exact, answered: true };
    let answered = true;
    const ancestor = async (sha: string): Promise<boolean> => {
      try {
        return await this.history.isAncestor(sha, at);
      } catch {
        // The port's contract is `false` for an unknown commit (ports.ts), and `at` is forgeable, so a
        // host that refuses instead must not wedge every later input. The stop it yields is the lower
        // one, and it is recomputed at the next settle.
        answered = false;
        return false;
      }
    };
    if (!(await ancestor(chain[0].sha))) return { index: 0, answered };
    let lo = 0;
    let hi = chain.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (await ancestor(chain[mid].sha)) lo = mid;
      else hi = mid - 1;
    }
    return { index: lo, answered };
  }

  private tryApply(r: Received): boolean {
    const body = r.body!;
    if (r.controlOnly) {
      this.applyControl(body);
      this.states.set(r.key, 'applied');
      return true;
    }
    const baseIdx = this.adoptedIndex(body.base);
    if (baseIdx === undefined) return false;
    const v = contentValidity(body, this.layout, this.fold.chain[baseIdx].tree);
    if (!v.valid) {
      this.states.set(r.key, 'invalid');
      this.reasons.set(r.key, v.reason ?? 'invalid');
      return true;
    }
    const ops: AppliedOp[] = [];
    body.ops.forEach((op, index) => {
      if (op.path.startsWith(CONTROL_PREFIX)) return;
      const m = matchPath(this.layout, op.path)!;
      const ref = resolveGroup(m.set, op.group)!;
      ops.push({
        id: opId(body.actor, body.seq, index),
        batch: r.key,
        actor: body.actor,
        seq: body.seq,
        lamport: body.lamport,
        index,
        path: op.path,
        group: op.group,
        set: m.set,
        ref,
        value: normalizeOpValue(m.set, ref, op.value),
        create: v.creates.has(op.path),
        base: baseIdx,
      });
    });
    this.fold.apply(ops);
    // Control operations in a batch that also carries content are inert (§15.5): a content batch
    // can be rolled back and held again (§5.4 d), and a control value that came and went with it
    // would split the replicas that applied it from those that never did.
    this.states.set(r.key, 'applied');
    return true;
  }

  private applyControl(body: BatchBody): void {
    body.ops.forEach((op, index) => {
      if (!op.path.startsWith(CONTROL_PREFIX)) return;
      this.control.apply({ actor: body.actor, seq: body.seq, lamport: body.lamport, index, path: op.path, value: op.value });
    });
  }

  /** Rolls the adopted chain back to `index`; content batches based later are held again (§5.4 d). */
  private rollbackTo(index: number): void {
    if (index >= this.fold.chain.length - 1) return;
    this.fold.rollback(index);
    for (const seqs of this.slots.values()) {
      for (const r of seqs.values()) {
        if (!r.body || r.controlOnly || this.adoptedIndex(r.body.base) !== undefined) continue;
        this.reasons.delete(r.key);
        this.states.set(r.key, 'held');
      }
    }
  }

  /** Applies what can be applied and adopts what can be adopted, until nothing moves. */
  private async settle(): Promise<void> {
    for (let progress = true; progress; ) {
      progress = false;
      for (const seqs of this.slots.values()) {
        for (const r of seqs.values()) {
          if (this.states.get(r.key) === 'held' && this.tryApply(r)) progress = true;
        }
      }
      // A freeze applied above, or written while adopting below, moves the stop before anything else is adopted.
      if (await this.restop()) progress = true;
      if (await this.adoptNext()) progress = true;
      if (await this.restop()) progress = true;
    }
  }

  private async adoptNext(): Promise<boolean> {
    const next = this.offered[this.fold.chain.length];
    if (!next || this.fold.chain.length - 1 >= this.stopIndex) return false;
    const reading = readTrailers(next.message, this.sessionId);
    if (reading.kind === 'malformed') {
      await this.freeze('integrity', this.fold.head.sha);
      return false;
    }
    const vector: Vector = reading.kind === 'publish' ? reading.vector : new Map();
    if (!dominates(this.holdingVector(), vector)) return false; // §5.4 (a): queue the advance
    if (reading.kind === 'publish') {
      const digest = await vectorDigest(vector, (a, s) => this.slot(a, s)?.hash, this.hash);
      if (digest !== reading.digest) {
        await this.freeze('integrity', this.fold.head.sha);
        return false;
      }
    }
    const keys = new Set(covered(vector).map(([a, s]) => batchKey(a, s)));
    this.fold.adopt(next, vector, keys);
    if (layoutFromMarker(next.tree.get(MARKER_PATH))?.fingerprint !== this.layout.fingerprint) {
      await this.freeze('layout', next.sha);
    }
    return true;
  }

  /**
   * §15.5 "Announcing it": writes the start-base freeze to the log once, unless the log already holds
   * it — whatever other freeze is in force. A replica with no lamport left stays silent (it keeps a
   * ceiling batch, which its readers derive the freeze from).
   */
  private async announce(): Promise<void> {
    if (!this.logRead) {
      this.announcePending = true;
      return;
    }
    this.announcePending = false;
    const w = this.control.writtenFrozen();
    const sb = this.control.startBaseFreeze();
    if (this.announced || (w !== null && w.reason === sb.reason && w.at === sb.at)) return;
    try {
      await this.issueUnlocked([frozenOp(sb.reason, sb.at)]);
    } catch (err) {
      if (err instanceof LamportExhausted) return;
      throw err;
    }
    this.announced = true;
  }

  /** Writes `_session/frozen` once (§15.7); every replica freezes when it arrives. */
  private async freeze(reason: FreezeReason, at: string): Promise<void> {
    // Idempotent (§15.5): once per replica, unless a layout freeze is overtaken by one that stops the
    // chain. What counts is the log's own written freezes.
    const f = this.control.writtenFrozen();
    if (!this.logRead) {
      this.deferredFreezes.push({ reason, at });
      return;
    }
    if (this.freezeIssued.has(reason) || stopsChain(f) || (f !== null && reason === 'layout')) return;
    try {
      await this.issueUnlocked([frozenOp(reason, at)]);
    } catch (err) {
      // Only the typed lamport exhaustion is swallowed: the log cannot take the freeze batch. An
      // exhausted replica keeps a ceiling batch, so it already holds the implied start-base freeze
      // (§15.5 "An exhausted log"). Anything else propagates.
      if (err instanceof LamportExhausted) return;
      throw err;
    }
    this.freezeIssued.add(reason);
  }

  private async issueUnlocked(ops: readonly Op[]): Promise<OutgoingBatch> {
    if (!this.logRead) throw new NotReadyError('the session log has not been read in full yet');
    const content = ops.some((op) => !op.path.startsWith(CONTROL_PREFIX));
    if (content && this.frozen() !== null) throw new FrozenError(`the session is frozen (${this.frozen()!.reason})`);
    const seq = this.ownSeq + 1;
    if (this.lamportMax + 1 >= LAMPORT_LIMIT) throw new LamportExhausted();
    const body: BatchBody = {
      v: BATCH_VERSION,
      actor: this.actor,
      seq,
      lamport: this.lamportMax + 1,
      base: this.fold.head.sha,
      prev: this.ownPrev,
      time: this.clock().toISOString(),
      ops,
    };
    const bytes = encodeBatch(body);
    const hash = await this.hash(bytes);
    this.ownSeq = seq;
    this.ownPrev = hash;
    const path = batchPath(this.actor, seq);
    await this.ingest(path, bytes, hash, false);
    // Our own batch is based on our adopted head, so it applies at once (a freeze takes effect here).
    const own = this.slot(this.actor, seq)!;
    if (this.states.get(own.key) === 'held') this.tryApply(own);
    const b = { path, bytes };
    this.outbox.push(b);
    return b;
  }
}

/**
 * Bootstrap (§15.7): the files "Create board" sends in one `contribute` request, outside any
 * session — the marker, `board.json` and three default columns.
 */
export function bootstrapFiles(marker: string, boardName: string, random: RandomInt): Map<string, string> {
  const id = () => {
    let s = '';
    for (let i = 0; i < 12; i++) s += ID_DIGITS[random(36)];
    return s;
  };
  const layout = layoutFromMarker(marker);
  if (!layout) throw new Error('the marker declares no valid layout');
  const files = new Map<string, string>([[MARKER_PATH, marker]]);
  const board = matchPath(layout, 'board.json')!;
  files.set('board.json', serialize(board.set, { name: boardName }));
  const keys = rebalancedKeys(3);
  ['To do', 'Doing', 'Done'].forEach((name, i) => {
    const path = `columns/${id()}.json`;
    const m = matchPath(layout, path)!;
    files.set(path, serialize(m.set, { name, order: keys[i], archived: false, deleted: false }));
  });
  return files;
}

function serialize(set: RecordSet, fields: Record<string, Json>): string {
  // Every field the bootstrap writes is its own group, so fields and groups coincide.
  return serializeRecord(set, null, new Map(Object.entries(fields)));
}
