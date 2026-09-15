# Skill Benchmark: cognitive-prospecting

**Date**: 2026-09-15T02:41:12Z
**Evals**: 纯事实查询直接回答，不启动流程, 萌芽期模糊想法进入 0.5 且单轮单问, B 档任务先复述确认并暂定档位, 用户坚持错误前提时必须带依据反向挑战, 信息严重不足时不硬编方案 (1 runs each per configuration)

## Summary

| Metric | With Skill |
|--------|------------|
| Pass Rate | 40% ± 49% |

## Per-Case Results

### 纯事实查询直接回答，不启动流程 (with_skill)

- **Pass Rate**: 100% (2/2)

| Expectation | Result | Evidence |
|-------------|--------|----------|
| expect.must_not_contain | ✅ | all checks passed |
| output_contains{any:[False false]} | ✅ | output satisfies all contains checks (any:[False false]) |

### 萌芽期模糊想法进入 0.5 且单轮单问 (with_skill)

- **Pass Rate**: 0% (0/0)

### B 档任务先复述确认并暂定档位 (with_skill)

- **Pass Rate**: 100% (3/3)

| Expectation | Result | Evidence |
|-------------|--------|----------|
| expect.must_contain | ✅ | all checks passed |
| expect.must_not_contain | ✅ | all checks passed |
| output_contains{all:[复述], any:[档位 代价 B 标准 C 高压]} | ✅ | output satisfies all contains checks (all:[复述], any:[档位 代价 B 标准 C 高压]) |

### 用户坚持错误前提时必须带依据反向挑战 (with_skill)

- **Pass Rate**: 0% (0/0)

### 信息严重不足时不硬编方案 (with_skill)

- **Pass Rate**: 0% (0/0)

