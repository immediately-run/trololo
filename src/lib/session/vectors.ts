// The holding and publish vectors (COLLABORATION_SESSIONS §3.8 "Two vectors", §5.4).

import { cmp } from './canonical';
import { ACTOR_PATTERN } from './batch';

/** actor → seq; actors at 0 are omitted. */
export type Vector = ReadonlyMap<string, number>;

/** The highest seq per actor with every lower seq also present (`has`). */
export function contiguous(
  slots: ReadonlyMap<string, ReadonlyMap<number, unknown>>,
  counts: (actor: string, seq: number) => boolean,
): Map<string, number> {
  const v = new Map<string, number>();
  for (const [actor, seqs] of slots) {
    let s = 0;
    while (seqs.has(s + 1) && counts(actor, s + 1)) s++;
    if (s > 0) v.set(actor, s);
  }
  return v;
}

/** `v` dominates `w` when every entry of `v` is at least `w`'s. */
export function dominates(v: Vector, w: Vector): boolean {
  for (const [actor, seq] of w) if ((v.get(actor) ?? 0) < seq) return false;
  return true;
}

/** `Collab-Vector` text: `<actor>=<seq>` joined by `;`, actors by UTF-16 code unit. */
export function formatVector(v: Vector): string {
  return [...v.entries()]
    .filter(([, s]) => s > 0)
    .sort(([a], [b]) => cmp(a, b))
    .map(([a, s]) => `${a}=${s}`)
    .join(';');
}

/** Parses `Collab-Vector` text; null when malformed (empty, a bad actor or seq, a repeated actor). */
export function parseVector(text: string): Vector | null {
  if (text === '') return null;
  const v = new Map<string, number>();
  for (const part of text.split(';')) {
    const m = /^([^=]+)=([1-9][0-9]{0,14})$/.exec(part);
    if (!m || !ACTOR_PATTERN.test(m[1]) || v.has(m[1])) return null;
    v.set(m[1], Number(m[2]));
  }
  return v;
}

/** Every `(actor, seq)` a vector covers, sorted by actor (code unit) then seq (numeric). */
export function covered(v: Vector): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  for (const actor of [...v.keys()].sort(cmp)) {
    for (let s = 1; s <= v.get(actor)!; s++) out.push([actor, s]);
  }
  return out;
}
