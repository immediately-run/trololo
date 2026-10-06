import { describe, expect, it } from 'vitest';
import marker from '../../../test/fixtures/marker.json?raw';
import { canonicalJson, cmp, normalizeGroup, parseRecord, sameValue, serializeRecord } from './canonical';
import { layoutFromMarker, resolveGroup } from './layout';

const cards = layoutFromMarker(marker)!.recordSets[2];

describe('§15.4 canonical bytes', () => {
  it('sorts keys by UTF-16 code unit at every level, integer-like keys included', () => {
    expect(canonicalJson({ b: 1, '10': 1, '9': 1, B: 1, a: { z: 1, Z: 2 } })).toBe(
      '{\n  "10": 1,\n  "9": 1,\n  "B": 1,\n  "a": {\n    "Z": 2,\n    "z": 1\n  },\n  "b": 1\n}',
    );
  });

  it('escapes strings exactly as JSON.stringify', () => {
    const s = 'quote " backslash \\ newline \n tab \t ü 😀  ';
    expect(canonicalJson({ s })).toBe(`{\n  "s": ${JSON.stringify(s)}\n}`);
  });

  it('cmp is code-unit order, not locale order', () => {
    expect(['b', 'B', 'a', 'é', 'e'].sort(cmp)).toEqual(['B', 'a', 'b', 'e', 'é']);
  });

  it('serialises a record: booleans written, deleted only when true, nulls omitted, labels only true and omitted when empty, unknown fields kept', () => {
    const base = { title: 'Old', extra: { kept: [1, 2] }, labels: { gone: false } };
    const values = new Map<string, unknown>([
      ['title', 'New'],
      ['position', { column: 'c7q2m9x0a1bz', order: 'a0' }],
      ['due', null],
      ['archived', false],
      ['deleted', false],
      ['created', '2026-10-06T12:00:00Z'],
      ['createdBy', 'ana'],
      ['labels.urgent', true],
      ['labels.blocked', null],
    ]);
    const text = serializeRecord(cards, base, values as Map<string, never>);
    expect(text).toBe(
      [
        '{',
        '  "archived": false,',
        '  "column": "c7q2m9x0a1bz",',
        '  "created": "2026-10-06T12:00:00Z",',
        '  "createdBy": "ana",',
        '  "extra": {',
        '    "kept": [',
        '      1,',
        '      2',
        '    ]',
        '  },',
        '  "labels": {',
        '    "urgent": true',
        '  },',
        '  "order": "a0",',
        '  "title": "New"',
        '}',
        '',
      ].join('\n'),
    );
    const noLabels = serializeRecord(cards, null, new Map([['deleted', true]]));
    expect(JSON.parse(noLabels)).toEqual({ archived: false, deleted: true });
  });

  it('normalised equality: absent ≡ null, absent boolean ≡ false, non-true map value ≡ absent', () => {
    const g = (name: string) => resolveGroup(cards, name)!;
    expect(normalizeGroup(cards, g('due'), {})).toBeNull();
    expect(normalizeGroup(cards, g('archived'), {})).toBe(false);
    expect(normalizeGroup(cards, g('labels.x'), { labels: { x: false } })).toBeNull();
    expect(normalizeGroup(cards, g('position'), { column: 'c' })).toEqual({ column: 'c', order: null });
    expect(sameValue({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  });

  it('only objects parse as records', () => {
    expect(parseRecord('[1]')).toBeNull();
    expect(parseRecord('{ broken')).toBeNull();
    expect(parseRecord(undefined)).toBeNull();
    expect(parseRecord('{"a":1}')).toEqual({ a: 1 });
  });
});
