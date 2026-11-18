import { normalizePage } from './adapter.mjs';
import { assessReading } from './readiness.mjs';
import { readSource } from './source.mjs';
import { RecordStore } from './store.mjs';

function summarizeDecisions(decisions) {
  const summary = { total: decisions.length, ready: 0, held: 0, error: 0 };
  for (const decision of decisions) {
    summary[decision.status] += 1;
  }
  return summary;
}

/**
 * 对存储中已有记录重新判定。
 *
 * 采集页可能暂时为空或部分记录缺失；这不应改变既有记录的状态。
 * 数据恢复后调用本函数，即可明确哪些批次可以继续处理。
 */
export function reassess(store, options = {}) {
  const decisions = store.list().map((record) => assessReading(record, options));
  return { decisions, summary: summarizeDecisions(decisions) };
}

export async function collect({
  source = readSource,
  store = new RecordStore(),
  now = new Date(),
  maxAgeMs,
  clockSkewMs,
  persist = false,
} = {}) {
  const page = await source();
  const observedAt = page.observedAt ?? null;
  const items = Array.isArray(page.items) ? page.items : [];

  // 空页只是本次采集没有可判定数据，不代表仓库永久不安全。
  const collection = {
    source: page.source,
    observedAt,
    itemCount: items.length,
    status: items.length === 0 ? 'empty' : 'ok',
  };

  if (items.length === 0) {
    const { decisions, summary } = reassess(store, { now, maxAgeMs, clockSkewMs });
    if (persist) {
      await store.persist();
    }
    return {
      ...collection,
      message: '本次采集没有返回记录，保留既有判定；待来源恢复后可继续处理',
      records: [],
      decisions,
      summary,
      store,
    };
  }

  const records = normalizePage({ ...page, items }).map((record) => store.save(record));
  const decisions = records.map((record) =>
    assessReading(record, { now, maxAgeMs, clockSkewMs }),
  );

  if (persist) {
    await store.persist();
  }

  return {
    ...collection,
    records,
    decisions,
    summary: summarizeDecisions(decisions),
    store,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await collect();
  console.log(
    JSON.stringify(
      {
        source: result.source,
        status: result.status,
        count: result.records.length,
        summary: result.summary,
        decisions: result.decisions,
      },
      null,
      2,
    ),
  );
}
