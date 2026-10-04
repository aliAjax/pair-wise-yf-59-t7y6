import { useEffect, useMemo, useState } from 'react';
import { Alert, App as AntApp, Badge, Button, Card, Col, Descriptions, Empty, Form, Input, Layout, List, Menu, Row, Select, Space, Statistic, Table, Tag, Timeline, Typography, message } from 'antd';
const { Text } = Typography;
import { ClockCircleOutlined, CloudOutlined, CloudUploadOutlined, FlagOutlined, PlusOutlined, SafetyCertificateOutlined, SwapOutlined, WifiOutlined } from '@ant-design/icons';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { useDispatch, useSelector } from 'react-redux';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { z } from 'zod';
import {
  addProtest, flushOutbox, publishFleet, setOnline, setRaceStatus, setRole, submitPenaltyEdit, submitResultEdit,
  transitionProtest, type AppDispatch, type RootState
} from './store';
import { useGetOfficialsQuery } from './api';
import type { RaceEntry, Role } from './types';
import ReconciliationPage, { OutboxDrawer, roleLabel } from './ReconciliationPage';

const { Header, Content, Sider } = Layout;

const resultSchema = z.object({
  id: z.string().min(1),
  elapsedSeconds: z.number().positive(),
  penaltySeconds: z.number().min(0),
  note: z.string().max(120)
});
const protestSchema = z.object({
  entryId: z.string().min(1),
  reason: z.string().min(4),
  rule: z.string().min(2)
});

function countdown(target: string, now: number) {
  const seconds = Math.max(0, Math.floor((new Date(target).getTime() - now) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function ControlPage() {
  const { t } = useTranslation();
  const dispatch = useDispatch<AppDispatch>();
  const race = useSelector((state: RootState) => state.regatta.races[0]);
  const entries = useSelector((state: RootState) => state.regatta.entries);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  const sorted = useMemo(() => [...entries].sort((a, b) => a.elapsedSeconds + a.penaltySeconds - b.elapsedSeconds - b.penaltySeconds), [entries]);

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Row gutter={[18, 18]}>
        <Col xs={24} lg={10}>
          <Card className="hero-card">
            <Badge status={race.status === 'running' ? 'processing' : 'success'} text={`比赛状态：${race.status}`} />
            <Statistic title="距离起航" value={countdown(race.startsAt, now)} prefix={<ClockCircleOutlined />} />
            <Descriptions column={1} style={{ marginTop: 18 }}>
              <Descriptions.Item label="组别">{race.fleet}</Descriptions.Item>
              <Descriptions.Item label="航线">{race.course}</Descriptions.Item>
            </Descriptions>
            <Space wrap>
              <Button type="primary" icon={<FlagOutlined />} onClick={() => dispatch(setRaceStatus({ id: race.id, status: 'running' }))}>开始比赛</Button>
              <Button onClick={() => dispatch(setRaceStatus({ id: race.id, status: 'finished' }))}>结束比赛</Button>
              <Button onClick={() => dispatch(setRaceStatus({ id: race.id, status: 'scheduled' }))}>重置排队</Button>
            </Space>
          </Card>
        </Col>
        <Col xs={24} lg={14}>
          <Card title={t('control')} extra={<Tag color="blue">{sorted.length} 艘参赛船</Tag>}>
            <Table rowKey="id" pagination={false} dataSource={sorted} columns={[
              { title: '排名', render: (_v, _r, index) => index + 1, width: 64 },
              { title: '船名', dataIndex: 'boat' },
              { title: '帆号', dataIndex: 'sailNo' },
              { title: '船长', dataIndex: 'skipper' },
              { title: '当前净用时', render: (_v, r: RaceEntry) => `${r.elapsedSeconds + r.penaltySeconds}s` },
              { title: '状态', render: (_v, r: RaceEntry) => <Tag color={r.resultStatus === 'official' ? 'green' : r.resultStatus === 'corrected' ? 'orange' : 'default'}>{r.resultStatus}</Tag> }
            ]} />
          </Card>
        </Col>
      </Row>
    </Space>
  );
}

function ResultsPage() {
  const dispatch = useDispatch<AppDispatch>();
  const entries = useSelector((state: RootState) => state.regatta.entries);
  const role = useSelector((state: RootState) => state.regatta.currentRole);
  const online = useSelector((state: RootState) => state.regatta.online);
  const [api, contextHolder] = message.useMessage();
  const { register, handleSubmit, reset, formState: { errors } } = useForm<z.infer<typeof resultSchema>>({
    resolver: zodResolver(resultSchema),
    defaultValues: { id: entries[0]?.id, elapsedSeconds: 3200, penaltySeconds: 0, note: '' }
  });
  const submit = (values: z.infer<typeof resultSchema>) => {
    dispatch(submitResultEdit({ entryId: values.id, elapsedSeconds: values.elapsedSeconds, note: values.note }));
    if (role !== 'race-officer' && role !== 'timer') api.error(`越权写入成绩被拒绝：当前角色为${roleLabel(role)}，仅竞赛官/计时员可写入净用时`);
    else if (!online) api.warning('当前离线：成绩更正已记入队列，回网后合并');
    else api.success('成绩已提交，进入合并管道（字段级合并 + 版本管理）');
    reset();
  };
  const fleets = useMemo(() => Array.from(new Set(entries.map((e) => e.fleet))), [entries]);
  return (
    <>
      {contextHolder}
      {(role !== 'race-officer' && role !== 'timer') && (
        <Alert type="error" showIcon style={{ marginBottom: 16 }} message={`当前角色为${roleLabel(role)}，无权写入净用时成绩；提交将被拒绝并记录`} />
      )}
      <Row gutter={[18, 18]}>
        <Col xs={24} lg={10}>
          <Card title="成绩更正（净用时）">
            <Form layout="vertical" onFinish={handleSubmit(submit)}>
              <Form.Item label="参赛船" validateStatus={errors.id ? 'error' : undefined} help={errors.id?.message}>
                <select {...register('id')} className="native-select">{entries.map((entry) => <option key={entry.id} value={entry.id}>{entry.boat} / {entry.sailNo}</option>)}</select>
              </Form.Item>
              <Form.Item label="净用时（秒）"><Input type="number" {...register('elapsedSeconds', { valueAsNumber: true })} /></Form.Item>
              <Form.Item label="处罚秒数">
                <Input type="number" value={0} disabled />
                <Text type="secondary" style={{ fontSize: 12 }}>处罚由仲裁在抗议处理中录入，竞赛官越权写入会被拒绝</Text>
              </Form.Item>
              <Form.Item label="更正原因"><Input.TextArea rows={3} {...register('note')} /></Form.Item>
              <Button htmlType="submit" type="primary">保存更正（{online ? '在线合并' : '记入离线队列'}）</Button>
            </Form>
          </Card>
        </Col>
        <Col xs={24} lg={14}>
          <Card title="临时与正式成绩">
            <List
              header={
                <Space wrap>
                  {fleets.map((f) => (
                    <Button key={f} size="small" type="primary" ghost onClick={() => dispatch(publishFleet(f))}>发布组别 {f} 正式成绩</Button>
                  ))}
                </Space>
              }
              dataSource={entries}
              renderItem={(entry) => (
                <List.Item>
                  <List.Item.Meta title={`${entry.boat} · ${entry.elapsedSeconds + entry.penaltySeconds} 秒（净${entry.elapsedSeconds} + 罚${entry.penaltySeconds}）`} description={entry.note || '无更正说明'} />
                  <Space>
                    {entry.pendingConflict && <Tag color="gold">冲突待复核</Tag>}
                    <Tag color={entry.resultStatus === 'official' ? 'green' : entry.resultStatus === 'corrected' ? 'orange' : 'default'}>{entry.resultStatus}</Tag>
                  </Space>
                </List.Item>
              )}
            />
          </Card>
        </Col>
      </Row>
    </>
  );
}

function ProtestsPage() {
  const dispatch = useDispatch<AppDispatch>();
  const protests = useSelector((state: RootState) => state.regatta.protests);
  const timeline = useSelector((state: RootState) => state.regatta.timeline);
  const entries = useSelector((state: RootState) => state.regatta.entries);
  const role = useSelector((state: RootState) => state.regatta.currentRole);
  const [api, contextHolder] = message.useMessage();
  const { register, handleSubmit, reset, formState: { errors } } = useForm<z.infer<typeof protestSchema>>({ resolver: zodResolver(protestSchema), defaultValues: { entryId: entries[0]?.id, reason: '', rule: 'RRS 14' } });
  const submit = (values: z.infer<typeof protestSchema>) => {
    dispatch(addProtest({ raceId: 'race-1', ...values }));
    reset({ entryId: entries[0]?.id, reason: '', rule: 'RRS 14' });
  };
  const resolveWithPenalty = (item: { id: string; entryId: string }) => {
    dispatch(transitionProtest({ id: item.id, status: 'resolved', decision: '接受抗议并处以30秒处罚' }));
    dispatch(submitPenaltyEdit({ entryId: item.entryId, penaltySeconds: 30, protestId: item.id }));
    if (role !== 'arbitrator') api.error(`越权写入处罚被拒绝：当前角色为${roleLabel(role)}，仅仲裁可录入处罚`);
    else api.success('处罚已提交，进入合并管道并关联对账记录');
  };
  return (
    <Row gutter={[18, 18]}>
      {contextHolder}
      <Col xs={24} lg={9}>
        <Card title="提交抗议">
          <Form layout="vertical" onFinish={handleSubmit(submit)}>
            <Form.Item label="参赛船" validateStatus={errors.entryId ? 'error' : undefined}>
              <select className="native-select" {...register('entryId')}>{entries.map((entry) => <option key={entry.id} value={entry.id}>{entry.boat}</option>)}</select>
            </Form.Item>
            <Form.Item label="适用规则" validateStatus={errors.rule ? 'error' : undefined} help={errors.rule?.message}><Input {...register('rule')} /></Form.Item>
            <Form.Item label="事件描述" validateStatus={errors.reason ? 'error' : undefined} help={errors.reason?.message}><Input.TextArea rows={4} {...register('reason')} /></Form.Item>
            <Button type="primary" htmlType="submit" icon={<PlusOutlined />}>登记抗议</Button>
          </Form>
        </Card>
      </Col>
      <Col xs={24} lg={9}>
        <Card title="冲突复核队列">
          {protests.length === 0 ? <Empty /> : <List dataSource={protests} renderItem={(item) => (
            <List.Item>
              <List.Item.Meta
                title={<Space><Tag color={item.status === 'reviewing' ? 'processing' : 'default'}>{item.status}</Tag>{item.rule}</Space>}
                description={<><div>{item.reason}</div><small>{entries.find((entry) => entry.id === item.entryId)?.boat}</small></>}
              />
              <Space direction="vertical">
                <Button size="small" onClick={() => dispatch(transitionProtest({ id: item.id, status: 'reviewing' }))}>进入复核</Button>
                <Button size="small" type="primary" onClick={() => resolveWithPenalty(item)}>接受并处罚</Button>
                <Button size="small" danger onClick={() => dispatch(transitionProtest({ id: item.id, status: 'rejected', decision: '证据不足，维持原成绩' }))}>驳回</Button>
              </Space>
            </List.Item>
          )} />}
        </Card>
      </Col>
      <Col xs={24} lg={6}>
        <Card title="事件时间线"><Timeline items={timeline.map((event) => ({ color: event.type === 'protest' ? 'orange' : 'blue', children: <><b>{event.type}</b><div>{event.message}</div><small>{new Date(event.time).toLocaleTimeString()}</small></> }))} /></Card>
      </Col>
    </Row>
  );
}

function Shell() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const dispatch = useDispatch<AppDispatch>();
  const { data = [] } = useGetOfficialsQuery();
  const role = useSelector((state: RootState) => state.regatta.currentRole);
  const online = useSelector((state: RootState) => state.regatta.online);
  const pendingCount = useSelector((state: RootState) => state.regatta.outbox.filter((i) => i.status === 'queued' || i.status === 'failed').length);
  const [outboxOpen, setOutboxOpen] = useState(false);
  return (
    <AntApp>
      <Layout className="shell">
      <Header className="header">
        <Space><SafetyCertificateOutlined style={{ fontSize: 24 }} /><Typography.Title level={4} style={{ margin: 0, color: 'white' }}>{t('title')}</Typography.Title></Space>
        <Space wrap>
          <Select
            size="small"
            value={role}
            style={{ width: 120 }}
            onChange={(v: Role) => dispatch(setRole(v))}
            options={[
              { value: 'race-officer', label: '竞赛官' },
              { value: 'arbitrator', label: '仲裁' },
              { value: 'timer', label: '计时员' }
            ]}
          />
          <Tag icon={online ? <WifiOutlined /> : <CloudOutlined />} color={online ? 'success' : 'default'} style={{ marginInlineEnd: 0 }}>
            {online ? '在线' : '离线'}
          </Tag>
          <Button
            size="small"
            ghost={!online}
            type={online ? 'default' : 'primary'}
            onClick={() => {
              if (online) dispatch(setOnline('offline'));
              else { dispatch(setOnline('online')); dispatch(flushOutbox()); }
            }}
          >
            {online ? '模拟断网' : '回网合并'}
          </Button>
          <Badge count={pendingCount} size="small">
            <Button size="small" icon={<CloudUploadOutlined />} onClick={() => setOutboxOpen(true)}>离线队列</Button>
          </Badge>
          <Tag>{data.length} 名值班人员</Tag>
          <Button ghost onClick={() => void i18n.changeLanguage(i18n.language.startsWith('zh') ? 'en' : 'zh')}>{t('language')}</Button>
        </Space>
      </Header>
      <Layout>
        <Sider width={210} breakpoint="lg" collapsedWidth="0" theme="light">
          <Menu mode="inline" selectedKeys={[location.pathname]} onClick={({ key }) => navigate(key)} items={[
            { key: '/', label: t('control'), icon: <FlagOutlined /> },
            { key: '/results', label: t('results'), icon: <ClockCircleOutlined /> },
            { key: '/protests', label: t('protests'), icon: <SafetyCertificateOutlined /> },
            { key: '/reconciliation', label: '对账中心', icon: <SwapOutlined /> }
          ]} />
        </Sider>
        <Content className="content"><Routes>
          <Route path="/" element={<ControlPage />} />
          <Route path="/results" element={<ResultsPage />} />
          <Route path="/protests" element={<ProtestsPage />} />
          <Route path="/reconciliation" element={<ReconciliationPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes></Content>
      </Layout>
      </Layout>
      <OutboxDrawer open={outboxOpen} onClose={() => setOutboxOpen(false)} />
    </AntApp>
  );
}

export default function App() { return <BrowserRouter><Shell /></BrowserRouter>; }
