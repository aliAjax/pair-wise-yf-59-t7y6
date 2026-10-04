// 对账引擎规则自验证：node 运行，不进 UI 打包
import { strict as assert } from 'node:assert';
import { buildSeed } from '../src/recon/seed';
import { applyOp, buildRecon, findReceiptFor, mergeQueue, netOf, revisionHistory, retryPending, uid } from '../src/recon/engine';
import type { CorrectionOp, Ledger } from '../src/recon/types';

let passed = 0;
const check = (name: string, fn: () => void) => {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
};

// ---------- 种子基线 ----------
const seed = buildSeed();
const s = seed.ledger;
const entry = (id: string) => s.entries.find((e) => e.id === id)!;

check('种子：组别/成绩/处罚/回执已接成对账记录', () => {
  const lines = buildRecon(s);
  assert.equal(lines.length, 5);
  const e1 = lines.find((l) => l.entryId === 'e1')!;
  assert.equal(e1.baseElapsed, 3168);
  assert.equal(e1.correctedElapsed, 3158); // 到达、更正按字段合并
  assert.ok(e1.receiptId, 'e1 应有发布回执');
  assert.match(e1.receiptChecksum ?? '', /^rc-/);
});

check('种子：g2 蓝鲸号离线双改 → 净用时冲突留两版待复核', () => {
  const e4 = entry('e4');
  assert.ok(e4.pending, 'e4 应存在 pending 冲突');
  assert.equal(e4.pending!.versions.length, 2);
  assert.equal(e4.pending!.versions[0].elapsedSeconds, 1902);
  assert.equal(e4.pending!.versions[1].elapsedSeconds, 1948);
  assert.equal(netOf(e4), 1880, '冲突未裁定前净用时沿用到达段，不被任一方覆盖');
});

check('种子：e3 发布后处罚 → 原版本失效但可查、待重发', () => {
  const e3 = entry('e3');
  assert.ok(e3.publishedRevId, '保留指向旧发布版的引用（旧版可查/回执可关联）');
  const statuses = e3.revisions.map((r) => r.status);
  assert.ok(statuses.includes('superseded'), '存在已失效旧版');
  const old = e3.revisions.find((r) => r.id === e3.publishedRevId)!;
  assert.equal(old.status, 'superseded');
  assert.ok(old.invalidatedAt, '失效带时间戳');
  assert.ok(findReceiptFor(s, old.id), '旧版关联得到当时发布回执，重发前可查');
  assert.equal(netOf(e3), 3150 + 20);
  const line = buildRecon(s).find((l) => l.entryId === 'e3')!;
  assert.equal(line.stale, true);
});

// ---------- 重复导入 ----------
check('重复导入不新增修订、不重复加罚', () => {
  const before = entry('e2').revisions.length;
  const dup = applyOp(s, {
    kind: 'penalty', opId: 'seed-pen-e2', entryId: 'e2', actor: 'o-jury', at: new Date().toISOString(),
    protestId: 'pr-14-01', rule: 'RRS 14', reason: '重复', deltaSeconds: 30, baseSeq: 0
  });
  assert.equal(dup.status, 'duplicate');
  assert.equal(entry('e2').revisions.length, before);
  assert.equal(entry('e2').penalties.find((p) => p.protestId === 'pr-14-01')!.seconds, 30);
});

check('同一抗议另补一步（新opId）：处罚按字段合并但产生修订', () => {
  const before = entry('e2').revisions.length;
  const out = applyOp(s, {
    kind: 'penalty', opId: uid('op'), entryId: 'e2', actor: 'o-jury', at: new Date().toISOString(),
    protestId: 'pr-14-01', rule: 'RRS 14', reason: '补罚', deltaSeconds: 10, baseSeq: 0
  });
  assert.equal(out.status, 'applied');
  assert.equal(entry('e2').penalties.find((p) => p.protestId === 'pr-14-01')!.seconds, 40);
  assert.equal(entry('e2').revisions.length, before + 1);
});

// ---------- 越权 ----------
check('越权写入成绩被拒绝（计时员不能更正）', () => {
  const out = applyOp(s, {
    kind: 'correction', opId: uid('op'), entryId: 'e1', actor: 'o-timer', at: new Date().toISOString(),
    elapsedSeconds: 1, reason: 'x', baseSeq: entry('e1').revisions[0].seq
  });
  assert.equal(out.status, 'rejected');
  assert.equal(out.code, 'FORBIDDEN');
  assert.notEqual(netOf(entry('e1')), 1);
  assert.ok(s.audit.some((a) => a.code === 'FORBIDDEN'));
});

check('越权写处罚被拒绝（竞赛官不能处罚）', () => {
  const out = applyOp(s, {
    kind: 'penalty', opId: uid('op'), entryId: 'e1', actor: 'o-ro', at: new Date().toISOString(),
    protestId: 'pr-x', rule: 'RRS 2', reason: 'x', deltaSeconds: 5, baseSeq: 0
  });
  assert.equal(out.status, 'rejected');
  assert.equal(out.code, 'FORBIDDEN');
});

check('仲裁可写更正（规则允许）', () => {
  const out = applyOp(s, {
    kind: 'correction', opId: uid('op'), entryId: 'e5', actor: 'o-jury', at: new Date().toISOString(),
    elapsedSeconds: 1900, reason: '仲裁更正', baseSeq: entry('e5').revisions[0].seq
  });
  assert.equal(out.status, 'applied');
});

// ---------- 发布门禁 ----------
check('同组别有待复核 → 发布被拒', () => {
  const out = applyOp(s, { kind: 'publish', opId: uid('op'), groupId: 'g2', actor: 'o-ro', at: new Date().toISOString() });
  assert.equal(out.status, 'rejected');
  assert.equal(out.code, 'PENDING_CONFLICT');
});

check('非竞赛官发布被拒', () => {
  const out = applyOp(s, { kind: 'publish', opId: uid('op'), groupId: 'g1', actor: 'o-jury', at: new Date().toISOString() });
  assert.equal(out.status, 'rejected');
  assert.equal(out.code, 'FORBIDDEN');
});

check('复核裁定后 g2 可发布，回执名次正确', () => {
  const e4 = entry('e4');
  const conflictId = e4.pending!.id;
  const resolveOut = applyOp(s, {
    kind: 'resolve', opId: uid('op'), entryId: 'e4', actor: 'o-jury', at: new Date().toISOString(),
    conflictId, pick: 'B'
  });
  assert.equal(resolveOut.status, 'applied');
  assert.equal(e4.pending, null);
  assert.equal(e4.correctedElapsed, 1948);
  const pub = applyOp(s, { kind: 'publish', opId: uid('op'), groupId: 'g2', actor: 'o-ro', at: new Date().toISOString() });
  assert.equal(pub.status, 'applied');
  const receipt = s.receipts.find((r) => r.id === pub.receiptId)!;
  const e4Line = receipt.lines.find((l) => l.entryId === 'e4')!;
  assert.equal(e4Line.net, 1948);
  // e5: 1925 到达 + 1900 更正已应用 → 1900 第一；但 e5 队列处罚还没 flush，所以此刻 e5=1900
  const rank1 = receipt.lines.find((l) => l.rank === 1)!;
  assert.equal(rank1.entryId, 'e5');
});

// ---------- 断网队列回网合并 + 失败重试 ----------
check('回网合并：队列中重复项/越权项识别，未落地步骤可单独重试', () => {
  const seed2 = buildSeed();
  const t = seed2.ledger;
  const results = mergeQueue(t, seed2.queue);
  const [pen, dup, forbidden] = results;
  assert.equal(pen.status, 'applied');
  assert.equal(dup.status, 'duplicate', '重复导入不新增修订');
  assert.equal(forbidden.status, 'rejected');
  assert.equal(forbidden.code, 'FORBIDDEN');
  assert.equal(t.entries.find((e) => e.id === 'e5')!.penalties[0].seconds, 15);

  // 写入失败后只重试没落地的步骤：越权项换成竞赛官合规更正 → 只它被重放
  const fixedQueue = seed2.queue
    .filter((op) => !t.appliedOpIds.includes(op.opId))
    .map((op) => op.kind === 'correction' ? { ...op, actor: 'o-ro', elapsedSeconds: 2990 } as CorrectionOp : op);
  const retried = retryPending(t, fixedQueue);
  assert.equal(retried.length, 1, '已落地（处罚）与重复项不重试');
  assert.equal(retried[0].status, 'applied');
  assert.equal(t.entries.find((e) => e.id === 'e2')!.correctedElapsed, 2990);
});

// ---------- 字段合并独立性 ----------
check('到达数据重传不冲掉更正段和处罚段', () => {
  const t: Ledger = buildSeed().ledger;
  const e1 = t.entries.find((e) => e.id === 'e1')!;
  const correctedBefore = e1.correctedElapsed;
  const penaltyBefore = e1.penalties.reduce((sum, p) => sum + p.seconds, 0);
  applyOp(t, { kind: 'arrival', opId: uid('op'), entryId: 'e1', actor: 'o-timer', at: new Date().toISOString(), finishTime: new Date().toISOString(), elapsedSeconds: 3170, baseSeq: 0 });
  assert.equal(e1.baseElapsed, 3170);
  assert.equal(e1.correctedElapsed, correctedBefore);
  assert.equal(e1.penalties.reduce((sum, p) => sum + p.seconds, 0), penaltyBefore);
});

check('两人基于同一版改出相同值：不产生冲突，直接落地', () => {
  const t = buildSeed().ledger;
  const e5 = t.entries.find((e) => e.id === 'e5')!;
  const baseSeq = e5.revisions[0].seq; // 到达版
  applyOp(t, { kind: 'correction', opId: uid('op'), entryId: 'e5', actor: 'o-ro', at: new Date().toISOString(), elapsedSeconds: 1900, reason: '同值A', baseSeq });
  applyOp(t, { kind: 'correction', opId: uid('op'), entryId: 'e5', actor: 'o-jury', at: new Date().toISOString(), elapsedSeconds: 1900, reason: '同值B', baseSeq });
  assert.equal(e5.pending, null);
  assert.equal(e5.correctedElapsed, 1900);
});

check('冲突期间更正被阻塞留在队列，裁定后只重试该未落地步骤并成功', () => {
  const t = buildSeed().ledger;
  const e4 = t.entries.find((e) => e.id === 'e4')!;
  const conflictId = e4.pending!.id;
  const blockedOp: CorrectionOp = { kind: 'correction', opId: uid('op'), entryId: 'e4', actor: 'o-ro', at: new Date().toISOString(), elapsedSeconds: 1933, reason: '冲突期间补的更正', baseSeq: e4.revisions[0].seq };
  const first = applyOp(t, blockedOp);
  assert.equal(first.status, 'rejected');
  assert.equal(first.code, 'CORRECTION_BLOCKED');
  assert.ok(!t.appliedOpIds.includes(blockedOp.opId));
  const resolveOp = { kind: 'resolve' as const, opId: uid('op'), entryId: 'e4', actor: 'o-jury', at: new Date().toISOString(), conflictId, pick: 'A' as const };
  applyOp(t, resolveOp);
  // 重试队列：resolve 已落地跳过，blockedOp 单独重放
  const retried = retryPending(t, [blockedOp, resolveOp]);
  assert.equal(retried.length, 1);
  assert.equal(retried[0].status, 'applied');
  assert.equal(e4.correctedElapsed, 1933);
});

check('修订链完整保留历史版本（旧版可查）', () => {
  const hist = revisionHistory(s, 'e1');
  assert.ok(hist.length >= 2);
  assert.ok(hist.every((r) => r.net !== null), '每个版本都有当时净用时快照');
});

console.log(`\n全部 ${passed} 项引擎规则验证通过`);
