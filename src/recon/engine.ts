// 纯函数对账引擎：字段级合并、净用时冲突留两版、修订版本链、发布门禁、权限拒绝、重复导入幂等

import type {
  ArrivalOp, AuditEvent, BatchLineResult, ConflictVersion, CorrectionOp,
  Ledger, Op, PenaltyItem, PenaltyOp, PublishOp, Receipt, ReceiptLine, ReconLine,
  ResolveOp, ResultEntry, Revision, RoleId
} from './types';

const WRITE_ROLES: Record<Op['kind'], RoleId[]> = {
  arrival: ['timer'],
  penalty: ['jury'],
  correction: ['ro', 'jury'],
  resolve: ['jury'],
  publish: ['ro']
};

let counter = 0;
export function uid(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}-${Math.random().toString(36).slice(2, 8)}`;
}

export function audit(state: Ledger, level: AuditEvent['level'], code: string, message: string, actor: string | null, opId?: string): void {
  state.audit.unshift({ id: uid('au'), at: new Date().toISOString(), actor, level, code, message, opId });
}

function roleOf(state: Ledger, actorId: string): RoleId | null {
  return state.officials[actorId]?.role ?? null;
}

export function isAuthorized(state: Ledger, op: Op): boolean {
  const role = roleOf(state, op.actor);
  return role !== null && WRITE_ROLES[op.kind].includes(role);
}

function findEntry(state: Ledger, entryId: string): ResultEntry | undefined {
  return state.entries.find((item) => item.id === entryId);
}

/** 现行版本（用于发布、净用时展示；争议态也算链尖） */
function head(entry: ResultEntry): Revision | undefined {
  return entry.revisions.find((rev) => rev.status === 'active' || rev.status === 'published' || rev.status === 'disputed');
}

/** 链尖：最新一条修订，无论状态 */
function tip(entry: ResultEntry): Revision | undefined {
  return entry.revisions[0];
}

function effectiveElapsed(entry: ResultEntry): number | null {
  return entry.correctedElapsed ?? entry.baseElapsed;
}

function penaltyTotal(entry: ResultEntry): number {
  return entry.penalties.reduce((sum, item) => sum + item.seconds, 0);
}

export function netOf(entry: ResultEntry): number | null {
  const elapsed = effectiveElapsed(entry);
  if (elapsed === null) return null;
  return elapsed + penaltyTotal(entry);
}

/** 在修订链头部追加新版本：旧现行版失效（已发布的保留可查，仅标记失效）；争议版保留标记 */
function pushRevision(entry: ResultEntry, state: Ledger, fields: Omit<Revision, 'id' | 'seq' | 'status' | 'net'> & { net?: number | null }): Revision {
  const previous = entry.revisions.find((rev) => rev.status === 'active' || rev.status === 'published');
  if (previous) {
    const wasPublished = previous.status === 'published';
    previous.status = 'superseded';
    previous.invalidatedAt = fields.at;
    previous.invalidatedBy = fields.actor;
    // 保留 entry.publishedRevId 指向旧发布版：重发前旧版与其回执可查，对账行据此提示待重发
    audit(state, 'info', 'REV_SUPERSEDED',
      `${entry.boat}（${entry.sailNo}）旧版 ${previous.id.slice(0, 8)} 已失效，重发前仍可查`, fields.actor, fields.opId);
    if (wasPublished) {
      audit(state, 'warn', 'PUBLISH_STALE', `${entry.boat} 的已发布版本被后续改动作废旧版`, fields.actor, fields.opId);
    }
  }
  const rev: Revision = {
    id: uid('rev'),
    seq: state.seq + 1,
    status: 'active',
    net: fields.net ?? null,
    ...fields
  };
  state.seq = rev.seq;
  entry.revisions.unshift(rev);
  return rev;
}

function snapshot(entry: ResultEntry, rev: Revision): void {
  rev.finishTime = entry.finishTime;
  rev.baseElapsed = entry.baseElapsed;
  rev.correctedElapsed = entry.correctedElapsed;
  rev.correctionReason = entry.correctionNote || null;
  rev.penaltySeconds = penaltyTotal(entry);
  rev.net = netOf(entry);
}

function applyArrival(state: Ledger, op: ArrivalOp): string[] {
  const entry = findEntry(state, op.entryId);
  if (!entry) throw new Error('ENTRY_NOT_FOUND');
  // 到达段只由计时数据写入；更正段、处罚段不动 —— 按字段合并
  entry.finishTime = op.finishTime;
  entry.baseElapsed = op.elapsedSeconds;
  entry.pending = null; // 重新计时到达，清掉旧冲突
  const rev = pushRevision(entry, state, {
    opId: op.opId, kind: 'arrival', actor: op.actor, actorName: state.officials[op.actor]?.name ?? op.actor,
    at: op.at, finishTime: op.finishTime, baseElapsed: op.elapsedSeconds, correctedElapsed: entry.correctedElapsed,
    correctionReason: entry.correctionNote || null, penaltySeconds: penaltyTotal(entry), net: null,
    summary: `到达数据：净用时段 ${op.elapsedSeconds}s${entry.correctedElapsed !== null ? '（沿用更正值）' : ''}`
  });
  snapshot(entry, rev);
  audit(state, 'success', 'ARRIVAL_MERGED', `${entry.boat} 到达数据按字段合并：用时 ${op.elapsedSeconds}s`, op.actor, op.opId);
  return [rev.id];
}

function applyPenalty(state: Ledger, op: PenaltyOp): string[] {
  const entry = findEntry(state, op.entryId);
  if (!entry) throw new Error('ENTRY_NOT_FOUND');
  // 同一份抗议的重复/离线补传：合并到同一处罚项，不新增修订
  const existing = entry.penalties.find((item) => item.protestId === op.protestId);
  if (existing) {
    existing.seconds += op.deltaSeconds;
    if (!existing.opIds.includes(op.opId)) existing.opIds.push(op.opId);
    existing.lastActor = op.actor;
    existing.updatedAt = op.at;
    audit(state, 'info', 'PENALTY_MERGED', `${entry.boat} 抗议 ${op.protestId.slice(0, 8)} 处罚按字段合并 +${op.deltaSeconds}s`, op.actor, op.opId);
  } else {
    const item: PenaltyItem = {
      protestId: op.protestId, rule: op.rule, reason: op.reason,
      seconds: op.deltaSeconds, opIds: [op.opId], lastActor: op.actor, updatedAt: op.at
    };
    entry.penalties.push(item);
    audit(state, 'success', 'PENALTY_ADDED', `${entry.boat} 抗议处罚 ${op.rule} +${op.deltaSeconds}s`, op.actor, op.opId);
  }
  const rev = pushRevision(entry, state, {
    opId: op.opId, kind: 'penalty', actor: op.actor, actorName: state.officials[op.actor]?.name ?? op.actor,
    at: op.at, finishTime: entry.finishTime, baseElapsed: entry.baseElapsed, correctedElapsed: entry.correctedElapsed,
    correctionReason: entry.correctionNote || null, penaltySeconds: penaltyTotal(entry), net: null,
    summary: `抗议 ${op.rule} 处罚合计 ${penaltyTotal(entry)}s`
  });
  snapshot(entry, rev);
  return [rev.id];
}

function makeVersion(op: CorrectionOp, state: Ledger, label: 'A' | 'B'): ConflictVersion {
  return { label, opId: op.opId, actor: op.actor, actorName: state.officials[op.actor]?.name ?? op.actor, at: op.at, elapsedSeconds: op.elapsedSeconds, reason: op.reason };
}

function applyCorrection(state: Ledger, op: CorrectionOp): string[] {
  const entry = findEntry(state, op.entryId);
  if (!entry) throw new Error('ENTRY_NOT_FOUND');

  // 离线双改合并：两人基于同一历史版本（baseSeq）各自更正净用时，
  // 若当前链尖该字段已被改成别的值（中间夹过处罚等不影响识别），即为净用时冲突
  const baseRev = entry.revisions.find((rev) => rev.seq === op.baseSeq);
  const current = tip(entry);
  const currentElapsed = current ? (current.correctedElapsed ?? current.baseElapsed) : null;
  const baseElapsedAtFork = baseRev ? (baseRev.correctedElapsed ?? baseRev.baseElapsed) : null;
  const concurrent = op.baseSeq > 0 && baseRev !== undefined &&
    currentElapsed !== null && baseElapsedAtFork !== null &&
    currentElapsed !== op.elapsedSeconds &&
    baseElapsedAtFork !== currentElapsed &&
    !entry.pending;

  if (concurrent && current) {
    // 净用时冲突：两版都保留，等待复核，不覆盖；生效值回退到分叉前基版
    const versionA: ConflictVersion = {
      label: 'A', opId: current.opId, actor: current.actor, actorName: current.actorName,
      at: current.at, elapsedSeconds: currentElapsed as number,
      reason: current.correctionReason ?? '先到版本'
    };
    const versionB = makeVersion(op, state, 'B');
    entry.pending = { id: uid('conf'), field: 'elapsed', versions: [versionA, versionB], createdAt: new Date().toISOString() };
    // 冲突期间两版都不作数：字段回退到分叉前基版，A 版修订标记争议态仍可查
    entry.correctedElapsed = baseRev.correctedElapsed;
    entry.correctionNote = baseRev.correctionReason ?? '';
    current.status = 'disputed';
    audit(state, 'warn', 'CONFLICT_PENDING',
      `${entry.boat} 净用时冲突：A=${versionA.elapsedSeconds}s（${versionA.actorName}）/ B=${versionB.elapsedSeconds}s（${versionB.actorName}），两版留待复核，生效值暂回退到分叉前基版`,
      op.actor, op.opId);
    return [];
  }

  if (entry.pending) {
    // 已有待复核冲突：新更正不落地，抛错让队列保留该步骤，裁定后只重试未落地步骤
    audit(state, 'warn', 'CORRECTION_BLOCKED', `${entry.boat} 存在待复核净用时冲突，新更正挂起，待仲裁裁定`, op.actor, op.opId);
    throw new Error('CORRECTION_BLOCKED');
  }

  entry.correctedElapsed = op.elapsedSeconds;
  entry.correctionNote = op.reason;
  const rev = pushRevision(entry, state, {
    opId: op.opId, kind: 'correction', actor: op.actor, actorName: state.officials[op.actor]?.name ?? op.actor,
    at: op.at, finishTime: entry.finishTime, baseElapsed: entry.baseElapsed, correctedElapsed: op.elapsedSeconds,
    correctionReason: op.reason, penaltySeconds: penaltyTotal(entry), net: null,
    summary: `成绩更正：净用时 ${op.elapsedSeconds}s（${op.reason || '无说明'}）`
  });
  snapshot(entry, rev);
  audit(state, 'success', 'CORRECTION_APPLIED', `${entry.boat} 成绩更正为 ${op.elapsedSeconds}s`, op.actor, op.opId);
  return [rev.id];
}

function applyResolve(state: Ledger, op: ResolveOp): string[] {
  const entry = findEntry(state, op.entryId);
  if (!entry) throw new Error('ENTRY_NOT_FOUND');
  if (!entry.pending || entry.pending.id !== op.conflictId) {
    audit(state, 'error', 'RESOLVE_STALE', `${entry.boat} 待复核冲突已不存在或已裁定`, op.actor, op.opId);
    throw new Error('RESOLVE_STALE');
  }
  const chosen = entry.pending.versions.find((version) => version.label === op.pick);
  if (!chosen) return [];
  entry.correctedElapsed = chosen.elapsedSeconds;
  entry.correctionNote = `冲突复核取 ${chosen.label} 版：${chosen.reason}`;
  entry.pending = null;
  const rev = pushRevision(entry, state, {
    opId: op.opId, kind: 'resolve', actor: op.actor, actorName: state.officials[op.actor]?.name ?? op.actor,
    at: op.at, finishTime: entry.finishTime, baseElapsed: entry.baseElapsed, correctedElapsed: chosen.elapsedSeconds,
    correctionReason: entry.correctionNote, penaltySeconds: penaltyTotal(entry), net: null,
    summary: `冲突裁定取 ${chosen.label} 版（${chosen.actorName} ${chosen.elapsedSeconds}s）`
  });
  snapshot(entry, rev);
  // 冲突中挂起的争议版（A 版）随裁定一并失效，仍保留在版本链可查
  for (const old of entry.revisions) {
    if (old.status === 'disputed') {
      old.status = 'superseded';
      old.invalidatedAt = op.at;
      old.invalidatedBy = op.actor;
    }
  }
  audit(state, 'success', 'CONFLICT_RESOLVED', `${entry.boat} 净用时冲突裁定：采用 ${chosen.label} 版 ${chosen.elapsedSeconds}s`, op.actor, op.opId);
  return [rev.id];
}

function checksumOf(lines: ReceiptLine[], groupId: string, at: string): string {
  const raw = `${groupId}|${at}|` + lines.map((line) => `${line.entryId}:${line.revId}:${line.net ?? ''}`).join('||');
  let hash = 0;
  for (let i = 0; i < raw.length; i += 1) {
    hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0;
  }
  return `rc-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function applyPublish(state: Ledger, op: PublishOp): { revIds: string[]; receipt: Receipt } {
  const groupEntries = state.entries.filter((entry) => entry.groupId === op.groupId);
  if (groupEntries.length === 0) throw new Error('GROUP_NOT_FOUND');

  const pendingBoats = groupEntries.filter((entry) => entry.pending);
  if (pendingBoats.length > 0) {
    const names = pendingBoats.map((entry) => entry.boat).join('、');
    audit(state, 'error', 'PUBLISH_BLOCKED', `组别 ${op.groupId} 存在 ${pendingBoats.length} 条待复核冲突（${names}），禁止发布`, op.actor, op.opId);
    throw new Error('PENDING_CONFLICT');
  }

  const ranked = groupEntries
    .map((entry) => ({ entry, net: netOf(entry) }))
    .sort((a, b) => (a.net ?? Number.POSITIVE_INFINITY) - (b.net ?? Number.POSITIVE_INFINITY));

  const lines: ReceiptLine[] = [];
  const revIds: string[] = [];
  ranked.forEach((item, index) => {
    const rev = head(item.entry);
    if (rev) {
      rev.status = 'published';
      rev.publishedAt = op.at;
      item.entry.publishedRevId = rev.id;
      rev.net = item.net;
      revIds.push(rev.id);
    }
    lines.push({
      entryId: item.entry.id, boat: item.entry.boat, sailNo: item.entry.sailNo,
      revId: rev?.id ?? '', net: item.net, rank: item.net === null ? null : index + 1
    });
  });

  const receipt: Receipt = {
    id: uid('receipt'), opId: op.opId, groupId: op.groupId,
    actor: op.actor, actorName: state.officials[op.actor]?.name ?? op.actor, at: op.at,
    lines, checksum: checksumOf(lines, op.groupId, op.at)
  };
  state.receipts.unshift(receipt);
  audit(state, 'success', 'PUBLISHED', `组别 ${op.groupId} 正式成绩已发布，回执 ${receipt.id.slice(0, 8)}（${lines.length} 条）`, op.actor, op.opId);
  return { revIds, receipt };
}

/** 单步应用：返回结构化结果，重复导入不新增修订，越权拒绝 */
export function applyOp(state: Ledger, op: Op): BatchLineResult {
  if (state.appliedOpIds.includes(op.opId)) {
    audit(state, 'info', 'OP_DUPLICATE', `操作 ${op.opId.slice(0, 8)} 已落地，重复导入忽略`, op.actor, op.opId);
    return { opId: op.opId, status: 'duplicate', code: 'OP_DUPLICATE', message: '重复导入，不新增修订' };
  }
  if (!isAuthorized(state, op)) {
    if (!state.rejectedOpIds.includes(op.opId)) state.rejectedOpIds.push(op.opId);
    const role = roleOf(state, op.actor);
    audit(state, 'error', 'FORBIDDEN',
      `越权写入被拒绝：${state.officials[op.actor]?.name ?? op.actor}(${role ?? '未知'}) 无权执行 ${op.kind}`, op.actor, op.opId);
    return { opId: op.opId, status: 'rejected', code: 'FORBIDDEN', message: '越权写入成绩或处罚被拒绝' };
  }

  try {
    let revIds: string[] = [];
    let receiptId: string | undefined;
    switch (op.kind) {
      case 'arrival': revIds = applyArrival(state, op); break;
      case 'penalty': revIds = applyPenalty(state, op); break;
      case 'correction': revIds = applyCorrection(state, op); break;
      case 'resolve': revIds = applyResolve(state, op); break;
      case 'publish': {
        const out = applyPublish(state, op);
        revIds = out.revIds;
        receiptId = out.receipt.id;
        break;
      }
    }
    if (!state.appliedOpIds.includes(op.opId)) state.appliedOpIds.push(op.opId);
    state.rejectedOpIds = state.rejectedOpIds.filter((id) => id !== op.opId);
    return { opId: op.opId, status: 'applied', revIds, receiptId };
  } catch (error) {
    const code = error instanceof Error ? error.message : 'APPLY_FAILED';
    if (!state.rejectedOpIds.includes(op.opId)) state.rejectedOpIds.push(op.opId);
    const messages: Record<string, string> = {
      PENDING_CONFLICT: '同组别有待复核冲突，禁止发布',
      CORRECTION_BLOCKED: '该船存在待复核净用时冲突，冲突裁定后可重试',
      RESOLVE_STALE: '冲突已裁定或不存在，无需重复处理'
    };
    return { opId: op.opId, status: 'rejected', code, message: messages[code] ?? code };
  }
}

/** 断网队列回网合并：逐条落地，已落地的不重试 */
export function mergeQueue(state: Ledger, ops: Op[]): BatchLineResult[] {
  return ops.map((op) => applyOp(state, op));
}

/** 失败重试：只重试没落地的步骤（appliedOpIds 之外的） */
export function retryPending(state: Ledger, ops: Op[]): BatchLineResult[] {
  const pending = ops.filter((op) => !state.appliedOpIds.includes(op.opId));
  audit(state, 'info', 'RETRY_SCAN', `重试扫描：${ops.length} 个排队步骤，${ops.length - pending.length} 个已落地跳过，${pending.length} 个待重试`, null);
  return pending.map((op) => applyOp(state, op));
}

/** 组装对账记录：组别 × 成绩 × 抗议处罚 × 发布回执 */
export function buildRecon(state: Ledger): ReconLine[] {
  const lines: ReconLine[] = [];
  for (const group of state.groups) {
    for (const entry of state.entries.filter((item) => item.groupId === group.id)) {
      const rev = head(entry);
      const latestReceipt = state.receipts.find((receipt) => receipt.groupId === group.id) ?? null;
      const line = latestReceipt?.lines.find((item) => item.entryId === entry.id) ?? null;
      const net = netOf(entry);
      const stale = entry.publishedRevId !== null && rev !== undefined && rev.id !== entry.publishedRevId;
      lines.push({
        groupId: group.id, groupName: group.name,
        entryId: entry.id, boat: entry.boat, sailNo: entry.sailNo,
        finishTime: entry.finishTime, baseElapsed: entry.baseElapsed, correctedElapsed: entry.correctedElapsed,
        penaltyTotal: penaltyTotal(entry), penaltyRefs: entry.penalties.map((item) => item.protestId),
        net, headRevId: rev?.id ?? null, publishedRevId: entry.publishedRevId,
        receiptId: line ? latestReceipt!.id : null, receiptChecksum: line ? latestReceipt!.checksum : null,
        stale,
        pending: entry.pending !== null
      });
    }
  }
  return lines;
}

/** 重发前查旧版：列出某条目所有历史版本（含已失效） */
export function revisionHistory(state: Ledger, entryId: string): Revision[] {
  return findEntry(state, entryId)?.revisions ?? [];
}

export function findReceiptFor(state: Ledger, revId: string): Receipt | undefined {
  return state.receipts.find((receipt) => receipt.lines.some((line) => line.revId === revId));
}
