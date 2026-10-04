import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { applyOp, mergeQueue, retryPending, uid } from './engine';
import { buildSeed, OFFICIALS, ROLE_LABEL } from './seed';
import type { BatchLineResult, Ledger, Op } from './types';

export type ConnectionMode = 'online' | 'offline';

export interface QueueItem {
  op: Op;
  queuedAt: string;
  /** flush 后未落地（拒绝/阻塞）时记录原因，供只重试未落地步骤 */
  lastResult?: BatchLineResult;
}

interface ReconState {
  ledger: Ledger;
  queue: QueueItem[];
  mode: ConnectionMode;
  currentActor: string;
  lastBatch: BatchLineResult[];
}

const STORAGE_KEY = 'regatta-recon-v2';

function freshState(): ReconState {
  const seed = buildSeed();
  return {
    ledger: seed.ledger,
    queue: seed.queue.map((op) => ({ op, queuedAt: op.at })),
    mode: 'offline',
    currentActor: 'o-ro',
    lastBatch: []
  };
}

function loadState(): ReconState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as ReconState;
      if (parsed.ledger && Array.isArray(parsed.ledger.entries)) return parsed;
    }
  } catch {
    // 损坏存档回退种子
  }
  return freshState();
}

const slice = createSlice({
  name: 'recon',
  initialState: loadState,
  reducers: {
    setMode(state, action: PayloadAction<ConnectionMode>) {
      state.mode = action.payload;
    },
    setActor(state, action: PayloadAction<string>) {
      state.currentActor = action.payload;
    },
    /** 提交一个写操作：在线直接落地；断网先记队列，回网再合并 */
    submitOp(state, action: PayloadAction<Op>) {
      const op = action.payload;
      if (state.mode === 'offline') {
        if (!state.queue.some((item) => item.op.opId === op.opId)) {
          state.queue.push({ op, queuedAt: new Date().toISOString() });
        }
      } else {
        state.lastBatch = [applyOp(state.ledger, op)];
      }
    },
    /** 回网合并：逐条落地，重复导入不新增修订，越权/阻塞留在队列里只重试没落地的 */
    flushQueue(state) {
      const results = mergeQueue(state.ledger, state.queue.map((item) => item.op));
      state.lastBatch = results;
      state.queue = state.queue
        .map((item, index) => ({ item, result: results[index] }))
        .filter(({ item, result }) => {
          item.lastResult = result;
          // applied / duplicate 都出队；rejected（越权、待复核阻塞、发布门禁）留队待重试
          return result.status === 'rejected';
        })
        .map(({ item }) => item);
      state.mode = 'online';
    },
    /** 写入失败后只重试没落地的步骤 */
    retryFailed(state) {
      const results = retryPending(state.ledger, state.queue.map((item) => item.op));
      state.lastBatch = results;
      const retriedIds = new Set(results.map((result) => result.opId));
      state.queue = state.queue
        .map((item) => {
          const result = results.find((candidate) => candidate.opId === item.op.opId);
          if (result) item.lastResult = result;
          return item;
        })
        .filter((item) => {
          if (!retriedIds.has(item.op.opId)) return true;
          return item.lastResult?.status === 'rejected';
        });
    },
    /** 清空队列中已确认无效的步骤（如越权项） */
    discardQueued(state, action: PayloadAction<string>) {
      state.queue = state.queue.filter((item) => item.op.opId !== action.payload);
    },
    resetDemo() {
      return freshState();
    }
  }
});

export const { setMode, setActor, submitOp, flushQueue, retryFailed, discardQueued, resetDemo } = slice.actions;

export const store = configureStore({ reducer: slice.reducer });
store.subscribe(() => {
  const state = store.getState();
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    ledger: state.ledger, queue: state.queue, mode: state.mode, currentActor: state.currentActor, lastBatch: state.lastBatch
  } satisfies ReconState));
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

// ---- selectors / helpers ----
export const officialsList = OFFICIALS;
export const roleLabel = ROLE_LABEL;
export { uid };
