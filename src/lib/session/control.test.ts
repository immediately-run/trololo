import { describe, expect, it } from 'vitest';
import { ControlState, FROZEN_PATH, TERMS_PATH, type ControlOp } from './control';

const op = (lamport: number, path: string, value: ControlOp['value'], actor = 'a.aaaaaaaa.aaaaaaaa'): ControlOp => ({
  lamport, actor, seq: 1, index: 0, path, value,
});
const AT1 = '1'.repeat(40);
const AT2 = '2'.repeat(40);

describe('§15.5 control records', () => {
  it('terms resolve last-write-wins by §3.8 order', () => {
    const c = new ControlState('0'.repeat(40));
    c.apply(op(2, TERMS_PATH, { name: 'later' }));
    c.apply(op(1, TERMS_PATH, { name: 'earlier' }));
    expect(c.termsName()).toBe('later');
  });

  it('a freeze that stops the chain outranks a later layout freeze', () => {
    const c = new ControlState('0'.repeat(40));
    c.apply(op(1, FROZEN_PATH, { reason: 'rewrite', at: AT1 }));
    c.apply(op(9, FROZEN_PATH, { reason: 'layout', at: AT2 }));
    expect(c.frozen()).toEqual({ reason: 'rewrite', at: AT1 });
    c.apply(op(3, FROZEN_PATH, { reason: 'integrity', at: AT2 }));
    expect(c.frozen()).toEqual({ reason: 'integrity', at: AT2 });
  });

  it('is independent of arrival order', () => {
    const ops = [
      op(4, FROZEN_PATH, { reason: 'layout', at: AT1 }),
      op(2, FROZEN_PATH, { reason: 'rewrite', at: AT2 }),
      op(2, FROZEN_PATH, { reason: 'rewrite', at: AT1 }, 'b.bbbbbbbb.bbbbbbbb'),
    ];
    const results = [ops, [...ops].reverse(), [ops[1], ops[0], ops[2]]].map((order) => {
      const c = new ControlState('0'.repeat(40));
      order.forEach((o) => c.apply(o));
      return c.frozen();
    });
    expect(new Set(results.map((r) => JSON.stringify(r))).size).toBe(1);
    expect(results[0]).toEqual({ reason: 'rewrite', at: AT1 });
  });

  it('written freezes only: a later stop freeze overtakes an earlier one in §3.8 order, and a layout freeze never lifts a stop', () => {
    const c = new ControlState('0'.repeat(40));
    c.apply(op(9, FROZEN_PATH, { reason: 'layout', at: AT2 }));
    c.apply(op(1, FROZEN_PATH, { reason: 'rewrite', at: AT1 }));
    // The layout freeze sits later in §3.8 order, yet the stop wins (precedence).
    expect(c.frozen()).toEqual({ reason: 'rewrite', at: AT1 });
    expect(c.writtenFrozen()).toEqual({ reason: 'rewrite', at: AT1 });
    // Among written freezes that both stop the chain, plain §3.8 order decides.
    c.apply(op(5, FROZEN_PATH, { reason: 'integrity', at: AT2 }));
    expect(c.frozen()).toEqual({ reason: 'integrity', at: AT2 });
    expect(new ControlState('0'.repeat(40)).frozen()).toBeNull();
  });
});

describe('§15.5 the start-base freeze (R3-995)', () => {
  const START = '0'.repeat(40);
  it('a written start-base freeze outranks every other freeze, whatever its §3.8 order', () => {
    const c = new ControlState(START);
    c.apply(op(1, FROZEN_PATH, { reason: 'integrity', at: START }));
    c.apply(op(9, FROZEN_PATH, { reason: 'rewrite', at: AT1 }));
    c.apply(op(8, FROZEN_PATH, { reason: 'integrity', at: AT2 }));
    expect(c.frozen()).toEqual({ reason: 'integrity', at: START });
  });

  it('an implied freeze is the start-base freeze, above any written one; writtenFrozen still reports the log', () => {
    const c = new ControlState(START);
    c.apply(op(9, FROZEN_PATH, { reason: 'rewrite', at: AT1 }));
    c.imply();
    expect(c.frozen()).toEqual({ reason: 'integrity', at: START });
    expect(c.writtenFrozen()).toEqual({ reason: 'rewrite', at: AT1 });
  });
});
