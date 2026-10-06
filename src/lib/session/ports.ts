// What the engine needs from outside, as interfaces the app injects (R3-970) and the simulator
// implements (test/sim). Nothing here imports the platform.

/** A commit's files: bundle-relative path → UTF-8 text. */
export type Tree = ReadonlyMap<string, string>;

/** One commit of the main line, as the engine adopts it (§5.3). */
export interface ChainCommit {
  readonly sha: string;
  /** The first parent, or null for a root commit. */
  readonly parent: string | null;
  readonly message: string;
  readonly tree: Tree;
}

export interface LogEntry {
  readonly sha: string;
  readonly parent: string | null;
  readonly message: string;
}

/**
 * The bundle history verbs (COLLABORATION_SESSIONS §16; R3-954 `bundleHead`, `bundleLog`,
 * `bundleIsAncestor`, `bundleRead`, `bundleDiffPaths`), narrowed to what the engine asks.
 */
export interface HistoryPort {
  head(): Promise<string>;
  /** First-parent log from `from` (inclusive), newest first, at most `limit` entries. */
  log(from: string, limit: number): Promise<LogEntry[]>;
  /** Reflexive: a commit is an ancestor of itself. */
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
  /** The bundle's files at `sha`. */
  read(sha: string): Promise<Tree>;
  /** Paths that differ between two commits. */
  diffPaths(a: string, b: string): Promise<string[]>;
}

/** SHA-256 of some bytes, lowercase hex. The app passes `crypto.subtle`; tests may pass Node's. */
export type Hash = (bytes: Uint8Array) => Promise<string>;

/** The clock, injected: the engine never reads `Date.now()` itself. */
export type Clock = () => Date;

export function sha256WithSubtle(subtle: SubtleCrypto): Hash {
  return async (bytes) => {
    const digest = await subtle.digest('SHA-256', bytes as BufferSource);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  };
}
