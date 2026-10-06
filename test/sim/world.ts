// The simulated world (R3-969): replicas with outboxes, a session space whose deliveries are
// delayed, duplicated and reordered, simulated git, external writers, and publishers whose commits
// are built by the ORACLE — never by the engine's publish code.

import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { batchPath, cmp, encodeBatch, LAMPORT_LIMIT, type BatchBody, type Op } from '../../src/lib/session/batch';
import type { Json } from '../../src/lib/session/canonical';
import { frozenOp, termsOp } from '../../src/lib/session/control';
import { SessionEngine, type OutgoingBatch } from '../../src/lib/session/engine';
import type { Board, Status } from '../../src/lib/session/fold';
import { parseLayout, type Layout } from '../../src/lib/session/layout';
import { sha256WithSubtle, type ChainCommit, type Tree } from '../../src/lib/session/ports';
import { oracle, type OracleResult, type OracleStatus } from '../oracle/reference';
import { SimGit } from './git';
import markerText from '../fixtures/marker.json?raw';

export const MARKER = markerText;
export const LAYOUT: Layout = parseLayout(JSON.parse(markerText).layout);
export const SESSION_ID = 'sess0000000abcde';
export const hash = sha256WithSubtle(webcrypto.subtle as unknown as SubtleCrypto);

export const COLUMNS = ['colaaaaaaaa1', 'colaaaaaaaa2', 'colaaaaaaaa3'];
export const CARDS = ['cardaaaaaaa1', 'cardaaaaaaa2', 'cardaaaaaaa3', 'cardaaaaaaa4'];
export const LABELS = ['urgent', 'blocked', 'bug', 'idea'];

export function json(v: unknown): string {
  return JSON.stringify(v, null, 2) + '\n';
}

export function startTree(): Map<string, string> {
  const t = new Map<string, string>();
  t.set('immediately.run.json', MARKER);
  t.set('README.md', '# A board\n');
  t.set('board.json', json({ name: 'Sprint board' }));
  COLUMNS.forEach((id, i) => t.set(`columns/${id}.json`, json({ name: `Column ${i + 1}`, order: `a${i}`, archived: false })));
  CARDS.forEach((id, i) =>
    t.set(
      `cards/${id}.json`,
      json({
        title: `Card ${i + 1}`,
        column: COLUMNS[i % 2],
        order: `a${i}`,
        archived: false,
        created: '2026-10-01T10:00:00Z',
        createdBy: 'seed',
        ...(i === 0 ? { labels: { bug: true } } : {}),
      }),
    ),
  );
  return t;
}

/** mulberry32: a small seeded generator, so a failing run replays exactly. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Replica {
  readonly name: string;
  readonly login: string;
  engine: SessionEngine;
  online = true;
  /** The outbox journal (§15.5): written before the space write, kept until it resolves. */
  journal: OutgoingBatch[] = [];
  unresolved: string[] = [];
  inbox: string[] = [];
  /**
   * The world's own record of this replica's view, kept independently of the engine for the
   * oracle: the first bytes it saw at each path, which of them are acknowledged, and the main-line
   * head it last synced.
   */
  seen = new Map<string, Uint8Array>();
  /** Later, different versions of a path already in `seen`, in reading order (§15.5 "An exhausted log" reads every version). */
  extra: Array<{ path: string; bytes: Uint8Array }> = [];
  /** It was served a version out of band — one the space may not store. */
  unstored = false;
  acked = new Set<string>();
  syncedHead = '';

  constructor(name: string, login: string, engine: SessionEngine) {
    this.name = name;
    this.login = login;
    this.engine = engine;
  }
}

export class World {
  readonly rng: () => number;
  readonly git: SimGit;
  readonly space = new Map<string, Uint8Array>();
  readonly replicas: Replica[] = [];
  readonly root: string;
  private time = Date.UTC(2026, 9, 6, 12, 0, 0);
  /** Every oracle check made, for the property test's sanity counters. */
  checks = 0;
  publishes = 0;
  conflicts = 0;
  merges = 0;
  reloads = 0;
  rewrites = 0;
  /** Mixed content+control batches issued (§15.5: their control operations are inert). */
  mixed = 0;
  /** A check saw a replica whose winning stop freeze has its `at` off the chain (the stop's ancestry search). */
  stopOffChain = false;

  constructor(seed: number, tree: Tree = startTree()) {
    this.rng = seeded(seed);
    this.git = new SimGit(tree);
    this.root = this.git.main;
  }

  int(n: number): number {
    return Math.floor(this.rng() * n);
  }

  pick<T>(xs: readonly T[]): T | undefined {
    return xs.length ? xs[this.int(xs.length)] : undefined;
  }

  commitOf(sha: string): ChainCommit {
    const c = this.git.commits.get(sha)!;
    return { sha, parent: c.parents[0] ?? null, message: c.message, tree: c.tree };
  }

  private randomId(n: number): string {
    const d = '0123456789abcdefghijklmnopqrstuvwxyz';
    let s = '';
    for (let i = 0; i < n; i++) s += d[this.int(36)];
    return s;
  }

  /** A new replica: a fresh actor, which reads the whole log once before writing (§3.8). */
  async join(login: string): Promise<Replica> {
    const actor = `${login}.${this.randomId(8)}.${this.randomId(8)}`;
    const engine = new SessionEngine({
      sessionId: SESSION_ID,
      layout: LAYOUT,
      start: this.commitOf(this.root),
      actor,
      history: this.git,
      hash,
      clock: () => new Date((this.time += 1000)),
      random: (n) => this.int(n),
    });
    const r = new Replica(`r${this.replicas.length}`, login, engine);
    for (const [path, bytes] of this.space) {
      await engine.receive(path, bytes);
      this.see(r, path, bytes, true);
    }
    await engine.markLogRead();
    await engine.sync();
    r.syncedHead = this.git.main;
    this.collect(r);
    this.replicas.push(r);
    return r;
  }

  /** A page reload: the replica's journaled, unresolved batches are re-sent byte for byte; a new actor takes over. */
  async reload(r: Replica): Promise<void> {
    const journal = r.journal;
    const fresh = await this.join(r.login);
    this.replicas.pop();
    r.engine = fresh.engine;
    r.journal = [...journal, ...fresh.journal];
    r.unresolved = [];
    r.inbox = [];
    r.seen = fresh.seen;
    r.extra = fresh.extra;
    r.unstored = false; // a reload reads the space only
    r.acked = fresh.acked;
    r.syncedHead = fresh.syncedHead;
    this.reloads++;
  }

  see(r: Replica, path: string, bytes: Uint8Array, acked: boolean): void {
    // First version read keeps the slot — the same reading the engine and the §15.6 rule make.
    // A later, different version is kept too, apart: §15.5 derives the implied freeze from every
    // version a replica reads, so the oracle must see them all.
    const first = r.seen.get(path);
    if (!first) r.seen.set(path, bytes);
    else if (!sameBytes(first, bytes)) {
      // Reading another version acknowledges nothing: the slot is acknowledged by its own bytes.
      if (!r.extra.some((x) => x.path === path && sameBytes(x.bytes, bytes))) r.extra.push({ path, bytes });
      return;
    }
    if (acked) r.acked.add(path);
  }

  collect(r: Replica): void {
    const out = r.engine.takeOutbox();
    for (const b of out) this.see(r, b.path, b.bytes, false);
    r.journal.push(...out);
  }

  /** Space writes of the journal (create-only); each becomes visible to every other replica. */
  write(r: Replica): void {
    if (!r.online) return;
    this.collect(r);
    for (const b of r.journal) {
      const existing = this.space.get(b.path);
      if (existing) {
        assert.deepEqual(existing, b.bytes, `a write may never overwrite ${b.path}`);
      } else {
        this.space.set(b.path, b.bytes);
        for (const o of this.replicas) if (o !== r) o.inbox.push(b.path);
        // Reading our own batch back; a batch of an earlier page load must reach the new actor.
        if (this.rng() < 0.3 || !b.path.startsWith(`batches/${r.engine.actor}/`)) r.inbox.push(b.path);
      }
      r.unresolved.push(b.path);
    }
    r.journal = [];
  }

  /** The writes resolve: acknowledgement (§15.5). */
  resolve(r: Replica): void {
    if (!r.online) return;
    for (const p of r.unresolved) {
      r.engine.acknowledge(p);
      r.acked.add(p);
    }
    r.unresolved = [];
  }

  /** A batch file written to the space by someone outside the simulation (a forger): every replica will read it. */
  plant(path: string, bytes: Uint8Array): void {
    this.space.set(path, bytes);
    for (const r of this.replicas) r.inbox.push(path);
  }

  /** Delivers one batch file from the space to `r` now (out of band of its inbox). */
  async receiveNow(r: Replica, path: string, bytes = this.space.get(path)!): Promise<void> {
    r.inbox = r.inbox.filter((p) => p !== path);
    await r.engine.receive(path, bytes);
    this.see(r, path, bytes, true);
    this.collect(r);
  }

  /** Delivers up to `k` batch files in random order, sometimes leaving a duplicate behind. */
  async deliver(r: Replica, k: number): Promise<void> {
    if (!r.online) return;
    for (let i = 0; i < k && r.inbox.length; i++) {
      const j = this.int(r.inbox.length);
      const path = r.inbox[j];
      if (this.rng() >= 0.15) r.inbox.splice(j, 1);
      await r.engine.receive(path, this.space.get(path)!);
      this.see(r, path, this.space.get(path)!, true);
    }
    this.collect(r);
  }

  async sync(r: Replica): Promise<void> {
    if (!r.online) return;
    await r.engine.sync();
    r.syncedHead = this.git.main;
    this.collect(r);
  }

  /** The first-parent chain of `head`, root first — computed from simulated git, not the engine. */
  firstParentChain(head: string): ChainCommit[] {
    const out: ChainCommit[] = [];
    for (let s: string | undefined = head; s !== undefined; s = this.git.commits.get(s)!.parents[0]) out.push(this.commitOf(s));
    return out.reverse();
  }

  /** The first-parent chain of `head` from the session's start base, or just the start base when it is not on it. */
  chainFromStart(head: string): ChainCommit[] {
    const chain = this.firstParentChain(head);
    const i = chain.findIndex((c) => c.sha === this.root);
    return i < 0 ? [this.commitOf(this.root)] : chain.slice(i);
  }

  /** The oracle's view of one replica. */
  oracleOf(r: Replica): OracleResult {
    return oracle({
      layout: LAYOUT,
      sessionId: SESSION_ID,
      offered: this.chainFromStart(r.syncedHead),
      isAncestor: (a, d) => this.git.reaches(a, d),
      batches: [...r.seen, ...r.extra.map((x) => [x.path, x.bytes] as const)].map(([path, bytes]) => ({ path, bytes, acked: r.acked.has(path) })),
    });
  }

  /**
   * A publish by `r` through the simulated `contribute` task. The commit is built from the
   * ORACLE's files and trailers; the engine's own plan must agree with it byte for byte.
   */
  async publish(r: Replica): Promise<'published' | 'conflict' | 'nothing'> {
    if (!r.online) return 'nothing';
    const o = this.oracleOf(r);
    const plan = await r.engine.publishPlan();
    if (o.trailers.length === 0) {
      assert.equal(plan, null, 'engine offers a publish the oracle forbids');
      return 'nothing';
    }
    assert.ok(plan, 'engine refuses a publish the oracle allows');
    assert.equal(plan.parent, o.adopted[o.adopted.length - 1]);
    assert.deepEqual([...plan.files], [...o.publishFiles], 'publish files differ from the oracle');
    assert.deepEqual(plan.trailers, o.trailers, 'trailers differ from the oracle');
    if (o.publishFiles.size === 0) {
      assert.equal(plan.needed, false);
      return 'nothing';
    }
    const message = `Publish session changes\n\n${o.trailers.join('\n')}\n`;
    const res = this.git.publish(o.adopted[o.adopted.length - 1], o.publishFiles, message);
    if (!res.ok) {
      this.conflicts++;
      await this.sync(r);
      return 'conflict';
    }
    this.publishes++;
    await this.sync(r);
    return 'published';
  }

  /** Engine and oracle agree on everything one replica derives. */
  check(r: Replica): void {
    this.checks++;
    const o = this.oracleOf(r);
    const e = r.engine;
    const where = `replica ${r.name}`;
    if (o.frozen && o.frozen.reason !== 'layout' && !this.chainFromStart(r.syncedHead).some((c) => c.sha === o.frozen!.at)) this.stopOffChain = true;
    assert.deepEqual(e.offeredChain().map((c) => c.sha), o.offered, `${where}: offered chain`);
    assert.deepEqual(e.adoptedChain(), o.adopted, `${where}: adopted chain`);
    assert.deepEqual(e.frozen(), o.frozen, `${where}: frozen`);
    assert.deepEqual(vec(e.holdingVector()), vec(o.holding), `${where}: holding vector`);
    assert.deepEqual(vec(e.publishVector()), vec(o.publishVector), `${where}: publish vector`);
    for (const b of e.received()) {
      const key = b.path.slice('batches/'.length, -'.json'.length);
      assert.equal(e.batchState(b.path), o.states.get(key), `${where}: state of ${b.path}`);
    }
    assert.deepEqual(statuses(e.statuses()), statuses(o.statuses), `${where}: statuses`);
    assert.deepEqual(boardOf(e.effectiveBoard()), oracleBoard(o), `${where}: effective state`);
    assert.deepEqual(e.pending().map((p) => p.id).sort(cmp), o.pending, `${where}: effective-pending`);
    const v = e.view();
    assert.deepEqual(
      {
        columns: v.columns.map((c) => ({ id: c.id, cards: c.cards.map((x) => x.id) })),
        unsorted: v.unsorted.map((c) => c.id),
        archivedColumns: v.archivedColumns.map((c) => c.id),
        deletedColumns: v.deletedColumns.map((c) => c.id),
        archivedCards: v.archivedCards.map((c) => c.id),
        deletedCards: v.deletedCards.map((c) => c.id),
        orphans: [...v.orphans],
      },
      o.rendered,
      `${where}: rendered board`,
    );
  }

  /** Brings everyone online and runs the network and history to a fixed point. */
  async quiesce(): Promise<void> {
    for (const r of this.replicas) r.online = true;
    for (let round = 0; round < 50; round++) {
      for (const r of this.replicas) {
        this.write(r);
        this.resolve(r);
      }
      for (const r of this.replicas) {
        await this.deliver(r, Infinity);
        await this.sync(r);
      }
      const busy = this.replicas.some((r) => r.inbox.length || r.journal.length || r.engine.takeOutbox().length);
      if (!busy) return;
    }
    throw new Error('the world did not quiesce');
  }

  /** The versions a replica has read, as a comparable key: every path with every version's hash. */
  readSet(r: Replica): string {
    const hex = (b: Uint8Array) => Buffer.from(b).toString('base64');
    return [...[...r.seen].map(([p, b]) => `${p} ${hex(b)}`), ...r.extra.map((x) => `${x.path} ${hex(x.bytes)}`)].sort().join('\n');
  }

  /**
   * Replicas that have read the same versions and synced the same head derive the same freeze and
   * the same chain (§15.5; R3-995's exit criterion) — whatever order they read them in, and
   * whichever version keeps a slot. Returns the number of replica groups, for coverage.
   */
  checkSameSets(): number {
    const groups = new Map<string, Replica[]>();
    for (const r of this.replicas) {
      const k = `${this.readSet(r)}\n@${r.syncedHead}`;
      groups.set(k, [...(groups.get(k) ?? []), r]);
    }
    for (const [, [first, ...rest]] of groups) {
      for (const r of rest) {
        assert.deepEqual(r.engine.frozen(), first.engine.frozen(), `replica ${r.name} freezes unlike ${first.name}, having read the same batches`);
        assert.deepEqual(r.engine.adoptedChain(), first.engine.adoptedChain(), `replica ${r.name} stops unlike ${first.name}, having read the same batches`);
      }
    }
    return groups.size;
  }

  /**
   * For coverage: the read-set groups, and how many groups of two or more replicas hold an
   * implied-freeze input (a second version, or a ceiling version) in what they read.
   */
  sameSetStats(): { groups: number; impliedPairs: number; orderSplits: number } {
    const groups = new Map<string, Replica[]>();
    for (const r of this.replicas) {
      const k = `${this.readSet(r)}\n@${r.syncedHead}`;
      groups.set(k, [...(groups.get(k) ?? []), r]);
    }
    const ceiling = (bytes: Uint8Array) => {
      try {
        return (JSON.parse(new TextDecoder().decode(bytes)) as { lamport?: number }).lamport === LAMPORT_LIMIT - 1;
      } catch {
        return false;
      }
    };
    let impliedPairs = 0;
    let orderSplits = 0;
    for (const [, rs] of groups) {
      if (rs.length < 2) continue;
      const r = rs[0];
      if (r.extra.length > 0 || [...r.seen.values()].some(ceiling)) impliedPairs++;
      // The same versions read, but a slot kept in a different version (read in another order).
      if (rs.some((o) => [...o.seen].some(([p, b]) => !sameBytes(b, r.seen.get(p) ?? new Uint8Array())))) orderSplits++;
    }
    return { groups: groups.size, impliedPairs, orderSplits };
  }

  /**
   * After quiescence every replica agrees with its oracle; replicas that read the same versions
   * agree on the freeze and the chain; and replicas served nothing out of band agree on everything.
   */
  checkConverged(): void {
    for (const r of this.replicas) this.check(r);
    this.checkSameSets();
    // Replicas served a version the space does not store have read different batches; past the
    // freeze and chain (checked above, within same-read groups), only the replicas with no such
    // version must agree on everything.
    const plain = this.replicas.filter((r) => r.extra.length === 0 && !r.unstored);
    const [first, ...rest] = plain;
    const sig = (r: Replica) => ({
      adopted: r.engine.adoptedChain(),
      frozen: r.engine.frozen(),
      holding: vec(r.engine.holdingVector()),
      statuses: statuses(r.engine.statuses()),
      board: boardOf(r.engine.effectiveBoard()),
      pending: r.engine.pending().map((p) => p.id).sort(cmp),
      view: r.engine.view(),
    });
    for (const r of rest) assert.deepEqual(sig(r), sig(first), `replica ${r.name} diverges from ${first.name}`);
  }

  // ---- the exhausted-log class (§15.5, R3-995): ceiling batches and second versions ---------

  /** Ceiling batches and second versions planted, and how many were served to some replicas only. */
  ceilingPlants = 0;
  secondVersions = 0;
  splitServes = 0;

  /** A forger's well-formed batch file (an actor outside the session), seq 1. */
  forgedBatch(lamport: number, base: string, title: string): { path: string; bytes: Uint8Array } {
    const actor = `mal.${this.randomId(8)}.${this.randomId(8)}`;
    const body: BatchBody = {
      v: 1,
      actor,
      seq: 1,
      lamport,
      base,
      prev: '',
      time: '2026-10-06T12:00:00.000Z',
      ops: [{ path: `cards/${CARDS[this.int(CARDS.length)]}.json`, group: 'title', value: title }],
    };
    return { path: batchPath(actor, 1), bytes: encodeBatch(body) };
  }

  /** Serves a version out of band (not through the create-only space) to a random proper subset, or to everyone. */
  private async serve(path: string, bytes: Uint8Array, everyone: boolean): Promise<void> {
    const targets = everyone ? [...this.replicas] : this.replicas.filter(() => this.rng() < 0.5);
    if (!everyone && (targets.length === 0 || targets.length === this.replicas.length)) {
      targets.splice(0, targets.length, this.replicas[this.int(this.replicas.length)]);
    }
    if (!everyone) this.splitServes++;
    for (const r of targets) {
      r.unstored = true;
      // Out of band, beside the space: the stored version stays in the replica's inbox, so some
      // replicas read it before this one and some after (§15.5: the order must not matter).
      await r.engine.receive(path, bytes);
      this.see(r, path, bytes, true);
      this.collect(r);
    }
  }

  /** A well-formed batch at the lamport ceiling (§3.8): stored in the space, or served to some replicas only. */
  async plantCeiling(): Promise<void> {
    this.ceilingPlants++;
    const chain = this.firstParentChain(this.git.main);
    const b = this.forgedBatch(LAMPORT_LIMIT - 1, this.pick(chain)!.sha, `Ceiling ${this.int(9)}`);
    if (this.rng() < 0.5) this.plant(b.path, b.bytes);
    else await this.serve(b.path, b.bytes, false);
  }

  /**
   * A second version of a batch file the space already stores — another title, and half the time
   * the ceiling lamport — served out of band, since the create-only space keeps one version per path.
   */
  async plantSecondVersion(): Promise<void> {
    const paths = [...this.space.keys()].filter((p) => p.startsWith('batches/'));
    const path = this.pick(paths);
    if (!path) return;
    const body = JSON.parse(new TextDecoder().decode(this.space.get(path)!)) as BatchBody;
    if (!body || !Array.isArray(body.ops)) return;
    this.secondVersions++;
    const alt: BatchBody = {
      ...body,
      lamport: this.rng() < 0.5 ? LAMPORT_LIMIT - 1 : body.lamport,
      ops: [{ path: `cards/${CARDS[this.int(CARDS.length)]}.json`, group: 'title', value: `Second ${this.int(99)}` }],
    };
    await this.serve(path, encodeBatch(alt), this.rng() < 0.2);
  }

  // ---- random activity -------------------------------------------------------------------

  /** One random session edit by `r` (sometimes a deliberately invalid batch). */
  async edit(r: Replica): Promise<void> {
    const e = r.engine;
    const v = e.view();
    const cards = [...v.columns.flatMap((c) => c.cards), ...v.unsorted, ...v.archivedCards, ...v.deletedCards];
    const card = this.pick(cards);
    const cols = v.columns;
    const col = this.pick(cols);
    const anyCol = this.pick([...cols, ...v.archivedColumns, ...v.deletedColumns]);
    const titles = ['Plan', 'Ship it', 'Fix the bug', 'Write docs', 'Ünïcode ✓', 'x'];
    try {
      switch (this.int(16)) {
        case 0:
        case 1:
          if (card) await e.renameCard(card.id, this.pick(titles)! + this.int(9));
          break;
        case 2:
        case 3:
        case 4:
          if (card && col) await e.moveCard(card.id, col.id, this.int(col.cards.length + 1));
          break;
        case 5:
          if (col) await e.createCard({ title: this.pick(titles)!, column: col.id, index: this.int(col.cards.length + 1), labels: this.rng() < 0.3 ? ['idea'] : [] });
          break;
        case 6:
        case 7:
          if (card) await e.setLabel(card.id, this.pick(LABELS)!, this.rng() < 0.6);
          break;
        case 8:
          if (card) await e.setDue(card.id, this.rng() < 0.7 ? `2026-1${this.int(3)}-0${1 + this.int(9)}` : null);
          break;
        case 9:
          if (card) await e.archiveCard(card.id, !card.archived);
          break;
        case 10:
          if (card) await e.deleteCard(card.id, !card.deleted);
          break;
        case 11:
          if (this.rng() < 0.5) await e.createColumn(`List ${this.int(99)}`, this.int(cols.length + 1));
          else if (anyCol) await e.renameColumn(anyCol.id, `Renamed ${this.int(99)}`);
          break;
        case 12:
          if (anyCol) {
            if (this.rng() < 0.6) await e.archiveColumn(anyCol.id, !anyCol.archived);
            else await e.deleteColumn(anyCol.id, !anyCol.deleted);
          }
          break;
        case 13:
          if (col) await e.moveColumn(col.id, this.int(cols.length));
          break;
        case 14:
          // A mixed batch (§15.5): its control operations — a freeze mid-batch, terms last — are
          // inert, so engine and oracle must both see only the rename. (No extra draw from the
          // generator: pinned seeds replay as before.)
          await e.issue([
            { path: 'board.json', group: 'name', value: `Board ${this.int(9)}` },
            frozenOp('integrity', this.git.main),
            termsOp('Mixed'),
          ]);
          this.mixed++;
          break;
        case 15:
          await e.issue(this.invalidOps(card?.path ?? `cards/${CARDS[0]}.json`));
          break;
      }
    } catch (err) {
      if (!(err instanceof Error) || !/frozen|rebalanc/.test(err.message)) throw err;
    }
    this.collect(r);
  }

  /** A batch that is invalid in its entirety (§15.9 S13), mixed with a valid operation. */
  invalidOps(cardPath: string): Op[] {
    const ok: Op = { path: cardPath, group: 'title', value: 'would be fine alone' };
    const bad: Op[] = [
      { path: cardPath, group: 'title', value: 'x'.repeat(501) },
      { path: cardPath, group: 'colour', value: 'red' },
      { path: cardPath, group: 'created', value: '2026-01-01T00:00:00Z' },
      { path: '.github/workflows/x.yml', group: 'name', value: 'x' },
      { path: cardPath, group: 'position', value: { column: COLUMNS[0] } },
      { path: cardPath, group: 'due', value: '2026-02-30' },
    ];
    return [ok, this.pick(bad)!];
  }

  /** One random outside change on `main` (an agent, a merged PR, a squash, a reformat…). */
  externalCommit(): void {
    const tree = new Map(this.git.tree());
    const cardPaths = [...tree.keys()].filter((p) => p.startsWith('cards/') && p.endsWith('.json'));
    const path = this.pick(cardPaths);
    const obj = (path ? (() => { try { return JSON.parse(tree.get(path)!); } catch { return null; } })() : null) as Record<string, Json> | null;
    const k = this.int(12);
    if (k <= 1 && path && obj) {
      obj.title = `Agent title ${this.int(99)}`;
      tree.set(path, json(obj));
    } else if (k === 2 && path && obj) {
      obj.column = this.pick(COLUMNS)!;
      obj.order = `a${this.int(9)}V`;
      tree.set(path, json(obj));
    } else if (k === 3 && path) {
      tree.delete(path);
    } else if (k === 4) {
      tree.set(`cards/ext${this.randomId(9)}.json`, json({ title: 'From outside', column: COLUMNS[2], order: 'a5', created: '2026-10-02T09:00:00Z', createdBy: 'agent' }));
    } else if (k === 5 && path) {
      tree.set(path, '{ not json');
    } else if (k === 6 && path && obj) {
      tree.set(path, JSON.stringify(obj)); // reformat only: the same values
    } else if (k === 7 && path && obj) {
      const labels = (obj.labels ?? {}) as Record<string, Json>;
      const l = this.pick(LABELS)!;
      if (labels[l] === true) delete labels[l];
      else labels[l] = true;
      obj.labels = labels;
      tree.set(path, json(obj));
    } else if (k === 8 && path && obj) {
      obj.extra = { kept: true };
      tree.set(path, json(obj));
    } else if (k === 9 && path && obj) {
      // A merged pull request: the side branch changes the title; the merge keeps it.
      obj.title = `Merged title ${this.int(99)}`;
      tree.set(path, json(obj));
      this.git.merge(tree, tree, 'Merge pull request #1');
      this.merges++;
      return;
    } else if (k === 11 && this.rng() < 0.5) {
      tree.set('README.md', `# Squashed ${this.int(99)}\n`);
      this.git.squash(tree, 'Squash merge of a pull request');
      return;
    } else if (k === 10) {
      // A commit carrying another session's trailers is an outside change for this one.
      tree.set('README.md', `# A board ${this.int(99)}\n`);
      this.git.advance(tree, 'Other session\n\nCollab-Session: other00000000000\nCollab-Vector: x.aaaaaaaa.bbbbbbbb=1\n');
      return;
    } else {
      const board = JSON.parse(tree.get('board.json') ?? '{}');
      board.name = `Renamed outside ${this.int(99)}`;
      tree.set('board.json', json(board));
    }
    this.git.advance(tree, 'Outside change');
  }

  /** A layout change in the marker (§3.1): every replica must freeze. */
  layoutChange(): void {
    const tree = new Map(this.git.tree());
    const m = JSON.parse(tree.get('immediately.run.json')!);
    m.layout.recordSets.board.fields.name = 'string:1..100';
    tree.set('immediately.run.json', json(m));
    this.git.advance(tree, 'Change the layout');
  }

  /**
   * A rewrite of the main line: either a force-push (`main` drops its newest commit and gains
   * another) or a merge whose FIRST parent is another line, so the old head is reachable only
   * through the second parent and leaves the first-parent chain (§5.3). With `below`, the new line
   * forks from that commit's first parent instead, so the rewrite removes `below` itself — how a
   * second rewrite takes away the commit an earlier freeze stopped at (§15.5 the stop).
   */
  forcePush(below?: string): void {
    const head = this.git.commits.get(this.git.main)!;
    if (head.parents.length === 0) return;
    const under = below === undefined ? undefined : this.git.commits.get(below)?.parents[0];
    const base = under ?? head.parents[0];
    this.rewrites++;
    const tree = new Map(this.git.tree(base));
    tree.set('README.md', `# Rewritten ${this.int(99)}\n`);
    const other = this.git.commit([base], tree, 'Rewritten history');
    if (this.rng() < 0.5) this.git.forcePush(other);
    else this.git.forcePush(this.git.commit([other, head.sha], tree, 'Merge main into a side line, pushed as main'));
  }
}

// ---- normalised comparison shapes -----------------------------------------------------------

export function vec(v: ReadonlyMap<string, number>): Record<string, number> {
  return Object.fromEntries([...v].sort(([a], [b]) => cmp(a, b)));
}

export function statuses(m: ReadonlyMap<string, Status | OracleStatus>): Record<string, string> {
  return Object.fromEntries(
    [...m].sort(([a], [b]) => cmp(a, b)).map(([id, s]) => [id, s.kind === 'pending' ? 'pending' : `${s.kind}@${s.at}`]),
  );
}

export function boardOf(b: Board): Record<string, { exists: boolean; values: Record<string, Json> }> {
  const out: Record<string, { exists: boolean; values: Record<string, Json> }> = {};
  for (const path of [...b.keys()].sort(cmp)) {
    const rec = b.get(path)!;
    out[path] = { exists: rec.exists, values: Object.fromEntries([...rec.values].sort(([x], [y]) => cmp(x, y))) };
  }
  return out;
}

function oracleBoard(o: OracleResult): ReturnType<typeof boardOf> {
  const out: ReturnType<typeof boardOf> = {};
  for (const path of [...o.effective.keys()].sort(cmp)) out[path] = { exists: o.effective.get(path)!.exists, values: { ...o.effective.get(path)!.values } };
  return out;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
