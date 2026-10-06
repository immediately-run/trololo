import { describe, expect, it } from 'vitest';
import marker from '../../../test/fixtures/marker.json?raw';
import { compareOrder, contentValidity, decodeBatch, encodeBatch, type BatchBody, type Op } from './batch';
import { layoutFromMarker } from './layout';

const layout = layoutFromMarker(marker)!;
const ACTOR = 'ana.dev00001.tab00001';
const BASE = 'a'.repeat(40);
const CARD = 'cards/k3f9x02mq1ab.json';
const existing = JSON.stringify({ title: 'T', column: 'c7q2m9x0a1bz', order: 'a0', created: '2026-01-01T00:00:00Z', createdBy: 'x' });
const tree = new Map([
  ['immediately.run.json', marker],
  [CARD, existing],
]);

const body = (ops: Op[], over: Partial<BatchBody> = {}): BatchBody => ({
  v: 1, actor: ACTOR, seq: 1, lamport: 0, base: BASE, prev: '', time: '2026-10-06T12:00:00.000Z', ops, ...over,
});
const decode = (b: BatchBody, path = `batches/${b.actor}/${b.seq}.json`) => decodeBatch(path, encodeBatch(b), 'h');

describe('§3.8 order', () => {
  it('is (lamport, actor by code unit, seq, index)', () => {
    const k = (lamport: number, actor: string, seq: number, index: number) => ({ lamport, actor, seq, index });
    expect(compareOrder(k(2, 'a', 1, 0), k(1, 'z', 9, 9))).toBe(1);
    expect(compareOrder(k(1, 'B', 1, 0), k(1, 'a', 1, 0))).toBe(-1);
    expect(compareOrder(k(1, 'a', 2, 0), k(1, 'a', 10, 0))).toBe(-1);
    expect(compareOrder(k(1, 'a', 1, 3), k(1, 'a', 1, 1))).toBe(1);
    expect(compareOrder(k(1, 'a', 1, 1), k(1, 'a', 1, 1))).toBe(0);
  });
});

describe('§15.5 batch files', () => {
  it('decodes a well-formed batch; control-only batches are flagged', () => {
    expect(decode(body([{ path: CARD, group: 'title', value: 'x' }])).shapeError).toBeNull();
    const c = decode(body([{ path: '_session/terms', group: '$value', value: { name: 'Sprint' } }]));
    expect(c.controlOnly).toBe(true);
  });

  it.each([
    ['a path that does not match actor and seq', () => decode(body([]), `batches/${ACTOR}/2.json`)],
    ['a lamport out of range', () => decode(body([], { lamport: 2 ** 48 }))],
    ['a first batch with a prev', () => decode(body([], { prev: 'f'.repeat(64) }))],
    ['a later batch without one', () => decode(body([], { seq: 2 }))],
    ['an unknown envelope key', () => decode({ ...body([]), extra: 1 } as unknown as BatchBody)],
    ['a malformed operation', () => decode(body([{ path: CARD, group: 'title' } as unknown as Op]))],
    ['an unknown control record', () => decode(body([{ path: '_session/other', group: '$value', value: {} }]))],
    ['a frozen op with a bad reason', () => decode(body([{ path: '_session/frozen', group: '$value', value: { reason: 'bored', at: BASE } }]))],
  ])('refuses %s whatever the base', (_, f) => {
    expect(f().shapeError).not.toBeNull();
  });

  it('refuses bytes that are not JSON', () => {
    expect(decodeBatch(`batches/${ACTOR}/1.json`, new TextEncoder().encode('{'), 'h').shapeError).toBe('not JSON');
  });
});

describe('§3.8 validity against the base', () => {
  const v = (ops: Op[], t = tree) => contentValidity(body(ops), layout, t);
  const NEW = 'cards/zzzzzzzzzzzz.json';
  const create: Op[] = [
    { path: NEW, group: 'title', value: 'New' },
    { path: NEW, group: 'position', value: { column: 'c7q2m9x0a1bz', order: 'a1' } },
    { path: NEW, group: 'due', value: null },
    { path: NEW, group: 'archived', value: false },
    { path: NEW, group: 'deleted', value: false },
    { path: NEW, group: 'created', value: '2026-10-06T12:00:00.000Z' },
    { path: NEW, group: 'createdBy', value: 'ana' },
  ];

  it('a create batch writes every non-map group of a record absent at the base', () => {
    expect(v(create)).toEqual({ valid: true, creates: new Set([NEW]) });
  });

  it('an immutable field outside a create batch is invalid', () => {
    expect(v(create.slice(0, 6)).valid).toBe(false); // createdBy missing
    expect(v([{ path: CARD, group: 'created', value: '2026-10-06T12:00:00Z' }]).valid).toBe(false); // exists at base
  });

  it('a batch writing every group of a record that exists is not a create', () => {
    const all = create.filter((o) => o.group !== 'created' && o.group !== 'createdBy').map((o) => ({ ...o, path: CARD }));
    expect(v(all)).toEqual({ valid: true, creates: new Set() });
  });

  it.each([
    ['an oversized title', [{ path: CARD, group: 'title', value: 'x'.repeat(501) }]],
    ['an unknown field', [{ path: CARD, group: 'colour', value: 'red' }]],
    ['a protected path', [{ path: '.github/x.yml', group: 'name', value: 'x' }]],
    ['an unmatched path', [{ path: 'README.md', group: 'name', value: 'x' }]],
    ['a turn-taking path', [{ path: 'cards/k3f9x02mq1ab.md', group: '$file', value: {} }]],
    ['a bad map key', [{ path: CARD, group: 'labels.\u0001', value: true }]],
    ['null on a non-nullable field', [{ path: CARD, group: 'title', value: null }]],
  ])('%s makes the whole batch invalid', (_, ops) => {
    expect(v([{ path: CARD, group: 'title', value: 'fine' }, ...(ops as Op[])]).valid).toBe(false);
  });

  it('a base whose layout differs from the pinned one invalidates content batches (§3.1)', () => {
    const changed = JSON.parse(marker);
    changed.layout.recordSets.board.fields.name = 'string:1..9';
    const t = new Map(tree).set('immediately.run.json', JSON.stringify(changed));
    expect(v([{ path: CARD, group: 'title', value: 'x' }], t).valid).toBe(false);
  });
});
