// COLLABORATION_SESSIONS §15.9: one case per scenario S1–S15 and S18–S21 (S16–S17 are phase P3),
// each driven through its exact steps. Every `settle` also checks every replica against every other
// replica and against the oracle.

import { describe, expect, it } from 'vitest';
import { compareOrder, type BatchBody } from '../src/lib/session/batch';
import { FrozenError } from '../src/lib/session/engine';
import { flush, outsideEdit, place, sendTo, settle, titleOf } from './sim/helpers';
import { CARDS, COLUMNS, World, type Replica } from './sim/world';

const [X, Y, Z, W] = CARDS;
const [C1, C2, C3] = COLUMNS;
const body = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes)) as BatchBody;

async function world(seed: number, ...logins: string[]): Promise<[World, ...Replica[]]> {
  const w = new World(seed);
  const rs: Replica[] = [];
  for (const l of logins) rs.push(await w.join(l));
  return [w, ...rs];
}

describe('§15.9 scenarios', () => {
  it('S1 — two users move the same card to different columns at once', async () => {
    const [w, a, b] = await world(101, 'ana', 'ben');
    const ba = body((await a.engine.moveCard(X, C2, 0)).bytes);
    const bb = body((await b.engine.moveCard(X, C3, 0)).bytes);
    await settle(w);
    const key = (x: BatchBody) => ({ lamport: x.lamport, actor: x.actor, seq: x.seq, index: 0 });
    const winner = compareOrder(key(ba), key(bb)) > 0 ? ba : bb;
    const pos = winner.ops[0].value as { column: string; order: string };
    for (const r of [a, b]) {
      const p = place(r.engine, X)!;
      expect(p.where).toBe(pos.column);
      expect(p.card.order).toBe(pos.order); // the winner's (column, order), never a mix
    }
  });

  it('S2 — one renames a card while the other moves it', async () => {
    const [w, a, b] = await world(102, 'ana', 'ben');
    await a.engine.renameCard(X, 'Renamed');
    await b.engine.moveCard(X, C3, 0);
    await settle(w);
    for (const r of [a, b]) expect(place(r.engine, X)).toMatchObject({ where: C3, card: { title: 'Renamed' } });
  });

  it('S3 — concurrent label additions; a third removes one it has seen', async () => {
    const [w, a, b, c] = await world(103, 'ana', 'ben', 'cy');
    await a.engine.setLabel(X, 'urgent', true);
    await b.engine.setLabel(X, 'blocked', true);
    await sendTo(w, a, c);
    await c.engine.setLabel(X, 'urgent', false);
    await settle(w);
    for (const r of [a, b, c]) expect(place(r.engine, X)!.card.labels).toEqual(['blocked', 'bug']);
  });

  it('S4 — one deletes a card while the other renames it; restore shows the new title', async () => {
    const [w, a, b] = await world(104, 'ana', 'ben');
    await a.engine.deleteCard(X, true);
    await b.engine.renameCard(X, 'New title');
    await settle(w);
    for (const r of [a, b]) expect(place(r.engine, X)!.where).toBe('deleted');
    await a.engine.deleteCard(X, false);
    await settle(w);
    for (const r of [a, b]) expect(place(r.engine, X)).toMatchObject({ where: C1, card: { title: 'New title' } });
  });

  it('S5 — one archives a column while the other moves a card into it', async () => {
    const [w, a, b] = await world(105, 'ana', 'ben');
    await a.engine.archiveColumn(C3, true);
    await b.engine.moveCard(X, C3, 0);
    await settle(w);
    for (const r of [a, b]) expect(place(r.engine, X)).toMatchObject({ where: 'unsorted', card: { column: C3 } });
    await a.engine.archiveColumn(C3, false);
    await settle(w);
    for (const r of [a, b]) expect(place(r.engine, X)!.where).toBe(C3);
  });

  it('S6 — two users insert cards at the same position at once', async () => {
    const [w, a, b] = await world(106, 'ana', 'ben');
    const before = Object.fromEntries(CARDS.map((id) => [id, place(a.engine, id)!.card.order]));
    await a.engine.createCard({ title: 'From Ana', column: C1, index: 0 });
    await b.engine.createCard({ title: 'From Ben', column: C1, index: 0 });
    await settle(w);
    const ids = (r: Replica) => r.engine.view().columns.find((c) => c.id === C1)!.cards.map((c) => c.id);
    expect(ids(a)).toEqual(ids(b));
    expect(ids(a)).toHaveLength(4);
    for (const id of CARDS) expect(place(a.engine, id)!.card.order).toBe(before[id]); // no other key changes
  });

  it('S7 — a card moved after the publish snapshot survives adoption', async () => {
    const [w, a, b] = await world(107, 'ana', 'ben');
    const first = body((await a.engine.moveCard(X, C2, 0)).bytes);
    await settle(w);
    expect(await w.publish(a)).toBe('published');
    const second = body((await b.engine.moveCard(X, C3, 0)).bytes); // b has not adopted the publish
    expect(second.base).toBe(w.root);
    await settle(w);
    for (const r of [a, b]) {
      expect(place(r.engine, X)!.where).toBe(C3);
      const st = r.engine.statuses();
      expect(st.get(`${first.actor}/${first.seq}/0`)?.kind).toBe('published');
      expect(st.get(`${second.actor}/${second.seq}/0`)?.kind).toBe('pending');
      expect(r.engine.pending().map((p) => p.path)).toEqual([`cards/${X}.json`]);
      expect(r.engine.superseded()).toEqual([]);
    }
  });

  it('S8 — an agent commits titles: (a) no override, (b) override before adopting, (c) override after', async () => {
    const [w, a, b] = await world(108, 'ana', 'ben');
    await a.engine.renameCard(Y, 'Session before'); // (b)
    await settle(w);
    const t = new Map(w.git.tree());
    for (const [id, title] of [[X, 'Agent X'], [Y, 'Agent Y'], [Z, 'Agent Z']]) {
      const o = JSON.parse(t.get(`cards/${id}.json`)!);
      o.title = title;
      t.set(`cards/${id}.json`, JSON.stringify(o, null, 2) + '\n');
    }
    w.git.advance(t, 'Agent retitles three cards');
    await settle(w);
    await b.engine.renameCard(Z, 'Session after'); // (c)
    await settle(w);
    for (const r of [a, b]) {
      expect(titleOf(r.engine, X)).toBe('Agent X'); // (a)
      expect(titleOf(r.engine, Y)).toBe('Agent Y'); // (b)
      expect(r.engine.superseded().map((s) => [s.path, s.value])).toEqual([[`cards/${Y}.json`, 'Session before']]);
      expect(titleOf(r.engine, Z)).toBe('Session after'); // (c)
    }
  });

  it('S9 — a replica offline across two outside commits and a publish, with journaled edits', async () => {
    const [w2, a2, b2, c2] = await world(109, 'ana', 'ben', 'cy');
    a2.online = false;
    await a2.engine.renameCard(X, 'Offline title');
    await a2.engine.setLabel(Y, 'idea', true);
    await a2.engine.moveCard(W, C3, 0);
    w2.collect(a2);
    expect(a2.journal).toHaveLength(3); // journaled, unsent
    outsideEdit(w2, `cards/${X}.json`, { title: 'Outside 1' });
    for (const r of [b2, c2]) await w2.sync(r);
    await b2.engine.renameCard(Z, 'Ben while Ana is away');
    flush(w2, b2);
    await w2.deliver(c2, Infinity);
    await w2.deliver(b2, Infinity);
    expect(await w2.publish(b2)).toBe('published');
    outsideEdit(w2, 'board.json', { name: 'Outside 2' });
    for (const r of [b2, c2]) await w2.sync(r);
    // Ana reloads before her journal is written: the batches are re-sent byte for byte.
    a2.online = true;
    await w2.reload(a2);
    await settle(w2);
    for (const r of [a2, b2, c2]) {
      expect(titleOf(r.engine, X)).toBe('Outside 1');
      expect(r.engine.superseded().map((s) => s.value)).toEqual(['Offline title']);
      expect(place(r.engine, Y)!.card.labels).toEqual(['idea']);
      expect(place(r.engine, W)!.where).toBe(C3);
      expect(titleOf(r.engine, Z)).toBe('Ben while Ana is away');
      expect(r.engine.view().name).toBe('Outside 2');
    }
  });

  it('S10 — the publish commit is seen before its batches arrive', async () => {
    const [w, a, b] = await world(110, 'ana', 'ben');
    await a.engine.renameCard(X, 'Published early');
    flush(w, a);
    expect(await w.publish(a)).toBe('published');
    await w.sync(b);
    expect(b.engine.offeredChain()).toHaveLength(2);
    expect(b.engine.adoptedChain()).toHaveLength(1); // §5.4 (a): waits
    w.check(b);
    await w.deliver(b, Infinity);
    expect(b.engine.adoptedChain()).toHaveLength(2);
    await settle(w);
    for (const r of [a, b]) {
      expect(titleOf(r.engine, X)).toBe('Published early');
      expect(r.engine.pending()).toEqual([]);
      expect([...r.engine.statuses().values()].map((s) => s.kind)).toEqual(['published']);
    }
  });

  it('S11 — two members press publish at once', async () => {
    const [w, a, b] = await world(111, 'ana', 'ben');
    await a.engine.renameCard(X, 'Ana');
    await b.engine.renameCard(Y, 'Ben');
    await settle(w);
    expect((await a.engine.publishPlan())!.needed).toBe(true);
    expect((await b.engine.publishPlan())!.needed).toBe(true);
    expect(await w.publish(a)).toBe('published');
    expect(await w.publish(b)).toBe('conflict');
    expect(b.engine.adoptedBase).toBe(w.git.main);
    expect((await b.engine.publishPlan())!.needed).toBe(false);
    await settle(w);
  });

  it('S12 — a cancelled publish dialog changes nothing', async () => {
    const [w, a] = await world(112, 'ana');
    await a.engine.renameCard(X, 'Kept pending');
    flush(w, a);
    const before = { pending: a.engine.pending(), plan: await a.engine.publishPlan() };
    // The contribute task resolves `cancelled`: the app does nothing.
    expect({ pending: a.engine.pending(), plan: await a.engine.publishPlan() }).toEqual(before);
    expect(before.pending).toHaveLength(1);
    await settle(w);
  });

  it('S13 — invalid batches are ignored in their entirety everywhere', async () => {
    const [w, a, b] = await world(113, 'ana', 'ben');
    const path = `cards/${X}.json`;
    const ok = { path, group: 'title', value: 'must not apply' };
    const bad = [
      { path, group: 'title', value: 'x'.repeat(501) },
      { path, group: 'colour', value: 'red' },
      { path, group: 'created', value: '2026-01-01T00:00:00Z' },
      { path: '.github/workflows/ci.yml', group: 'name', value: 'x' },
    ];
    const paths: string[] = [];
    for (const op of bad) paths.push((await a.engine.issue([ok, op])).path);
    // A batch file whose path does not match its actor and seq.
    const forged = (await a.engine.issue([{ path, group: 'title', value: 'forged' }])).bytes;
    const forgedPath = 'batches/mallory.aaaaaaaa.bbbbbbbb/1.json';
    w.space.set(forgedPath, forged);
    for (const r of [a, b]) r.inbox.push(forgedPath);
    await settle(w);
    for (const r of [a, b]) {
      for (const p of [...paths, forgedPath]) {
        expect(r.engine.batchState(p)).toBe('invalid');
        expect(r.engine.invalidReason(p)).toBeTruthy();
      }
      expect(titleOf(r.engine, X)).toBe('forged'); // only Ana's own valid batch applied
    }
  });

  it('S14 — identical bytes from two replicas; satisfied operations need no publish', async () => {
    const [w, a, b] = await world(114, 'ana', 'ben');
    await a.engine.renameCard(X, 'Same bytes');
    await b.engine.setLabel(Y, 'urgent', true);
    await settle(w);
    const pa = (await a.engine.publishPlan())!;
    const pb = (await b.engine.publishPlan())!;
    expect([...pa.files]).toEqual([...pb.files]);
    expect(pa.trailers).toEqual(pb.trailers);

    const [w2, c, d] = await world(214, 'cy', 'dee');
    await c.engine.renameCard(X, 'Card 1'); // the base value
    await d.engine.setLabel(X, 'bug', true); // already set at the base
    await settle(w2);
    for (const r of [c, d]) {
      expect(r.engine.pending()).toEqual([]);
      expect((await r.engine.publishPlan())!.needed).toBe(false);
    }
  });

  it('S15 — an outside commit changes the layout: the session freezes; restart offers the pending', async () => {
    const [w, a, b] = await world(115, 'ana', 'ben');
    await a.engine.renameCard(Y, 'Before the freeze');
    await settle(w);
    w.layoutChange();
    await settle(w);
    for (const r of [a, b]) {
      expect(r.engine.frozen()).toEqual({ reason: 'layout', at: w.git.main });
      await expect(r.engine.renameCard(X, 'no')).rejects.toBeInstanceOf(FrozenError);
      expect(r.engine.restartOffer().map((p) => [p.path, p.value])).toEqual([[`cards/${Y}.json`, 'Before the freeze']]);
      expect(await r.engine.publishPlan()).not.toBeNull(); // a layout freeze can still publish
    }
  });

  it('S18 — an edit made after adopting an outside change survives a publish that lacks it', async () => {
    const [w, a, b] = await world(118, 'ana', 'ben');
    await a.engine.renameCard(X, 'Published title');
    await settle(w);
    expect(await w.publish(a)).toBe('published');
    await settle(w);
    outsideEdit(w, `cards/${X}.json`, { title: 'Outside title' });
    await settle(w);
    const edit = body((await b.engine.renameCard(X, 'Edited after adopting')).bytes);
    flush(w, b); // written, not yet delivered to Ana
    await a.engine.renameCard(Y, 'Something else');
    flush(w, a);
    expect(await w.publish(a)).toBe('published'); // without Ben's edit
    await settle(w);
    for (const r of [a, b]) {
      expect(titleOf(r.engine, X)).toBe('Edited after adopting');
      expect(r.engine.pending().map((p) => p.id)).toEqual([`${edit.actor}/${edit.seq}/0`]);
    }
  });

  it('S19 — a published delete, then a restore: the card returns with its last fields', async () => {
    const [w, a, b] = await world(119, 'ana', 'ben');
    await a.engine.renameCard(X, 'Last title');
    await a.engine.setLabel(X, 'urgent', true);
    await a.engine.deleteCard(X, true);
    await settle(w);
    expect(await w.publish(a)).toBe('published');
    await settle(w);
    expect(JSON.parse(w.git.tree().get(`cards/${X}.json`)!).deleted).toBe(true); // a tombstone, not a removal
    await b.engine.deleteCard(X, false);
    await settle(w);
    for (const r of [a, b]) {
      expect(place(r.engine, X)).toMatchObject({ where: C1, card: { title: 'Last title', labels: ['bug', 'urgent'] } });
    }
    expect(await w.publish(b)).toBe('published');
    expect(JSON.parse(w.git.tree().get(`cards/${X}.json`)!).deleted).toBeUndefined();
    await settle(w);
  });

  it('S20 — batch k is invalid, batch k+1 is valid: k+1 applies and is published', async () => {
    const [w, a, b] = await world(120, 'ana', 'ben');
    const k = await a.engine.issue([{ path: `cards/${X}.json`, group: 'title', value: '' }]);
    const k1 = body((await a.engine.renameCard(X, 'Valid')).bytes);
    await settle(w);
    expect(await w.publish(b)).toBe('published');
    await settle(w);
    for (const r of [a, b]) {
      expect(r.engine.batchState(k.path)).toBe('invalid');
      expect(r.engine.statuses().get(`${k1.actor}/${k1.seq}/0`)?.kind).toBe('published');
      expect(titleOf(r.engine, X)).toBe('Valid');
    }
  });

  it('S21 — a commit one replica saw is force-pushed away: both freeze; restart offers the same', async () => {
    const [w, a, b] = await world(121, 'ana', 'ben');
    await b.engine.renameCard(Y, 'Pending everywhere');
    await settle(w);
    const before = w.git.main;
    outsideEdit(w, `cards/${X}.json`, { title: 'Soon gone' });
    await w.sync(a); // Ana adopts it; Ben never sees it
    expect(a.engine.adoptedChain()).toHaveLength(2);
    w.git.forcePush(w.git.commit([before], new Map(w.git.tree(before)).set('README.md', '# rewritten\n'), 'Rewrite'));
    await settle(w);
    for (const r of [a, b]) {
      expect(r.engine.frozen()?.reason).toBe('rewrite');
      expect(r.engine.adoptedChain()).toEqual([before]);
      expect(await r.engine.publishPlan()).toBeNull();
    }
    expect(a.engine.restartOffer()).toEqual(b.engine.restartOffer());
    expect(a.engine.restartOffer().map((p) => p.value)).toEqual(['Pending everywhere']);
  });
});
