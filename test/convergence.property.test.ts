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

async function run(seed: number, replicas: number, actions: number[]): Promise<World> {
  const w = new World(seed);
  const logins = ['ana', 'ben', 'cy', 'dee', 'eli'];
  const rs: Replica[] = [];
  for (let i = 0; i < replicas; i++) rs.push(await w.join(logins[i]));

  for (const a of actions) {
    const r = rs[w.int(rs.length)];
    if (a < 30) await w.edit(r);
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
    else if (a === 92) w.layoutChange();
    else if (a === 93) w.forcePush();
    else await w.deliver(r, Infinity);
    w.check(r);
  }
  await w.quiesce();
  w.checkConverged();
  return w;
}

describe('convergence', () => {
  it.each(PINNED)('pinned seed $seed', async ({ seed, replicas, actions }) => {
    await run(seed, replicas, actions);
  });

  it(`random sessions converge to the oracle (${RUNS} runs)`, async () => {
    let checks = 0;
    let publishes = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 2 ** 31 - 1 }),
        fc.integer({ min: 2, max: 5 }),
        // Layout changes and force-pushes (92, 93) are rare: one in a hundred actions each.
        fc.array(fc.nat({ max: 99 }), { minLength: 20, maxLength: 90, size: 'max' }),
        async (seed, replicas, actions) => {
          const w = await run(seed, replicas, actions);
          checks += w.checks;
          publishes += w.publishes;
        },
      ),
      { numRuns: RUNS },
    );
    // The suite must actually exercise the machinery it claims to.
    expect(checks).toBeGreaterThan(RUNS * 10);
    expect(publishes).toBeGreaterThan(RUNS / 4);
  });
});
