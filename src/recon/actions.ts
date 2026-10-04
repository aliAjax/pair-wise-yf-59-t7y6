import { uid } from './engine';
import type { ArrivalOp, CorrectionOp, Ledger, PenaltyOp, PublishOp, ResolveOp } from './types';

const nowIso = () => new Date().toISOString();

function headSeq(ledger: Ledger, entryId: string): number {
  const entry = ledger.entries.find((item) => item.id === entryId);
  return entry?.revisions[0]?.seq ?? 0;
}

export function makeArrival(ledger: Ledger, entryId: string, elapsedSeconds: number, actor: string): ArrivalOp {
  return { kind: 'arrival', opId: uid('op'), entryId, actor, at: nowIso(), finishTime: nowIso(), elapsedSeconds, baseSeq: headSeq(ledger, entryId) };
}

export function makePenalty(ledger: Ledger, entryId: string, protestId: string, rule: string, reason: string, deltaSeconds: number, actor: string): PenaltyOp {
  return { kind: 'penalty', opId: uid('op'), entryId, actor, at: nowIso(), protestId, rule, reason, deltaSeconds, baseSeq: headSeq(ledger, entryId) };
}

export function makeCorrection(ledger: Ledger, entryId: string, elapsedSeconds: number, reason: string, actor: string): CorrectionOp {
  return { kind: 'correction', opId: uid('op'), entryId, actor, at: nowIso(), elapsedSeconds, reason, baseSeq: headSeq(ledger, entryId) };
}

export function makeResolve(entryId: string, conflictId: string, pick: 'A' | 'B', actor: string): ResolveOp {
  return { kind: 'resolve', opId: uid('op'), entryId, actor, at: nowIso(), conflictId, pick };
}

export function makePublish(groupId: string, actor: string): PublishOp {
  return { kind: 'publish', opId: uid('op'), groupId, actor, at: nowIso() };
}

export function formatSeconds(value: number | null): string {
  if (value === null) return '—';
  const mm = Math.floor(value / 60);
  const ss = value % 60;
  return `${mm}:${String(ss).padStart(2, '0')}`;
}
