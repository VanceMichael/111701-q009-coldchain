# 冷链仓温度与装货状态采集服务

这是一个用于冷链仓温度读数和装货状态的本地数据采集与归档服务。当前版本从仓库自带的合成来源记录读取一页数据，经过字段规整后写入进程内目录；来源内容和规整后的记录保留独立边界，便于在不访问外部系统的情况下复现采集过程。

## 装货判定

温度数值本身不能作为放行依据。每条记录会独立收集两类证据：

- **读数时效**：`observedAt` 与判定时刻的差值。超过 `maxAgeMs`（默认 10 分钟）记为 `reading_stale`；解析失败或明显晚于当前时间（超出 `clockSkewMs`，默认 1 分钟）记为 `error`。
- **门状态**：`closed` 视为已确认关闭；`open` 记为 `door_open`；缺失、无法识别或传感器报错记为门状态未确认（`unknown`）。

判定结果是三者同时满足才为 `ready`：

| 状态 | 含义 | 后续动作 |
| --- | --- | --- |
| `ready` | 读数新鲜、温度有效、仓门已关闭 | 可以装货 |
| `held` | 至少一项无法确认，但数据本身可解释 | 暂缓，待重新采集后复判 |
| `error` | 时间戳或温度数据本身无法解释 | 需修复来源后复判 |

`held` 不表示仓库永久不安全：它只针对当前这条读数。每条判定都带 `reasons` 和 `evidence`，其中 `evidence.reading` 给出 `observedAt`、`ageMs`、`maxAgeMs` 与 `withinMaxAge`，`evidence.door` 给出规整后的门状态和原始上报值，便于现场核对放行依据。

## 空响应与恢复

一次空响应（或部分记录缺失）只表示本次采集没有得到可判定数据：

- 已存储的记录不会被删除；
- 本次结果的 `status` 为 `empty`，`decisions` 是对既有记录的复判结果；
- 来源恢复后再次采集，`summary` 与逐条 `status` 会明确哪些批次可以继续处理。

## 运行

需要 Node.js 20 或更高版本，不需要安装第三方依赖。

```sh
npm test
npm run build
node src/pipeline.mjs
```

`collect()` 接受 `now`、`maxAgeMs`、`clockSkewMs`、`persist` 等选项。传入 `persist: true` 会把记录写入 `store.persist()` 指定的 JSON 快照；用 `RecordStore.load({ path })` 重新加载后可调用 `reassess(store, { now })` 继续判定，适合在进程重启或现场数据恢复后使用。

测试使用项目内的合成记录；执行不需要网络、凭据或外部服务。判定时间为显式传入的固定值，因此结果可复现。
