import { useMemo, useState } from 'react';
import {
  Alert, Badge, Button, Card, Col, Descriptions, Drawer, Empty, Grid, List, Row, Space, Statistic,
  Switch, Table, Tag, Timeline, Tooltip, Typography, message
} from 'antd';
import {
  CheckCircleOutlined, CloseCircleOutlined, CloudOutlined, CloudUploadOutlined,
  HistoryOutlined, ReloadOutlined, SafetyCertificateOutlined, SwapOutlined, WarningOutlined, WifiOutlined
} from '@ant-design/icons';
import { useDispatch, useSelector } from 'react-redux';
import {
  dismissItem, flushOutbox, importConflictEdits, importOfflineEdits, publishFleet, reimportLastEdit,
  resolveConflict, retryItem, setFailNext, type AppDispatch, type RootState
} from './store';
import type { QueueItem, QueueStep, RaceEntry, ResultVersion, Role } from './types';

const { Text } = Typography;

export const roleLabel = (role: Role | 'system') =>
  role === 'race-officer' ? '竞赛官' : role === 'arbitrator' ? '仲裁' : role === 'timer' ? '计时员' : '系统';

const roleColor = (role: Role | 'system') =>
  role === 'race-officer' ? 'blue' : role === 'arbitrator' ? 'purple' : role === 'timer' ? 'default' : 'default';

const versionStateTag = (state: ResultVersion['state']) =>
  state === 'official' ? <Tag color="green">正式</Tag>
    : state === 'superseded' ? <Tag color="default">已失效</Tag>
      : <Tag color="orange">草稿</Tag>;

const queueStatusTag = (status: QueueItem['status']) => {
  const map: Record<QueueItem['status'], { color: string; text: string }> = {
    queued: { color: 'default', text: '排队中' },
    failed: { color: 'red', text: '失败待重试' },
    review: { color: 'gold', text: '等复核' },
    done: { color: 'green', text: '已落地' },
    rejected: { color: 'red', text: '已拒绝' }
  };
  const s = map[status];
  return <Tag color={s.color}>{s.text}</Tag>;
};

const kindLabel = (kind: QueueItem['kind']) =>
  kind === 'result-edit' ? '成绩更正' : kind === 'penalty-edit' ? '处罚录入' : '发布';

function StepList({ steps }: { steps: QueueStep[] }) {
  return (
    <Space direction="vertical" size={2} style={{ width: '100%' }}>
      {steps.map((s) => (
        <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {s.landed ? <CheckCircleOutlined style={{ color: '#52c41a' }} /> : <CloseCircleOutlined style={{ color: s.error ? '#ff4d4f' : '#bfbfbf' }} />}
          <Text delete={s.landed} type={s.landed ? 'secondary' : undefined} style={{ fontSize: 13 }}>{s.name}</Text>
          {s.error && <Text type="danger" style={{ fontSize: 12 }}>{s.error}</Text>}
        </div>
      ))}
    </Space>
  );
}

export function OutboxDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dispatch = useDispatch<AppDispatch>();
  const online = useSelector((state: RootState) => state.regatta.online);
  const outbox = useSelector((state: RootState) => state.regatta.outbox);
  const pendingCount = outbox.filter((i) => i.status === 'queued' || i.status === 'failed').length;

  return (
    <Drawer
      title={<Space><CloudUploadOutlined />离线写入队列（只重试未落地步骤）</Space>}
      placement="right"
      width={460}
      open={open}
      onClose={onClose}
      extra={<Button type="primary" icon={<ReloadOutlined />} disabled={!online || pendingCount === 0} onClick={() => dispatch(flushOutbox())}>回网合并</Button>}
    >
      {!online && <Alert type="warning" showIcon icon={<CloudOutlined />} message="当前离线：新写入只记队列，回网后自动合并" style={{ marginBottom: 12 }} />}
      {outbox.length === 0 ? <Empty description="队列为空" /> : (
        <List dataSource={outbox} renderItem={(item) => (
          <List.Item key={item.id} style={{ flexDirection: 'column', alignItems: 'stretch', border: '1px solid #f0f0f0', borderRadius: 8, padding: 12, marginBottom: 12 }}>
            <Space style={{ justifyContent: 'space-between', width: '100%' }}>
              <Space>
                <Tag color="cyan">{kindLabel(item.kind)}</Tag>
                <Tag color={roleColor(item.source)}>{roleLabel(item.source)}</Tag>
                {queueStatusTag(item.status)}
              </Space>
              <Text type="secondary" style={{ fontSize: 12 }}>第 {item.attempts} 次</Text>
            </Space>
            <div style={{ marginTop: 8 }}><StepList steps={item.steps} /></div>
            {item.message && <Alert style={{ marginTop: 8 }} type="info" message={item.message} />}
            {item.status === 'failed' && (
              <Space style={{ marginTop: 8, justifyContent: 'space-between', width: '100%' }}>
                <Space><Switch size="small" checked={item.failNext} onChange={(v) => dispatch(setFailNext({ id: item.id, value: v }))} /> <Text type="secondary" style={{ fontSize: 12 }}>模拟下次写入失败</Text></Space>
                <Button size="small" type="primary" icon={<ReloadOutlined />} onClick={() => dispatch(retryItem(item.id))}>重试未落地步骤</Button>
              </Space>
            )}
            {item.status === 'rejected' && (
              <Space style={{ marginTop: 8, justifyContent: 'flex-end' }}>
                <Button size="small" onClick={() => dispatch(dismissItem({ id: item.id }))}>移除</Button>
              </Space>
            )}
          </List.Item>
        )} />
      )}
    </Drawer>
  );
}

function VersionHistory({ entry, open, onClose }: { entry: RaceEntry | null; open: boolean; onClose: () => void }) {
  return (
    <Drawer title={`版本历史 · ${entry?.boat ?? ''}`} placement="right" width={480} open={open} onClose={onClose}>
      {!entry ? null : (
        <Timeline
          items={[...entry.versions].reverse().map((v) => ({
            color: v.state === 'official' ? 'green' : v.state === 'superseded' ? 'gray' : 'blue',
            children: (
              <div>
                <Space>{versionStateTag(v.state)}<Text strong>v{v.version}</Text><Tag color={roleColor(v.source)}>{roleLabel(v.source)}</Tag></Space>
                <div style={{ marginTop: 4 }}>净用时 <Text strong>{v.elapsedSeconds}s</Text> · 处罚 {v.penaltySeconds}s · 总计 {v.elapsedSeconds + v.penaltySeconds}s</div>
                {v.note && <div><Text type="secondary">{v.note}</Text></div>}
                <div><Text type="secondary" style={{ fontSize: 12 }}>{new Date(v.createdAt).toLocaleString()}</Text></div>
              </div>
            )
          }))}
        />
      )}
    </Drawer>
  );
}

export default function ReconciliationPage() {
  const dispatch = useDispatch<AppDispatch>();
  const entries = useSelector((state: RootState) => state.regatta.entries);
  const reconciliations = useSelector((state: RootState) => state.regatta.reconciliations);
  const receipts = useSelector((state: RootState) => state.regatta.receipts);
  const protests = useSelector((state: RootState) => state.regatta.protests);
  const online = useSelector((state: RootState) => state.regatta.online);
  const role = useSelector((state: RootState) => state.regatta.currentRole);
  const [historyEntry, setHistoryEntry] = useState<RaceEntry | null>(null);
  const [outboxOpen, setOutboxOpen] = useState(false);
  const [api, contextHolder] = message.useMessage();
  const screens = Grid.useBreakpoint();

  const fleets = useMemo(() => Array.from(new Set(entries.map((e) => e.fleet))), [entries]);
  const recByEntry = useMemo(() => new Map(reconciliations.map((r) => [r.entryId, r])), [reconciliations]);

  const pendingByFleet = useMemo(() => {
    const map: Record<string, boolean> = {};
    for (const f of fleets) {
      const fleetEntries = entries.filter((e) => e.fleet === f);
      const entryIds = new Set(fleetEntries.map((e) => e.id));
      const conflict = fleetEntries.some((e) => !!e.pendingConflict);
      const protest = protests.some((p) => entryIds.has(p.entryId) && (p.status === 'reviewing' || p.status === 'submitted'));
      map[f] = conflict || protest;
    }
    return map;
  }, [entries, protests, fleets]);

  const receiptById = useMemo(() => new Map(receipts.map((r) => [r.id, r])), [receipts]);

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      {contextHolder}
      <Alert
        showIcon
        type={online ? 'success' : 'warning'}
        icon={online ? <WifiOutlined /> : <CloudOutlined />}
        message={online ? '网络在线' : '网络断开'}
        description={online
          ? '写入将实时走合并管道：字段级合并、冲突留两版、重复导入去重、越权写入拒绝。'
          : '离线期间所有写入只记入队列，回网后自动合并；失败只重试未落地步骤。当前角色：' + roleLabel(role)}
        action={<Button icon={<CloudUploadOutlined />} onClick={() => setOutboxOpen(true)}>离线队列</Button>}
      />

      <Card title="离线对账操作" size="small">
        <Space wrap>
          <Tooltip title="竞赛官离线改净用时、仲裁离线改处罚，回网后按字段合并到同一份成绩">
            <Button icon={<SwapOutlined />} onClick={() => { dispatch(importOfflineEdits()); api.success('已回传离线设备并按字段合并'); }}>从离线设备回传成绩</Button>
          </Tooltip>
          <Tooltip title="两版净用时改值不一致，留两版等复核，发布闸门拦截">
            <Button icon={<WarningOutlined />} onClick={() => { dispatch(importConflictEdits()); api.warning('两版净用时冲突，已留两版等复核'); }}>模拟两版净用时冲突</Button>
          </Tooltip>
          <Tooltip title="哈希命中已有版本，不新增修订">
            <Button icon={<HistoryOutlined />} onClick={() => { dispatch(reimportLastEdit()); api.info('重复导入已去重，未新增修订'); }}>重复导入同一份成绩</Button>
          </Tooltip>
          <Button icon={<ReloadOutlined />} disabled={!online} onClick={() => dispatch(flushOutbox())}>回网合并队列</Button>
        </Space>
      </Card>

      {fleets.map((fleet) => {
        const fleetEntries = entries.filter((e) => e.fleet === fleet);
        const blocked = pendingByFleet[fleet];
        return (
          <Card
            key={fleet}
            title={<Space><SafetyCertificateOutlined />组别 {fleet}{blocked && <Tag color="gold">待复核</Tag>}</Space>}
            extra={
              <Tooltip title={blocked ? '本组别有净用时冲突或抗议待复核，禁止发布' : '无待复核，可发布正式成绩并生成回执'}>
                <Button
                  type="primary"
                  icon={<CheckCircleOutlined />}
                  disabled={blocked}
                  onClick={() => { dispatch(publishFleet(fleet)); blocked ? api.error('存在待复核，发布被拒绝') : api.success('已提交发布，回执生成中'); }}
                >
                  发布本组正式成绩
                </Button>
              </Tooltip>
            }
          >
            <List
              dataSource={fleetEntries}
              renderItem={(entry) => {
                const rec = recByEntry.get(entry.id);
                const receipt = rec?.receiptId ? receiptById.get(rec.receiptId) : undefined;
                return (
                  <List.Item key={entry.id} style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                    <Space style={{ justifyContent: 'space-between', width: '100%' }} wrap>
                      <Space>
                        <Text strong>{entry.boat}</Text>
                        <Tag>{entry.sailNo}</Tag>
                        <Tag color={entry.resultStatus === 'official' ? 'green' : entry.resultStatus === 'corrected' ? 'orange' : 'default'}>{entry.resultStatus}</Tag>
                        {entry.pendingConflict && <Badge status="warning" text="净用时冲突待复核" />}
                      </Space>
                      <Button size="small" icon={<HistoryOutlined />} onClick={() => setHistoryEntry(entry)}>版本历史</Button>
                    </Space>

                    <Descriptions size="small" column={screens.xs ? 1 : 4} style={{ marginTop: 8 }}>
                      <Descriptions.Item label="净用时">{entry.elapsedSeconds}s</Descriptions.Item>
                      <Descriptions.Item label="处罚">{entry.penaltySeconds}s</Descriptions.Item>
                      <Descriptions.Item label="总计"><Text strong>{entry.elapsedSeconds + entry.penaltySeconds}s</Text></Descriptions.Item>
                      <Descriptions.Item label="当前版本">v{entry.currentVersion} {versionStateTag(entry.versions.find((v) => v.version === entry.currentVersion)?.state ?? 'draft')}</Descriptions.Item>
                      <Descriptions.Item label="关联抗议">
                        {rec?.protestIds.length ? rec.protestIds.map((pid) => {
                          const p = protests.find((x) => x.id === pid);
                          return p ? <Tag key={pid} color="orange">{p.rule} · {p.status}{p.penaltySeconds ? ` +${p.penaltySeconds}s` : ''}</Tag> : null;
                        }) : '—'}
                      </Descriptions.Item>
                      <Descriptions.Item label="发布回执">{receipt ? <Tag color="green">{receipt.id} · {new Date(receipt.publishedAt).toLocaleString()}</Tag> : '未发布'}</Descriptions.Item>
                      <Descriptions.Item label="最近修订">{new Date(entry.versions[entry.versions.length - 1]?.createdAt ?? '').toLocaleString()}</Descriptions.Item>
                    </Descriptions>

                    {entry.pendingConflict && (
                      <Alert
                        style={{ marginTop: 12 }}
                        type="warning"
                        showIcon
                        message="净用时两版冲突，已留两版等复核（发布闸门拦截）"
                        description={
                          <Space wrap style={{ marginTop: 8 }}>
                            {entry.pendingConflict.candidates.map((c) => (
                              <Card key={c.version} size="small" style={{ minWidth: 180 }} title={<Space>v{c.version}<Tag color={roleColor(c.source)}>{roleLabel(c.source)}</Tag></Space>}>
                                <Statistic value={c.value} suffix="s" />
                                <Button size="small" type="primary" style={{ marginTop: 8 }} onClick={() => { dispatch(resolveConflict({ entryId: entry.id, version: c.version })); api.success(`已采用 v${c.version}`); }}>采用此版</Button>
                              </Card>
                            ))}
                          </Space>
                        }
                      />
                    )}
                  </List.Item>
                );
              }}
            />
          </Card>
        );
      })}

      <Card title="发布回执存根" size="small">
        {receipts.length === 0 ? <Empty description="尚未发布" /> : (
          <List dataSource={receipts} renderItem={(r) => (
            <List.Item>
              <List.Item.Meta
                title={<Space><Tag color="green">{r.id}</Tag><Text>组别 {r.fleet}</Text><Tag color={roleColor(r.publishedBy)}>{roleLabel(r.publishedBy)}发布</Tag></Space>}
                description={`发布于 ${new Date(r.publishedAt).toLocaleString()}，含 ${r.entries.length} 艘船的版本：${r.entries.map((e) => `v${e.version}`).join(' / ')}`}
              />
            </List.Item>
          )} />
        )}
      </Card>

      <VersionHistory entry={historyEntry} open={!!historyEntry} onClose={() => setHistoryEntry(null)} />
      <OutboxDrawer open={outboxOpen} onClose={() => setOutboxOpen(false)} />
    </Space>
  );
}
