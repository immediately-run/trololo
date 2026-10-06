// The built-in control record set `_session/` (COLLABORATION_SESSIONS §15.5): terms and the
// frozen state. Outside `Snap`, `C_B`, publish and §5.5; §3.8 last-write-wins, with the freeze
// precedence rule and the freeze an exhausted log implies (§15.5).

import { cmp, compareOrder, CONTROL_GROUP, type Op, type OpRef } from './batch';
import type { Json } from './canonical';

export type FreezeReason = 'layout' | 'rewrite' | 'integrity';

export interface Frozen {
  readonly reason: FreezeReason;
  /** The commit the freeze refers to (§15.7). After `rewrite` or `integrity` the chain stops here. */
  readonly at: string;
}

export const TERMS_PATH = '_session/terms';
export const FROZEN_PATH = '_session/frozen';

export interface ControlOp extends OpRef {
  readonly path: string;
  readonly value: Json;
}

export class ControlState {
  private readonly winners = new Map<string, ControlOp>();
  /** The winning freeze implied by an exhausted log (§15.5), kept apart from the written ones. */
  private implied: ControlOp | null = null;

  apply(op: ControlOp): void {
    const cur = this.winners.get(op.path);
    if (!cur || outranks(op, cur)) this.winners.set(op.path, op);
  }

  /**
   * A version of a batch file at the lamport ceiling has been read (§15.5, an exhausted log): it
   * counts as carrying, after its own operations, an `integrity` freeze at its base. `ref` is the
   * batch's own order key with `index` one past its last operation. Two versions of one slot can tie
   * in §3.8 order; the greater `at` wins, so the result does not depend on which was read first.
   */
  applyExhausted(ref: OpRef, at: string): void {
    const op: ControlOp = { ...ref, path: FROZEN_PATH, value: { reason: 'integrity', at } };
    const cur = this.implied;
    const c = cur ? compareOrder(op, cur) : 1;
    if (c > 0 || (c === 0 && cmp(at, (cur!.value as { at: string }).at) > 0)) this.implied = op;
  }

  /** The winning freeze, written or implied, under the §15.5 precedence rule. */
  frozen(): Frozen | null {
    const written = this.winners.get(FROZEN_PATH);
    const win = !written ? this.implied : !this.implied ? written : outranks(this.implied, written) ? this.implied : written;
    return asFrozen(win);
  }

  /** The winning freeze written to the log, ignoring one an exhausted log implies. */
  writtenFrozen(): Frozen | null {
    return asFrozen(this.winners.get(FROZEN_PATH));
  }

  termsName(): string | null {
    const v = this.winners.get(TERMS_PATH)?.value as { name: string } | undefined;
    return v?.name ?? null;
  }
}

function asFrozen(op: ControlOp | null | undefined): Frozen | null {
  const v = op?.value as { reason: FreezeReason; at: string } | undefined;
  return v ? { reason: v.reason, at: v.at } : null;
}

/**
 * §3.8 order, except that on `_session/frozen` a freeze that stops the chain (rewrite, integrity)
 * outranks a layout freeze whatever their order: a replica that has not yet seen the rewrite may
 * still write a layout freeze, and it must not lift the stop.
 */
function outranks(op: ControlOp, cur: ControlOp): boolean {
  if (op.path === FROZEN_PATH) {
    const a = (op.value as { reason: FreezeReason }).reason !== 'layout';
    const b = (cur.value as { reason: FreezeReason }).reason !== 'layout';
    if (a !== b) return a;
  }
  return compareOrder(op, cur) > 0;
}

export function frozenOp(reason: FreezeReason, at: string): Op {
  return { path: FROZEN_PATH, group: CONTROL_GROUP, value: { reason, at } };
}

export function termsOp(name: string): Op {
  return { path: TERMS_PATH, group: CONTROL_GROUP, value: { name } };
}

/** Whether a freeze stops the chain and publishing (a rewrite or an integrity failure). */
export function stopsChain(f: Frozen | null): boolean {
  return f !== null && f.reason !== 'layout';
}
