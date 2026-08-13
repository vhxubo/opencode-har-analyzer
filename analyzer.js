/* ===========================================================================
 * analyzer.js — opencode.ai/_server HAR 解析与分析引擎（纯逻辑，无 DOM 依赖）
 *
 * 解析 SolidJS server-fn 的 $R 序列化格式：
 *   ;0x....;((self.$R=self.$R||{})["server-fn:0"]=[],($R=>$R[0]={...})($R["server-fn:0"]))
 *
 * 输出:
 *   keyMap   key_xxx -> displayName 映射（来自 server-fn:0 的 keys 数组）
 *   records  逐次调用明细（server-fn:1..N 的 usage 记录）
 *   daily    服务端每日汇总（server-fn:0 的 usage 数组）
 * ==========================================================================*/

class RFormatError extends Error {}

class RParser {
  constructor(text) {
    this.s = text;
    this.i = 0;
    this.n = text.length;
    this.R = new Map(); // 引用数组 $R[n]
  }
  _skip() {
    while (this.i < this.n && " \t\r\n".includes(this.s[this.i])) this.i++;
  }
  _peek(k = 0) {
    return this.s[this.i + k] ?? "";
  }
  _expect(ch) {
    if (this._peek() !== ch)
      throw new RFormatError(
        `期望 ${ch}，实际在 ${this.i}: ${this.s.slice(this.i, this.i + 40)}`
      );
    this.i++;
  }
  parse() {
    const v = this._value();
    this._skip();
    return v;
  }
  _value() {
    this._skip();
    const c = this._peek();
    if (c === "$") return this._rref();
    if (c === "{") return this._object();
    if (c === "[") return this._array();
    if (c === '"' || c === "'") return this._string();
    if (c === "!") {
      // JS: !0 => true, !1 => false
      this.i++;
      const b = this._peek();
      if (b === "0") { this.i++; return true; }
      if (b === "1") { this.i++; return false; }
      throw new RFormatError(`非法布尔标记 at ${this.i}`);
    }
    for (const kw of ["null", "undefined", "NaN"]) {
      if (this.s.startsWith(kw, this.i)) {
        this.i += kw.length;
        return kw === "NaN" ? NaN : null;
      }
    }
    if (this.s.startsWith("new Date", this.i)) {
      const m = /new\s+Date\(/.exec(this.s.slice(this.i));
      if (m) {
        this.i += m[0].length;
        const inner = this._string();
        this._skip();
        this._expect(")");
        return inner; // ISO 字符串
      }
    }
    const m = /-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(this.s.slice(this.i));
    if (m && m[0]) {
      this.i += m[0].length;
      return /[.eE]/.test(m[0]) ? parseFloat(m[0]) : parseInt(m[0], 10);
    }
    throw new RFormatError(`无法解析 at ${this.i}: ${this.s.slice(this.i, this.i + 40)}`);
  }
  _rref() {
    this._skip();
    this._expect("$");
    this._expect("R");
    this._expect("[");
    let j = this.i;
    while (this._peek() >= "0" && this._peek() <= "9") this.i++;
    const idx = parseInt(this.s.slice(j, this.i), 10);
    this._expect("]");
    this._skip();
    if (this._peek() === "=") {
      this.i++;
      const val = this._value();
      this.R.set(idx, val);
      return val;
    }
    if (this.R.has(idx)) return this.R.get(idx);
    throw new RFormatError(`未知引用 $R[${idx}]`);
  }
  _object() {
    this._expect("{");
    const obj = {};
    this._skip();
    if (this._peek() === "}") { this.i++; return obj; }
    while (true) {
      this._skip();
      let key;
      if (this._peek() === '"' || this._peek() === "'") key = this._string();
      else {
        const m = /[A-Za-z_$][A-Za-z0-9_$]*/.exec(this.s.slice(this.i));
        if (!m) throw new RFormatError(`非法对象键 at ${this.i}: ${this.s.slice(this.i, this.i + 30)}`);
        key = m[0];
        this.i += m[0].length;
      }
      this._skip();
      this._expect(":");
      obj[key] = this._value();
      this._skip();
      if (this._peek() === ",") { this.i++; continue; }
      if (this._peek() === "}") { this.i++; return obj; }
      throw new RFormatError("对象分隔符异常");
    }
  }
  _array() {
    this._expect("[");
    const arr = [];
    this._skip();
    if (this._peek() === "]") { this.i++; return arr; }
    while (true) {
      arr.push(this._value());
      this._skip();
      if (this._peek() === ",") { this.i++; continue; }
      if (this._peek() === "]") { this.i++; return arr; }
      throw new RFormatError("数组分隔符异常");
    }
  }
  _string() {
    const q = this._peek();
    this.i++;
    let out = "";
    const esc = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", '"': '"', "'": "'", "\\": "\\", "/": "/" };
    while (this.i < this.n) {
      const ch = this.s[this.i];
      if (ch === "\\") {
        this.i++;
        const e = this.s[this.i] ?? "";
        out += esc[e] ?? e;
        this.i++;
        continue;
      }
      if (ch === q) { this.i++; return out; }
      out += ch;
      this.i++;
    }
    throw new RFormatError("字符串未闭合");
  }
}

/* ---------------- 单条 server 响应解析 ---------------- */

/**
 * displayName 形如 "925122985@qq.com - zifeiyu"，
 * 只保留 " - " 后的别名（前面是账户名）。
 */
function stripAccount(name) {
  if (!name) return name;
  const idx = name.indexOf(" - ");
  return idx >= 0 ? name.slice(idx + 3).trim() : name;
}

function parseServerResponse(respText) {
  const m = /server-fn:(\d+)/.exec(respText);
  const fn = m ? parseInt(m[1], 10) : null;
  const idx = respText.indexOf(",($R=>");
  if (idx === -1) return { fn, data: null };
  let body = respText.slice(idx + ",($R=>".length);
  const end = /\)\s*\(\$R\["server-fn:\d+"\]\)\)\s*$/.exec(body);
  if (end) body = body.slice(0, end.index);
  return { fn, data: new RParser(body).parse() };
}

/* ---------------- HAR 整体分析 ---------------- */

function analyzeHar(har) {
  const entries = (har && har.log && har.log.entries) || [];
  const keyMap = new Map();   // keyId -> {displayName, deleted, plan}
  const records = [];          // 调用明细（按 id 去重）
  const daily = new Map();     // (date, model, keyId) -> totalCost
  const fnStats = new Map();   // server-fn id -> 调用次数
  const errors = [];
  const seenIds = new Set();   // 明细去重
  let serverCalls = 0;

  for (const entry of entries) {
    const url = (entry.request && entry.request.url) || "";
    if (!url.includes("/_server")) continue;
    serverCalls++;
    const respText =
      (entry.response && entry.response.content && entry.response.content.text) || "";
    if (!respText) continue;
    let fn, data;
    try {
      ({ fn, data } = parseServerResponse(respText));
    } catch (err) {
      errors.push(`解析失败: ${err.message}`);
      continue;
    }
    if (fn === null) continue;
    fnStats.set(fn, (fnStats.get(fn) || 0) + 1);

    if (fn === 0 && data && typeof data === "object") {
      // key_xxx -> displayName 映射
      const keys = Array.isArray(data.keys) ? data.keys : [];
      for (const k of keys) {
        if (!k || typeof k !== "object") continue;
        const kid = k.id;
        if (!kid) continue;
        const prev = keyMap.get(kid);
        // 优先保留未删除版本
        if (!prev || (prev.deleted && !k.deleted)) {
          keyMap.set(kid, {
            displayName: stripAccount(k.displayName || kid),
            deleted: !!k.deleted,
            plan: k.plan ?? null,
          });
        }
      }
      // 服务端每日汇总
      const usage = Array.isArray(data.usage) ? data.usage : [];
      for (const u of usage) {
        if (!u || typeof u !== "object") continue;
        const dk = `${u.date}|${u.model}|${u.keyId}`;
        daily.set(dk, u.totalCost ?? 0);
      }
    } else if (Array.isArray(data)) {
      for (const it of data) {
        if (!it || typeof it !== "object" || !it.id) continue;
        if (seenIds.has(it.id)) continue;
        seenIds.add(it.id);
        records.push(it);
      }
    }
  }

  records.sort((a, b) => String(a.timeCreated).localeCompare(String(b.timeCreated)));
  const dailyRows = [...daily.entries()]
    .map(([k, totalCost]) => {
      const [date, model, keyId] = k.split("|");
      return { date, model, keyId, totalCost };
    })
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    har: { serverCalls, fnStats: [...fnStats.entries()].sort((a, b) => a[0] - b[0]), errors },
    keyMap,
    records,
    daily: dailyRows,
    errors,
  };
}

/* ---------------- 聚合 ---------------- */

function displayNameOf(keyMap, kid) {
  if (!kid) return "(未知 key)";
  return (keyMap.get(kid) || {}).displayName || kid;
}

function shortKey(kid) {
  if (!kid) return "";
  // key_xxxxxxxx...xxxx -> 取后 6 位
  const m = /key_[A-Za-z0-9]*([A-Za-z0-9]{6})$/.exec(kid);
  return m ? `…${m[1]}` : kid;
}

function aggregateByKey(records, keyMap) {
  const map = new Map();
  for (const r of records) {
    const kid = r.keyID || r.keyId || "";
    let agg = map.get(kid);
    if (!agg) {
      agg = {
        keyId: kid,
        displayName: displayNameOf(keyMap, kid),
        calls: 0, input: 0, output: 0, reasoning: 0, cache: 0, cost: 0,
        models: new Set(), plan: (r.enrichment && r.enrichment.plan) || null,
      };
      map.set(kid, agg);
    }
    agg.calls++;
    agg.input += r.inputTokens || 0;
    agg.output += r.outputTokens || 0;
    agg.reasoning += r.reasoningTokens || 0;
    agg.cache += r.cacheReadTokens || 0;
    agg.cost += r.cost || 0;
    if (r.model) agg.models.add(r.model);
  }
  return [...map.values()].map((a) => ({ ...a, models: [...a.models] }));
}

function timeBucketKey(ts, granularity) {
  const d = new Date(ts);
  if (isNaN(d)) return null;
  const p = (x) => String(x).padStart(2, "0");
  if (granularity === "day") return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:00`;
}

function aggregateByTime(records, keyMap, granularity) {
  const buckets = new Map(); // bucketKey -> Map<keyId, {calls,cost,input,output}>
  for (const r of records) {
    const bk = timeBucketKey(r.timeCreated, granularity);
    if (!bk) continue;
    const kid = r.keyID || r.keyId || "";
    let km = buckets.get(bk);
    if (!km) { km = new Map(); buckets.set(bk, km); }
    let cell = km.get(kid);
    if (!cell) { cell = { calls: 0, cost: 0, input: 0, output: 0 }; km.set(kid, cell); }
    cell.calls++;
    cell.cost += r.cost || 0;
    cell.input += r.inputTokens || 0;
    cell.output += r.outputTokens || 0;
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([bucket, km]) => ({
      bucket,
      cells: [...km.entries()].map(([kid, v]) => ({
        keyId: kid,
        displayName: displayNameOf(keyMap, kid),
        ...v,
      })),
    }));
}

function aggregateByModel(records, keyMap) {
  const map = new Map();
  for (const r of records) {
    const m = r.model || "(未知)";
    let agg = map.get(m);
    if (!agg) { agg = { model: m, calls: 0, cost: 0, input: 0, output: 0, keys: new Set() }; map.set(m, agg); }
    agg.calls++;
    agg.cost += r.cost || 0;
    agg.input += r.inputTokens || 0;
    agg.output += r.outputTokens || 0;
    if (r.keyID) agg.keys.add(displayNameOf(keyMap, r.keyID));
  }
  return [...map.values()]
    .map((a) => ({ ...a, keys: [...a.keys] }))
    .sort((a, b) => b.cost - a.cost);
}

/* ---------------- 异常检测：分钟级调用次数 ---------------- */

/**
 * 按分钟统计每个 key 的调用次数：
 *   - 每 key 每分钟调用数 ≥ max(minCalls, 平均每分钟调用数 × multiplier) 即标记该分钟异常；
 *   - 相邻异常分钟（间隔 ≤ mergeGapMin 分钟）合并为同一异常事件。
 */
function detectAnomalies(records, keyMap, opts = {}) {
  const minCalls = opts.minCalls ?? 8;
  const multiplier = opts.multiplier ?? 3;
  const mergeGapMin = opts.mergeGapMin ?? 1;

  const groups = new Map();
  for (const r of records) {
    const kid = r.keyID || r.keyId || "";
    if (!groups.has(kid)) groups.set(kid, []);
    groups.get(kid).push(r);
  }

  const events = [];
  for (const [kid, list] of groups) {
    if (list.length < minCalls) continue;

    // 分钟级分桶
    const bucket = new Map(); // minuteKey -> { count, recs, ts }
    for (const r of list) {
      const d = new Date(r.timeCreated);
      if (isNaN(d)) continue;
      const p = (x) => String(x).padStart(2, "0");
      const mkey = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
      if (!bucket.has(mkey)) bucket.set(mkey, { count: 0, recs: [], ts: d.getTime() });
      const b = bucket.get(mkey);
      b.count++;
      b.recs.push(r);
    }
    if (!bucket.size) continue;

    const times = [...bucket.values()].map((b) => b.ts).sort((a, b) => a - b);
    const spanMin = (times[times.length - 1] - times[0]) / 60000 + 1;
    const avgPerMin = spanMin > 0 ? list.length / spanMin : 0; // 平均每分钟调用数
    const threshold = Math.max(minCalls, Math.ceil(avgPerMin * multiplier));

    // 标记异常分钟并按时间排序
    const abnormal = [...bucket.entries()]
      .filter(([, b]) => b.count >= threshold)
      .sort((a, b) => a[1].ts - b[1].ts);

    // 相邻异常分钟合并为事件段（间隔 ≤ mergeGapMin 分钟）
    const merged = [];
    for (const [, b] of abnormal) {
      const last = merged[merged.length - 1];
      if (last && (b.ts - last.end) / 60000 <= mergeGapMin) {
        last.end = b.ts;
        last.calls += b.count;
        last.recs.push(...b.recs);
      } else {
        merged.push({ start: b.ts, end: b.ts, calls: b.count, recs: [...b.recs] });
      }
    }

    for (const ev of merged) {
      const minutes = Math.max(1, (ev.end - ev.start) / 60000 + 1);
      const ratePerMin = ev.calls / minutes;
      const models = {};
      for (const r of ev.recs) models[r.model || "?"] = (models[r.model || "?"] || 0) + 1;
      events.push({
        keyId: kid,
        displayName: displayNameOf(keyMap, kid),
        start: ev.start,
        end: ev.end,
        startIso: new Date(ev.start).toISOString(),
        endIso: new Date(ev.end).toISOString(),
        calls: ev.calls,
        ratePerMin,
        models: Object.entries(models).sort((a, b) => b[1] - a[1]),
        pctOfKey: Math.round((ev.calls / list.length) * 1000) / 10,
        threshold,
        avgRate: avgPerMin,
        windowMin: 1,
        records: ev.recs,
      });
    }
  }
  events.sort((a, b) => b.calls - a.calls);
  return events;
}

/* ---------------- 导出（Node / 浏览器通用） ---------------- */

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    RParser, parseServerResponse, analyzeHar,
    aggregateByKey, aggregateByTime, aggregateByModel,
    detectAnomalies,
    displayNameOf, shortKey, stripAccount, timeBucketKey,
  };
}
