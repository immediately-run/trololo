// Simulated git (R3-969): an in-memory DAG with a `main` ref — commits, merges, squashes and
// force-pushes — answering the history verbs through the same `HistoryPort` the app injects.

import { createHash } from 'node:crypto';
import type { HistoryPort, LogEntry, Tree } from '../../src/lib/session/ports';

export interface SimCommit {
  readonly sha: string;
  readonly parents: readonly string[];
  readonly message: string;
  readonly tree: Tree;
}

export type PublishResult = { ok: true; sha: string } | { ok: false; code: 'conflict'; head: string };

export class SimGit implements HistoryPort {
  readonly commits = new Map<string, SimCommit>();
  main: string;
  private counter = 0;

  constructor(tree: Tree, message = 'Initial board') {
    this.main = this.commit([], tree, message);
  }

  /** Creates a commit (not moving any ref). */
  commit(parents: readonly string[], tree: Tree, message: string): string {
    const sha = createHash('sha1').update(`${this.counter++}\u0000${parents.join(',')}\u0000${message}`).digest('hex');
    this.commits.set(sha, { sha, parents: [...parents], message, tree: new Map(tree) });
    return sha;
  }

  tree(sha = this.main): Tree {
    return this.commits.get(sha)!.tree;
  }

  /** An ordinary commit on `main` (an agent, a direct git edit). */
  advance(tree: Tree, message: string): string {
    this.main = this.commit([this.main], tree, message);
    return this.main;
  }

  /** A merge on `main` of a side branch forked at `main`: first parent `main`, tree `tree`. */
  merge(sideTree: Tree, tree: Tree, message: string): string {
    const side = this.commit([this.main], sideTree, 'side branch work');
    this.main = this.commit([this.main, side], tree, message);
    return this.main;
  }

  /** A squash merge: one ordinary commit on `main` carrying a whole branch's changes. */
  squash(tree: Tree, message: string): string {
    return this.advance(tree, message);
  }

  /** A force-push: `main` jumps to `sha` (usually an ancestor plus new commits). */
  forcePush(sha: string): void {
    this.main = sha;
  }

  /**
   * A direct commit through the `contribute` task (§6.9): files on an explicit parent, refused with
   * `conflict` when `main` no longer points at it (the fence, §6.3).
   */
  publish(parent: string, files: ReadonlyMap<string, string | null>, message: string): PublishResult {
    if (this.main !== parent) return { ok: false, code: 'conflict', head: this.main };
    const tree = new Map(this.tree(parent));
    for (const [p, text] of files) {
      if (text === null) tree.delete(p);
      else tree.set(p, text);
    }
    return { ok: true, sha: this.advance(tree, message) };
  }

  // ---- HistoryPort -------------------------------------------------------------------------

  async head(): Promise<string> {
    return this.main;
  }

  async log(from: string, limit: number): Promise<LogEntry[]> {
    const out: LogEntry[] = [];
    let cur: string | null = from;
    while (cur !== null && out.length < limit) {
      const c: SimCommit = this.commits.get(cur)!;
      const parent: string | null = c.parents[0] ?? null;
      out.push({ sha: c.sha, parent, message: c.message });
      cur = parent;
    }
    return out;
  }

  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    const seen = new Set<string>();
    const stack = [descendant];
    while (stack.length) {
      const s = stack.pop()!;
      if (s === ancestor) return true;
      if (seen.has(s)) continue;
      seen.add(s);
      stack.push(...(this.commits.get(s)?.parents ?? []));
    }
    return false;
  }

  async read(sha: string): Promise<Tree> {
    return this.tree(sha);
  }

  async diffPaths(a: string, b: string): Promise<string[]> {
    const ta = this.tree(a);
    const tb = this.tree(b);
    const out = new Set<string>();
    for (const [p, t] of ta) if (tb.get(p) !== t) out.add(p);
    for (const p of tb.keys()) if (!ta.has(p)) out.add(p);
    return [...out].sort();
  }
}
