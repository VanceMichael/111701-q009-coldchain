// 装货放行判定：把“读数时效”和“门状态”作为两个独立条件。
// 任一条无法确认时都不放行，但只有数据本身损坏才记为 error；
// 陈旧读数、仓门未确认等可恢复情况记为 held。

export const DEFAULT_MAX_READING_AGE_MS = 10 * 60 * 1000;
export const DEFAULT_CLOCK_SKEW_MS = 60 * 1000;

const DECIDED_READY = 'ready';
const DECIDED_HELD = 'held';
const DECIDED_ERROR = 'error';

// 只有数据本身无法解释时才记为 error；缺少读数属于现场可恢复的未确认状态。
const ERROR_CODES = new Set([
  'timestamp_invalid',
  'timestamp_in_future',
  'temperature_invalid',
]);

const CLOSED = new Set(['closed', 'close', 'shut']);
const OPEN = new Set(['open', 'opened', 'opening']);
const DOOR_FAULT = new Set(['error', 'fault', 'unavailable', 'unknown']);

function toNowMs(now) {
  const ms = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(ms)) {
    throw new TypeError('now 必须是有效的日期或时间戳');
  }
  return ms;
}

function parseObservedAt(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function inspectDoor(value) {
  if (value === null || value === undefined || String(value).trim() === '') {
    return {
      state: 'unknown',
      reported: value ?? null,
      code: 'door_state_unknown',
      message: '门状态缺失，无法确认仓门已关闭',
    };
  }
  const raw = String(value).trim().toLowerCase();
  if (CLOSED.has(raw)) {
    return { state: 'closed', reported: value, code: null, message: null };
  }
  if (OPEN.has(raw)) {
    return {
      state: 'open',
      reported: value,
      code: 'door_open',
      message: '仓门处于打开状态，装货环境未封闭',
    };
  }
  if (DOOR_FAULT.has(raw)) {
    return {
      state: 'unknown',
      reported: value,
      code: 'door_state_error',
      message: '门状态传感器报错，无法确认仓门状态',
    };
  }
  return {
    state: 'unknown',
    reported: value,
    code: 'door_state_unknown',
    message: `门状态取值无法识别：${String(value)}`,
  };
}

function inspectTemperature(value) {
  if (value === null || value === undefined) {
    return { code: 'temperature_missing', message: '缺少温度读数，无法确认货物环境' };
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { code: 'temperature_invalid', message: `温度读数无效：${String(value)}` };
  }
  return { code: null, message: null };
}

function summarize(reasons) {
  if (reasons.length === 0) return DECIDED_READY;
  if (reasons.some((reason) => ERROR_CODES.has(reason.code))) return DECIDED_ERROR;
  return DECIDED_HELD;
}

/**
 * 对一条已规整记录做装货判定。
 *
 * @param {object} record 规整后的记录（含 temperatureC、doorState、observedAt）
 * @param {object} [options]
 * @param {Date|string|number} [options.now] 判定时刻
 * @param {number} [options.maxAgeMs] 读数允许的最大时效
 * @param {number} [options.clockSkewMs] 允许的未来时间偏差
 */
export function assessReading(record, options = {}) {
  const nowMs = toNowMs(options.now ?? new Date());
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_READING_AGE_MS;
  const clockSkewMs = options.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS;

  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
    throw new TypeError('maxAgeMs 必须是非负数');
  }
  if (!Number.isFinite(clockSkewMs) || clockSkewMs < 0) {
    throw new TypeError('clockSkewMs 必须是非负数');
  }

  const reasons = [];
  const observedMs = parseObservedAt(record.observedAt);
  const ageMs = observedMs === null ? null : nowMs - observedMs;

  const readingEvidence = {
    observedAt: record.observedAt ?? null,
    ageMs,
    maxAgeMs,
    withinMaxAge: ageMs === null ? null : ageMs <= maxAgeMs,
  };

  if (observedMs === null) {
    reasons.push({
      code: 'timestamp_invalid',
      message:
        record.observedAt === null || record.observedAt === undefined
          ? '缺少读数时间戳，无法判断读数是否仍然有效'
          : `读数时间戳无法解析：${String(record.observedAt)}`,
    });
  } else if (ageMs < -clockSkewMs) {
    reasons.push({
      code: 'timestamp_in_future',
      message: `读数时间戳晚于判定时刻 ${Math.abs(ageMs)}ms，超出允许的时钟偏差`,
    });
  } else if (ageMs > maxAgeMs) {
    reasons.push({
      code: 'reading_stale',
      message: `读数已过去 ${ageMs}ms，超过允许的 ${maxAgeMs}ms 时效`,
    });
  }

  const temperature = inspectTemperature(record.temperatureC);
  if (temperature.code) {
    reasons.push({ code: temperature.code, message: temperature.message });
  }

  const door = inspectDoor(record.doorState);
  if (door.code) {
    reasons.push({ code: door.code, message: door.message });
  }

  return {
    key: `${record.source}:${record.id}`,
    source: record.source,
    id: record.id,
    revision: record.revision,
    observedAt: record.observedAt ?? null,
    temperatureC: record.temperatureC ?? null,
    status: summarize(reasons),
    code: reasons[0]?.code ?? null,
    reasons,
    evidence: {
      reading: readingEvidence,
      door: { state: door.state, reported: door.reported },
    },
  };
}

export { DECIDED_ERROR, DECIDED_HELD, DECIDED_READY };
