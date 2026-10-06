import { describe, expect, it } from 'vitest';
import marker from '../../../test/fixtures/marker.json?raw';
import { boardView } from './effective';
import { contentsOf } from './fold';
import { layoutFromMarker } from './layout';

const layout = layoutFromMarker(marker)!;
const j = (o: unknown) => JSON.stringify(o);
const col = (id: string, order: string, extra = {}) => [`columns/${id}.json`, j({ name: id, order, ...extra })] as const;
const card = (id: string, column: string, order: string, extra = {}) =>
  [`cards/${id}.json`, j({ title: id, column, order, created: '2026-01-01T00:00:00Z', createdBy: 'x', ...extra })] as const;

describe('§15.7 rendering', () => {
  const tree = new Map<string, string>([
    ['immediately.run.json', marker],
    ['board.json', j({ name: 'Board' })],
    col('colaaaaaaaab', 'a1'),
    col('colaaaaaaaaa', 'a1'), // same key: ties break by id
    col('colarchived1', 'a2', { archived: true }),
    col('coldeleted01', 'a3', { deleted: true }),
    card('card00000002', 'colaaaaaaaaa', 'a1'),
    card('card00000001', 'colaaaaaaaaa', 'a1'),
    card('card00000003', 'colarchived1', 'a0'),
    card('card00000004', 'coldeleted01', 'a0'),
    card('card00000005', 'colmissing01', 'Zz'),
    card('card00000006', 'colaaaaaaaab', 'a0', { archived: true }),
    card('card00000007', 'colaaaaaaaab', 'a0', { deleted: true, archived: true }),
    ['cards/card00000008.json', '{ not json'],
    ['README.md', 'not a record'],
  ]);
  const v = boardView(layout, contentsOf(layout, tree), tree);

  it('orders columns and cards by (order, id)', () => {
    expect(v.name).toBe('Board');
    expect(v.columns.map((c) => c.id)).toEqual(['colaaaaaaaaa', 'colaaaaaaaab']);
    expect(v.columns[0].cards.map((c) => c.id)).toEqual(['card00000001', 'card00000002']);
  });

  it('puts cards of a missing, archived or deleted column in Unsorted, keeping their column', () => {
    expect(v.unsorted.map((c) => [c.id, c.column])).toEqual([
      ['card00000005', 'colmissing01'],
      ['card00000003', 'colarchived1'],
      ['card00000004', 'coldeleted01'],
    ]);
  });

  it('lists archived and deleted separately; delete wins over archive', () => {
    expect(v.archivedColumns.map((c) => c.id)).toEqual(['colarchived1']);
    expect(v.deletedColumns.map((c) => c.id)).toEqual(['coldeleted01']);
    expect(v.archivedCards.map((c) => c.id)).toEqual(['card00000006']);
    expect(v.deletedCards.map((c) => c.id)).toEqual(['card00000007']);
  });

  it('lists unreadable record files', () => {
    expect(v.unreadable).toEqual(['cards/card00000008.json']);
    expect(v.orphans).toEqual([]);
  });
});
