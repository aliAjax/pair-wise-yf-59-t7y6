export type RaceStatus = 'scheduled' | 'running' | 'finished';
export type ProtestStatus = 'submitted' | 'reviewing' | 'resolved' | 'rejected';
export type ResultStatus = 'provisional' | 'corrected' | 'official';

/** 角色：竞赛官写成绩（到达/净用时），仲裁写处罚，计时员只读 */
export type Role = 'race-officer' | 'arbitrator' | 'timer';
export type OnlineStatus = 'online' | 'offline';

export interface Race {
  id: string;
  name: string;
  fleet: string;
  course: string;
  startsAt: string;
  status: RaceStatus;
}

/** 成绩版本：每次改动生成一版，旧版置为 superseded 但保留可查 */
export interface ResultVersion {
  version: number;
  elapsedSeconds: number;
  penaltySeconds: number;
  note: string;
  source: Role | 'system';
  hash: string;
  state: 'draft' | 'official' | 'superseded';
  createdAt: string;
}

/** 净用时冲突：两版并列，等复核 */
export interface PendingConflict {
  field: 'elapsedSeconds';
  candidates: { value: number; source: Role; version: number }[];
  status: 'pending_review';
  createdAt: string;
}

export interface RaceEntry {
  id: string;
  boat: string;
  sailNo: string;
  skipper: string;
  fleet: string;
  elapsedSeconds: number;
  penaltySeconds: number;
  resultStatus: ResultStatus;
  note: string;
  versions: ResultVersion[];
  currentVersion: number;
  officialVersion: number | null;
  /** 每个字段最后由谁修改，用于净用时冲突判定（system 为基线，不算竞争） */
  fieldSource: { elapsedSeconds: Role | 'system'; penaltySeconds: Role | 'system' };
  pendingConflict?: PendingConflict;
  lastReceiptId?: string;
}

export interface Protest {
  id: string;
  raceId: string;
  entryId: string;
  reason: string;
  rule: string;
  status: ProtestStatus;
  decision: string;
  penaltySeconds?: number;
  createdAt: string;
}

export interface TimelineEvent {
  id: string;
  time: string;
  type: 'race' | 'result' | 'protest' | 'system';
  message: string;
}

/** 对账记录：把组别、成绩、抗议处罚、发布回执接在一起 */
export interface Reconciliation {
  id: string;
  raceId: string;
  fleet: string;
  entryId: string;
  version: number;
  protestIds: string[];
  receiptId?: string;
  conflict: boolean;
  pendingReview: boolean;
  updatedAt: string;
}

/** 发布回执 */
export interface Receipt {
  id: string;
  raceId: string;
  fleet: string;
  publishedAt: string;
  publishedBy: Role;
  entries: { entryId: string; version: number }[];
}

export type QueueKind = 'result-edit' | 'penalty-edit' | 'publish';
export type QueueStatus = 'queued' | 'failed' | 'review' | 'done' | 'rejected';
export type StepKind = 'permission' | 'write' | 'version' | 'conflict' | 'reconcile' | 'receipt';

export interface QueueStep {
  id: string;
  kind: StepKind;
  name: string;
  landed: boolean;
  error?: string;
}

export interface QueueItem {
  id: string;
  kind: QueueKind;
  payload: any;
  source: Role;
  status: QueueStatus;
  steps: QueueStep[];
  createdAt: string;
  attempts: number;
  failNext: boolean;
  message?: string;
  result?: { skipped?: boolean; conflict?: boolean; incoming?: any; receiptId?: string };
}
