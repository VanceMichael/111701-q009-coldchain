import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { normalizePage } from '../src/adapter.mjs';
import { collect, reassess } from '../src/pipeline.mjs';
import { assessReading } from '../src/readiness.mjs';
import { RecordStore } from '../src/store.mjs';

const NOW = '2026-11-17T08:40:00.000Z';

function item(overrides = {}) {
  return {
    id: 'warehouse-A',
    label: '冷链仓温度读数甲',
    state: 'active',
    revision: 1,
    temperatureC: 3.8,
    doorState: 'closed',
    ...overrides,
  };
}

test('采集链保留来源、记录身份和观察时间', async () => {
  const store = new RecordStore();
  const result = await collect({
    source: async () => ({
      source: 'local',
      observedAt: '2026-11-17T08:00:00.000Z',
      items: [{ id: 'a', label: '样例记录', state: 'active', revision: 1 }],
    }),
    store,
  });
  assert.equal(result.records[0].source, 'local');
  assert.equal(result.records[0].id, 'a');
  assert.equal(result.records[0].observedAt, '2026-11-17T08:00:00.000Z');
  assert.equal(store.list().length, 1);
});

test('重复身份按较新的修订号更新', () => {
  const store = new RecordStore();
  store.save({ source: 'local', id: 'a', name: '旧值', state: 'active', revision: 1 });
  store.save({ source: 'local', id: 'a', name: '新值', state: 'active', revision: 2 });
  assert.equal(store.list()[0].name, '新值');
});

test('不完整来源记录被拒绝', () => {
  assert.throws(() => normalizePage({ source: 'local', items: [{ id: 'a' }] }));
});

test('规整记录时保留温度与门状态', () => {
  const [record] = normalizePage({ source: 'local', observedAt: NOW, items: [item()] });
  assert.equal(record.temperatureC, 3.8);
  assert.equal(record.doorState, 'closed');
  assert.equal(record.observedAt, NOW);
});

test('读数新鲜且仓门关闭时放行', () => {
  const decision = assessReading(
    { source: 'local', id: 'a', revision: 1, observedAt: NOW, temperatureC: 3.8, doorState: 'closed' },
    { now: NOW },
  );
  assert.equal(decision.status, 'ready');
  assert.deepEqual(decision.reasons, []);
  assert.equal(decision.evidence.reading.withinMaxAge, true);
  assert.equal(decision.evidence.door.state, 'closed');
});

test('温度看似正常但读数落后四十分钟时暂缓，并给出时效证据', () => {
  const decision = assessReading(
    {
      source: 'local',
      id: 'a',
      revision: 1,
      observedAt: '2026-11-17T08:00:00.000Z',
      temperatureC: 3.8,
      doorState: 'closed',
    },
    { now: NOW },
  );
  assert.equal(decision.status, 'held');
  assert.equal(decision.code, 'reading_stale');
  assert.equal(decision.evidence.reading.ageMs, 40 * 60 * 1000);
  assert.equal(decision.evidence.reading.withinMaxAge, false);
  assert.equal(decision.temperatureC, 3.8, '温度本身仍然被保留，便于现场核查');
});

test('陈旧读数叠加仓门打开时同时记录两个原因', () => {
  const decision = assessReading(
    {
      source: 'local',
      id: 'a',
      revision: 1,
      observedAt: '2026-11-17T08:00:00.000Z',
      temperatureC: 3.8,
      doorState: 'open',
    },
    { now: NOW },
  );
  assert.equal(decision.status, 'held');
  assert.deepEqual(
    decision.reasons.map((reason) => reason.code),
    ['reading_stale', 'door_open'],
  );
  assert.equal(decision.evidence.door.state, 'open');
});

test('仅仓门未确认时也暂缓，而不是误判为安全', () => {
  for (const doorState of [null, 'unknown', 'fault', 'ajar']) {
    const decision = assessReading(
      { source: 'local', id: 'a', revision: 1, observedAt: NOW, temperatureC: 3.8, doorState },
      { now: NOW },
    );
    assert.equal(decision.status, 'held', `doorState=${doorState}`);
    assert.equal(decision.evidence.door.state, 'unknown');
  }
});

test('无法解析或位于未来的时间戳记为 error 而非暂缓', () => {
  const invalid = assessReading(
    { source: 'local', id: 'a', revision: 1, observedAt: 'not-a-date', temperatureC: 3.8, doorState: 'closed' },
    { now: NOW },
  );
  assert.equal(invalid.status, 'error');
  assert.equal(invalid.code, 'timestamp_invalid');
  assert.equal(invalid.evidence.reading.ageMs, null);

  const future = assessReading(
    { source: 'local', id: 'a', revision: 1, observedAt: '2026-11-17T09:00:00.000Z', temperatureC: 3.8, doorState: 'closed' },
    { now: NOW },
  );
  assert.equal(future.status, 'error');
  assert.equal(future.code, 'timestamp_in_future');
});

test('缺少温度读数时暂缓', () => {
  const decision = assessReading(
    { source: 'local', id: 'a', revision: 1, observedAt: NOW, temperatureC: null, doorState: 'closed' },
    { now: NOW },
  );
  assert.equal(decision.status, 'held');
  assert.equal(decision.code, 'temperature_missing');
});

test('空响应当次采集为空，但保留既有批次判定而不是永久卡住', async () => {
  const store = new RecordStore();
  await collect({
    source: async () => ({
      source: 'local',
      observedAt: '2026-11-17T08:00:00.000Z',
      items: [item()],
    }),
    store,
    now: '2026-11-17T08:05:00.000Z',
  });
  assert.equal(store.list().length, 1);

  const result = await collect({
    source: async () => ({ source: 'local', observedAt: NOW, items: [] }),
    store,
    now: NOW,
  });
  assert.equal(result.status, 'empty');
  assert.equal(result.records.length, 0);
  assert.equal(result.summary.total, 1);
  assert.equal(result.decisions[0].id, 'warehouse-A');
  assert.equal(store.list().length, 1, '既有记录不因一次空响应被删除');
});

test('空响应后数据恢复时可明确哪些批次可以继续处理', async () => {
  const store = new RecordStore();
  await collect({
    source: async () => ({ source: 'local', observedAt: '2026-11-17T08:00:00.000Z', items: [item()] }),
    store,
    now: '2026-11-17T08:05:00.000Z',
  });
  await collect({
    source: async () => ({ source: 'local', observedAt: NOW, items: [] }),
    store,
    now: NOW,
  });

  const recovered = await collect({
    source: async () => ({
      source: 'local',
      observedAt: '2026-11-17T08:41:00.000Z',
      items: [
        item({ revision: 2, observedAt: '2026-11-17T08:41:00.000Z', doorState: 'closed', temperatureC: 3.9 }),
        item({
          id: 'warehouse-B',
          label: '冷链仓温度读数乙',
          revision: 1,
          temperatureC: 4.2,
          doorState: 'open',
          observedAt: '2026-11-17T08:41:00.000Z',
        }),
      ],
    }),
    store,
    now: '2026-11-17T08:41:00.000Z',
  });

  const byId = Object.fromEntries(recovered.decisions.map((decision) => [decision.id, decision]));
  assert.equal(byId['warehouse-A'].status, 'ready');
  assert.equal(byId['warehouse-B'].status, 'held');
  assert.equal(byId['warehouse-B'].code, 'door_open');
  assert.deepEqual(recovered.summary, { total: 2, ready: 1, held: 1, error: 0 });
});

test('持久化后重新加载存储可继续判定', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cold-chain-'));
  const path = join(dir, 'store.json');
  try {
    const store = new RecordStore({ path });
    await collect({
      source: async () => ({
        source: 'local',
        observedAt: NOW,
        items: [item({ observedAt: NOW }), item({ id: 'warehouse-B', observedAt: NOW, doorState: 'open' })],
      }),
      store,
      now: NOW,
      persist: true,
    });

    const reloaded = await RecordStore.load({ path });
    assert.equal(reloaded.list().length, 2);

    const { decisions, summary } = reassess(reloaded, { now: NOW });
    assert.deepEqual(summary, { total: 2, ready: 1, held: 1, error: 0 });
    assert.equal(decisions.find((decision) => decision.id === 'warehouse-B').code, 'door_open');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('存储加载不存在的文件时返回空存储', async () => {
  const store = await RecordStore.load({ path: join(tmpdir(), 'cold-chain-missing', 'none.json') });
  assert.equal(store.list().length, 0);
});
