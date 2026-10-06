// The board the app renders from a `Snap` (COLLABORATION_SESSIONS §15.3 existence, §15.7
// ordering, Unsorted, Archived, delete wins), plus the orphaned and unreadable lists.

import { cmp } from './batch';
import { parseRecord, type Json } from './canonical';
import type { Board, SnapRecord } from './fold';
import { matchPath, type Layout } from './layout';
import type { Tree } from './ports';

export interface CardView {
  readonly id: string;
  readonly path: string;
  readonly title: string | null;
  readonly column: string | null;
  readonly order: string | null;
  readonly labels: readonly string[];
  readonly due: string | null;
  readonly archived: boolean;
  readonly deleted: boolean;
  readonly created: string | null;
  readonly createdBy: string | null;
}

export interface ColumnView {
  readonly id: string;
  readonly path: string;
  readonly name: string | null;
  readonly order: string | null;
  readonly archived: boolean;
  readonly deleted: boolean;
}

export interface ColumnWithCards extends ColumnView {
  readonly cards: readonly CardView[];
}

export interface BoardView {
  readonly name: string | null;
  /** Visible columns by `(order, id)`, each with its visible cards by `(order, id)`. */
  readonly columns: readonly ColumnWithCards[];
  /** Cards whose column is missing, archived or deleted — rendered at the end, not a drop target. */
  readonly unsorted: readonly CardView[];
  readonly archivedColumns: readonly ColumnView[];
  readonly archivedCards: readonly CardView[];
  readonly deletedColumns: readonly ColumnView[];
  readonly deletedCards: readonly CardView[];
  /** Records that operations name but that do not exist (§15.3): kept, neither rendered nor published. */
  readonly orphans: readonly string[];
  /** Base files that do not parse (§15.3). */
  readonly unreadable: readonly string[];
}

/** A field's normalised value from a snap record, whichever group holds it. */
export function fieldOf(rec: SnapRecord, field: string): Json {
  if (rec.set.maps.has(field)) {
    const keys: string[] = [];
    for (const [g, v] of rec.values) if (v === true && g.startsWith(field + '.')) keys.push(g.slice(field.length + 1));
    return keys.sort(cmp);
  }
  for (const [g, fields] of rec.set.groups) {
    if (!fields.includes(field)) continue;
    const v = rec.values.get(g) ?? null;
    return fields.length === 1 ? v : ((v as Record<string, Json> | null)?.[field] ?? null);
  }
  return null;
}

const str = (v: Json): string | null => (typeof v === 'string' ? v : null);

function byOrderThenId(a: { order: string | null; id: string }, b: { order: string | null; id: string }): number {
  return cmp(a.order ?? '', b.order ?? '') || cmp(a.id, b.id);
}

export function cardView(rec: SnapRecord): CardView {
  return {
    id: rec.id ?? '',
    path: rec.path,
    title: str(fieldOf(rec, 'title')),
    column: str(fieldOf(rec, 'column')),
    order: str(fieldOf(rec, 'order')),
    labels: fieldOf(rec, 'labels') as string[],
    due: str(fieldOf(rec, 'due')),
    archived: fieldOf(rec, 'archived') === true,
    deleted: fieldOf(rec, 'deleted') === true,
    created: str(fieldOf(rec, 'created')),
    createdBy: str(fieldOf(rec, 'createdBy')),
  };
}

export function columnView(rec: SnapRecord): ColumnView {
  return {
    id: rec.id ?? '',
    path: rec.path,
    name: str(fieldOf(rec, 'name')),
    order: str(fieldOf(rec, 'order')),
    archived: fieldOf(rec, 'archived') === true,
    deleted: fieldOf(rec, 'deleted') === true,
  };
}

export function boardView(layout: Layout, board: Board, tree: Tree): BoardView {
  let name: string | null = null;
  const columns: ColumnView[] = [];
  const cards: CardView[] = [];
  const orphans: string[] = [];
  for (const rec of board.values()) {
    if (!rec.exists) {
      if (rec.touched) orphans.push(rec.path);
      continue;
    }
    if (rec.set.name === 'board') name = str(fieldOf(rec, 'name'));
    else if (rec.set.name === 'columns') columns.push(columnView(rec));
    else if (rec.set.name === 'cards') cards.push(cardView(rec));
  }
  columns.sort(byOrderThenId);
  cards.sort(byOrderThenId);

  const visible = columns.filter((c) => !c.deleted && !c.archived);
  const visibleIds = new Set(visible.map((c) => c.id));
  const live = cards.filter((c) => !c.deleted && !c.archived);

  const unreadable: string[] = [];
  for (const [path, text] of tree) {
    const m = matchPath(layout, path);
    if (m && m.set.mergeType === 'register' && parseRecord(text) === null) unreadable.push(path);
  }

  return {
    name,
    columns: visible.map((c) => ({ ...c, cards: live.filter((card) => card.column === c.id) })),
    unsorted: live.filter((c) => c.column === null || !visibleIds.has(c.column)),
    archivedColumns: columns.filter((c) => c.archived && !c.deleted),
    archivedCards: cards.filter((c) => c.archived && !c.deleted),
    deletedColumns: columns.filter((c) => c.deleted),
    deletedCards: cards.filter((c) => c.deleted),
    orphans: orphans.sort(cmp),
    unreadable: unreadable.sort(cmp),
  };
}
