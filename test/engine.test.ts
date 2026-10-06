// Engine behaviour around integrity (§3.8, §15.6), readiness, bootstrap and the recoverable view.

import { describe, expect, it } from 'vitest';
import { batchPath, encodeBatch, type BatchBody } from '../src/lib/session/batch';
import { bootstrapFiles, NotReadyError, SessionEngine } from '../src/lib/session/engine';
import { layoutFromMarker } from '../src/lib/session/layout';
import { outsideEdit, place, settle, titleOf } from './sim/helpers';
import { CARDS, hash, LAYOUT, MARKER, SESSION_ID, World } from './sim/world';

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
    await b.engine.receive(sent.path, forged); // a second version of the same slot
    w.collect(b);
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
    await b.engine.receive(path, encodeBatch(bad));
    w.collect(b);
    expect(b.engine.frozen()).toBeNull(); // its predecessor has not arrived yet
    await b.engine.receive(one.path, one.bytes);
    w.collect(b);
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
