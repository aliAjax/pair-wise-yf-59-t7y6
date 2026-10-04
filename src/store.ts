import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type {
  OnlineStatus,
  Protest,
  ProtestStatus,
  QueueItem,
  QueueKind,
  QueueStep,
  Race,
  RaceEntry,
  Receipt,
  Reconciliation,
  ResultVersion,
  Role,
  TimelineEvent
} from './types';
import { raceApi } from './api';

export interface AppState {
  races: Race[];
  entries: RaceEntry[];
  protests: Protest[];
  timeline: TimelineEvent[];
  reconciliations: Reconciliation[];
  receipts: Receipt[];
  outbox: QueueItem[];
  currentRole: Role;
  online: OnlineStatus;
}

/* ---------- 工具 ---------- */

function hashOf(input: unknown): string {
  const str = JSON.stringify(input);
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return `h${h.toString(36)}`;
}

const nowIso = () => new Date().toISOString();

function makeVersion(v: number, e: number, p: number, n: string, source: Role | 'system', state: ResultVersion['state'], at: string): ResultVersion {
  return { version: v, elapsedSeconds: e, penaltySeconds: p, note: n, source, hash: hashOf({ e, p, n, source }), state, createdAt: at };
}

function buildSteps(kind: QueueKind): QueueStep[] {
  const mk = (kind: QueueStep['kind'], name: string): QueueStep => ({ id: crypto.randomUUID(), kind, name, landed: false });
  if (kind === 'result-edit') {
    return [
      mk('permission', '权限校验'),
      mk('write', '写入到达/净用时字段'),
      mk('version', '生成成绩版本'),
      mk('conflict', '净用时冲突检测'),
      mk('reconcile', '更新对账记录')
    ];
  }
  if (kind === 'penalty-edit') {
    return [
      mk('permission', '权限校验'),
      mk('write', '写入处罚字段'),
      mk('version', '生成成绩版本'),
      mk('reconcile', '更新对账记录并关联抗议')
    ];
  }
  return [
    mk('permission', '权限校验'),
    mk('write', '复核闸门检查'),
    mk('receipt', '生成发布回执'),
    mk('reconcile', '回写对账记录')
  ];
}

/* ---------- 初始数据 ---------- */

const initialEntries: RaceEntry[] = [
  {
    id: 'entry-1', boat: '海风号', sailNo: 'CHN 218', skipper: '林舟', fleet: '统一级',
    elapsedSeconds: 3168, penaltySeconds: 0, resultStatus: 'provisional', note: '',
    versions: [], currentVersion: 1, officialVersion: null,
    fieldSource: { elapsedSeconds: 'system', penaltySeconds: 'system' }
  },
  {
    id: 'entry-2', boat: '远岚号', sailNo: 'CHN 106', skipper: '周屿', fleet: '统一级',
    elapsedSeconds: 3194, penaltySeconds: 30, resultStatus: 'provisional', note: '标记争议',
    versions: [], currentVersion: 1, officialVersion: null,
    fieldSource: { elapsedSeconds: 'system', penaltySeconds: 'system' }
  },
  {
    id: 'entry-3', boat: '北辰号', sailNo: 'CHN 077', skipper: '许澄', fleet: '统一级',
    elapsedSeconds: 3210, penaltySeconds: 0, resultStatus: 'official', note: '',
    versions: [], currentVersion: 1, officialVersion: 1,
    fieldSource: { elapsedSeconds: 'system', penaltySeconds: 'system' }
  }
];
for (const e of initialEntries) {
  e.versions.push(makeVersion(1, e.elapsedSeconds, e.penaltySeconds, e.note, 'system', e.resultStatus === 'official' ? 'official' : 'draft', nowIso()));
}

const initialRace: Race = { id: 'race-1', name: '海湾长距离赛 第1轮', fleet: '统一级', course: 'W2 / 东北风 12节', startsAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(), status: 'scheduled' };

function seedReconciliations(entries: RaceEntry[]): Reconciliation[] {
  return entries.map((e) => ({
    id: crypto.randomUUID(),
    raceId: initialRace.id,
    fleet: e.fleet,
    entryId: e.id,
    version: e.currentVersion,
    protestIds: e.id === 'entry-2' ? ['protest-1'] : [],
    conflict: false,
    pendingReview: false,
    updatedAt: nowIso()
  }));
}

const initialState: AppState = {
  races: [initialRace],
  entries: initialEntries,
  protests: [{ id: 'protest-1', raceId: 'race-1', entryId: 'entry-2', reason: '起航后发生舷侧接触', rule: 'RRS 14', status: 'reviewing', decision: '', createdAt: nowIso() }],
  timeline: [
    { id: 'event-1', time: nowIso(), type: 'race', message: '航线 W2 已发布' },
    { id: 'event-2', time: new Date(Date.now() + 2000).toISOString(), type: 'protest', message: '远岚号抗议进入复核' }
  ],
  reconciliations: seedReconciliations(initialEntries),
  receipts: [],
  outbox: [],
  currentRole: 'race-officer',
  online: 'online'
};

/* ---------- 对账记录维护 ---------- */

function upsertReconciliation(state: AppState, entry: RaceEntry, extra?: { protestId?: string; receiptId?: string }) {
  let rec = state.reconciliations.find((r) => r.entryId === entry.id && r.raceId === state.races[0].id);
  if (!rec) {
    rec = {
      id: crypto.randomUUID(), raceId: state.races[0].id, fleet: entry.fleet, entryId: entry.id,
      version: entry.currentVersion, protestIds: [], conflict: !!entry.pendingConflict,
      pendingReview: !!entry.pendingConflict, updatedAt: nowIso()
    };
    state.reconciliations.push(rec);
  } else {
    rec.version = entry.currentVersion;
    rec.conflict = !!entry.pendingConflict;
    rec.pendingReview = !!entry.pendingConflict;
    rec.updatedAt = nowIso();
  }
  if (extra?.protestId && !rec.protestIds.includes(extra.protestId)) rec.protestIds.push(extra.protestId);
  if (extra?.receiptId) rec.receiptId = extra.receiptId;
}

function fleetHasPendingReview(state: AppState, fleet: string): { blocked: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const fleetEntries = state.entries.filter((e) => e.fleet === fleet);
  for (const e of fleetEntries) {
    if (e.pendingConflict) reasons.push(`${e.boat} 净用时冲突待复核`);
  }
  const entryIds = new Set(fleetEntries.map((e) => e.id));
  for (const p of state.protests) {
    if (entryIds.has(p.entryId) && (p.status === 'reviewing' || p.status === 'submitted')) {
      const boat = state.entries.find((e) => e.id === p.entryId)?.boat ?? p.entryId;
      reasons.push(`${boat} 抗议 ${p.rule} 待处理`);
    }
  }
  return { blocked: reasons.length > 0, reasons };
}

/* ---------- 队列步骤执行 ---------- */

/** 执行一个步骤，返回错误信息（null 表示落地） */
function executeStep(state: AppState, item: QueueItem, step: QueueStep): string | null {
  const entry = state.entries.find((e) => e.id === item.payload.entryId);

  if (item.kind === 'result-edit') {
    if (step.kind === 'permission') {
      if (item.source !== 'race-officer' && item.source !== 'timer') return '越权：仅竞赛官/计时员可写入到达/净用时成绩';
      return null;
    }
    if (!entry) return '成绩条目不存在';
    if (step.kind === 'write') {
      const hash = hashOf({ entryId: entry.id, elapsedSeconds: item.payload.elapsedSeconds, note: item.payload.note, source: item.source });
      if (entry.versions.some((v) => hashOf({ entryId: entry.id, elapsedSeconds: v.elapsedSeconds, note: v.note, source: v.source }) === hash)) {
        item.result = { skipped: true };
        item.message = '重复导入，未新增修订';
        return null;
      }
      if (item.failNext) {
        item.failNext = false;
        return '网络抖动：写入字段未落地';
      }
      const incoming = { elapsedSeconds: item.payload.elapsedSeconds ?? entry.elapsedSeconds, note: item.payload.note ?? entry.note };
      const elapsedChanged = item.payload.elapsedSeconds != null && entry.elapsedSeconds !== item.payload.elapsedSeconds;
      // 净用时冲突：该字段已由另一个真实角色改过且新值不同（system 基线不算竞争）
      if (elapsedChanged && entry.fieldSource.elapsedSeconds !== 'system' && entry.fieldSource.elapsedSeconds !== item.source) {
        item.result = { conflict: true, incoming };
        return null;
      }
      if (item.payload.elapsedSeconds != null) {
        entry.elapsedSeconds = item.payload.elapsedSeconds;
        entry.fieldSource.elapsedSeconds = item.source;
      }
      if (item.payload.note != null) entry.note = item.payload.note;
      item.result = { incoming };
      return null;
    }
    if (step.kind === 'version') {
      if (item.result?.skipped) return null;
      const latest = entry.versions[entry.versions.length - 1];
      const newNum = entry.currentVersion + 1;
      if (latest) latest.state = 'superseded';
      const incoming = item.result?.incoming ?? { elapsedSeconds: entry.elapsedSeconds, note: entry.note };
      const v = makeVersion(newNum, incoming.elapsedSeconds, entry.penaltySeconds, incoming.note, item.source, 'draft', nowIso());
      entry.versions.push(v);
      entry.currentVersion = newNum;
      entry.resultStatus = 'corrected';
      state.timeline.unshift({ id: crypto.randomUUID(), time: nowIso(), type: 'result', message: `${entry.boat} 成绩生成 v${newNum}（${item.source === 'race-officer' ? '竞赛官' : '计时端'}端）` });
      return null;
    }
    if (step.kind === 'conflict') {
      if (item.result?.conflict) {
        const latest = entry.versions[entry.versions.length - 2];
        const incoming = item.result.incoming;
        entry.pendingConflict = {
          field: 'elapsedSeconds',
          candidates: [
            { value: latest.elapsedSeconds, source: latest.source as Role, version: latest.version },
            { value: incoming.elapsedSeconds, source: item.source, version: entry.currentVersion }
          ],
          status: 'pending_review',
          createdAt: nowIso()
        };
        item.status = 'review';
        state.timeline.unshift({ id: crypto.randomUUID(), time: nowIso(), type: 'system', message: `${entry.boat} 净用时两版冲突，已留两版等待复核` });
      }
      return null;
    }
    if (step.kind === 'reconcile') {
      upsertReconciliation(state, entry);
      return null;
    }
  }

  if (item.kind === 'penalty-edit') {
    if (step.kind === 'permission') {
      if (item.source !== 'arbitrator' && item.source !== 'race-officer') return '越权：仅仲裁/竞赛官可写入处罚秒数';
      return null;
    }
    if (!entry) return '成绩条目不存在';
    if (step.kind === 'write') {
      const hash = hashOf({ entryId: entry.id, penaltySeconds: item.payload.penaltySeconds, source: item.source });
      if (entry.versions.some((v) => hashOf({ entryId: entry.id, penaltySeconds: v.penaltySeconds, source: v.source }) === hash)) {
        item.result = { skipped: true };
        item.message = '重复导入，未新增修订';
        return null;
      }
      if (item.failNext) {
        item.failNext = false;
        return '网络抖动：写入字段未落地';
      }
      entry.penaltySeconds = item.payload.penaltySeconds;
      entry.fieldSource.penaltySeconds = item.source;
      item.result = { incoming: { penaltySeconds: item.payload.penaltySeconds } };
      return null;
    }
    if (step.kind === 'version') {
      if (item.result?.skipped) return null;
      const latest = entry.versions[entry.versions.length - 1];
      const newNum = entry.currentVersion + 1;
      if (latest) latest.state = 'superseded';
      const v = makeVersion(newNum, entry.elapsedSeconds, item.payload.penaltySeconds, entry.note, item.source, 'draft', nowIso());
      entry.versions.push(v);
      entry.currentVersion = newNum;
      entry.resultStatus = 'corrected';
      state.timeline.unshift({ id: crypto.randomUUID(), time: nowIso(), type: 'result', message: `${entry.boat} 处罚更新为 ${item.payload.penaltySeconds}s（仲裁端），生成 v${newNum}` });
      return null;
    }
    if (step.kind === 'reconcile') {
      upsertReconciliation(state, entry, { protestId: item.payload.protestId });
      return null;
    }
  }

  if (item.kind === 'publish') {
    if (step.kind === 'permission') {
      if (item.source !== 'race-officer') return '越权：仅竞赛官可发布正式成绩';
      return null;
    }
    if (step.kind === 'write') {
      const { blocked, reasons } = fleetHasPendingReview(state, item.payload.fleet);
      if (blocked) return `复核闸门未通过：${reasons.join('；')}`;
      return null;
    }
    if (step.kind === 'receipt') {
      const fleetEntries = state.entries.filter((e) => e.fleet === item.payload.fleet);
      const receipt: Receipt = {
        id: `R-${crypto.randomUUID().slice(0, 8)}`,
        raceId: state.races[0].id,
        fleet: item.payload.fleet,
        publishedAt: nowIso(),
        publishedBy: item.source,
        entries: fleetEntries.map((e) => ({ entryId: e.id, version: e.currentVersion }))
      };
      state.receipts.unshift(receipt);
      for (const e of fleetEntries) {
        const cur = e.versions.find((v) => v.version === e.currentVersion);
        if (cur) cur.state = 'official';
        const prevOfficial = e.officialVersion == null ? null : e.versions.find((v) => v.version === e.officialVersion);
        if (prevOfficial && prevOfficial.version !== e.currentVersion) prevOfficial.state = 'superseded';
        e.officialVersion = e.currentVersion;
        e.resultStatus = 'official';
        e.lastReceiptId = receipt.id;
      }
      item.result = { ...item.result, receiptId: receipt.id };
      state.timeline.unshift({ id: crypto.randomUUID(), time: nowIso(), type: 'system', message: `组别 ${item.payload.fleet} 正式成绩已发布，回执 ${receipt.id}` });
      return null;
    }
    if (step.kind === 'reconcile') {
      const fleetEntries = state.entries.filter((e) => e.fleet === item.payload.fleet);
      for (const e of fleetEntries) upsertReconciliation(state, e, { receiptId: item.result?.receiptId });
      return null;
    }
  }
  return null;
}

const slice = createSlice({
  name: 'regatta',
  initialState,
  reducers: {
    setRole(state, action: PayloadAction<Role>) {
      state.currentRole = action.payload;
      state.timeline.unshift({ id: crypto.randomUUID(), time: nowIso(), type: 'system', message: `当前角色切换为 ${action.payload === 'race-officer' ? '竞赛官' : action.payload === 'arbitrator' ? '仲裁' : '计时员'}` });
    },
    setOnline(state, action: PayloadAction<OnlineStatus>) {
      state.online = action.payload;
      state.timeline.unshift({ id: crypto.randomUUID(), time: nowIso(), type: 'system', message: action.payload === 'online' ? '网络恢复，开始回网合并离线队列' : '网络断开，操作将先记入离线队列' });
    },
    enqueue(state, action: PayloadAction<{ kind: QueueKind; payload: any; source: Role }>) {
      const item: QueueItem = {
        id: crypto.randomUUID(),
        kind: action.payload.kind,
        payload: action.payload.payload,
        source: action.payload.source,
        status: 'queued',
        steps: buildSteps(action.payload.kind),
        createdAt: nowIso(),
        attempts: 0,
        failNext: false
      };
      state.outbox.unshift(item);
    },
    /** 从第一个未落地步骤开始顺序执行；失败则停在该步，已落地步骤保留 */
    processItem(state, action: PayloadAction<{ id: string }>) {
      const item = state.outbox.find((i) => i.id === action.payload.id);
      if (!item) return;
      if (item.status === 'done' || item.status === 'rejected') return;
      item.attempts += 1;
      const first = item.steps.findIndex((s) => !s.landed);
      for (let i = first; i < item.steps.length; i++) {
        const step = item.steps[i];
        const err = executeStep(state, item, step);
        if (err) {
          step.error = err;
          item.status = err.startsWith('越权') ? 'rejected' : 'failed';
          return;
        }
        step.landed = true;
        step.error = undefined;
        if (item.status === 'review') return;
      }
      if (item.status !== 'review') item.status = 'done';
    },
    setFailNext(state, action: PayloadAction<{ id: string; value: boolean }>) {
      const item = state.outbox.find((i) => i.id === action.payload.id);
      if (item) item.failNext = action.payload.value;
    },
    dismissItem(state, action: PayloadAction<{ id: string }>) {
      state.outbox = state.outbox.filter((i) => i.id !== action.payload.id);
    },
    resolveConflict(state, action: PayloadAction<{ entryId: string; version: number }>) {
      const entry = state.entries.find((e) => e.id === action.payload.entryId);
      if (!entry || !entry.pendingConflict) return;
      const picked = entry.pendingConflict.candidates.find((c) => c.version === action.payload.version);
      if (!picked) return;
      entry.elapsedSeconds = picked.value;
      entry.fieldSource.elapsedSeconds = picked.source;
      for (const v of entry.versions) {
        if (v.version === picked.version) v.state = 'draft';
        else if (entry.pendingConflict.candidates.some((c) => c.version === v.version)) v.state = 'superseded';
      }
      entry.pendingConflict = undefined;
      entry.resultStatus = 'corrected';
      upsertReconciliation(state, entry);
      for (const i of state.outbox) {
        if (i.status === 'review' && i.payload.entryId === entry.id) i.status = 'done';
      }
      state.timeline.unshift({ id: crypto.randomUUID(), time: nowIso(), type: 'system', message: `${entry.boat} 净用时冲突已复核，采用 v${picked.version}（${picked.source === 'race-officer' ? '竞赛官' : '仲裁'}版）` });
    },
    setRaceStatus(state, action: PayloadAction<{ id: string; status: Race['status'] }>) {
      const race = state.races.find((item) => item.id === action.payload.id);
      if (race) {
        race.status = action.payload.status;
        state.timeline.unshift({ id: crypto.randomUUID(), time: nowIso(), type: 'race', message: `${race.name} 状态更新为 ${race.status}` });
      }
    },
    addProtest(state, action: PayloadAction<{ raceId: string; entryId: string; reason: string; rule: string }>) {
      const protest: Protest = { id: crypto.randomUUID(), ...action.payload, status: 'submitted', decision: '', createdAt: nowIso() };
      state.protests.unshift(protest);
      state.timeline.unshift({ id: crypto.randomUUID(), time: protest.createdAt, type: 'protest', message: `收到 ${action.payload.rule} 抗议，等待复核` });
    },
    transitionProtest(state, action: PayloadAction<{ id: string; status: ProtestStatus; decision?: string; penaltySeconds?: number }>) {
      const protest = state.protests.find((item) => item.id === action.payload.id);
      if (!protest) return;
      protest.status = action.payload.status;
      protest.decision = action.payload.decision ?? protest.decision;
      if (action.payload.penaltySeconds != null) protest.penaltySeconds = action.payload.penaltySeconds;
      state.timeline.unshift({ id: crypto.randomUUID(), time: nowIso(), type: 'protest', message: `抗议 ${action.payload.id.slice(0, 6)} 更新为 ${action.payload.status}` });
    }
  }
});

/* ---------- 持久化（含 v1 迁移） ---------- */

const STORAGE_KEY = 'regatta-control-v2';

function migrateV1(old: any): AppState {
  const entries: RaceEntry[] = (old.entries ?? []).map((e: any) => ({
    ...e,
    fleet: e.fleet ?? '统一级',
    versions: [makeVersion(1, e.elapsedSeconds, e.penaltySeconds, e.note ?? '', 'system', e.resultStatus === 'official' ? 'official' : 'draft', nowIso())],
    currentVersion: 1,
    officialVersion: e.resultStatus === 'official' ? 1 : null,
    fieldSource: { elapsedSeconds: 'system', penaltySeconds: 'system' },
    pendingConflict: undefined,
    lastReceiptId: undefined
  }));
  return {
    ...initialState,
    races: old.races ?? initialState.races,
    entries,
    protests: old.protests ?? [],
    timeline: old.timeline ?? [],
    reconciliations: seedReconciliations(entries),
    receipts: [],
    outbox: [],
    currentRole: 'race-officer',
    online: 'online'
  };
}

function loadState(): AppState {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try { return JSON.parse(raw) as AppState; } catch { /* 落回迁移 */ }
  }
  const v1 = localStorage.getItem('regatta-control-v1');
  if (v1) {
    try { return migrateV1(JSON.parse(v1)); } catch { /* 落回初始 */ }
  }
  return initialState;
}

const preloadedState = loadState();

export const {
  setRole, setOnline, enqueue, processItem, setFailNext, dismissItem,
  resolveConflict, setRaceStatus, addProtest, transitionProtest
} = slice.actions;

/* ----------  thunks：断网记队列，回网合并 ---------- */

function flush(dispatch: AppDispatch, getState: () => RootState) {
  const pending = getState().regatta.outbox.filter((i) => i.status === 'queued' || i.status === 'failed');
  for (const item of pending) dispatch(processItem({ id: item.id }));
}

/** 提交成绩更正（到达/净用时）：断网先入队，回网自动合并 */
export const submitResultEdit = (payload: { entryId: string; elapsedSeconds?: number; note?: string }) =>
  (dispatch: AppDispatch, getState: () => RootState) => {
    const { currentRole, online } = getState().regatta;
    dispatch(enqueue({ kind: 'result-edit', payload, source: currentRole }));
    if (online) flush(dispatch, getState);
  };

/** 提交处罚（抗议判罚）：仅仲裁可落地 */
export const submitPenaltyEdit = (payload: { entryId: string; penaltySeconds: number; protestId?: string }) =>
  (dispatch: AppDispatch, getState: () => RootState) => {
    const { currentRole, online } = getState().regatta;
    dispatch(enqueue({ kind: 'penalty-edit', payload, source: currentRole }));
    if (online) flush(dispatch, getState);
  };

/** 发布本组正式成绩：无待复核才放行 */
export const publishFleet = (fleet: string) =>
  (dispatch: AppDispatch, getState: () => RootState) => {
    const { currentRole, online } = getState().regatta;
    dispatch(enqueue({ kind: 'publish', payload: { fleet }, source: currentRole }));
    if (online) flush(dispatch, getState);
  };

/** 回网合并：处理所有 queued/failed 项，只重试未落地步骤 */
export const flushOutbox = () => (dispatch: AppDispatch, getState: () => RootState) => flush(dispatch, getState);

export const retryItem = (id: string) => (dispatch: AppDispatch) => dispatch(processItem({ id }));

/** 从离线设备回传：竞赛官改净用时 + 仲裁改处罚，按字段合并 */
export const importOfflineEdits = () =>
  (dispatch: AppDispatch, getState: () => RootState) => {
    const state = getState().regatta;
    const target = state.entries.find((e) => e.id === 'entry-2') ?? state.entries[0];
    dispatch(enqueue({ kind: 'result-edit', payload: { entryId: target.id, elapsedSeconds: 3200, note: '到达数据更正' }, source: 'race-officer' }));
    dispatch(enqueue({ kind: 'penalty-edit', payload: { entryId: target.id, penaltySeconds: 60, protestId: 'protest-1' }, source: 'arbitrator' }));
    if (state.online) flush(dispatch, getState);
  };

/** 模拟两版净用时冲突：计时员与竞赛官离线改了同一字段且不一致 */
export const importConflictEdits = () =>
  (dispatch: AppDispatch, getState: () => RootState) => {
    const state = getState().regatta;
    const target = state.entries.find((e) => e.id === 'entry-2') ?? state.entries[0];
    dispatch(enqueue({ kind: 'result-edit', payload: { entryId: target.id, elapsedSeconds: 3200, note: '计时员版到达' }, source: 'timer' }));
    dispatch(enqueue({ kind: 'result-edit', payload: { entryId: target.id, elapsedSeconds: 3210, note: '竞赛官版到达' }, source: 'race-officer' }));
    if (state.online) flush(dispatch, getState);
  };

/** 重复导入同一份成绩：哈希命中，不新增修订 */
export const reimportLastEdit = () =>
  (dispatch: AppDispatch, getState: () => RootState) => {
    const state = getState().regatta;
    const target = state.entries.find((e) => e.id === 'entry-2') ?? state.entries[0];
    const v = target.versions[target.versions.length - 1];
    // 重放同一份成绩更正：来源须具备成绩写入权限（竞赛官/计时员），否则会被权限闸门拒绝
    const source = (v.source === 'race-officer' || v.source === 'timer') ? v.source : 'race-officer';
    dispatch(enqueue({ kind: 'result-edit', payload: { entryId: target.id, elapsedSeconds: v.elapsedSeconds, note: v.note }, source }));
    if (state.online) flush(dispatch, getState);
  };

export const store = configureStore({
  reducer: { regatta: slice.reducer, [raceApi.reducerPath]: raceApi.reducer },
  middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(raceApi.middleware)
});
store.subscribe(() => localStorage.setItem(STORAGE_KEY, JSON.stringify(store.getState().regatta)));

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
