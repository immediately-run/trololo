import { describe, expect, it } from 'vitest';
import { contiguous, covered, dominates, formatVector, parseVector } from './vectors';

const A = 'ana.dev00001.tab00001';
const B = 'Ben.dev00002.tab00002';

describe('§3.8 vectors', () => {
  it('contiguous prefixes stop at the first gap or refused seq', () => {
    const slots = new Map([
      [A, new Map([[1, 0], [2, 0], [4, 0]])],
      [B, new Map([[2, 0]])],
    ]);
    expect(contiguous(slots, () => true)).toEqual(new Map([[A, 2]]));
    expect(contiguous(slots, (_, s) => s !== 2)).toEqual(new Map([[A, 1]]));
  });

  it('dominance is entry-wise', () => {
    expect(dominates(new Map([[A, 3]]), new Map([[A, 3]]))).toBe(true);
    expect(dominates(new Map([[A, 3]]), new Map([[A, 4]]))).toBe(false);
    expect(dominates(new Map(), new Map([[B, 1]]))).toBe(false);
    expect(dominates(new Map([[A, 1]]), new Map())).toBe(true);
  });

  it('formats sorted by code unit and parses back', () => {
    const v = new Map([[A, 10], [B, 2]]);
    expect(formatVector(v)).toBe(`${B}=2;${A}=10`);
    expect(parseVector(formatVector(v))).toEqual(v);
  });

  it.each(['', `${A}=0`, `${A}=1;${A}=2`, 'bad=1', `${A}=x`, `${A}=1;`])('refuses %j', (t) => {
    expect(parseVector(t)).toBeNull();
  });

  it('covered lists actors by code unit, then seq numerically', () => {
    expect(covered(new Map([[A, 2], [B, 1]]))).toEqual([[B, 1], [A, 1], [A, 2]]);
    expect(covered(new Map([[A, 10]])).map(([, s]) => s)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});
