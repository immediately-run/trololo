import { describe, expect, it } from 'vitest';
import { sha256WithSubtle } from './ports';
import { buildTrailers, commitMessage, readTrailers, vectorDigest } from './publish';

const hash = sha256WithSubtle(globalThis.crypto.subtle);
const A = 'ana.dev00001.tab00001';
const SID = 'sess0000000abcde';
const DIGEST = 'd'.repeat(64);

describe('§15.6 trailers', () => {
  it('a commit is this session’s publish iff it carries this session’s Collab-Session', () => {
    const msg = commitMessage('Publish', buildTrailers(SID, new Map([[A, 3]]), DIGEST, ['ana']));
    expect(msg).toBe(
      `Publish\n\nCollab-Session: ${SID}\nCollab-Vector: ${A}=3\nCollab-Digest: ${DIGEST}\nCo-authored-by: ana <ana@users.noreply.github.com>\n`,
    );
    expect(readTrailers(msg, SID)).toEqual({ kind: 'publish', vector: new Map([[A, 3]]), digest: DIGEST });
    expect(readTrailers(msg, 'other00000000000')).toEqual({ kind: 'external' });
    expect(readTrailers('Fix a typo', SID)).toEqual({ kind: 'external' });
  });

  it.each([
    ['a second set of trailers', `m\n\nCollab-Session: ${SID}\nCollab-Session: ${SID}\nCollab-Vector: ${A}=1\nCollab-Digest: ${DIGEST}`],
    ['another session’s trailers alongside', `m\n\nCollab-Session: ${SID}\nCollab-Session: other00000000000\nCollab-Vector: ${A}=1\nCollab-Digest: ${DIGEST}`],
    ['a missing vector', `m\n\nCollab-Session: ${SID}\nCollab-Digest: ${DIGEST}`],
    ['a malformed vector', `m\n\nCollab-Session: ${SID}\nCollab-Vector: ${A}=0\nCollab-Digest: ${DIGEST}`],
    ['a malformed digest', `m\n\nCollab-Session: ${SID}\nCollab-Vector: ${A}=1\nCollab-Digest: xyz`],
  ])('%s is malformed (an integrity failure)', (_, msg) => {
    expect(readTrailers(msg, SID).kind).toBe('malformed');
  });

  it('the digest covers "actor seq hash" lines in vector order', async () => {
    const hashes: Record<string, string> = { [`${A}/1`]: '01', [`${A}/2`]: '02' };
    const d = await vectorDigest(new Map([[A, 2]]), (a, s) => hashes[`${a}/${s}`], hash);
    expect(d).toBe(await hash(new TextEncoder().encode(`${A} 1 01\n${A} 2 02\n`)));
    expect(await vectorDigest(new Map([[A, 3]]), (a, s) => hashes[`${a}/${s}`], hash)).toBeNull();
  });
});
