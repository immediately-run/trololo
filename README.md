# Trololo

A Trello-like board for [immediately.run](https://immediately.run) whose collaboration sessions are
**semantically correct**: several people edit one board live, and git stays the board's truth at rest.

Trololo is the proof of concept for
[`COLLABORATION_SESSIONS_SPEC`](https://github.com/immediately-run/docs/blob/main/content/specs/COLLABORATION_SESSIONS_SPEC.mdx)
§15. Work is tracked in the docs repo under the `collaboration-sessions` project.

## What is here (phase P1, R3-969)

The **session engine** — a pure library with no platform dependency — and the harness that proves it.

| Path | What it is |
|---|---|
| `src/lib/session/layout.ts` | The marker's `layout` grammar and type tokens (§15.3); path matching; protected paths. |
| `src/lib/session/fracKey.ts` | Vendored rocicorp `fractional-indexing` 3.2.0 (CC0), plus jitter, validity, equal neighbours and the length budget (§3.4). |
| `src/lib/session/canonical.ts` | Canonical bytes and normalised equality (§15.4); `cmp`, the one string order. |
| `src/lib/session/batch.ts` | Batch files, the §3.8 order, and validity as a pure function of batch, layout and base contents. |
| `src/lib/session/vectors.ts` | Holding and publish vectors, dominance, the `Collab-Vector` text. |
| `src/lib/session/fold.ts` | The adopted-base chain, the status fold, `Snap`, `C_B`, late arrival, rollback (§5.3–§5.5). |
| `src/lib/session/effective.ts` | The rendered board: ordering, Unsorted, Archived, delete wins, orphans, unreadable files. |
| `src/lib/session/publish.ts` | Publish files, trailers, digest; reading a commit's trailers (§6.2, §15.6). |
| `src/lib/session/control.ts` | `_session/` terms and freezes. |
| `src/lib/session/engine.ts` | The façade the app calls: receive, adopt, issue, publish plan, the typed board operations. |
| `src/lib/session/ports.ts` | `HistoryPort` (the §16 history verbs), the injected hash and clock. |
| `test/oracle/reference.ts` | An independent oracle transcribed from the spec; it shares only `layout.ts` and `canonical.ts`. |
| `test/sim/` | Simulated git (merges, squashes, force-pushes, merges that move the old head off the first-parent chain), a session space with delayed, duplicated and reordered delivery, replicas with outboxes. The world records each replica's view itself (batches seen, acknowledgements, synced head) and feeds that — not the engine's own record — to the oracle; publish commits are built by the **oracle**. |

The board UI, the platform wiring (`HistoryPort` over the history verbs, the session space, the
`contribute` task) and descriptions arrive in R3-970 and R3-973.

## Tests

```bash
npm test          # unit tests, §15.9 scenarios, review counterexamples, 500-run convergence property
npm run build
npm run lint      # also bans localeCompare, Date.now, Math.random and platform imports in the engine
CONVERGENCE_RUNS=3000 npx vitest run test/convergence.property.test.ts   # a longer soak
```

The convergence property drives 2–5 replicas through random edits (some invalid), out-of-order and
duplicated delivery, offline periods, reloads, outside commits, merges, competing publishes, layout
changes and force-pushes. After every step the acting replica must equal the oracle on its own view;
after quiescence all replicas must equal each other and the oracle. Seeds that once failed are pinned
in the test file.
