// Engine behaviour around integrity (§3.8, §15.6), readiness, bootstrap and the recoverable view.

import { describe, expect, it } from 'vitest';
import { batchPath, encodeBatch, LAMPORT_LIMIT, type BatchBody } from '../src/lib/session/batch';
import { bootstrapFiles, NotReadyError, SessionEngine } from '../src/lib/session/engine';
import { layoutFromMarker } from '../src/lib/session/layout';
import { outsideEdit, place, settle, titleOf } from './sim/helpers';
import { CARDS, COLUMNS, hash, LAYOUT, MARKER, SESSION_ID, World } from './sim/world';

const [X] = CARDS;
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
      sessionId: SESSION_ID, layout: LAYOUT, start: w.commitOf(w.root), actor: 'ana.aaaaaaaa.bbbbbbbb',
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
      sessionId: SESSION_ID, layout: LAYOUT, start: w.commitOf(w.root), actor: 'ana.aaaaaaaa.bbbbbbbb',
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

  it('refuses to issue once the lamport space is exhausted rather than send invalid batches', async () => {
    const w = new World(316);
    const a = await w.join('ana');
    const b = await w.join('ben');
    const one = decode((await a.engine.renameCard(X, 'x')).bytes);
    const top = encodeBatch({ ...one, lamport: LAMPORT_LIMIT - 1 });
    // Ben reads a batch at the top of the lamport range (here, a rewritten copy of Ana's first).
    await w.receiveNow(b, batchPath(one.actor, 1), top);
    await expect(b.engine.renameCard(X, 'y')).rejects.toThrow(/lamport/);
  });
});
