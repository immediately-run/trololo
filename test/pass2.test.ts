// The concrete counterexamples of reviews/collaboration-sessions-2026-10-05:
// ADVERSARIAL_REVIEW_2.md P2-1 and P2-2 (cases i–iv), IMPLEMENTABILITY_REVIEW.md IM-4.
// Each is a defect revision 3 claims to have closed; each is driven exactly as the review wrote it.

import { describe, expect, it } from 'vitest';
import type { BatchBody } from '../src/lib/session/batch';
import { flush, outsideEdit, sendTo, settle, titleOf } from './sim/helpers';
import { CARDS, COLUMNS, World, type Replica } from './sim/world';

const [X, Y, Z] = CARDS;
const [, , C3] = COLUMNS;
const id = (bytes: Uint8Array, index = 0) => {
  const b = JSON.parse(new TextDecoder().decode(bytes)) as BatchBody;
  return `${b.actor}/${b.seq}/${index}`;
};

async function world(seed: number, ...logins: string[]): Promise<[World, ...Replica[]]> {
  const w = new World(seed);
  const rs: Replica[] = [];
  for (const l of logins) rs.push(await w.join(l));
  return [w, ...rs];
}

describe('pass-2 counterexamples', () => {
  it('P2-1 — a superseded override stays superseded across an unrelated later commit', async () => {
    const [w, a, b] = await world(201, 'ana', 'ben');
    const o = id((await a.engine.renameCard(X, 'Override')).bytes);
    await settle(w);
    outsideEdit(w, `cards/${X}.json`, { title: 'Agent' }); // B1 supersedes o (S8 b)
    await settle(w);
    outsideEdit(w, `cards/${Y}.json`, { archived: true }); // B2 touches another card only
    await settle(w);
    for (const r of [a, b]) {
      expect(titleOf(r.engine, X)).toBe('Agent');
      expect(r.engine.statuses().get(o)).toEqual({ kind: 'superseded', at: 1 });
    }
    // …and a published operation stays published across later commits.
    const p = id((await b.engine.renameCard(Z, 'Published')).bytes);
    await settle(w);
    expect(await w.publish(b)).toBe('published');
    outsideEdit(w, `cards/${Y}.json`, { archived: false });
    await settle(w);
    for (const r of [a, b]) {
      expect(r.engine.statuses().get(p)?.kind).toBe('published');
      expect(r.engine.pending()).toEqual([]);
    }
  });

  it('P2-2 (i) — an op in V_B superseded earlier does not turn the publish into an outside change', async () => {
    const [w, ana, ben] = await world(202, 'ana', 'ben');
    const o = id((await ana.engine.renameCard(X, 'Draft')).bytes); // 1
    await settle(w);
    outsideEdit(w, `cards/${X}.json`, { title: 'Final' }); // 2: E supersedes o
    await settle(w);
    await ben.engine.renameCard(Y, 'Ben also changed something'); // so Ben has a publish to make
    flush(w, ben);
    await w.deliver(ana, Infinity);
    await w.deliver(ben, Infinity);
    // 3. Ben's snapshot at P = E writes "Final"; his vector covers o.
    // 4. Ana, at E, edits after the snapshot.
    const o2 = id((await ana.engine.renameCard(X, 'Final v2')).bytes);
    expect(await w.publish(ben)).toBe('published'); // 5.
    await settle(w);
    for (const r of [ana, ben]) {
      expect(titleOf(r.engine, X)).toBe('Final v2');
      expect(r.engine.statuses().get(o2)?.kind).toBe('pending');
      expect(r.engine.superseded().map((s) => s.id)).toEqual([o]); // no phantom outside change
    }
  });

  it('P2-2 (ii) — a gap in the publisher vector: a later edit still wins by order, not by supersession', async () => {
    const [w, a, b] = await world(203, 'ana', 'ben');
    const a1 = await a.engine.renameCard(X, 'a:1');
    const a2 = await a.engine.renameCard(X, 'a:2 (lamport 30 in the review)');
    flush(w, a);
    // Ben receives a:2 but not a:1: a gap. His publish vector for Ana is empty.
    await b.engine.receive(a2.path, a2.bytes);
    b.inbox = b.inbox.filter((p) => p !== a2.path);
    expect(b.engine.publishVector().get(a.engine.actor)).toBeUndefined();
    await b.engine.renameCard(Y, 'Ben publishes this');
    flush(w, b);
    expect(await w.publish(b)).toBe('published');
    // Made after the snapshot, with a greater lamport than a:2.
    const later = id((await b.engine.renameCard(X, 'b after the snapshot')).bytes);
    await settle(w);
    void a1;
    for (const r of [a, b]) {
      expect(titleOf(r.engine, X)).toBe('b after the snapshot');
      expect(r.engine.statuses().get(later)?.kind).toBe('pending');
      expect(r.engine.superseded()).toEqual([]);
    }
  });

  it('P2-2 (iii) — a held batch is outside the publish vector until its base is adopted', async () => {
    const [w, a, b] = await world(204, 'ana', 'ben');
    outsideEdit(w, `cards/${Z}.json`, { title: 'Outside' });
    await w.sync(a); // Ana adopts N; Ben has not
    const held = await a.engine.renameCard(X, 'Based on N');
    await sendTo(w, a, b);
    expect(b.engine.batchState(held.path)).toBe('held');
    expect(b.engine.publishVector().get(a.engine.actor)).toBeUndefined();
    const plan = (await b.engine.publishPlan())!;
    expect([...plan.files.keys()]).not.toContain(`cards/${X}.json`);
    expect(await w.publish(b)).toBe('nothing');
    await w.sync(b);
    expect(b.engine.batchState(held.path)).toBe('applied');
    expect([...(await b.engine.publishPlan())!.files.keys()]).toContain(`cards/${X}.json`);
    await settle(w);
  });

  it('P2-2 (iv) — a published delete leaves a tombstone, so later adoption meets no missing file', async () => {
    const [w, a, b] = await world(205, 'ana', 'ben');
    await a.engine.deleteCard(X, true);
    await settle(w);
    expect(await w.publish(a)).toBe('published');
    const after = id((await b.engine.renameCard(Y, 'After the delete')).bytes);
    await a.engine.setLabel(Z, 'urgent', true);
    await settle(w);
    expect(await w.publish(a)).toBe('published');
    await settle(w);
    expect(w.git.tree().has(`cards/${X}.json`)).toBe(true);
    for (const r of [a, b]) {
      expect(r.engine.superseded()).toEqual([]);
      expect(r.engine.statuses().get(after)?.kind).toBe('published');
      expect(r.engine.view().deletedCards.map((c) => c.id)).toEqual([X]);
    }
  });

  it('IM-4 — a cumulative V_B does not make the session’s own publish look like an outside change', async () => {
    const [w, r1, r2] = await world(206, 'ana', 'ben');
    await r1.engine.renameCard(X, 'x'); // o1
    await settle(w);
    expect(await w.publish(r1)).toBe('published'); // B1
    await settle(w);
    outsideEdit(w, `cards/${X}.json`, { title: 'y' }); // B2
    await settle(w);
    const o5 = id((await r2.engine.renameCard(X, 'z')).bytes); // R2 has adopted B2
    flush(w, r2);
    await r1.engine.moveCard(Z, C3, 0);
    flush(w, r1);
    expect(await w.publish(r1)).toBe('published'); // B3: V3 covers o1, not o5
    await settle(w);
    for (const r of [r1, r2]) {
      expect(r.engine.statuses().get(o5)?.kind).toBe('pending');
      expect(titleOf(r.engine, X)).toBe('z');
    }
  });
});
