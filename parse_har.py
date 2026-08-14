#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
opencode.ai HAR 用量分析脚本
============================
解析 https://opencode.ai/_server 的 server-fn 响应（SolidJS $R 序列化格式），
提取：
  1. key_xxx → displayName 映射表（来自 server-fn:0 的 keys 数组）
  2. 逐次调用明细（server-fn:1..N 的 usage 记录：时间/模型/token/成本/key）
  3. 服务端每日汇总（server-fn:0 的 usage 数组）
  4. 按 key / 按小时 / 按模型的聚合统计

用法:
  python3 parse_har.py opencode.ai.har
  python3 parse_har.py opencode.ai.har --json out.json --csv records.csv
"""

import argparse
import csv
import json
import math
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

# ---------------------------------------------------------------------------
# $R 序列化格式解析器
# ---------------------------------------------------------------------------

class RFormatError(Exception):
    pass


class RParser:
    """解析 opencode.ai/_server 响应中的 SolidJS server-fn 序列化文本。

    格式形如:
      ;0x00001192;((self.$R=self.$R||{})["server-fn:0"]=[],($R=>$R[0]={...})($R["server-fn:0"]))
    其中 $R[n]=<值> 表示把 <值> 存入引用数组，之后裸 $R[n] 表示复用该值。
    """

    def __init__(self, text: str):
        self.s = text
        self.i = 0
        self.n = len(text)
        self.R: dict[int, object] = {}

    # ---- 基础工具 ----
    def _skip(self):
        while self.i < self.n and self.s[self.i] in " \t\r\n":
            self.i += 1

    def _peek(self, k: int = 0) -> str:
        j = self.i + k
        return self.s[j] if j < self.n else ""

    def _expect(self, ch: str):
        if self._peek() != ch:
            raise RFormatError(f"期望 {ch!r}，实际在 {self.i}: {self.s[self.i:self.i+40]!r}")
        self.i += 1

    # ---- 入口 ----
    def parse(self):
        v = self._value()
        self._skip()
        return v

    # ---- 值 ----
    def _value(self):
        self._skip()
        c = self._peek()
        if c == "$":
            return self._rref()
        if c == "{":
            return self._object()
        if c == "[":
            return self._array()
        if c in ('"', "'"):
            return self._string()
        if c == "!":
            self.i += 1
            # JS: !0 => true, !1 => false
            if self._peek() == "0":
                self.i += 1
                return True
            if self._peek() == "1":
                self.i += 1
                return False
            raise RFormatError(f"非法布尔标记 at {self.i}")
        for kw, val in (("null", None), ("undefined", None), ("NaN", float("nan"))):
            if self.s.startswith(kw, self.i):
                self.i += len(kw)
                return val
        if self.s.startswith("new Date", self.i):
            m = re.match(r"new\s+Date\(", self.s[self.i:])
            if m:
                self.i += m.end()
                inner = self._string()
                self._skip()
                self._expect(")")
                return inner  # 直接返回 ISO 字符串
        m = re.match(r"-?\d+(\.\d+)?([eE][+-]?\d+)?", self.s[self.i:])
        if m:
            self.i += m.end()
            raw = m.group(0)
            return float(raw) if ("." in raw or "e" in raw.lower()) else int(raw)
        raise RFormatError(f"无法解析的值 at {self.i}: {self.s[self.i:self.i+40]!r}")

    def _rref(self):
        self._skip()
        self._expect("$")
        self._expect("R")
        self._expect("[")
        j = self.i
        while self._peek().isdigit():
            self.i += 1
        idx = int(self.s[j:self.i])
        self._expect("]")
        self._skip()
        if self._peek() == "=":
            self.i += 1
            val = self._value()
            self.R[idx] = val
            return val
        if idx in self.R:
            return self.R[idx]
        raise RFormatError(f"未知引用 $R[{idx}]")

    def _object(self):
        self._expect("{")
        obj = {}
        self._skip()
        if self._peek() == "}":
            self.i += 1
            return obj
        while True:
            self._skip()
            if self._peek() in ('"', "'"):
                key = self._string()
            else:
                m = re.match(r"[A-Za-z_$][A-Za-z0-9_$]*", self.s[self.i:])
                if not m:
                    raise RFormatError(f"非法对象键 at {self.i}: {self.s[self.i:self.i+30]!r}")
                key = m.group(0)
                self.i += m.end()
            self._skip()
            self._expect(":")
            obj[key] = self._value()
            self._skip()
            if self._peek() == ",":
                self.i += 1
                continue
            if self._peek() == "}":
                self.i += 1
                return obj
            raise RFormatError("对象分隔符异常")

    def _array(self):
        self._expect("[")
        arr = []
        self._skip()
        if self._peek() == "]":
            self.i += 1
            return arr
        while True:
            arr.append(self._value())
            self._skip()
            if self._peek() == ",":
                self.i += 1
                continue
            if self._peek() == "]":
                self.i += 1
                return arr
            raise RFormatError("数组分隔符异常")

    def _string(self):
        q = self._peek()
        self.i += 1
        out = []
        escapes = {
            "n": "\n", "t": "\t", "r": "\r", "b": "\b",
            "f": "\f", '"': '"', "'": "'", "\\": "\\", "/": "/",
        }
        while self.i < self.n:
            ch = self.s[self.i]
            if ch == "\\":
                self.i += 1
                e = self.s[self.i] if self.i < self.n else ""
                out.append(escapes.get(e, e))
                self.i += 1
                continue
            if ch == q:
                self.i += 1
                return "".join(out)
            out.append(ch)
            self.i += 1
        raise RFormatError("字符串未闭合")


# ---------------------------------------------------------------------------
# HAR 分析
# ---------------------------------------------------------------------------

def strip_account(name):
    """displayName 形如 '账户名 - 别名'，只保留 ' - ' 后的别名。"""
    if not name:
        return name
    idx = name.find(" - ")
    return name[idx + 3:].strip() if idx >= 0 else name

def parse_server_response(resp_text: str):
    """解析一个 _server 响应文本，返回 (fn_id, 顶层数据对象)。"""
    m = re.search(r"server-fn:(\d+)", resp_text)
    fn = int(m.group(1)) if m else None
    # 去掉前缀 ;0x....;((self.$R=self.$R||{})["server-fn:N"]=[],($R=>
    idx = resp_text.find('",($R=>')
    if idx == -1:
        idx = resp_text.find(",($R=>")
    if idx == -1:
        return fn, None
    body = resp_text[idx + len(",($R=>"):]
    # 去掉结尾 )($R["server-fn:N"]))
    m_end = re.search(r"\)\s*\(\$R\[\"server-fn:\d+\"\]\)\)\s*$", body)
    if m_end:
        body = body[: m_end.start()]
    return fn, RParser(body).parse()


def load_har(path: str):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def analyze(har: dict):
    """分析整个 HAR，返回结构化结果。"""
    entries = har.get("log", {}).get("entries", [])
    key_map = {}            # keyId -> {displayName, deleted, plan, firstSeen}
    records = []            # 逐次调用明细
    daily = {}              # (date, model, keyId) -> totalCost
    fn_stats = defaultdict(int)
    errors = []
    server_calls = 0

    for entry in entries:
        url = entry.get("request", {}).get("url", "")
        if "/_server" not in url:
            continue
        server_calls += 1
        resp_text = entry.get("response", {}).get("content", {}).get("text", "")
        if not resp_text:
            continue
        try:
            fn, data = parse_server_response(resp_text)
        except Exception as exc:  # noqa: BLE001
            errors.append(f"解析失败 (fn 未知): {exc}")
            continue
        if fn is None:
            continue
        fn_stats[fn] += 1
        if fn == 0:
            # keys 映射
            keys = (data or {}).get("keys") or []
            for k in keys:
                if not isinstance(k, dict):
                    continue
                kid = k.get("id")
                if not kid:
                    continue
                if kid not in key_map or (key_map[kid].get("deleted") and not k.get("deleted")):
                    key_map[kid] = {
                        "displayName": strip_account(k.get("displayName", kid)),
                        "deleted": bool(k.get("deleted")),
                        "plan": k.get("plan"),
                    }
            # 每日汇总
            usage = (data or {}).get("usage") or []
            for u in usage:
                if not isinstance(u, dict):
                    continue
                key = (u.get("date"), u.get("model"), u.get("keyId"))
                daily[key] = u.get("totalCost", 0)
        else:
            # 调用明细（一条响应可能含多条记录，且不同 fn 响应会重复）
            items = data if isinstance(data, list) else []
            for it in items:
                if not isinstance(it, dict) or "id" not in it:
                    continue
                rid = it.get("id")
                if any(r.get("id") == rid for r in records):
                    continue
                records.append(it)

    # 按时间排序
    records.sort(key=lambda r: (r.get("timeCreated") or ""))
    daily_rows = [
        {"date": d, "model": m, "keyId": k, "totalCost": c}
        for (d, m, k), c in sorted(daily.items(), key=lambda kv: kv[0][0])
    ]
    return {
        "har": {"fileSize": None, "serverCalls": server_calls, "fnStats": dict(fn_stats)},
        "keyMap": key_map,
        "records": records,
        "daily": daily_rows,
        "errors": errors,
    }


def summarize(result: dict) -> dict:
    """对记录做聚合：按 key / 按小时 / 按模型。"""
    records = result["records"]
    key_map = result["keyMap"]

    def dn(kid):
        return key_map.get(kid, {}).get("displayName", kid)

    by_key = defaultdict(lambda: {"calls": 0, "input": 0, "output": 0, "cache": 0, "cost": 0})
    for r in records:
        kid = r.get("keyID") or r.get("keyId")
        agg = by_key[kid]
        agg["calls"] += 1
        agg["input"] += r.get("inputTokens") or 0
        agg["output"] += r.get("outputTokens") or 0
        agg["cache"] += r.get("cacheReadTokens") or 0
        agg["cost"] += r.get("cost") or 0

    by_hour = defaultdict(lambda: defaultdict(lambda: {"calls": 0, "cost": 0}))
    for r in records:
        t = r.get("timeCreated")
        if not t:
            continue
        dt = datetime.fromisoformat(t.replace("Z", "+00:00")).astimezone()
        hour = dt.strftime("%Y-%m-%d %H:00")
        kid = r.get("keyID") or r.get("keyId")
        h = by_hour[hour][kid]
        h["calls"] += 1
        h["cost"] += r.get("cost") or 0

    by_model = defaultdict(lambda: {"calls": 0, "cost": 0})
    for r in records:
        m = r.get("model", "?")
        by_model[m]["calls"] += 1
        by_model[m]["cost"] += r.get("cost") or 0

    return {
        "byKey": {
            kid: {"displayName": dn(kid), "keyId": kid, **agg}
            for kid, agg in sorted(by_key.items(), key=lambda kv: -kv[1]["cost"])
        },
        "byHour": {
            hour: {kid: {"displayName": dn(kid), **v} for kid, v in keys.items()}
            for hour, keys in sorted(by_hour.items())
        },
        "byModel": {
            m: {"calls": v["calls"], "cost": v["cost"]}
            for m, v in sorted(by_model.items(), key=lambda kv: -kv[1]["cost"])
        },
    }


def detect_anomalies(records, key_map, min_calls=8, multiplier=3, merge_gap_min=1):
    """分钟级高频调用检测（与前端 detectAnomalies 同逻辑）。"""
    groups = defaultdict(list)
    for r in records:
        groups[r.get("keyID") or r.get("keyId")].append(r)

    events = []
    for kid, lst in groups.items():
        if len(lst) < min_calls:
            continue
        bucket = defaultdict(lambda: {"count": 0, "recs": [], "ts": None})
        for r in lst:
            t = r.get("timeCreated")
            if not t:
                continue
            dt = datetime.fromisoformat(t.replace("Z", "+00:00")).astimezone()
            mkey = dt.strftime("%Y-%m-%dT%H:%M")
            b = bucket[mkey]
            b["count"] += 1
            b["recs"].append(r)
            b["ts"] = dt.timestamp() * 1000
        if not bucket:
            continue
        times = sorted(b["ts"] for b in bucket.values())
        span_min = (times[-1] - times[0]) / 60000 + 1
        avg = len(lst) / span_min if span_min > 0 else 0
        threshold = max(min_calls, math.ceil(avg * multiplier))
        abnormal = sorted(
            [b for b in bucket.values() if b["count"] >= threshold],
            key=lambda b: b["ts"],
        )
        merged = []
        for b in abnormal:
            if merged and (b["ts"] - merged[-1]["end"]) / 60000 <= merge_gap_min:
                last = merged[-1]
                last["end"] = b["ts"]
                last["calls"] += b["count"]
                last["recs"].extend(b["recs"])
            else:
                merged.append({"start": b["ts"], "end": b["ts"], "calls": b["count"], "recs": list(b["recs"])})
        for ev in merged:
            minutes = max(1, (ev["end"] - ev["start"]) / 60000 + 1)
            events.append({
                "keyId": kid,
                "displayName": key_map.get(kid, {}).get("displayName", kid),
                "start": ev["start"],
                "end": ev["end"],
                "calls": ev["calls"],
                "ratePerMin": ev["calls"] / minutes,
                "pctOfKey": round(ev["calls"] / len(lst) * 1000) / 10,
                "threshold": threshold,
            })
    events.sort(key=lambda e: -e["calls"])
    return events


def is_liveness_call(r, max_input=100, max_output=100):
    """判断单条调用是否为测活（短输入短输出）调用。"""
    has_in = r.get("inputTokens") is not None
    has_out = r.get("outputTokens") is not None
    if not has_in and not has_out:
        return False
    return (r.get("inputTokens") or 0) <= max_input and (r.get("outputTokens") or 0) <= max_output


def detect_liveness(records, key_map, max_input=100, max_output=100):
    """按 key 聚合测活调用（与前端 detectLiveness 同逻辑）。"""
    groups = defaultdict(list)
    totals = defaultdict(int)
    for r in records:
        kid = r.get("keyID") or r.get("keyId")
        totals[kid] += 1
        if is_liveness_call(r, max_input, max_output):
            groups[kid].append(r)
    rows = []
    for kid, recs in groups.items():
        recs.sort(key=lambda x: x.get("timeCreated") or "")
        rows.append({
            "keyId": kid,
            "displayName": key_map.get(kid, {}).get("displayName", kid),
            "calls": len(recs),
            "input": sum(r.get("inputTokens") or 0 for r in recs),
            "output": sum(r.get("outputTokens") or 0 for r in recs),
            "cost": sum(r.get("cost") or 0 for r in recs),
            "totalCalls": totals[kid],
            "pctOfKey": round(len(recs) / totals[kid] * 1000) / 10 if totals[kid] else 0,
            "start": recs[0].get("timeCreated"),
            "end": recs[-1].get("timeCreated"),
            "models": sorted({r.get("model", "?") for r in recs}),
        })
    rows.sort(key=lambda x: -x["calls"])
    return rows


def main():
    ap = argparse.ArgumentParser(description="opencode.ai HAR 用量分析")
    ap.add_argument("har", help="HAR 文件路径")
    ap.add_argument("--json", help="输出完整分析结果到 JSON 文件")
    ap.add_argument("--csv", help="输出调用明细到 CSV 文件")
    args = ap.parse_args()

    har = load_har(args.har)
    result = analyze(har)
    agg = summarize(result)

    print("=" * 60)
    print("OpenCode AI HAR 用量分析")
    print("=" * 60)
    print(f"server 调用数      : {result['har']['serverCalls']}")
    print(f"server-fn 分布    : {result['har']['fnStats']}")
    print(f"解析错误          : {len(result['errors'])}")
    for e in result["errors"][:5]:
        print(f"  - {e}")
    print(f"调用明细条数      : {len(result['records'])}")
    print(f"涉及 key 数量     : {len(result['keyMap'])}")
    print()
    print("-" * 60)
    print("Key 映射表 (key_xxx -> displayName)")
    print("-" * 60)
    for kid, info in sorted(result["keyMap"].items()):
        mark = " [已删除]" if info["deleted"] else ""
        print(f"  {kid}  ->  {info['displayName']}{mark}")
    print()
    print("-" * 60)
    print("按 key 汇总 (按成本降序)")
    print("-" * 60)
    print(f"{'displayName':<32}{'calls':>8}{'input':>12}{'output':>12}{'cost':>14}")
    for kid, a in agg["byKey"].items():
        print(f"{a['displayName']:<32}{a['calls']:>8}{a['input']:>12,}{a['output']:>12,}{a['cost']:>14,}")
    print()
    print("-" * 60)
    print("按模型汇总")
    print("-" * 60)
    for m, a in agg["byModel"].items():
        print(f"  {m:<28}{a['calls']:>6} 次  成本 {a['cost']:,}")
    print()
    print("-" * 60)
    print("按小时调用量 (top 10 小时)")
    print("-" * 60)
    for hour, keys in list(agg["byHour"].items())[:10]:
        calls = sum(v["calls"] for v in keys.values())
        cost = sum(v["cost"] for v in keys.values())
        print(f"  {hour}  调用 {calls:>4} 次  成本 {cost:,}")
    print()
    print("-" * 60)
    print("异常分析（分钟级高频调用）")
    print("-" * 60)
    events = detect_anomalies(result["records"], result["keyMap"])
    if not events:
        print("  未检测到异常事件")
    for e in events[:10]:
        st = datetime.fromtimestamp(e["start"] / 1000).strftime("%m-%d %H:%M")
        print(f"  {st}  {e['displayName']:<28}{e['calls']:>4} 次  {e['ratePerMin']:.1f} 次/分  阈值≥{e['threshold']}")
    print()
    print("-" * 60)
    print("测活标注（短输入短输出：input≤100 且 output≤100）")
    print("-" * 60)
    live = detect_liveness(result["records"], result["keyMap"])
    if not live:
        print("  未发现测活调用")
    for r in live:
        st = (r["start"] or "")[:16]
        print(f"  {st}  {r['displayName']:<28}{r['calls']:>4} 次  占 {r['pctOfKey']}%  成本 {r['cost']:,}")

    if args.json:
        out = {
            "keyMap": result["keyMap"],
            "records": result["records"],
            "daily": result["daily"],
            "byKey": agg["byKey"],
            "byHour": agg["byHour"],
            "byModel": agg["byModel"],
            "anomalies": detect_anomalies(result["records"], result["keyMap"]),
            "liveness": detect_liveness(result["records"], result["keyMap"]),
        }
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, indent=2)
        print(f"\nJSON 已写入: {args.json}")
    if args.csv:
        with open(args.csv, "w", encoding="utf-8", newline="") as f:
            w = csv.writer(f)
            w.writerow(["id", "timeCreated", "model", "provider", "keyID", "displayName",
                        "inputTokens", "outputTokens", "reasoningTokens", "cacheReadTokens",
                        "cost", "plan", "sessionID"])
            km = result["keyMap"]
            for r in result["records"]:
                kid = r.get("keyID") or r.get("keyId")
                w.writerow([
                    r.get("id"), r.get("timeCreated"), r.get("model"), r.get("provider"),
                    kid, km.get(kid, {}).get("displayName", ""),
                    r.get("inputTokens"), r.get("outputTokens"), r.get("reasoningTokens"),
                    r.get("cacheReadTokens"), r.get("cost"),
                    (r.get("enrichment") or {}).get("plan") if isinstance(r.get("enrichment"), dict) else "",
                    r.get("sessionID"),
                ])
        print(f"CSV 已写入: {args.csv}")


if __name__ == "__main__":
    main()
