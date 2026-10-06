import { describe, expect, it } from 'vitest';
import { ControlState, FROZEN_PATH, TERMS_PATH, type ControlOp } from './control';

const op = (lamport: number, path: string, value: ControlOp['value'], actor = 'a.aaaaaaaa.aaaaaaaa'): ControlOp => ({
  lamport, actor, seq: 1, index: 0, path, value,
});
const AT1 = '1'.repeat(40);
const AT2 = '2'.repeat(40);

describe('§15.5 control records', () => {
  it('terms resolve last-write-wins by §3.8 order', () => {
    const c = new ControlState();
    c.apply(op(2, TERMS_PATH, { name: 'later' }));
    c.apply(op(1, TERMS_PATH, { name: 'earlier' }));
    expect(c.termsName()).toBe('later');
  });

  it('a freeze that stops the chain outranks a later layout freeze', () => {
    const c = new ControlState();
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
      const c = new ControlState();
      order.forEach((o) => c.apply(o));
      return c.frozen();
    });
    expect(new Set(results.map((r) => JSON.stringify(r))).size).toBe(1);
    expect(results[0]).toEqual({ reason: 'rewrite', at: AT1 });
  });

  it('an exhausted log implies an integrity freeze that a layout freeze cannot lift, written or not (§15.5)', () => {
    const top = { lamport: 2 ** 48 - 1, actor: 'm.aaaaaaaa.aaaaaaaa', seq: 1, index: 1 };
    const c = new ControlState();
    c.apply(op(9, FROZEN_PATH, { reason: 'layout', at: AT2 }));
    c.applyExhausted(top, AT1);
    expect(c.frozen()).toEqual({ reason: 'integrity', at: AT1 });
    expect(c.writtenFrozen()).toEqual({ reason: 'layout', at: AT2 });
    // Among freezes that stop the chain, §3.8 order decides: the implied one sits at the ceiling.
    c.apply(op(5, FROZEN_PATH, { reason: 'rewrite', at: AT2 }));
    expect(c.frozen()).toEqual({ reason: 'integrity', at: AT1 });
    c.apply({ ...op(2 ** 48 - 1, FROZEN_PATH, { reason: 'rewrite', at: AT2 }), actor: 'z.aaaaaaaa.aaaaaaaa' });
    expect(c.frozen()).toEqual({ reason: 'rewrite', at: AT2 });
    expect(new ControlState().frozen()).toBeNull();
  });
});
