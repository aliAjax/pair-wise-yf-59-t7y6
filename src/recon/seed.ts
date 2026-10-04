import { applyOp } from './engine';
import type { Ledger, Official, Op, ResultEntry } from './types';

export const OFFICIALS: Official[] = [
  { id: 'o-ro', name: '陈港', role: 'ro' },
  { id: 'o-jury', name: '宋宁', role: 'jury' },
  { id: 'o-timer', name: '罗夏', role: 'timer' }
];

export const ROLE_LABEL: Record<Official['role'], string> = {
  ro: '竞赛官',
  jury: '仲裁',
  timer: '计时员'
};

interface SeedEntry {
  id: string; groupId: string; boat: string; sailNo: string; skipper: string;
}

const SEED_ENTRIES: SeedEntry[] = [
  { id: 'e1', groupId: 'g1', boat: '海风号', sailNo: 'CHN 218', skipper: '林舟' },
  { id: 'e2', groupId: 'g1', boat: '远岚号', sailNo: 'CHN 106', skipper: '周屿' },
  { id: 'e3', groupId: 'g1', boat: '北辰号', sailNo: 'CHN 077', skipper: '许澄' },
  { id: 'e4', groupId: 'g2', boat: '蓝鲸号', sailNo: 'CHN 402', skipper: '沈砚' },
  { id: 'e5', groupId: 'g2', boat: '白鹭号', sailNo: 'CHN 315', skipper: '高航' }
];

function emptyEntry(seed: SeedEntry): ResultEntry {
  return {
    id: seed.id, groupId: seed.groupId, boat: seed.boat, sailNo: seed.sailNo, skipper: seed.skipper,
    finishTime: null, baseElapsed: null, correctedElapsed: null, correctionNote: '',
    penalties: [], pending: null, revisions: [], publishedRevId: null
  };
}

export interface SeedBundle {
  ledger: Ledger;
  queue: Op[];
  arrivalSeq: Record<string, number>;
}

export function buildSeed(now: number = Date.now()): SeedBundle {
  const at = (offsetMin: number) => new Date(now + offsetMin * 60000).toISOString();
  const ledger: Ledger = {
    seq: 0,
    officials: Object.fromEntries(OFFICIALS.map((item) => [item.id, item])),
    groups: [
      { id: 'g1', name: '海湾长距离赛', fleet: '统一级', course: 'W2 / 东北风 12节', startsAt: at(-40) },
      { id: 'g2', name: '近岸绕标赛', fleet: '青年级', course: 'S1 / 东风 8节', startsAt: at(-25) }
    ],
    entries: SEED_ENTRIES.map(emptyEntry),
    receipts: [],
    appliedOpIds: [],
    rejectedOpIds: [],
    audit: []
  };

  const arrivalSeq: Record<string, number> = {};
  const arrival = (entryId: string, elapsed: number, offset: number, opId: string) => {
    const out = applyOp(ledger, {
      kind: 'arrival', opId, entryId, actor: 'o-timer', at: at(offset),
      finishTime: at(offset), elapsedSeconds: elapsed, baseSeq: 0
    });
    arrivalSeq[entryId] = ledger.seq;
    return out;
  };

  // 回网前已合成的时间线
  arrival('e1', 3168, -30, 'seed-arr-e1');
  arrival('e2', 3194, -29, 'seed-arr-e2');
  arrival('e3', 3150, -31, 'seed-arr-e3');
  arrival('e4', 1880, -15, 'seed-arr-e4');
  arrival('e5', 1925, -14, 'seed-arr-e5');

  applyOp(ledger, { kind: 'penalty', opId: 'seed-pen-e2', entryId: 'e2', actor: 'o-jury', at: at(-20), protestId: 'pr-14-01', rule: 'RRS 14', reason: '舷侧接触', deltaSeconds: 30, baseSeq: 0 });
  applyOp(ledger, { kind: 'correction', opId: 'seed-cor-e1', entryId: 'e1', actor: 'o-ro', at: at(-18), elapsedSeconds: 3158, reason: '计时复核修正', baseSeq: arrivalSeq.e1 });

  // g1 先发布一版
  applyOp(ledger, { kind: 'publish', opId: 'seed-pub-g1', groupId: 'g1', actor: 'o-ro', at: at(-10) });

  // 发布后又落处罚：e3 原版本失效，旧版仍可在修订链中查
  applyOp(ledger, { kind: 'penalty', opId: 'seed-pen-e3', entryId: 'e3', actor: 'o-jury', at: at(-6), protestId: 'pr-42-01', rule: 'RRS 42', reason: '动力补给', deltaSeconds: 20, baseSeq: 0 });

  // g2 离线双改同一成绩：净用时冲突留两版
  applyOp(ledger, { kind: 'correction', opId: 'seed-cor-e4-a', entryId: 'e4', actor: 'o-ro', at: at(-8), elapsedSeconds: 1902, reason: '竞赛官改判绕标罚时', baseSeq: arrivalSeq.e4 });
  applyOp(ledger, { kind: 'correction', opId: 'seed-cor-e4-b', entryId: 'e4', actor: 'o-jury', at: at(-7), elapsedSeconds: 1948, reason: '仲裁采信抗议版本', baseSeq: arrivalSeq.e4 });

  // 断网期间攒下的队列：1 条待落地处罚、1 条重复导入、1 条越权
  const queue: Op[] = [
    { kind: 'penalty', opId: 'q-pen-e5', entryId: 'e5', actor: 'o-jury', at: at(-3), protestId: 'pr-31-02', rule: 'RRS 31', reason: '碰标', deltaSeconds: 15, baseSeq: 0 },
    { kind: 'arrival', opId: 'seed-arr-e1', entryId: 'e1', actor: 'o-timer', at: at(-30), finishTime: at(-30), elapsedSeconds: 3168, baseSeq: 0 },
    { kind: 'correction', opId: 'q-cor-forbidden', entryId: 'e2', actor: 'o-timer', at: at(-2), elapsedSeconds: 3000, reason: '计时员越权改成绩', baseSeq: arrivalSeq.e2 }
  ];

  return { ledger, queue, arrivalSeq };
}
