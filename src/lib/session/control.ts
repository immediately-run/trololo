// The built-in control record set `_session/` (COLLABORATION_SESSIONS §15.5): terms and the
// frozen state. Outside `Snap`, `C_B`, publish and §5.5; plain §3.8 last-write-wins.

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

  apply(op: ControlOp): void {
    const cur = this.winners.get(op.path);
    if (!cur || outranks(op, cur)) this.winners.set(op.path, op);
  }

  frozen(): Frozen | null {
    const v = this.winners.get(FROZEN_PATH)?.value as { reason: FreezeReason; at: string } | undefined;
    return v ? { reason: v.reason, at: v.at } : null;
  }

  termsName(): string | null {
    const v = this.winners.get(TERMS_PATH)?.value as { name: string } | undefined;
    return v?.name ?? null;
  }
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
