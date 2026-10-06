import { it } from 'vitest';
import { World } from './sim/world';
it('repro', async () => {
  const w = new World(1879047932);
  const rs = [await w.join('ana'), await w.join('ben')];
  const actions = [0,81,93,73,0,65,93,0,65,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];
  const short = (s: string) => s.slice(0, 6);
  for (const a of actions) {
    const r = rs[w.int(rs.length)];
    if (a < 30) await w.edit(r);
    else if (a < 65) await w.deliver(r, 1 + w.int(4));
    else if (a < 73) { await w.sync(r); console.log("sync", r.name, r.engine.adoptedChain().map(short).join(","), JSON.stringify(r.engine.frozen())); }
    else if (a < 81) { w.externalCommit(); console.log('external ->', short(w.git.main)); }
    else if (a < 88) { if (w.rng() < 0.7) { w.write(r); w.resolve(r); } console.log('publish', r.name, await w.publish(r), short(w.git.main)); }
    else if (a === 92) { w.layoutChange(); console.log('layout ->', short(w.git.main)); }
    else if (a === 93) { w.forcePush(); console.log('force ->', short(w.git.main)); }
    w.check(r);
  }
  for (const r of rs) console.log(r.name, r.engine.adoptedChain().map(short), JSON.stringify(r.engine.frozen()), r.engine.offeredChain().map(c => short(c.sha)));
  await w.quiesce();
  for (const r of rs) console.log(r.name, r.engine.adoptedChain().map(short), JSON.stringify(r.engine.frozen()), r.engine.offeredChain().map(c => short(c.sha)));
  w.checkConverged();
});
