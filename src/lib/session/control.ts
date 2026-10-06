// The built-in control record set `_session/` (COLLABORATION_SESSIONS §15.5): terms and the
// frozen state. Outside `Snap`, `C_B`, publish and §5.5; §3.8 last-write-wins, with the freeze
// precedence rule over the written freezes, and the start-base freeze — written, or implied by an
// exhausted log or a slot read in two versions (§15.5, R3-995) — above them all.

import { compareOrder, CONTROL_GROUP, type Op, type OpRef } from './batch';
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
  private implied = false;

  private readonly startBase: string;

  /** `startBase` is the session's start base: the `at` of the start-base freeze (§15.5). */
  constructor(startBase: string) {
    this.startBase = startBase;
  }

  apply(op: ControlOp): void {
    const cur = this.winners.get(op.path);
    if (!cur || outranks(op, cur, this.startBase)) this.winners.set(op.path, op);
  }

  /**
   * §15.5 "An exhausted log": a well-formed ceiling version, or a second version of a slot, has
   * been read. From now on the replica holds the start-base freeze, whatever the log says.
   */
  imply(): void {
    this.implied = true;
  }

  /** The winning freeze: the implied start-base freeze when one holds, else the winning written one. */
  frozen(): Frozen | null {
    return this.implied ? this.startBaseFreeze() : this.writtenFrozen();
  }

  /** The winning freeze written to the log, under the §15.5 precedence rule. */
  writtenFrozen(): Frozen | null {
    return asFrozen(this.winners.get(FROZEN_PATH));
  }

  /** The start-base freeze `{ integrity, startBase }`, which outranks every other freeze value. */
  startBaseFreeze(): Frozen {
    return { reason: 'integrity', at: this.startBase };
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
 * §3.8 order, except that on `_session/frozen` the start-base freeze outranks everything, and a
 * freeze that stops the chain (rewrite, integrity) outranks a layout freeze whatever their order:
 * a replica that has not yet seen the rewrite may still write a layout freeze, and it must not
 * lift the stop.
 */
function outranks(op: ControlOp, cur: ControlOp, startBase: string): boolean {
  if (op.path === FROZEN_PATH) {
    // The start-base freeze outranks every other freeze value (§15.5, R3-995).
    const sa = isStartBase(op.value, startBase);
    const sb = isStartBase(cur.value, startBase);
    if (sa !== sb) return sa;
    const a = (op.value as { reason: FreezeReason }).reason !== 'layout';
    const b = (cur.value as { reason: FreezeReason }).reason !== 'layout';
    if (a !== b) return a;
  }
  return compareOrder(op, cur) > 0;
}

function isStartBase(value: Json, startBase: string): boolean {
  const v = value as { reason: FreezeReason; at: string };
  return v.reason === 'integrity' && v.at === startBase;
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
