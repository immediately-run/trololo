// What a publish writes and how a publish commit is recognised (COLLABORATION_SESSIONS §6.2,
// §6.3, §15.6): the files of `Snap(P, ops(V))`, the trailers, and the digest.

import { actorLogin, cmp } from './batch';
import { normalizeGroup, sameValue, serializeRecord } from './canonical';
import type { Board, SnapRecord } from './fold';
import { resolveGroup } from './layout';
import type { Hash } from './ports';
import { covered, formatVector, parseVector, type Vector } from './vectors';

export const TRAILER_SESSION = 'Collab-Session';
export const TRAILER_VECTOR = 'Collab-Vector';
export const TRAILER_DIGEST = 'Collab-Digest';

/**
 * The files a publish writes: the canonical serialisation of every record of `board` that exists
 * and whose values differ from the base (a record the operations leave equal to the base is
 * satisfied, §5.5, and not rewritten). Path → text.
 */
export function publishFiles(board: Board): Map<string, string> {
  const files = new Map<string, string>();
  for (const [path, rec] of [...board.entries()].sort(([a], [b]) => cmp(a, b))) {
    if (!rec.exists || !differsFromBase(rec)) continue;
    files.set(path, serializeRecord(rec.set, rec.base, rec.values));
  }
  return files;
}

function differsFromBase(rec: SnapRecord): boolean {
  if (rec.base === null) return true;
  for (const [g, op] of rec.from) {
    if (!sameValue(op.value, normalizeGroup(rec.set, resolveGroup(rec.set, g)!, rec.base))) return true;
  }
  return false;
}

/** Logins of the authors whose operations a publish of `board` writes (`Co-authored-by`). */
export function publishAuthors(board: Board): string[] {
  const logins = new Set<string>();
  for (const rec of board.values()) {
    if (!rec.exists) continue;
    for (const [g, op] of rec.from) {
      const atBase = normalizeGroup(rec.set, resolveGroup(rec.set, g)!, rec.base);
      if (!sameValue(op.value, atBase)) logins.add(actorLogin(op.actor));
    }
  }
  return [...logins].sort(cmp);
}

/**
 * `Collab-Digest`: SHA-256 over the lines `"<actor> <seq> <batch-hash>\n"` of every batch the
 * vector covers, ordered by actor (UTF-16 code unit) and then seq (numeric).
 */
export async function vectorDigest(
  v: Vector,
  hashOf: (actor: string, seq: number) => string | undefined,
  hash: Hash,
): Promise<string | null> {
  let text = '';
  for (const [actor, seq] of covered(v)) {
    const h = hashOf(actor, seq);
    if (h === undefined) return null;
    text += `${actor} ${seq} ${h}\n`;
  }
  return hash(new TextEncoder().encode(text));
}

export function buildTrailers(sessionId: string, v: Vector, digest: string, authors: readonly string[]): string[] {
  return [
    `${TRAILER_SESSION}: ${sessionId}`,
    `${TRAILER_VECTOR}: ${formatVector(v)}`,
    `${TRAILER_DIGEST}: ${digest}`,
    ...authors.map((l) => `Co-authored-by: ${l} <${l}@users.noreply.github.com>`),
  ];
}

/** The commit message a `contribute` request produces: the message, a blank line, the trailers. */
export function commitMessage(message: string, trailers: readonly string[]): string {
  return `${message}\n\n${trailers.join('\n')}\n`;
}

export type TrailerReading =
  | { readonly kind: 'external' }
  | { readonly kind: 'publish'; readonly vector: Vector; readonly digest: string }
  | { readonly kind: 'malformed'; readonly reason: string };

function trailerValues(message: string, name: string): string[] {
  const out: string[] = [];
  for (const line of message.split('\n')) {
    if (line.startsWith(name + ':')) out.push(line.slice(name.length + 1).trim());
  }
  return out;
}

/**
 * Reads a commit's session trailers (§15.6). A commit is a publish of this session iff it carries
 * this session's `Collab-Session`; a malformed set, or a second set, is an integrity failure.
 */
export function readTrailers(message: string, sessionId: string): TrailerReading {
  const sessions = trailerValues(message, TRAILER_SESSION);
  if (!sessions.includes(sessionId)) return { kind: 'external' };
  if (sessions.length > 1) return { kind: 'malformed', reason: 'a second set of session trailers' };
  const vectors = trailerValues(message, TRAILER_VECTOR);
  const digests = trailerValues(message, TRAILER_DIGEST);
  if (vectors.length !== 1 || digests.length !== 1) return { kind: 'malformed', reason: 'vector or digest count' };
  const vector = parseVector(vectors[0]);
  if (vector === null) return { kind: 'malformed', reason: 'vector' };
  if (!/^[0-9a-f]{64}$/.test(digests[0])) return { kind: 'malformed', reason: 'digest' };
  return { kind: 'publish', vector, digest: digests[0] };
}
