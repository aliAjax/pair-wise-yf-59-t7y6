import { useMemo, useState } from 'react';
import {
  App as AntApp, Alert, Badge, Button, Card, Col, Descriptions, Drawer, Empty, Form,
  Input, InputNumber, Layout, List, Menu, Row, Select, Space, Statistic, Table, Tabs, Tag,
  Timeline, Typography
} from 'antd';
import {
  ClockCircleOutlined, CloudOutlined, DisconnectOutlined, FileDoneOutlined,
  HistoryOutlined, MergeCellsOutlined, SafetyCertificateOutlined, SendOutlined
} from '@ant-design/icons';
import { Provider, useDispatch, useSelector, useStore } from 'react-redux';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { buildRecon, findReceiptFor } from './recon/engine';
import { discardQueued, flushQueue, resetDemo, retryFailed, setActor, setMode, submitOp, officialsList, roleLabel, store, type AppDispatch, type RootState } from './recon/store';
import { formatSeconds, makeArrival, makeCorrection, makePenalty, makePublish, makeResolve } from './recon/actions';
import type { Op, ResultEntry, Revision } from './recon/types';

const { Header, Content, Sider } = Layout;

const OP_LABEL: Record<Op['kind'], string> = {
  arrival: '到达数据',
  penalty: '抗议处罚',
  correction: '成绩更正',
  resolve: '冲突裁定',
  publish: '整组发布'
};

const REV_STATUS: Record<Revision['status'], { label: string; color: string }> = {
  active: { label: '现行', color: 'blue' },
  published: { label: '已发布', color: 'green' },
  superseded: { label: '已失效（旧版可查）', color: 'default' },
  invalidated: { label: '已作废', color: 'red' },
  disputed: { label: '争议版·待复核', color: 'volcano' }
};

function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('zh-CN', { hour12: false });
}

function describeOp(op: Op): string {
  switch (op.kind) {
    case 'arrival': return `${OP_LABEL.arrival}：${op.entryId} 用时 ${op.elapsedSeconds}s`;
    case 'penalty': return `${OP_LABEL.penalty}：${op.entryId} ${op.rule} +${op.deltaSeconds}s（${op.protestId.slice(0, 8)}）`;
    case 'correction': return `${OP_LABEL.correction}：${op.entryId} 净用时 ${op.elapsedSeconds}s`;
    case 'resolve': return `${OP_LABEL.resolve}：${op.entryId} 采用 ${op.pick} 版`;
    case 'publish': return `${OP_LABEL.publish}：组别 ${op.groupId}`;
  }
}

// ---------------- 对账记录 ----------------

function RevisionDrawer({ entryId, onClose }: { entryId: string | null; onClose: () => void }) {
  const ledger = useSelector((state: RootState) => state.ledger);
  const entry = ledger.entries.find((item) => item.id === entryId) ?? null;
  if (!entry) return <Drawer open={false} onClose={onClose} />;
  return (
    <Drawer width={760} open onClose={onClose} title={`版本链与旧版查询 · ${entry.boat}（${entry.sailNo}）`}>
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        <Alert type="info" showIcon message="成绩改动后原版本自动失效；已发布旧版在重发前仍可在此完整查阅，并关联当时发布回执。" />
        <Table rowKey="id" pagination={false} size="small" dataSource={entry.revisions} columns={[
          { title: '#', dataIndex: 'seq', width: 56 },
          { title: '类型', render: (_v, r: Revision) => <Tag>{OP_LABEL[r.kind]}</Tag> },
          { title: '操作人', render: (_v, r: Revision) => `${r.actorName}（${roleLabel[ledger.officials[r.actor]?.role ?? 'ro']}）` },
          { title: '时间', render: (_v, r: Revision) => fmtTime(r.at) },
          {
            title: '字段快照',
            render: (_v, r: Revision) => (
              <Space size={4} wrap>
                <span>到达 {r.baseElapsed === null ? '—' : formatSeconds(r.baseElapsed)}</span>
                <Tag color={r.correctedElapsed === null ? 'default' : 'orange'}>更正 {r.correctedElapsed === null ? '沿用' : formatSeconds(r.correctedElapsed)}</Tag>
                <Tag color="red">罚 {r.penaltySeconds}s</Tag>
                <b>净 {r.net === null ? '—' : formatSeconds(r.net)}</b>
              </Space>
            )
          },
          { title: '状态', render: (_v, r: Revision) => {
            const meta = REV_STATUS[r.status];
            const receipt = findReceiptFor(ledger, r.id);
            return (
              <Space direction="vertical" size={2}>
                <Tag color={meta.color}>{meta.label}</Tag>
                {receipt && <small>回执 {receipt.id.slice(0, 10)} · {receipt.checksum}</small>}
                {r.invalidatedAt && <small>失效于 {fmtTime(r.invalidatedAt)}</small>}
              </Space>
            );
          } },
          { title: '说明', dataIndex: 'summary' }
        ]} />
      </Space>
    </Drawer>
  );
}

function ReconPage() {
  const ledger = useSelector((state: RootState) => state.ledger);
  const [groupTab, setGroupTab] = useState(ledger.groups[0]?.id ?? '');
  const [drawerEntry, setDrawerEntry] = useState<string | null>(null);
  const lines = useMemo(() => buildRecon(ledger).filter((line) => line.groupId === groupTab), [ledger, groupTab]);

  return (
    <>
      <Card>
        <Tabs activeKey={groupTab} onChange={setGroupTab} items={ledger.groups.map((group) => {
          const groupLines = buildRecon(ledger).filter((line) => line.groupId === group.id);
          const pending = groupLines.filter((line) => line.pending).length;
          const stale = groupLines.filter((line) => line.stale).length;
          return {
            key: group.id,
            label: <Space>{group.name}<Tag>{group.fleet}</Tag>{pending > 0 && <Badge count={`${pending} 待复核`} />}{stale > 0 && <Tag color="orange">{stale} 待重发</Tag>}</Space>
          };
        })} />
        <Descriptions size="small" column={3} style={{ marginBottom: 12 }}
          items={(() => {
            const group = ledger.groups.find((item) => item.id === groupTab);
            return group ? [
              { key: 'f', label: '组别', children: group.fleet },
              { key: 'c', label: '航线', children: group.course },
              { key: 's', label: '起航', children: fmtTime(group.startsAt) }
            ] : [];
          })()} />
        <Table rowKey="entryId" pagination={false} dataSource={lines} columns={[
          { title: '船名 / 帆号', render: (_v, r) => <b>{r.boat}</b> },
          { title: '到达冲线', dataIndex: 'finishTime', render: (v: string | null) => fmtTime(v) },
          { title: '到达用时', dataIndex: 'baseElapsed', render: (v: number | null) => formatSeconds(v) },
          { title: '更正净用时', dataIndex: 'correctedElapsed', render: (v: number | null) => v === null ? <Tag>沿用到达</Tag> : <Tag color="orange">{formatSeconds(v)}</Tag> },
          { title: '抗议处罚', render: (_v, r) => r.penaltyTotal === 0 ? '0s' : <Space size={4} wrap><Tag color="red">+{r.penaltyTotal}s</Tag>{r.penaltyRefs.map((id) => <small key={id}>{id.slice(0, 8)}</small>)}</Space> },
          { title: '净用时合计', render: (_v, r) => <b style={{ fontSize: 15 }}>{formatSeconds(r.net)}</b> },
          { title: '发布回执', render: (_v, r) => r.receiptId ? <Space direction="vertical" size={0}><FileDoneOutlined style={{ color: '#52c41a' }} /><small>{r.receiptId.slice(0, 10)}</small><small>{r.receiptChecksum}</small></Space> : <Tag>未发布</Tag> },
          {
            title: '状态',
            render: (_v, r) => (
              <Space direction="vertical" size={2}>
                {r.pending && <Tag color="volcano">净用时冲突·两版待复核</Tag>}
                {r.stale && <Tag color="orange">成绩改动·旧版失效待重发</Tag>}
                {!r.pending && !r.stale && r.receiptId && <Tag color="green">发布版现行有效</Tag>}
                {!r.pending && !r.stale && !r.receiptId && <Tag color="blue">待发布</Tag>}
              </Space>
            )
          },
          { title: '版本', render: (_v, r) => <Button size="small" icon={<HistoryOutlined />} onClick={() => setDrawerEntry(r.entryId)}>版本链 ({ledger.entries.find((e) => e.id === r.entryId)?.revisions.length ?? 0})</Button> }
        ]} />
      </Card>
      <RevisionDrawer entryId={drawerEntry} onClose={() => setDrawerEntry(null)} />
    </>
  );
}

// ---------------- 录入：到达 / 更正 / 处罚 ----------------

function OpsPage() {
  const ledger = useSelector((state: RootState) => state.ledger);
  const mode = useSelector((state: RootState) => state.mode);
  const actor = useSelector((state: RootState) => state.currentActor);
  const dispatch = useDispatch<AppDispatch>();
  const storeInstance = useStore<RootState>();
  const { message } = AntApp.useApp();
  const [arrivalForm] = Form.useForm();
  const [correctionForm] = Form.useForm();
  const [penaltyForm] = Form.useForm();

  const entryOptions = ledger.entries.map((entry) => ({ value: entry.id, label: `${entry.boat} / ${entry.sailNo}（${ledger.groups.find((g) => g.id === entry.groupId)?.name}）` }));

  const afterSubmit = () => {
    const results = storeInstance.getState().lastBatch;
    if (mode === 'offline') {
      message.warning('当前断网：操作已记入离线队列，回网后合并');
      return;
    }
    const result = results[0];
    if (result?.status === 'applied') message.success('已落地并生成新版本');
    else if (result?.status === 'duplicate') message.info('重复导入，不新增修订');
    else if (result?.status === 'rejected') message.error(`写入被拒绝：${result.message ?? result.code}`);
  };

  const role = ledger.officials[actor]?.role;

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      {mode === 'offline' && <Alert type="warning" showIcon icon={<DisconnectOutlined />} message="码头网络中断中：所有写入先记入离线队列，回网时按字段合并，不丢步骤。" />}
      <Alert type="info" showIcon message={<>当前身份：<b>{ledger.officials[actor]?.name}</b>（{roleLabel[role ?? 'ro']}）。到达数据限计时员、抗议处罚限仲裁、更正限竞赛官/仲裁、发布限竞赛官；越权写入会被拒绝。</>} />
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={8}>
          <Card title={<Space><ClockCircleOutlined />到达数据 <Tag>计时员</Tag></Space>}>
            <Form form={arrivalForm} layout="vertical" initialValues={{ elapsedSeconds: 3200 }} onFinish={(values) => {
              dispatch(submitOp(makeArrival(ledger, values.entryId, values.elapsedSeconds, actor)));
              afterSubmit();
            }}>
              <Form.Item name="entryId" label="参赛船" rules={[{ required: true }]}><Select options={entryOptions} placeholder="选择参赛船" /></Form.Item>
              <Form.Item name="elapsedSeconds" label="到达用时（秒）" rules={[{ required: true }]}><InputNumber min={1} style={{ width: '100%' }} /></Form.Item>
              <Button block type="primary" htmlType="submit">提交到达数据</Button>
            </Form>
          </Card>
        </Col>
        <Col xs={24} lg={8}>
          <Card title={<Space><SafetyCertificateOutlined />成绩更正 <Tag>竞赛官 / 仲裁</Tag></Space>}>
            <Form form={correctionForm} layout="vertical" initialValues={{ reason: '' }} onFinish={(values) => {
              dispatch(submitOp(makeCorrection(ledger, values.entryId, values.elapsedSeconds, values.reason || '现场更正', actor)));
              afterSubmit();
            }}>
              <Form.Item name="entryId" label="参赛船" rules={[{ required: true }]}><Select options={entryOptions} placeholder="选择参赛船" /></Form.Item>
              <Form.Item name="elapsedSeconds" label="更正后净用时（秒）" rules={[{ required: true }]}><InputNumber min={1} style={{ width: '100%' }} /></Form.Item>
              <Form.Item name="reason" label="更正说明" rules={[{ required: true, message: '请填写更正依据' }]}><Input.TextArea rows={2} /></Form.Item>
              <Button block type="primary" htmlType="submit">保存更正</Button>
            </Form>
          </Card>
        </Col>
        <Col xs={24} lg={8}>
          <Card title={<Space><SafetyCertificateOutlined />抗议处罚 <Tag color="red">仲裁</Tag></Space>}>
            <Form form={penaltyForm} layout="vertical" initialValues={{ rule: 'RRS 14', deltaSeconds: 20, protestId: `pr-${Math.random().toString(36).slice(2, 8)}` }} onFinish={(values) => {
              dispatch(submitOp(makePenalty(ledger, values.entryId, values.protestId.trim(), values.rule.trim(), values.reason || '抗议成立', values.deltaSeconds, actor)));
              penaltyForm.setFieldValue('protestId', `pr-${Math.random().toString(36).slice(2, 8)}`);
              afterSubmit();
            }}>
              <Form.Item name="entryId" label="被判罚船" rules={[{ required: true }]}><Select options={entryOptions} placeholder="选择参赛船" /></Form.Item>
              <Form.Item name="protestId" label="抗议编号（同编号重复/离线补传自动合并，不新增修订）" rules={[{ required: true }]}><Input /></Form.Item>
              <Space style={{ display: 'flex' }}>
                <Form.Item name="rule" label="规则" style={{ flex: 1 }}><Input /></Form.Item>
                <Form.Item name="deltaSeconds" label="加罚秒数" style={{ width: 130 }}><InputNumber min={1} style={{ width: '100%' }} /></Form.Item>
              </Space>
              <Form.Item name="reason" label="事由"><Input.TextArea rows={2} /></Form.Item>
              <Button block danger type="primary" htmlType="submit">记录处罚</Button>
            </Form>
          </Card>
        </Col>
      </Row>
    </Space>
  );
}

// ---------------- 复核与发布 ----------------

function ReviewPage() {
  const ledger = useSelector((state: RootState) => state.ledger);
  const mode = useSelector((state: RootState) => state.mode);
  const actor = useSelector((state: RootState) => state.currentActor);
  const dispatch = useDispatch<AppDispatch>();
  const storeInstance = useStore<RootState>();
  const { message } = AntApp.useApp();
  const pendingEntries = ledger.entries.filter((entry) => entry.pending);
  const isJury = ledger.officials[actor]?.role === 'jury';
  const isRo = ledger.officials[actor]?.role === 'ro';

  const doPublish = (groupId: string) => {
    dispatch(submitOp(makePublish(groupId, actor)));
    if (mode === 'offline') { message.warning('断网中：发布已记入队列，回网合并时仍会校验待复核门禁'); return; }
    const result = storeInstance.getState().lastBatch[0];
    if (result?.status === 'rejected') message.error(`发布被拒绝：${result.message ?? result.code}`);
    else if (result?.status === 'applied') message.success(`发布成功，回执 ${result.receiptId?.slice(0, 10)}`);
  };

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Card title={<Space><MergeCellsOutlined />净用时冲突复核（两版留档）</Space>}>
        {pendingEntries.length === 0 ? <Empty description="暂无待复核冲突" /> : (
          <List dataSource={pendingEntries} renderItem={(entry: ResultEntry) => {
            const conflict = entry.pending!;
            return (
              <List.Item>
                <List.Item.Meta
                  title={<Space><b>{entry.boat}（{entry.sailNo}）</b><Tag color="volcano">待仲裁复核</Tag><small>{fmtTime(conflict.createdAt)}</small></Space>}
                  description={
                    <Row gutter={16} style={{ marginTop: 8, width: '100%' }}>
                      {conflict.versions.map((version) => (
                        <Col xs={24} md={12} key={version.label}>
                          <Card size="small" title={<Space><Tag color={version.label === 'A' ? 'blue' : 'purple'}>{version.label} 版</Tag>{version.actorName}<small>{fmtTime(version.at)}</small></Space>}>
                            <Statistic value={formatSeconds(version.elapsedSeconds)} suffix="（净用时）" />
                            <div style={{ marginTop: 8 }}>{version.reason}</div>
                            <Button style={{ marginTop: 8 }} size="small" type="primary" disabled={!isJury}
                              onClick={() => {
                                dispatch(submitOp(makeResolve(entry.id, conflict.id, version.label, actor)));
                                if (mode === 'offline') message.warning('断网中：裁定已记入队列');
                                else message.success(`已采用 ${version.label} 版并生成新版本`);
                              }}>
                              {isJury ? `采用 ${version.label} 版` : '仅仲裁可裁定'}
                            </Button>
                          </Card>
                        </Col>
                      ))}
                    </Row>
                  }
                />
              </List.Item>
            );
          }} />
        )}
      </Card>

      <Card title={<Space><SendOutlined />组别发布门禁</Space>}>
        <Row gutter={[16, 16]}>
          {ledger.groups.map((group) => {
            const groupEntries = ledger.entries.filter((entry) => entry.groupId === group.id);
            const pending = groupEntries.filter((entry) => entry.pending);
            const stale = groupEntries.filter((entry) => entry.publishedRevId && entry.revisions[0]?.id !== entry.publishedRevId);
            const receipt = ledger.receipts.find((item) => item.groupId === group.id);
            const blocked = pending.length > 0;
            return (
              <Col xs={24} lg={12} key={group.id}>
                <Card size="small" title={<Space>{group.name}<Tag>{group.fleet}</Tag></Space>}
                  extra={isRo ? <Button type="primary" disabled={blocked} onClick={() => doPublish(group.id)}>{receipt ? '重新发布' : '发布正式成绩'}</Button> : <Tag>仅竞赛官可发布</Tag>}>
                  <Space direction="vertical" style={{ width: '100%' }}>
                    {blocked
                      ? <Alert type="error" showIcon message={`同组别存在 ${pending.length} 条待复核冲突（${pending.map((e) => e.boat).join('、')}），禁止发布`} />
                      : <Alert type="success" showIcon message="同组别无待复核，满足发布条件" />}
                    {stale.length > 0 && <Alert type="warning" showIcon message={`${stale.map((e) => e.boat).join('、')} 成绩改动后原发布版本已失效，发布后将产生新回执，旧版仍可查`} />}
                    {receipt ? (
                      <Descriptions size="small" column={1}>
                        <Descriptions.Item label="最近回执">{receipt.id.slice(0, 10)} · {receipt.checksum}</Descriptions.Item>
                        <Descriptions.Item label="发布人">{receipt.actorName} · {fmtTime(receipt.at)}</Descriptions.Item>
                        <Descriptions.Item label="名次">{receipt.lines.filter((l) => l.rank).map((l) => `${l.rank}.${l.boat} ${formatSeconds(l.net)}`).join('　')}</Descriptions.Item>
                      </Descriptions>
                    ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未发布" />}
                  </Space>
                </Card>
              </Col>
            );
          })}
        </Row>
      </Card>
    </Space>
  );
}

// ---------------- 离线队列 ----------------

function QueuePage() {
  const ledger = useSelector((state: RootState) => state.ledger);
  const queue = useSelector((state: RootState) => state.queue);
  const mode = useSelector((state: RootState) => state.mode);
  const lastBatch = useSelector((state: RootState) => state.lastBatch);
  const dispatch = useDispatch<AppDispatch>();
  const { message } = AntApp.useApp();

  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} lg={13}>
        <Card title={<Space><DisconnectOutlined />离线队列 / 回网合并</Space>}
          extra={
            <Space>
              <Button icon={<DisconnectOutlined />} type={mode === 'offline' ? 'primary' : 'default'} danger={mode === 'offline'} onClick={() => dispatch(setMode('offline'))}>模拟断网</Button>
              <Button icon={<CloudOutlined />} type={mode === 'online' ? 'primary' : 'default'} onClick={() => dispatch(setMode('online'))}>恢复在线</Button>
            </Space>
          }>
          <Space direction="vertical" style={{ width: '100%' }} size="middle">
            <Alert type={mode === 'offline' ? 'warning' : 'success'} showIcon
              message={mode === 'offline' ? '断网中：新写入只进队列，不直接落库' : '在线：新写入直接落库；队列仍可手动回网合并'} />
            <Space wrap>
              <Button type="primary" icon={<MergeCellsOutlined />} disabled={queue.length === 0}
                onClick={() => { dispatch(flushQueue()); message.success('回网合并完成：已落地/重复项出队，被拒绝项留在队列'); }}>
                回网合并队列（{queue.length}）
              </Button>
              <Button icon={<ClockCircleOutlined />} disabled={queue.length === 0}
                onClick={() => { dispatch(retryFailed()); message.info('已只重试未落地步骤，已落地的不重复执行'); }}>
                只重试没落地的步骤
              </Button>
            </Space>
            <Table rowKey={(item) => item.op.opId} size="small" pagination={false} dataSource={queue} columns={[
              { title: '步骤', render: (_v, item) => <Space direction="vertical" size={0}><Tag>{OP_LABEL[item.op.kind]}</Tag><span>{describeOp(item.op)}</span></Space> },
              { title: '操作人', render: (_v, item) => ledger.officials[item.op.actor]?.name ?? item.op.actor, width: 90 },
              { title: '入队时间', render: (_v, item) => fmtTime(item.queuedAt), width: 170 },
              { title: '上次结果', render: (_v, item) => item.lastResult ? (
                <Tag color={item.lastResult.status === 'rejected' ? 'red' : item.lastResult.status === 'duplicate' ? 'default' : 'green'}>
                  {item.lastResult.status === 'rejected' ? `被拒绝：${item.lastResult.message ?? item.lastResult.code}` : item.lastResult.status}
                </Tag>
              ) : <Tag color="orange">待合并</Tag> },
              { title: '', width: 80, render: (_v, item) => <Button size="small" danger type="link" onClick={() => dispatch(discardQueued(item.op.opId))}>丢弃</Button> }
            ]} />
          </Space>
        </Card>
        {lastBatch.length > 0 && (
          <Card size="small" style={{ marginTop: 16 }} title="最近一批合并结果">
            <List size="small" dataSource={lastBatch} renderItem={(result) => (
              <List.Item>
                <Tag color={result.status === 'applied' ? 'green' : result.status === 'duplicate' ? 'default' : 'red'}>{result.status}</Tag>
                <span style={{ flex: 1 }}>{result.opId.slice(0, 10)}{result.message ? ` · ${result.message}` : ''}</span>
                {result.revIds?.length ? <small>修订 {result.revIds.length} 条</small> : null}
                {result.receiptId ? <small>回执 {result.receiptId.slice(0, 10)}</small> : null}
              </List.Item>
            )} />
          </Card>
        )}
      </Col>
      <Col xs={24} lg={11}>
        <Card title="审计时间线（拒绝 / 合并 / 失效 / 发布）" style={{ maxHeight: 720, overflow: 'auto' }}>
          <Timeline items={ledger.audit.slice(0, 60).map((event) => ({
            color: event.level === 'error' ? 'red' : event.level === 'warn' ? 'orange' : event.level === 'success' ? 'green' : 'blue',
            children: <><Space size={4}><Tag>{event.code}</Tag><small>{fmtTime(event.at)}</small>{event.actor && <small>{ledger.officials[event.actor]?.name ?? event.actor}</small>}</Space><div>{event.message}</div></>
          }))} />
        </Card>
      </Col>
    </Row>
  );
}

// ---------------- 外壳 ----------------

function Shell() {
  const navigate = useNavigate();
  const location = useLocation();
  const dispatch = useDispatch<AppDispatch>();
  const mode = useSelector((state: RootState) => state.mode);
  const actor = useSelector((state: RootState) => state.currentActor);
  const queueLen = useSelector((state: RootState) => state.queue.length);
  const ledger = useSelector((state: RootState) => state.ledger);
  const pendingCount = ledger.entries.filter((entry) => entry.pending).length;

  return (
    <AntApp>
      <Layout className="shell">
        <Header className="header">
          <Space><SafetyCertificateOutlined style={{ fontSize: 22, color: '#7dd3fc' }} /><Typography.Title level={4} style={{ margin: 0, color: 'white' }}>帆船赛成绩离线对账台</Typography.Title></Space>
          <Space>
            <Select size="small" value={actor} style={{ width: 200 }} onChange={(value) => dispatch(setActor(value))}
              options={officialsList.map((item) => ({ value: item.id, label: `${item.name} · ${roleLabel[item.role]}` }))} />
            {mode === 'offline'
              ? <Tag color="orange" icon={<DisconnectOutlined />}>断网{queueLen > 0 ? ` · 队列 ${queueLen}` : ''}</Tag>
              : <Tag color="green" icon={<CloudOutlined />}>在线{queueLen > 0 ? ` · 待合并 ${queueLen}` : ''}</Tag>}
            {pendingCount > 0 && <Tag color="volcano">{pendingCount} 待复核</Tag>}
            <Button size="small" ghost onClick={() => { dispatch(resetDemo()); navigate('/'); }}>重置演示数据</Button>
          </Space>
        </Header>
        <Layout>
          <Sider width={200} breakpoint="lg" collapsedWidth="0" theme="light">
            <Menu mode="inline" selectedKeys={[location.pathname]} onClick={({ key }) => navigate(key)} items={[
              { key: '/', label: '对账记录', icon: <FileDoneOutlined /> },
              { key: '/ops', label: '到达 / 更正 / 处罚', icon: <ClockCircleOutlined /> },
              { key: '/review', label: '复核与发布', icon: <SafetyCertificateOutlined /> },
              { key: '/queue', label: `离线队列${queueLen > 0 ? `（${queueLen}）` : ''}`, icon: <MergeCellsOutlined /> }
            ]} />
          </Sider>
          <Content className="content">
            <Routes>
              <Route path="/" element={<ReconPage />} />
              <Route path="/ops" element={<OpsPage />} />
              <Route path="/review" element={<ReviewPage />} />
              <Route path="/queue" element={<QueuePage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Content>
        </Layout>
      </Layout>
    </AntApp>
  );
}

export default function App() {
  return (
    <Provider store={store}>
      <BrowserRouter>
        <Shell />
      </BrowserRouter>
    </Provider>
  );
}
