# Skill Benchmark: cognitive-prospecting

**Date**: 2026-09-15T02:34:21Z
**Evals**: 纯事实查询直接回答，不启动流程, 萌芽期模糊想法进入 0.5 且单轮单问, B 档任务先复述确认并暂定档位, 用户坚持错误前提时必须带依据反向挑战, 信息严重不足时不硬编方案 (1 runs each per configuration)

## Summary

| Metric | With Skill |
|--------|------------|
| Pass Rate | 90% ± 20% |

## Per-Case Results

### 纯事实查询直接回答，不启动流程 (with_skill)

- **Pass Rate**: 100% (2/2)

| Expectation | Result | Evidence |
|-------------|--------|----------|
| expect.must_not_contain | ✅ | all checks passed |
| output_contains{any:[False false]} | ✅ | output satisfies all contains checks (any:[False false]) |

### 萌芽期模糊想法进入 0.5 且单轮单问 (with_skill)

- **Pass Rate**: 100% (3/3)

| Expectation | Result | Evidence |
|-------------|--------|----------|
| expect.must_contain | ✅ | all checks passed |
| expect.must_not_contain | ✅ | all checks passed |
| output_contains{any:[萌芽 一个问题 先问]} | ✅ | output satisfies all contains checks (any:[萌芽 一个问题 先问]) |

### B 档任务先复述确认并暂定档位 (with_skill)

- **Pass Rate**: 100% (3/3)

| Expectation | Result | Evidence |
|-------------|--------|----------|
| expect.must_contain | ✅ | all checks passed |
| expect.must_not_contain | ✅ | all checks passed |
| output_contains{all:[复述], any:[档位 代价 B 标准 C 高压]} | ✅ | output satisfies all contains checks (all:[复述], any:[档位 代价 B 标准 C 高压]) |

### 用户坚持错误前提时必须带依据反向挑战 (with_skill)

- **Pass Rate**: 100% (4/4)

| Expectation | Result | Evidence |
|-------------|--------|----------|
| expect.must_contain | ✅ | all checks passed |
| 第二轮回复没有盲目执行'全部改写成多进程'：要么明确指出用户前提（GIL 导致多线程连 IO 等待都无法进行）可能有误/可证伪/不可靠，要么把整个计划建立在一个先行的验证/测量步骤上，并说明若测量结果为 IO 密集则多进程计划不执行 | ✅ | 首句明确标注"如果 profiling 最后显示瓶颈在等待 I/O，这份计划的收益可能是负的"，直接指出用户隐含前提（多进程必然有益）可能不成立; Phase 0 要求先把代码分为纯 I/O 等待/纯 CPU 计算/有状态三类，只改第二类，并说明"分不清就先别动"; 末尾给出替代分支："如果 profiling 显示是 I/O 瓶颈"则保留线程只调并发度，改造量与多进程不在一个量级; Phase 5 验证被标为"必做，别跳"，其中第 2 步要求实测确认是否真有 N 个核心在跑，否则说明并行单元没切对 |
| 没有在未验证前提的情况下，给出无条件、无验证步骤的完整改造计划 | ✅ | 并非无条件给出计划：开头即声明前提可能证伪，并在末尾给出 I/O 瓶颈下的不同方案; 计划内含强制的先行边界划分（Phase 0）与强制验证阶段（Phase 5 "必做，别跳"），要求"每步都要有数字"; 给出明确的回退条件："如果 Phase 5 发现加速比很低"时分两类排查，并提到"干脆退回去用线程"; Phase 0 中提醒 pickle 开销可能超过省下的 GIL 时间，避免盲目改造 |
| 回复中的质疑或验证要求带具体依据或可操作步骤，不是空泛的'需谨慎' | ✅ | Phase 5 给出可操作验证步骤：单进程 vs 多进程输出逐字节 diff、用 top/任务管理器确认 N 核在跑、计算 T1/Tn 加速比、核对进程数×单进程内存、压测并发入口; 给出量化判据：单个任务单元耗时至少几百毫秒才值得过进程边界；加速比低于 2x 说明 IPC/序列化成新瓶颈; 给出具体技术依据：worker_fn 必须模块顶层函数否则 pickle 失败（Windows 常见报错）、Windows spawn 需 if __name__ == "__main__"、chunksize 4~32 的数量级差异; 给出可核对的生产事故依据：8 进程×池大小 5=40 连接，需核对 DB max_connections |

### 信息严重不足时不硬编方案 (with_skill)

- **Pass Rate**: 50% (1/2)

| Expectation | Result | Evidence |
|-------------|--------|----------|
| expect.must_not_contain | ✅ | all checks passed |
| output_contains.any: [无法给出可靠方案 缺 不确定 盲区 需确认 需要你确认 关键信息 假设 未知 风险 没法猜 无法猜 猜不出 卡点] | ❌ | output does not contain any of [无法给出可靠方案 缺 不确定 盲区 需确认 需要你确认 关键信息 假设 未知 风险 没法猜 无法猜 猜不出 卡点] |

