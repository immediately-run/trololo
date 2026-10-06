// Engine behaviour around integrity (§3.8, §15.6), readiness, bootstrap and the recoverable view.

import { describe, expect, it } from 'vitest';
import { batchPath, encodeBatch, LAMPORT_LIMIT, type BatchBody } from '../src/lib/session/batch';
import { bootstrapFiles, FrozenError, LamportExhausted, NotReadyError, SessionEngine } from '../src/lib/session/engine';
import { layoutFromMarker } from '../src/lib/session/layout';
import { outsideEdit, place, sendTo, settle, titleOf } from './sim/helpers';
import { CARDS, COLUMNS, hash, LAYOUT, MARKER, SESSION_ID, World, type Replica } from './sim/world';

const [X, Y] = CARDS;
const decode = (b: Uint8Array) => JSON.parse(new TextDecoder().decode(b)) as BatchBody;

describe('integrity failures freeze every replica (§15.6)', () => {
  it('a batch file rewritten in place', async () => {
    const w = new World(301);
    const a = await w.join('ana');
    const b = await w.join('ben');
    const sent = await a.engine.renameCard(X, 'Original');
    await settle(w);
    const forged = encodeBatch({ ...decode(sent.bytes), ops: [{ path: `cards/${X}.json`, group: 'title', value: 'Forged' }] });
    await w.receiveNow(b, sent.path, forged); // a second version of the same slot
    await w.quiesce();
    for (const r of [a, b]) {
      expect(r.engine.frozen()?.reason).toBe('integrity');
      expect(await r.engine.publishPlan()).toBeNull();
      expect(titleOf(r.engine, X)).toBe('Original'); // the first version read is kept
    }
  });

  it('a batch whose prev does not match its predecessor', async () => {
    const w = new World(302);
    const a = await w.join('ana');
    const b = await w.join('ben');
    const one = await a.engine.renameCard(X, 'one');
    const bad: BatchBody = { ...decode(one.bytes), seq: 2, lamport: 5, prev: 'f'.repeat(64) };
    const path = batchPath(a.engine.actor, 2);
    w.space.set(path, encodeBatch(bad));
    await w.receiveNow(b, path);
    expect(b.engine.frozen()).toBeNull(); // its predecessor has not arrived yet
    w.write(a);
    await w.receiveNow(b, one.path);
    expect(b.engine.frozen()?.reason).toBe('integrity');
    await w.quiesce();
    expect(a.engine.frozen()?.reason).toBe('integrity');
  });

  it('a publish whose digest does not match the batches held is not adopted', async () => {
    const w = new World(303);
    const a = await w.join('ana');
    await a.engine.renameCard(X, 'x');
    w.write(a);
    w.resolve(a);
    const plan = (await a.engine.publishPlan())!;
    const wrong = plan.trailers.map((t) => (t.startsWith('Collab-Digest:') ? `Collab-Digest: ${'0'.repeat(64)}` : t));
    const start = w.git.main;
    w.git.publish(start, plan.files, `Publish\n\n${wrong.join('\n')}\n`);
    await w.sync(a);
    expect(a.engine.adoptedChain()).toEqual([start]);
    expect(a.engine.frozen()).toEqual({ reason: 'integrity', at: start });
  });

  it('a malformed trailer set', async () => {
    const w = new World(304);
    const a = await w.join('ana');
    const tree = new Map(w.git.tree());
    w.git.advance(tree, `Hand-made\n\nCollab-Session: ${SESSION_ID}\nCollab-Vector: nonsense\n`);
    await w.sync(a);
    expect(a.engine.frozen()?.reason).toBe('integrity');
    expect(a.engine.adoptedChain()).toHaveLength(1);
  });
});

describe('engine', () => {
  it('issues nothing before the log has been read in full (§3.8)', async () => {
    const w = new World(305);
    const e = new SessionEngine({
      sessionId: SESSION_ID, layout: LAYOUT, start: w.commitOf(w.root), actor: 'ana.aaaaaaaa.bbbbbbbb', history: w.git,
      hash, clock: () => new Date(0), random: () => 0,
    });
    await expect(e.renameCard(X, 'too early')).rejects.toBeInstanceOf(NotReadyError);
  });

  it('bootstrap writes the marker, the board and three default columns (§15.7)', () => {
    let n = 0;
    const files = bootstrapFiles(MARKER, 'Roadmap', (k) => n++ % k);
    expect([...files.keys()].filter((p) => p.startsWith('columns/'))).toHaveLength(3);
    expect(JSON.parse(files.get('board.json')!)).toEqual({ name: 'Roadmap' });
    expect(layoutFromMarker(files.get('immediately.run.json'))!.fingerprint).toBe(LAYOUT.fingerprint);
    const w = new World(306, files);
    expect(w).toBeDefined();
  });

  it('keeps operations on a record that does not exist as orphans, neither rendered nor published', async () => {
    const w = new World(308);
    const a = await w.join('ana');
    const ghost = 'cards/ghost0000000.json';
    await a.engine.issue([{ path: ghost, group: 'title', value: 'Nobody created me' }]);
    w.write(a);
    w.resolve(a);
    expect(a.engine.view().orphans).toEqual([ghost]);
    expect([...(await a.engine.publishPlan())!.files.keys()]).toEqual([]);
    w.check(a);
  });

  it('re-applies a superseded operation at the current base; dismiss hides it locally', async () => {
    const w = new World(307);
    const a = await w.join('ana');
    const b = await w.join('ben');
    await a.engine.renameCard(X, 'Mine');
    await settle(w);
    outsideEdit(w, `cards/${X}.json`, { title: 'Theirs' });
    await settle(w);
    const [s] = a.engine.superseded();
    expect(s.value).toBe('Mine');
    await a.engine.reapply(s.id);
    await settle(w);
    for (const r of [a, b]) expect(titleOf(r.engine, X)).toBe('Mine');
    b.engine.dismiss(s.id);
    expect(b.engine.superseded()).toEqual([]);
    expect(a.engine.superseded()).toHaveLength(1);
    expect(place(a.engine, X)).not.toBeNull();
  });
});

describe('review regressions (PR #1)', () => {
  it('an integrity failure already in the log when a replica joins freezes it', async () => {
    const w = new World(311);
    const a = await w.join('ana');
    const one = await a.engine.renameCard(X, 'one');
    w.write(a);
    const forged: BatchBody = { ...decode(one.bytes), seq: 2, lamport: 5, prev: 'f'.repeat(64), ops: [{ path: `cards/${X}.json`, group: 'title', value: 'forged' }] };
    w.space.set(batchPath(a.engine.actor, 2), encodeBatch(forged));
    const cat = await w.join('cat');
    expect(cat.engine.frozen()?.reason).toBe('integrity');
    expect(await cat.engine.publishPlan()).toBeNull();
    await expect(cat.engine.renameCard(X, 'no')).rejects.toThrow(/frozen/);
  });

  it('a card created in the session, published, then removed by git does not come back', async () => {
    const w = new World(312);
    const a = await w.join('ana');
    const created = decode((await a.engine.createCard({ title: 'Short-lived', column: COLUMNS[0] })).bytes);
    const path = created.ops[0].path;
    await settle(w);
    expect(await w.publish(a)).toBe('published');
    const tree = new Map(w.git.tree());
    tree.delete(path);
    w.git.advance(tree, 'git rm');
    await settle(w);
    expect(a.engine.effectiveBoard().get(path)?.exists).toBe(false);
    expect((await a.engine.publishPlan())!.needed).toBe(false);
  });

  it('a merge whose first parent skips the adopted base freezes as a rewrite instead of throwing', async () => {
    const w = new World(313);
    const a = await w.join('ana');
    const x0 = w.git.main;
    const t = new Map(w.git.tree()).set('README.md', '# x1\n');
    const x1 = w.git.advance(t, 'X1');
    await w.sync(a);
    expect(a.engine.adoptedBase).toBe(x1);
    const l = w.git.commit([x0], new Map(w.git.tree(x0)).set('README.md', '# l\n'), 'L');
    w.git.forcePush(w.git.commit([l, x1], t, 'Merge X1 into L'));
    await w.sync(a);
    await w.sync(a); // and again: no throw
    expect(a.engine.frozen()).toEqual({ reason: 'rewrite', at: x0 });
    expect(a.engine.adoptedChain()).toEqual([x0]);
    w.check(a);
  });

  it('a layout change offered before the log is read freezes once it is read', async () => {
    const w = new World(314);
    w.layoutChange();
    const e = new SessionEngine({
      sessionId: SESSION_ID, layout: LAYOUT, start: w.commitOf(w.root), actor: 'ana.aaaaaaaa.bbbbbbbb', history: w.git,
      hash, clock: () => new Date(0), random: () => 0,
    });
    await e.offer(w.commitOf(w.git.main));
    expect(e.frozen()).toBeNull();
    await e.markLogRead();
    expect(e.frozen()).toEqual({ reason: 'layout', at: w.git.main });
  });

  it('operations restating a new record’s absent values are satisfied, not pending', async () => {
    const w = new World(315);
    const a = await w.join('ana');
    await a.engine.createCard({ title: 'New', column: COLUMNS[0] });
    expect(a.engine.pending().map((p) => p.group).sort()).toEqual(['created', 'createdBy', 'position', 'title']);
  });

  it('refuses to issue once the lamport space is exhausted, and the exhausted log freezes the reader (§15.5)', async () => {
    const w = new World(316);
    const a = await w.join('ana');
    const b = await w.join('ben');
    const one = decode((await a.engine.renameCard(X, 'x')).bytes);
    const top = encodeBatch({ ...one, lamport: LAMPORT_LIMIT - 1 });
    // Ben reads a batch at the top of the lamport range (here, a rewritten copy of Ana's first).
    await w.receiveNow(b, batchPath(one.actor, 1), top);
    expect(b.engine.frozen()).toEqual({ reason: 'integrity', at: one.base });
    await expect(b.engine.renameCard(X, 'y')).rejects.toBeInstanceOf(FrozenError);
    await expect(b.engine.setTerms('no lamport left')).rejects.toBeInstanceOf(LamportExhausted);
    w.check(b);
  });
});

/** A well-formed batch of a forger's at the lamport ceiling, based on `base` (§15.5, an exhausted log). */
function exhausting(base: string, name = 'top'): { path: string; bytes: Uint8Array } {
  const actor = 'mal.aaaaaaaa.bbbbbbbb';
  const body: BatchBody = {
    v: 1, actor, seq: 1, lamport: LAMPORT_LIMIT - 1, base, prev: '', time: '2026-10-06T00:00:00Z',
    ops: [{ path: '_session/terms', group: '$value', value: { name } }],
  };
  return { path: batchPath(actor, 1), bytes: encodeBatch(body) };
}

/** One version of a forger's batch slot, at `lamport`, based on `base`. */
function forgedVersion(base: string, lamport: number, name: string): { path: string; bytes: Uint8Array } {
  const actor = 'mal.aaaaaaaa.cccccccc';
  const body: BatchBody = {
    v: 1, actor, seq: 1, lamport, base, prev: '', time: '2026-10-06T00:00:00Z',
    ops: [{ path: '_session/terms', group: '$value', value: { name } }],
  };
  return { path: batchPath(actor, 1), bytes: encodeBatch(body) };
}

describe('review regressions, round two (PR #2, kept by R3-992)', () => {
  it('restart re-applies an unpublished new card as a valid create batch', async () => {
    const w = new World(321);
    const a = await w.join('ana');
    await a.engine.createCard({ title: 'Never published', column: COLUMNS[0] });
    await settle(w);
    w.layoutChange();
    await settle(w);
    const offer = a.engine.restartOffer();
    expect(offer.map((p) => p.group).sort()).toEqual(['archived', 'created', 'createdBy', 'deleted', 'due', 'position', 'title']);
    // "Restart session": a new session re-applies the offer in one batch.
    const w2 = new World(322);
    const b = await w2.join('ana');
    const sent = await b.engine.issue(offer.map(({ path, group, value }) => ({ path, group, value })));
    expect(b.engine.batchState(sent.path)).toBe('applied');
    expect(b.engine.effectiveBoard().get(offer[0].path)?.exists).toBe(true);
    w2.collect(b);
    w2.check(b);
  });

  it('a head that does not reach the start base is walked once, not on every poll', async () => {
    const w = new World(325);
    const a = await w.join('ana');
    w.git.forcePush(w.git.commit([], new Map(w.git.tree()), 'an unrelated root'));
    await w.sync(a);
    expect(a.engine.frozen()?.reason).toBe('rewrite');
    w.check(a);
    const after = w.git.logCalls;
    await w.sync(a);
    expect(w.git.logCalls).toBe(after);
    w.check(a);
  });
});

describe('R3-992: the freeze stop and the exhausted log (§15.5)', () => {
  /** Ana adopts x1 and x2 while Ben is offline; a force-push drops x2 (Ana freezes at x1); a second drops x1. */
  async function twoRewrites(seed: number) {
    const w = new World(seed);
    const a = await w.join('ana');
    const b = await w.join('ben');
    await b.engine.renameCard(Y, 'Pending everywhere');
    await settle(w);
    b.online = false;
    const x0 = w.git.main;
    const x1 = outsideEdit(w, `cards/${X}.json`, { title: 'x1' });
    outsideEdit(w, `cards/${X}.json`, { title: 'x2' });
    await w.sync(a);
    expect(a.engine.adoptedChain()).toHaveLength(3);
    w.check(a);
    w.git.forcePush(w.git.commit([x1], new Map(w.git.tree(x1)).set('README.md', '# y\n'), 'y'));
    await w.sync(a);
    expect(a.engine.frozen()).toEqual({ reason: 'rewrite', at: x1 });
    expect(a.engine.adoptedChain()).toEqual([x0, x1]);
    w.check(a);
    const z1 = w.git.commit([x0], new Map(w.git.tree(x0)).set('README.md', '# z1\n'), 'z1');
    w.git.forcePush(w.git.commit([z1], new Map(w.git.tree(z1)).set('README.md', '# z2\n'), 'z2'));
    await w.sync(a);
    // x1 has left the chain: the stop is the last commit of the chain that is an ancestor of x1.
    expect(a.engine.frozen()).toEqual({ reason: 'rewrite', at: x1 });
    expect(a.engine.adoptedChain()).toEqual([x0]);
    expect(a.engine.offeredChain().map((c) => c.sha)).toEqual([x0]);
    w.check(a);
    return { w, a, b, x0, x1 };
  }

  it('two replicas, two force-pushes: the offline one syncs first, then reads the freeze — both stop at the same commit', async () => {
    const { w, a, b, x0, x1 } = await twoRewrites(341);
    b.online = true;
    await w.sync(b);
    expect(b.engine.adoptedChain()).toHaveLength(3); // no freeze yet: z1 and z2 adopted
    w.check(b);
    await sendTo(w, a, b); // the freeze arrives: Ben rolls back to the stop
    expect(b.engine.frozen()).toEqual({ reason: 'rewrite', at: x1 });
    expect(b.engine.adoptedChain()).toEqual([x0]);
    w.check(b);
    await settle(w);
    for (const r of [a, b]) {
      expect(r.engine.adoptedChain()).toEqual([x0]);
      expect(await r.engine.publishPlan()).toBeNull();
    }
    expect(a.engine.restartOffer()).toEqual(b.engine.restartOffer());
    expect(a.engine.restartOffer().map((p) => p.value)).toEqual(['Pending everywhere']);
  });

  it('two replicas, two force-pushes: the offline one reads the freeze first, then syncs', async () => {
    const { w, a, b, x0, x1 } = await twoRewrites(342);
    b.online = true;
    await sendTo(w, a, b);
    expect(b.engine.frozen()).toEqual({ reason: 'rewrite', at: x1 });
    w.check(b);
    await w.sync(b);
    expect(b.engine.adoptedChain()).toEqual([x0]);
    w.check(b);
    await settle(w);
    expect(b.engine.restartOffer()).toEqual(a.engine.restartOffer());
  });

  it('a frozen replica keeps the chain it walked: a new head walks only the commits it adds', async () => {
    const { w, a, x0 } = await twoRewrites(343);
    const before = w.git.logCalls;
    outsideEdit(w, `cards/${X}.json`, { title: 'after the freeze' });
    await w.sync(a);
    expect(w.git.logCalls).toBe(before + 1);
    expect(a.engine.adoptedChain()).toEqual([x0]);
    w.check(a);
  });

  it('a lamport-exhausted replica is not lifted by a peer’s later layout freeze, and its offered chain is cut at the stop', async () => {
    const w = new World(344);
    const a = await w.join('ana');
    const b = await w.join('ben');
    await a.engine.renameCard(X, 'Kept pending');
    await settle(w);
    const root = w.git.main;
    outsideEdit(w, `cards/${Y}.json`, { title: 'outside' });
    await w.sync(b);
    expect(b.engine.adoptedChain()).toHaveLength(2);
    w.layoutChange();
    await w.sync(a);
    expect(a.engine.frozen()?.reason).toBe('layout'); // written, not yet delivered to Ben
    const top = exhausting(root);
    w.plant(top.path, top.bytes);
    await w.receiveNow(b, top.path);
    expect(b.engine.frozen()).toEqual({ reason: 'integrity', at: root });
    expect(b.engine.adoptedChain()).toEqual([root]);
    expect(b.engine.offeredChain().map((c) => c.sha)).toEqual([root]);
    w.check(b);
    await sendTo(w, a, b); // Ana's layout freeze reaches Ben
    expect(b.engine.frozen()).toEqual({ reason: 'integrity', at: root });
    w.check(b);
    await settle(w);
    for (const r of [a, b]) {
      expect(r.engine.frozen()).toEqual({ reason: 'integrity', at: root });
      expect(r.engine.adoptedChain()).toEqual([root]);
    }
  });

  it('an exhausted replica that detects another integrity failure writes nothing and does not throw', async () => {
    const w = new World(345);
    const b = await w.join('ben');
    const top = exhausting(w.root);
    w.plant(top.path, top.bytes);
    await w.receiveNow(b, top.path);
    // A second version of the same slot: an integrity failure Ben has no lamport left to announce.
    await expect(w.receiveNow(b, top.path, exhausting(w.root, 'other').bytes)).resolves.toBeUndefined();
    expect(b.engine.takeOutbox()).toEqual([]);
    expect(b.engine.frozen()).toEqual({ reason: 'integrity', at: w.root });
    w.check(b);
  });

  /** Two versions of one forged slot; `v2` sits at the ceiling (the round-one repro on trololo#3). */
  async function twoVersions(seed: number) {
    const w = new World(seed);
    const a = await w.join('ana');
    const b = await w.join('ben');
    const root = w.git.main;
    const x1 = outsideEdit(w, `cards/${X}.json`, { title: 'x1' });
    await w.sync(a);
    await w.sync(b);
    expect(a.engine.adoptedChain()).toEqual([root, x1]);
    const v1 = forgedVersion(root, 50, 'one');
    const v2 = forgedVersion(root, LAMPORT_LIMIT - 1, 'two');
    return { w, a, b, root, x1, v1, v2 };
  }

  it('two versions of a slot, one at the ceiling: the replica that read the lower one first freezes like the one that read the ceiling', async () => {
    const { w, a, b, root, v1, v2 } = await twoVersions(347);
    await w.receiveNow(a, v1.path, v1.bytes);
    await w.receiveNow(b, v2.path, v2.bytes);
    await w.receiveNow(a, v2.path, v2.bytes); // Ana detects the conflict and has no lamport left to announce it
    await sendTo(w, a, b);
    w.check(a);
    w.check(b);
    expect(a.engine.frozen()).toEqual({ reason: 'integrity', at: root });
    expect(b.engine.frozen()).toEqual(a.engine.frozen());
    expect(b.engine.adoptedChain()).toEqual(a.engine.adoptedChain());
    expect(a.engine.adoptedChain()).toEqual([root]);
  });

  it('two versions of a slot, one at the ceiling: the same freeze whichever version each replica reads first', async () => {
    const { w, a, b, v1, v2 } = await twoVersions(348);
    await w.receiveNow(a, v1.path, v1.bytes);
    await w.receiveNow(b, v2.path, v2.bytes);
    await w.receiveNow(a, v2.path, v2.bytes);
    await w.receiveNow(b, v1.path, v1.bytes);
    w.check(a);
    w.check(b);
    expect(b.engine.frozen()).toEqual(a.engine.frozen());
    expect(b.engine.adoptedChain()).toEqual(a.engine.adoptedChain());
  });

  it('two ceiling versions of one slot tie in §3.8 order: the greater at wins in either reading order', async () => {
    const { w, a, b, root, x1, v2 } = await twoVersions(350);
    const other = forgedVersion(x1, LAMPORT_LIMIT - 1, 'six');
    await w.receiveNow(a, v2.path, v2.bytes);
    await w.receiveNow(a, other.path, other.bytes);
    await w.receiveNow(b, other.path, other.bytes);
    await w.receiveNow(b, v2.path, v2.bytes);
    w.check(a);
    w.check(b);
    const greater = root > x1 ? root : x1;
    for (const r of [a, b]) expect(r.engine.frozen()).toEqual({ reason: 'integrity', at: greater });
    expect(b.engine.adoptedChain()).toEqual(a.engine.adoptedChain());
  });

  it('a forged freeze whose at names no commit stops at the start base, and a port that refuses the question does not wedge the replica', async () => {
    const w = new World(349);
    const a = await w.join('ana');
    const root = w.git.main;
    outsideEdit(w, `cards/${X}.json`, { title: 'x1' });
    await w.sync(a);
    expect(a.engine.adoptedChain()).toHaveLength(2);
    w.git.refuseUnknown = true;
    const forger = 'mal.aaaaaaaa.bbbbbbbb';
    const body: BatchBody = {
      v: 1, actor: forger, seq: 1, lamport: 3, base: root, prev: '', time: '2026-10-06T00:00:00Z',
      ops: [{ path: '_session/frozen', group: '$value', value: { reason: 'rewrite', at: 'f'.repeat(40) } }],
    };
    w.plant(batchPath(forger, 1), encodeBatch(body));
    await expect(w.receiveNow(a, batchPath(forger, 1))).resolves.toBeUndefined();
    expect(a.engine.frozen()).toEqual({ reason: 'rewrite', at: 'f'.repeat(40) });
    expect(a.engine.adoptedChain()).toEqual([root]);
    w.check(a);
    outsideEdit(w, `cards/${X}.json`, { title: 'x2' });
    await expect(w.sync(a)).resolves.toBeUndefined(); // later inputs still settle
    expect(a.engine.adoptedChain()).toEqual([root]);
    w.check(a);
  });

  /**
   * After a ceiling conflict: Carl joins, Ana reloads. Every replica — those that read the ceiling
   * version, and those that read only the space — must hold the same freeze and chain.
   */
  async function joinAndReload(w: World, rs: Replica[]): Promise<Replica[]> {
    for (const r of rs) {
      w.write(r);
      w.resolve(r);
    }
    const carl = await w.join('carl');
    await w.reload(rs[0]);
    const all = [...rs, carl];
    const [first, ...rest] = all;
    expect(first.engine.frozen()?.reason).toBe('integrity');
    for (const r of rest) {
      expect(r.engine.frozen()).toEqual(first.engine.frozen());
      expect(r.engine.adoptedChain()).toEqual(first.engine.adoptedChain());
    }
    await expect(carl.engine.renameCard(X, 'Carl edits')).rejects.toBeInstanceOf(FrozenError);
    await expect(rs[0].engine.renameCard(X, 'Ana edits after reload')).rejects.toBeInstanceOf(FrozenError);
    for (const r of all) {
      w.collect(r);
      w.check(r);
    }
    await settle(w);
    return all;
  }

  it('a ceiling version the space does not hold is announced: a joiner and a reloaded replica freeze like the rest', async () => {
    const { w, a, b, root, v1, v2 } = await twoVersions(352);
    w.plant(v1.path, v1.bytes); // the space holds the lower version
    await w.receiveNow(a, v1.path, v1.bytes);
    await w.receiveNow(b, v2.path, v2.bytes); // Ben is served the ceiling version
    await w.receiveNow(a, v2.path, v2.bytes); // Ana kept the lower one, so she announces
    expect(a.journal).toHaveLength(1);
    expect(decode(a.journal[0].bytes)).toMatchObject({
      lamport: LAMPORT_LIMIT - 1, base: root, ops: [{ path: '_session/frozen', value: { reason: 'integrity', at: root } }],
    });
    await sendTo(w, a, b);
    for (const r of await joinAndReload(w, [a, b])) expect(r.engine.frozen()).toEqual({ reason: 'integrity', at: root });
  });

  it('a space that holds the ceiling version: the replica that kept the lower one announces, and every reader agrees', async () => {
    const { w, a, b, root, v1, v2 } = await twoVersions(353);
    w.plant(v2.path, v2.bytes); // the space holds the ceiling version
    await w.receiveNow(a, v1.path, v1.bytes); // Ana is served the lower one first
    await w.receiveNow(a, v2.path);
    await w.receiveNow(b, v2.path);
    expect(a.journal.map((o) => decode(o.bytes).lamport)).toEqual([LAMPORT_LIMIT - 1]);
    for (const r of await joinAndReload(w, [a, b])) expect(r.engine.frozen()).toEqual({ reason: 'integrity', at: root });
  });

  it('the announcement is written even when a stop freeze is already in force', async () => {
    const { w, a, b, root, x1, v1, v2 } = await twoVersions(354);
    const forger = 'mal.aaaaaaaa.dddddddd';
    const rewrite: BatchBody = {
      v: 1, actor: forger, seq: 1, lamport: 3, base: root, prev: '', time: '2026-10-06T00:00:00Z',
      ops: [{ path: '_session/frozen', group: '$value', value: { reason: 'rewrite', at: x1 } }],
    };
    w.plant(batchPath(forger, 1), encodeBatch(rewrite));
    for (const r of [a, b]) await w.receiveNow(r, batchPath(forger, 1));
    expect(a.engine.frozen()).toEqual({ reason: 'rewrite', at: x1 });
    w.plant(v1.path, v1.bytes);
    await w.receiveNow(a, v1.path);
    await w.receiveNow(b, v2.path, v2.bytes);
    await w.receiveNow(a, v2.path, v2.bytes);
    expect(a.engine.frozen()).toEqual({ reason: 'integrity', at: root });
    w.collect(a);
    for (const r of await joinAndReload(w, [a, b])) expect(r.engine.frozen()).toEqual({ reason: 'integrity', at: root });
  });

  it('a stop computed on a refused ancestry question is asked again by a poll of the same head', async () => {
    const w = new World(355);
    const a = await w.join('ana');
    const root = w.git.main;
    const x1 = outsideEdit(w, `cards/${X}.json`, { title: 'x1' });
    const x2 = outsideEdit(w, `cards/${X}.json`, { title: 'x2' });
    await w.sync(a);
    expect(a.engine.adoptedChain()).toEqual([root, x1, x2]);
    // A freeze at a side commit off x2: off the chain, so the stop needs the ancestry search.
    const side = w.git.commit([x2], new Map(w.git.tree(x2)), 'side');
    const forger = 'mal.aaaaaaaa.eeeeeeee';
    const body: BatchBody = {
      v: 1, actor: forger, seq: 1, lamport: 3, base: root, prev: '', time: '2026-10-06T00:00:00Z',
      ops: [{ path: '_session/frozen', group: '$value', value: { reason: 'rewrite', at: side } }],
    };
    w.plant(batchPath(forger, 1), encodeBatch(body));
    w.git.refuseNext = 1000; // the history verb is down for the whole of this input
    await w.receiveNow(a, batchPath(forger, 1));
    expect(a.engine.adoptedChain()).toEqual([root]); // the refusal counted as "not an ancestor"
    w.git.refuseNext = 0;
    await w.sync(a); // the same head: nothing to walk, but the stop is asked again
    expect(a.engine.adoptedChain()).toEqual([root, x1, x2]);
    w.check(a);
    const calls = w.git.logCalls;
    await w.sync(a);
    expect(w.git.logCalls).toBe(calls);
    w.check(a);
  });

  it('a freeze that cannot be written for any other reason propagates', async () => {
    const w = new World(346);
    let failing = false;
    const e = new SessionEngine({
      sessionId: SESSION_ID, layout: LAYOUT, start: w.commitOf(w.root), actor: 'ana.aaaaaaaa.bbbbbbbb', history: w.git,
      hash: (bytes) => (failing ? Promise.reject(new Error('hashing failed')) : hash(bytes)), clock: () => new Date(0), random: () => 0,
    });
    await e.markLogRead();
    w.layoutChange();
    failing = true;
    await expect(e.sync()).rejects.toThrow('hashing failed');
    expect(e.frozen()).toBeNull();
  });
});
