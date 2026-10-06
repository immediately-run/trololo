// The randomized-order convergence property (R3-969, COLLABORATION_SESSIONS §5.5 last paragraph):
// 2–5 replicas, random edits (some invalid), delivery delayed, duplicated and reordered, replicas
// going offline and reloading, outside commits including merges, competing publishes, and rarely
// a layout change or a force-push. After every step the acting replica must equal the oracle on
// its own view; after quiescence every replica must equal every other and the oracle.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { World, type Replica } from './sim/world';

const RUNS = Number(process.env.CONVERGENCE_RUNS ?? 500);

/** Seeds that once failed, replayed on every run (append, never remove). */
const PINNED: Array<{ seed: number; replicas: number; actions: number[] }> = [
  // The oracle compared a never-set map key as undefined against null (an oracle defect).
  { seed: 248204832, replicas: 2, actions: [0, 0, 0, 30, 0, 81, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  // A batch based on a commit a force-push removed must be held again, not stay invalid.
  { seed: 23, replicas: 2, actions: [0, 30, 73, 0, 65, 42, 0, 0, 30, 0, 0, 0, 0, 0, 0, 0, 93, 0, 0, 0] },
  // A later layout freeze must not lift an earlier rewrite freeze (spec §15.5 amended).
  { seed: 1, replicas: 2, actions: [0, 0, 92, 0, 0, 0, 73, 81, 93, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 65, 0, 0, 0, 0, 0, 0, 65, 0, 0] },
  // Detecting a rewrite rolls back even when another replica's freeze already stopped the chain.
  { seed: 1879047932, replicas: 2, actions: [0, 81, 93, 73, 0, 65, 93, 0, 65, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
];

interface Coverage {
  publishes: number;
  conflicts: number;
  merges: number;
  reloads: number;
  supersededRuns: number;
  unfrozenRuns: number;
  frozenRuns: number;
  twoFreezeRuns: number;
  twoRewriteRuns: number;
  stopOffChainRuns: number;
  mixedBatches: number;
  ceilingRuns: number;
  secondVersionRuns: number;
  splitRuns: number;
  sameSetGroupsSplit: number;
  combinedRuns: number;
  sameSetImpliedPairs: number;
  orderSplitRuns: number;
  lateJoinRuns: number;
}

/** The `at` of a freeze that stops the chain, as some replica holds it: what a second rewrite removes. */
function stopAt(rs: readonly Replica[]): string | undefined {
  return rs.map((x) => x.engine.frozen()).find((f) => f !== null && f.reason !== 'layout')?.at;
}

async function run(seed: number, replicas: number, actions: number[], cov?: Coverage): Promise<World> {
  const w = new World(seed);
  const logins = ['ana', 'ben', 'cy', 'dee', 'eli'];
  const rs: Replica[] = [];
  for (let i = 0; i < replicas; i++) rs.push(await w.join(logins[i]));

  // A layout change or a rewrite freezes the session for good; keep at most two per run, in the
  // last third, so most of a run exercises a live session and some runs rewrite twice (§15.5 the stop).
  let freezers = 0;
  let plants = 0;
  let joined = false;
  for (const [i, a] of actions.entries()) {
    const r = rs[w.int(rs.length)];
    const late = i >= (actions.length * 2) / 3;
    if (late && freezers === 1 && w.rewrites === 1 && a >= 73 && a < 88) {
      // After one late rewrite, an outside change or a publish is instead: a sync, until the rewrite
      // has frozen someone; then a second rewrite that removes the commit that freeze stopped at
      // (§15.5 the stop).
      const at = stopAt(rs);
      if (at !== undefined) {
        freezers++;
        w.forcePush(at);
      } else await w.sync(r);
    }
    else if (a < 30) await w.edit(r);
    else if (a < 42) w.write(r);
    else if (a < 50) w.resolve(r);
    else if (a < 65) await w.deliver(r, 1 + w.int(4));
    else if (a < 73) await w.sync(r);
    else if (a < 81) w.externalCommit();
    else if (a < 88) {
      // Usually the publisher's outbox has drained before the button is pressed.
      if (w.rng() < 0.7) {
        w.write(r);
        w.resolve(r);
      }
      await w.publish(r);
    }
    else if (a < 91) r.online = !r.online;
    else if (a === 91) await w.reload(r);
    else if ((a === 94 || a === 95) && late && plants < 3 && w.rng() < 0.6) {
      // The exhausted-log class (§15.5, R3-995): a ceiling batch, or a second version of a stored
      // batch file, stored or served to some replicas only. Rare, late, at most three per run, so
      // some runs combine them (the P1–P3 shapes: a ceiling batch beside a second version, or a
      // second version of a ceiling batch).
      plants++;
      if (a === 94) await w.plantCeiling();
      else await w.plantSecondVersion();
      // Now and then a replica joins after the plant: it reads the space only.
      if (w.rng() < 0.3 && w.replicas.length < 6) {
        await w.join(['fay', 'gus', 'hal'][w.int(3)]);
        joined = true;
      }
    }
    else if (a === 92 || a === 93) {
      if (late && freezers < 2) {
        freezers++;
        if (a === 92) w.layoutChange();
        else w.forcePush(stopAt(rs));
      } else await w.deliver(r, Infinity);
    }
    else await w.deliver(r, Infinity);
    w.check(r);
  }
  await w.quiesce();
  w.checkConverged();
  if (cov) {
    cov.publishes += w.publishes;
    cov.conflicts += w.conflicts;
    cov.merges += w.merges;
    cov.reloads += w.reloads;
    if (rs.some((r) => r.engine.superseded().length > 0)) cov.supersededRuns++;
    if (rs[0].engine.frozen() === null) cov.unfrozenRuns++;
    else cov.frozenRuns++;
    if (freezers === 2) cov.twoFreezeRuns++;
    if (w.rewrites === 2) cov.twoRewriteRuns++;
    if (w.stopOffChain) cov.stopOffChainRuns++;
    cov.mixedBatches += w.mixed;
    if (w.ceilingPlants) cov.ceilingRuns++;
    if (w.secondVersions) cov.secondVersionRuns++;
    if (w.splitServes) cov.splitRuns++;
    const sets = w.sameSetStats();
    if (sets.groups > 1) cov.sameSetGroupsSplit++;
    if (sets.impliedPairs > 0) cov.sameSetImpliedPairs++;
    if (sets.orderSplits > 0) cov.orderSplitRuns++;
    if (joined) cov.lateJoinRuns++;
    if (w.ceilingPlants + w.secondVersions >= 2 && w.ceilingPlants > 0 && w.secondVersions > 0) cov.combinedRuns++;
  }
  return w;
}

describe('convergence', () => {
  it.each(PINNED)('pinned seed $seed', async ({ seed, replicas, actions }) => {
    await run(seed, replicas, actions);
  });

  it(`random sessions converge to the oracle (${RUNS} runs)`, async () => {
    const cov: Coverage = { publishes: 0, conflicts: 0, merges: 0, reloads: 0, supersededRuns: 0, unfrozenRuns: 0, frozenRuns: 0, twoFreezeRuns: 0, twoRewriteRuns: 0, stopOffChainRuns: 0, mixedBatches: 0, ceilingRuns: 0, secondVersionRuns: 0, splitRuns: 0, sameSetGroupsSplit: 0, combinedRuns: 0, sameSetImpliedPairs: 0, orderSplitRuns: 0, lateJoinRuns: 0 };
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 2 ** 31 - 1 }),
        fc.integer({ min: 2, max: 5 }),
        // Layout changes and force-pushes (92, 93) are rare: one in a hundred actions each.
        fc.array(fc.nat({ max: 99 }), { minLength: 20, maxLength: 90, size: 'max' }),
        async (seed, replicas, actions) => {
          await run(seed, replicas, actions, cov);
        },
      ),
      { numRuns: RUNS },
    );
    // The suite must actually exercise the machinery it claims to (floors well below what a
    // normal run reaches, so a regression in the generator fails loudly).
    expect(cov.publishes).toBeGreaterThan(RUNS / 4);
    expect(cov.conflicts).toBeGreaterThan(RUNS / 10);
    expect(cov.merges).toBeGreaterThan(RUNS / 10);
    expect(cov.reloads).toBeGreaterThan(RUNS / 20);
    expect(cov.supersededRuns).toBeGreaterThan(RUNS / 10);
    expect(cov.unfrozenRuns).toBeGreaterThan(RUNS / 2);
    expect(cov.frozenRuns).toBeGreaterThan(RUNS / 50);
    expect(cov.twoFreezeRuns).toBeGreaterThan(RUNS / 200);
    expect(cov.twoRewriteRuns).toBeGreaterThan(0);
    // A second rewrite removes the winning stop's `at`: the stop's ancestry search (§15.5).
    expect(cov.stopOffChainRuns).toBeGreaterThan(RUNS / 250);
    // Mixed content+control batches, a freeze mid-batch (§15.5: their control operations are inert).
    expect(cov.mixedBatches).toBeGreaterThan(RUNS / 4);
    // The exhausted-log class (§15.5, R3-995): ceiling batches and second versions, and runs
    // where replicas end having read different versions.
    expect(cov.ceilingRuns).toBeGreaterThan(RUNS / 50);
    expect(cov.secondVersionRuns).toBeGreaterThan(RUNS / 50);
    expect(cov.splitRuns).toBeGreaterThan(RUNS / 50);
    expect(cov.sameSetGroupsSplit).toBeGreaterThan(RUNS / 100);
    // A run where two or more replicas read the same versions AND those versions hold an implied-
    // freeze input — the pairs the same-set assertion is about.
    expect(cov.sameSetImpliedPairs).toBeGreaterThan(RUNS / 50);
    // A ceiling batch and a second version in one run (the P1/P3 shapes).
    expect(cov.combinedRuns).toBeGreaterThan(RUNS / 250);
    // Round 1's shape: two replicas read the same versions but keep different ones of a slot.
    expect(cov.orderSplitRuns).toBeGreaterThan(RUNS / 250);
    // A replica that joins after a plant, reading the space only.
    expect(cov.lateJoinRuns).toBeGreaterThan(RUNS / 100);
    console.info('convergence coverage', cov);
  });
});
