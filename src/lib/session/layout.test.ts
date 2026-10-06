import { describe, expect, it } from 'vitest';
import marker from '../../../test/fixtures/marker.json?raw';
import {
  checkGroupValue,
  checkScalar,
  isProtectedPath,
  LayoutError,
  layoutFromMarker,
  matchPath,
  nonMapGroups,
  parseFieldType,
  parseLayout,
  resolveGroup,
} from './layout';

// The marker of COLLABORATION_SESSIONS §15.3, copied verbatim into test/fixtures/marker.json.
const layout = layoutFromMarker(marker)!;

describe('the §15.3 marker', () => {
  it('parses into four record sets with their merge types', () => {
    expect(layout.version).toBe(2);
    expect(layout.recordSets.map((s) => [s.name, s.mergeType])).toEqual([
      ['board', 'register'],
      ['columns', 'register'],
      ['cards', 'register'],
      ['descriptions', 'turn-taking'],
    ]);
  });

  it('derives groups, maps and immutable groups for cards', () => {
    const cards = layout.recordSets[2];
    expect([...cards.groups]).toEqual([
      ['position', ['column', 'order']],
      ['title', ['title']],
      ['due', ['due']],
      ['archived', ['archived']],
      ['deleted', ['deleted']],
      ['created', ['created']],
      ['createdBy', ['createdBy']],
    ]);
    expect([...cards.maps]).toEqual(['labels']);
    expect([...cards.immutableGroups]).toEqual(['created', 'createdBy']);
    expect(nonMapGroups(cards)).not.toContain('labels');
    expect(layout.recordSets[3]).toMatchObject({ mediaType: 'text/markdown', maxBytes: 65536 });
  });

  it('matches paths by glob, with the file-name stem as the id', () => {
    expect(matchPath(layout, 'board.json')).toMatchObject({ set: { name: 'board' }, id: null });
    expect(matchPath(layout, 'cards/k3f9x02mq1ab.json')).toMatchObject({ set: { name: 'cards' }, id: 'k3f9x02mq1ab' });
    expect(matchPath(layout, 'cards/k3f9x02mq1ab.md')).toMatchObject({ set: { name: 'descriptions' } });
    expect(matchPath(layout, 'cards/UPPERCASE123.json')).toBeNull(); // the stem must satisfy `id`
    expect(matchPath(layout, 'cards/sub/k3f9x02mq1ab.json')).toBeNull(); // `*` is one segment
    expect(matchPath(layout, 'README.md')).toBeNull();
  });

  it('keeps protected paths outside every record set', () => {
    for (const p of ['immediately.run.json', '.github/workflows/ci.yml', '_session/terms']) {
      expect(isProtectedPath(p)).toBe(true);
      expect(matchPath(layout, p)).toBeNull();
    }
  });

  it('resolves map entries at the first dot', () => {
    const cards = layout.recordSets[2];
    expect(resolveGroup(cards, 'labels.needs.review')).toEqual({ kind: 'mapEntry', map: 'labels', key: 'needs.review' });
    expect(resolveGroup(cards, 'labels.')).toBeNull();
    expect(resolveGroup(cards, 'column')).toBeNull(); // a grouped field is written through its group
    expect(resolveGroup(cards, 'nope')).toBeNull();
  });

  it('checks group values exactly', () => {
    const cards = layout.recordSets[2];
    const pos = resolveGroup(cards, 'position')!;
    expect(checkGroupValue(cards, pos, { column: 'c7q2m9x0a1bz', order: 'a0V' })).toBe(true);
    expect(checkGroupValue(cards, pos, { column: 'c7q2m9x0a1bz' })).toBe(false);
    expect(checkGroupValue(cards, pos, { column: 'c7q2m9x0a1bz', order: 'a0V', extra: 1 })).toBe(false);
    expect(checkGroupValue(cards, resolveGroup(cards, 'due')!, null)).toBe(true);
    expect(checkGroupValue(cards, resolveGroup(cards, 'title')!, null)).toBe(false);
    expect(checkGroupValue(cards, resolveGroup(cards, 'labels.urgent')!, true)).toBe(true);
    expect(checkGroupValue(cards, resolveGroup(cards, 'labels.urgent')!, false)).toBe(false);
  });
});

describe('type tokens', () => {
  it('string lengths count code points', () => {
    const s = parseFieldType('string:1..3');
    expect(s.kind === 'scalar' && checkScalar(s.scalar, '😀😀😀')).toBe(true);
    expect(s.kind === 'scalar' && checkScalar(s.scalar, '')).toBe(false);
    expect(s.kind === 'scalar' && checkScalar(s.scalar, 'abcd')).toBe(false);
  });

  it('dates must be real calendar dates; timestamps and logins follow their patterns', () => {
    expect(checkScalar({ kind: 'date' }, '2024-02-29')).toBe(true);
    expect(checkScalar({ kind: 'date' }, '2026-02-29')).toBe(false);
    expect(checkScalar({ kind: 'date' }, '2026-13-01')).toBe(false);
    expect(checkScalar({ kind: 'timestamp' }, '2026-10-06T12:00:00.123Z')).toBe(true);
    expect(checkScalar({ kind: 'timestamp' }, '2026-10-06T12:00:00+01:00')).toBe(false);
    expect(checkScalar({ kind: 'login' }, 'octo-cat')).toBe(true);
    expect(checkScalar({ kind: 'login' }, 'octo.cat')).toBe(false);
    expect(checkScalar({ kind: 'labelName' }, 'bad\u0007')).toBe(false);
    expect(checkScalar({ kind: 'labelName' }, 'x'.repeat(41))).toBe(false);
    expect(checkScalar({ kind: 'id' }, 'k3f9x02mq1ab')).toBe(true);
  });

  it('parses nullable and map tokens', () => {
    expect(parseFieldType('date|null')).toEqual({ kind: 'scalar', scalar: { kind: 'date' }, nullable: true });
    expect(parseFieldType('map<labelName,true>')).toEqual({ kind: 'map', key: { kind: 'labelName' } });
    expect(() => parseFieldType('uid')).toThrow(LayoutError);
  });
});

describe('malformed layouts are refused', () => {
  const base = { match: 'x/*.json', id: 'filename', mergeType: 'register', fields: { a: 'boolean', b: 'boolean' } };
  it.each([
    ['a group named like a field', { ...base, groups: { a: ['b'] } }],
    ['a field in two groups', { ...base, groups: { g: ['a'], h: ['a'] } }],
    ['a map field not declared as a map', { ...base, maps: ['a'] }],
    ['a map type not listed in maps', { ...base, fields: { m: 'map<labelName,true>' } }],
    ['an unknown merge type', { ...base, mergeType: 'crdt' }],
    ['an immutable map', { ...base, fields: { m: 'map<labelName,true>' }, maps: ['m'], immutable: ['m'] }],
  ])('%s', (_, rs) => {
    expect(() => parseLayout({ version: 1, recordSets: { x: rs } })).toThrow(LayoutError);
  });

  it('a marker without a valid layout has none', () => {
    expect(layoutFromMarker(undefined)).toBeNull();
    expect(layoutFromMarker('{')).toBeNull();
    expect(layoutFromMarker('{"kind":"board"}')).toBeNull();
  });
});
