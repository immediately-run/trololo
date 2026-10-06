// Small helpers for the named scenarios: where a card is, what its title is, and a check that
// every replica agrees with every other and with the oracle.

import type { CardView } from '../../src/lib/session/effective';
import type { SessionEngine } from '../../src/lib/session/engine';
import { json, type Replica, type World } from './world';

export type Place = { where: string; card: CardView } | null;

/** Where a card renders: its column id, `unsorted`, `archived`, `deleted`, or null if absent. */
export function place(e: SessionEngine, id: string): Place {
  const v = e.view();
  const hits: Array<{ where: string; card: CardView }> = [];
  for (const c of v.columns) for (const card of c.cards) if (card.id === id) hits.push({ where: c.id, card });
  for (const card of v.unsorted) if (card.id === id) hits.push({ where: 'unsorted', card });
  for (const card of v.archivedCards) if (card.id === id) hits.push({ where: 'archived', card });
  for (const card of v.deletedCards) if (card.id === id) hits.push({ where: 'deleted', card });
  if (hits.length > 1) throw new Error(`card ${id} renders ${hits.length} times`);
  return hits[0] ?? null;
}

/** Quiesce, then require convergence across replicas and with the oracle. */
export async function settle(w: World): Promise<void> {
  await w.quiesce();
  w.checkConverged();
}

/** Delivers everything `from` has written to `to` only (a partial exchange). */
export async function sendTo(w: World, from: Replica, to: Replica): Promise<void> {
  w.write(from);
  w.resolve(from);
  const mine = to.inbox.filter((p) => p.startsWith(`batches/${from.engine.actor}/`));
  to.inbox = to.inbox.filter((p) => !mine.includes(p));
  for (const p of mine) await to.engine.receive(p, w.space.get(p)!);
  w.collect(to);
}

/** Writes and resolves a replica's outbox without delivering it anywhere yet. */
export function flush(w: World, r: Replica): void {
  w.write(r);
  w.resolve(r);
}

/** An outside commit that sets fields of one card file. */
export function outsideEdit(w: World, path: string, fields: Record<string, unknown>, message = 'Outside change'): string {
  const tree = new Map(w.git.tree());
  const obj = JSON.parse(tree.get(path)!);
  Object.assign(obj, fields);
  tree.set(path, json(obj));
  return w.git.advance(tree, message);
}

export function titleOf(e: SessionEngine, id: string): string | null {
  return place(e, id)?.card.title ?? null;
}
