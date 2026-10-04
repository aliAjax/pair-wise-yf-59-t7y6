// 离线对账领域模型：组别 / 成绩 / 抗议处罚 / 发布回执 四类记录接成对账台账

export type RoleId = 'ro' | 'timer' | 'jury';

export interface Official {
  id: string;
  name: string;
  role: RoleId;
}

export type OpKind = 'arrival' | 'penalty' | 'correction' | 'resolve' | 'publish';

/** 到达数据（计时员） */
export interface ArrivalOp {
  kind: 'arrival';
  opId: string;
  entryId: string;
  actor: string;
  at: string;
  finishTime: string;
  elapsedSeconds: number;
  baseSeq: number;
}

/** 抗议处罚（仲裁）：按 protestId 字段合并，秒数累加 */
export interface PenaltyOp {
  kind: 'penalty';
  opId: string;
  entryId: string;
  actor: string;
  at: string;
  protestId: string;
  rule: string;
  reason: string;
  deltaSeconds: number;
  baseSeq: number;
}

/** 成绩更正（竞赛官 / 仲裁裁决）：写更正净用时段，与到达段分字段合并 */
export interface CorrectionOp {
  kind: 'correction';
  opId: string;
  entryId: string;
  actor: string;
  at: string;
  elapsedSeconds: number;
  reason: string;
  baseSeq: number;
}

/** 净用时冲突裁定：两版中选一版落地 */
export interface ResolveOp {
  kind: 'resolve';
  opId: string;
  entryId: string;
  actor: string;
  at: string;
  conflictId: string;
  pick: 'A' | 'B';
}

/** 整组发布：同组别无待复核冲突才可发布 */
export interface PublishOp {
  kind: 'publish';
  opId: string;
  groupId: string;
  actor: string;
  at: string;
}

export type Op = ArrivalOp | PenaltyOp | CorrectionOp | ResolveOp | PublishOp;

export interface PenaltyItem {
  protestId: string;
  rule: string;
  reason: string;
  seconds: number;
  opIds: string[];
  lastActor: string;
  updatedAt: string;
}

export interface ConflictVersion {
  label: 'A' | 'B';
  opId: string;
  actor: string;
  actorName: string;
  at: string;
  elapsedSeconds: number;
  reason: string;
}

export interface PendingConflict {
  id: string;
  field: 'elapsed';
  versions: [ConflictVersion, ConflictVersion];
  createdAt: string;
}

export type RevisionStatus = 'active' | 'superseded' | 'published' | 'invalidated' | 'disputed';

export interface Revision {
  id: string;
  seq: number;
  opId: string;
  kind: OpKind;
  actor: string;
  actorName: string;
  at: string;
  /** 到达段快照 */
  finishTime: string | null;
  baseElapsed: number | null;
  /** 更正段快照（生效净用时来源；为空表示沿用到达段） */
  correctedElapsed: number | null;
  correctionReason: string | null;
  penaltySeconds: number;
  net: number | null;
  status: RevisionStatus;
  summary: string;
  publishedAt?: string;
  invalidatedAt?: string;
  invalidatedBy?: string;
}

export interface ResultEntry {
  id: string;
  groupId: string;
  boat: string;
  sailNo: string;
  skipper: string;
  finishTime: string | null;
  baseElapsed: number | null;
  correctedElapsed: number | null;
  correctionNote: string;
  penalties: PenaltyItem[];
  pending: PendingConflict | null;
  revisions: Revision[];
  publishedRevId: string | null;
}

export interface Group {
  id: string;
  name: string;
  fleet: string;
  course: string;
  startsAt: string;
}

export interface ReceiptLine {
  entryId: string;
  boat: string;
  sailNo: string;
  revId: string;
  net: number | null;
  rank: number | null;
}

export interface Receipt {
  id: string;
  opId: string;
  groupId: string;
  actor: string;
  actorName: string;
  at: string;
  lines: ReceiptLine[];
  checksum: string;
}

export interface AuditEvent {
  id: string;
  at: string;
  actor: string | null;
  level: 'info' | 'success' | 'warn' | 'error';
  code: string;
  message: string;
  opId?: string;
}

export interface Ledger {
  seq: number;
  officials: Record<string, Official>;
  groups: Group[];
  entries: ResultEntry[];
  receipts: Receipt[];
  appliedOpIds: string[];
  rejectedOpIds: string[];
  audit: AuditEvent[];
}

/** 对账行：组别 + 成绩字段 + 抗议处罚 + 发布回执 接成一条 */
export interface ReconLine {
  groupId: string;
  groupName: string;
  entryId: string;
  boat: string;
  sailNo: string;
  finishTime: string | null;
  baseElapsed: number | null;
  correctedElapsed: number | null;
  penaltyTotal: number;
  penaltyRefs: string[];
  net: number | null;
  headRevId: string | null;
  publishedRevId: string | null;
  receiptId: string | null;
  receiptChecksum: string | null;
  stale: boolean;
  pending: boolean;
}

export interface BatchLineResult {
  opId: string;
  status: 'applied' | 'duplicate' | 'rejected';
  code?: string;
  message?: string;
  revIds?: string[];
  receiptId?: string;
}
