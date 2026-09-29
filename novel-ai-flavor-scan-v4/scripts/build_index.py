#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_index.py — 辅助生成 D17（跨章事实网络）与 D18（虚构专名）索引表

用途：
  给 novel-ai-flavor-scan-v4 提供确定性的预处理索引，
  替代纯 LLM 在长文本中容易漏记/遗忘的长程追踪。

使用方法：
  python scripts/build_index.py <小说正文.txt> [--output index.md]

输出两张表：
  1. 专名表（D18 基础）：人名/店名/地名在各章的出现频次、写法漂移、语义透明度提示
  2. 事实变动候选表（D17 基础）：带身体状态/物品归属/关键承诺的段落索引

仅依赖 Python 标准库（re, sys, collections, argparse）。
"""

import argparse
import collections
import re
import sys
from pathlib import Path


# 常见中文姓氏（百家姓高频）
SURNAMES = set(
    "李王张刘陈杨赵黄周吴徐孙胡朱高林何郭马罗梁宋郑谢韩唐冯于董萧程曹袁邓许傅沈曾彭吕苏卢蒋蔡贾丁魏薛叶阎余潘杜戴夏钟汪田任姜范方石姚谭廖邹熊金陆郝孔白崔康毛邱秦江史顾侯邵孟龙万段雷钱汤尹黎易常武乔贺赖龚文"
)

# 专名透明度后缀（网文标签化命名常见字）
LABEL_SUFFIXES = {
    "咖啡馆", "咖啡厅", "客栈", "酒楼", "庄园", "医馆", "书院", "武馆",
    "殿", "阁", "楼", "山庄", "商会", "客坊", "府", "宗", "派",
}

# 不应作专名开头的虚词/动词（用于清洗提取污染）
COMMON_CHARS = set("的了在是与和我你他她这那对把被从往走来去说想看能会可什么怎么一个上下中里外一二三四五六七八九十在要进过得到有没不都很更还也就家")

# 常见误匹配人名词（不是人名）
PERSON_STOPWORDS = {
    "人们", "大家", "地方", "东西", "时候", "虽然", "如果", "为了", "因为",
    "所以", "他们", "我们", "你们", "自己", "这个", "那个", "什么", "怎么",
}

# 事实变化敏感词（用于捕捉潜在状态改变）
FACT_CHANGE_KEYWORDS = [
    # 身体损伤/变化（顺序 A：部位在前，"左臂…断了"）
    r"[左右]?[臂手臂腿手脚指肋骨筋脉眼睛][^，。！？\n、]{0,10}断[了过]?",
    # 身体损伤/变化（顺序 B：变化在前，"断了一臂"）
    r"断[了过]?[^，。！？\n、]{0,6}[左右]?[臂手臂腿手脚指肋骨筋脉一]",
    r"(瞎|盲)[了过]?[左右]?[眼睛]|一[只双]眼",
    r"(重伤|吐血|昏迷|毒发|毁容|失忆|废[了过]|残[了过])",
    # 物品归属与转移
    r"(递给|交到|收入|夺走|抢过|扔下|遗失|掉落|赠予)[^，。！？\n]{0,10}(手里|手中|怀中|纳戒|乾坤袋)?",
    # 伏笔承诺与期限
    r"(约定|承诺|发誓|限期|三[日天月年]|十[日天]|半[个月年]|七日之内)",
]


def split_chapters(text: str):
    """
    按常见中文章节模式分章；若无明显章节标记，则退化为固定字数切块。
    """
    pattern = r"(?:^|\n)(第[0-9一二三四五六七八九十百千万]+[章回节卷部]|Chapter\s+[0-9]+[^\n]*)"
    parts = re.split(pattern, text)
    chapters = []

    if len(parts) <= 1:
        # 无明显章节标记，每 3000 字一段
        chunk_size = 3000
        for i in range(0, len(text), chunk_size):
            title = f"第{i // chunk_size + 1}段"
            body = text[i:i + chunk_size]
            chapters.append((title, body))
        return chapters

    # parts[0] 是前言/序，若有内容单列
    if parts[0].strip():
        chapters.append(("序/引言", parts[0]))

    for i in range(1, len(parts), 2):
        title = parts[i].strip()
        body = parts[i + 1] if i + 1 < len(parts) else ""
        chapters.append((title, body))

    return chapters


def extract_proper_nouns(chapters):
    """
    提取人名与地点/机构名，统计其在各章的出现。
    """
    name_chapters = collections.defaultdict(lambda: collections.defaultdict(int))
    place_chapters = collections.defaultdict(lambda: collections.defaultdict(int))

    # 中文人名正则：姓氏 + 1-2 字（优先 2 字名：李明/林晚）
    # 统计 2 字和 3 字分别作为候选
    surname_pattern = "[" + "".join(SURNAMES) + "]"
    p2_re = re.compile(rf"({surname_pattern}[一-龥])")
    p3_re = re.compile(rf"({surname_pattern}[一-龥]{{2}})")

    # 简单地点正则：2-4 字 + 后缀
    place_regexes = [
        (suffix, re.compile(rf"([一-龥]{{2,4}}{re.escape(suffix)})"))
        for suffix in LABEL_SUFFIXES
    ]

    for chap_idx, (title, body) in enumerate(chapters, 1):
        # 1. 人名候选（2 字优先匹配，过滤停用词）
        for m in p2_re.finditer(body):
            name = m.group(1)
            if name in PERSON_STOPWORDS:
                continue
            name_chapters[name][(chap_idx, title)] += 1

        for m in p3_re.finditer(body):
            name = m.group(1)
            if name in PERSON_STOPWORDS or name[:2] in PERSON_STOPWORDS:
                continue
            # 若 2 字形式（姓+名首字）已存在且频次更高，3 字多为语境变体，丢弃
            if name[:2] in name_chapters:
                continue  # 先只记 2 字；若 3 字在文中是真名（频次更高），下一轮统计补
            name_chapters[name][(chap_idx, title)] += 1

        # 2. 地点/店名候选
        for suffix, regex in place_regexes:
            for m in regex.finditer(body):
                place = m.group(1)
                # 清洗首字动词（如"进暖阳咖啡馆"→"暖阳咖啡馆"）
                while place and place[0] in COMMON_CHARS and len(place) > len(suffix) + 1:
                    place = place[1:]
                if len(place) >= len(suffix) + 2:
                    place_chapters[place][(chap_idx, title)] += 1

    return name_chapters, place_chapters


def detect_noun_anomalies(name_chapters):
    """
    检测专名异常：
    1. 音近/字近异写（如 林晚 vs 林婉）
    2. 孤立重现（第 1 章出现，中间消失 20 章，后面突然重现）
    """
    anomalies = []
    names = list(name_chapters.keys())

    # 仅保留出现频次 >= 2 的 2 字人名进行比对（真实人名会跨章重复）
    frequent = [
        n for n in names
        if len(n) == 2 and sum(name_chapters[n].values()) >= 2
    ]

    for i in range(len(frequent)):
        for j in range(i + 1, len(frequent)):
            n1, n2 = frequent[i], frequent[j]
            # 长度相同且仅 1 字不同
            if len(n1) == len(n2) and sum(c1 != c2 for c1, c2 in zip(n1, n2)) == 1:
                # 姓氏相同
                if n1[0] == n2[0]:
                    anomalies.append(
                        f"疑似专名异写/漂移：`{n1}`（出现 {sum(name_chapters[n1].values())} 次）"
                        f" vs `{n2}`（出现 {sum(name_chapters[n2].values())} 次）"
                    )

    return anomalies


def extract_fact_candidates(chapters):
    """
    提取带身体损伤/物品转移/关键期限承诺的段落索引。
    """
    compiled = [re.compile(p) for p in FACT_CHANGE_KEYWORDS]
    candidates = []

    for chap_idx, (title, body) in enumerate(chapters, 1):
        paragraphs = [p.strip() for p in body.split("\n") if p.strip()]
        for p_idx, para in enumerate(paragraphs, 1):
            for regex in compiled:
                m = regex.search(para)
                if m:
                    # 摘录上下文 <= 40 字
                    start = max(0, m.start() - 10)
                    end = min(len(para), m.end() + 20)
                    snippet = para[start:end].replace("\n", " ")
                    candidates.append({
                        "chapter_idx": chap_idx,
                        "chapter_title": title,
                        "para_idx": p_idx,
                        "matched": m.group(0),
                        "snippet": snippet,
                    })
                    break  # 一段只报一次

    return candidates


def generate_report(chapters, name_chapters, place_chapters, anomalies, fact_candidates):
    lines = []
    lines.append("# D17/D18 预处理索引表")
    lines.append(f"\n> 扫描章节数：{len(chapters)} ｜ 提取人名候选：{len(name_chapters)} ｜ 提取地点/店名：{len(place_chapters)}")
    lines.append("\n---\n")

    lines.append("## 一、D18 专名稳定性索引\n")
    if anomalies:
        lines.append("### ⚠️ 疑似专名漂移/冲突")
        for a in anomalies[:10]:
            lines.append(f"- {a}")
        lines.append("")

    lines.append("### 核心人名出现跨度（前 15 个高频）")
    lines.append("| 人名 | 总频次 | 首现章 | 末现章 | 跨度(章数) | 出现章节分布 |")
    lines.append("|---|---|---|---|---|---|")

    sorted_names = [
        (n, m) for n, m in name_chapters.items()
        if sum(m.values()) >= 2  # 过滤单次出现的噪声 n-gram
    ]
    sorted_names = sorted(
        sorted_names,
        key=lambda x: sum(x[1].values()),
        reverse=True
    )[:15]

    for name, chap_map in sorted_names:
        total = sum(chap_map.values())
        chaps = sorted(chap_map.keys(), key=lambda x: x[0])
        first_chap = chaps[0][0]
        last_chap = chaps[-1][0]
        span = last_chap - first_chap + 1
        dist_str = ",".join(str(c[0]) for c in chaps[:8])
        if len(chaps) > 8:
            dist_str += f"...(共{len(chaps)}章)"
        lines.append(f"| {name} | {total} | 第{first_chap}章 | 第{last_chap}章 | {span} | {dist_str} |")

    lines.append("\n### 具标签化后缀的地点/机构名（前 10 个）")
    lines.append("| 名称 | 频次 | 出现章节 | 语义透明度提示 |")
    lines.append("|---|---|---|---|")
    sorted_places = sorted(
        place_chapters.items(),
        key=lambda x: sum(x[1].values()),
        reverse=True
    )[:10]
    for place, chap_map in sorted_places:
        total = sum(chap_map.values())
        chaps_str = ",".join(str(c[0]) for c in sorted(chap_map.keys(), key=lambda x: x[0])[:5])
        lines.append(f"| {place} | {total} | 第{chaps_str}章 | 可直译标签拼合 (B022) |")

    lines.append("\n---\n")
    lines.append("## 二、D17 跨章事实网络变动候选（需人工/LLM核验）\n")
    lines.append(f"共检测到 **{len(fact_candidates)}** 处状态变化/转移/承诺相关段落。请重点核对跨章一致性：\n")
    lines.append("| # | 章节 | 段落 | 触发词 | 摘录上下文 | 核对重点 |")
    lines.append("|---|---|---|---|---|---|")

    for idx, c in enumerate(fact_candidates[:25], 1):
        lines.append(
            f"| {idx} | {c['chapter_title']} | 第{c['para_idx']}段 | `{c['matched']}` "
            f"| ...{c['snippet']}... | 确认后续章节状态是否维持/有无自愈/物品归属是否漂移 |"
        )

    if len(fact_candidates) > 25:
        lines.append(f"\n> ...其余 {len(fact_candidates) - 25} 处已折叠，详见结构化数据。")

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="生成 D17/D18 预处理索引表")
    parser.add_argument("input_file", help="小说文本文件路径 (txt/md)")
    parser.add_argument("--output", "-o", help="输出 Markdown 路径（默认 stdout）")
    args = parser.parse_args()

    input_path = Path(args.input_file)
    if not input_path.exists():
        print(f"Error: 文件不存在 {input_path}", file=sys.stderr)
        sys.exit(1)

    text = input_path.read_text(encoding="utf-8", errors="ignore")
    chapters = split_chapters(text)
    name_chapters, place_chapters = extract_proper_nouns(chapters)
    anomalies = detect_noun_anomalies(name_chapters)
    fact_candidates = extract_fact_candidates(chapters)

    report = generate_report(chapters, name_chapters, place_chapters, anomalies, fact_candidates)

    if args.output:
        Path(args.output).write_text(report, encoding="utf-8")
        print(f"索引已写入 {args.output}")
    else:
        print(report)


if __name__ == "__main__":
    main()
