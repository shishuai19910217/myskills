# cognitive-prospecting — 维护自检（非运行时文档）

> 供 skill 维护者使用，不参与运行时流程；SKILL.md 在「结构纪律」处保留一行指针。
> 对 SKILL.md（或任何改版）在交付/提交前逐项自查：

1. **引用完整性**：正文的附录引用都有对应章节；每个资源区（两层引擎/六类认知边界/模型池/回退表/异常表/模板）至少有 1 个正文入点
2. **术语冻结**：禁词表零命中；确证=动作、置信度=程度，不混用；置信度定义全文唯一
3. **结构完整**：阶段0→4、两层引擎、六类认知边界、附录A/B、术语表齐全
4. **产出模板齐全**：阶段1 复述话术、阶段3 输出框架（B1~B6 + M4 自查）、阶段4 M4-1~4 完整未压缩（输出资产不压缩）

自动化（在仓库根目录运行；退出码 0 = 通过）：

```powershell
pwsh tools/lint-skill.ps1 -Path cognitive-prospecting
```

规则在 `tools/lint-config.json`；增删附录 / 资源区 / 术语后，同步更新该配置的 `requiredHeadings` / `forbiddenPatterns` / `uniquePatterns`。
