// The simulated world (R3-969): replicas with outboxes, a session space whose deliveries are
// delayed, duplicated and reordered, simulated git, external writers, and publishers whose commits
// are built by the ORACLE — never by the engine's publish code.

import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { cmp, type Op } from '../../src/lib/session/batch';
import type { Json } from '../../src/lib/session/canonical';
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
      hash,
      clock: () => new Date((this.time += 1000)),
      random: (n) => this.int(n),
    });
    const r = new Replica(`r${this.replicas.length}`, login, engine);
    for (const [path, bytes] of this.space) await engine.receive(path, bytes);
    engine.markLogRead();
    await engine.sync(this.git);
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
  }

  collect(r: Replica): void {
    r.journal.push(...r.engine.takeOutbox());
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
    for (const p of r.unresolved) r.engine.acknowledge(p);
    r.unresolved = [];
  }

  /** Delivers up to `k` batch files in random order, sometimes leaving a duplicate behind. */
  async deliver(r: Replica, k: number): Promise<void> {
    if (!r.online) return;
    for (let i = 0; i < k && r.inbox.length; i++) {
      const j = this.int(r.inbox.length);
      const path = r.inbox[j];
      if (this.rng() >= 0.15) r.inbox.splice(j, 1);
      await r.engine.receive(path, this.space.get(path)!);
    }
    this.collect(r);
  }

  async sync(r: Replica): Promise<void> {
    if (!r.online) return;
    await r.engine.sync(this.git);
    this.collect(r);
  }

  /** The oracle's view of one replica. */
  oracleOf(r: Replica): OracleResult {
    return oracle({
      layout: LAYOUT,
      sessionId: SESSION_ID,
      offered: r.engine.offeredChain(),
      batches: r.engine.received(),
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

  /** After quiescence every replica derives the same state, and it is the oracle's. */
  checkConverged(): void {
    const [first, ...rest] = this.replicas;
    for (const r of this.replicas) this.check(r);
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
          await e.issue([{ path: 'board.json', group: 'name', value: `Board ${this.int(9)}` }]);
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

  /** A force-push: `main` drops its newest commit and gains another. */
  forcePush(): void {
    const head = this.git.commits.get(this.git.main)!;
    if (head.parents.length === 0) return;
    const base = head.parents[0];
    const tree = new Map(this.git.tree(base));
    tree.set('README.md', `# Rewritten ${this.int(99)}\n`);
    this.git.forcePush(this.git.commit([base], tree, 'Rewritten history'));
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
