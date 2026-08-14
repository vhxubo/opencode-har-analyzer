/* ===========================================================================
 * app.js — OpenCode AI 用量台 UI 逻辑
 * 上传 HAR → 解析 → 表格 + 图表（ECharts）
 * ==========================================================================*/

"use strict";

const $ = (id) => document.getElementById(id);

/* ---------- 常量 ---------- */

const KEY_COLORS = [
  "#f2a93b", "#3ed8b0", "#6ea8ff", "#e27bd8", "#93e06a",
  "#ff8a5c", "#b9a8ff", "#55cfe6", "#f0d15a", "#ff7eb0",
];

const STAT_ACCENTS = {
  calls: "#6ea8ff", cost: "#f2a93b", input: "#3ed8b0", output: "#e27bd8",
  keys: "#b9a8ff", span: "#55cfe6",
};

const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ---------- 状态 ---------- */

const state = {
  result: null,
  byKey: [],
  byTime: [],
  byModel: [],
  colorOf: new Map(),      // keyId -> 颜色
  visible: new Set(),      // 当前纳入统计的 keyId
  granularity: "hour",     // hour | day
  metric: "calls",         // calls | input | output | cost
  costUnit: "raw",         // raw | usd
  search: "",
  sortKey: "timeCreated",
  sortDir: "desc",
  page: 1,
  pageSize: 50,
  dateRange: { start: "", end: "" }, // YYYY-MM-DD，空串表示不过滤
  rangeMin: "",
  rangeMax: "",
};

/* ---------- 格式化 ---------- */

const fmtInt = (n) => (n ?? 0).toLocaleString("en-US");

function fmtCost(n) {
  if (state.costUnit === "usd") return "$" + (n / 1e6).toFixed(4);
  return fmtInt(n);
}
const costTitle = () => (state.costUnit === "usd" ? "成本 ($, ÷1e6)" : "成本 (原始值)");

function fmtTime(ts) {
  const d = new Date(ts);
  if (isNaN(d)) return ts || "—";
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtBucket(bucket) {
  return bucket; // 已按本地时区分桶: "YYYY-MM-DD HH:00" 或 "YYYY-MM-DD"
}

/* 本地时区 YYYY-MM-DD（日期部分） */
function localDateStr(d) {
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* 本地时区 YYYY-MM-DDTHH:mm:ss（精确到秒，datetime-local 格式） */
function localDateTimeStr(d) {
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/* 按全局时间区间过滤调用明细（空串 = 不限） */
function recordsInRange() {
  const { start, end } = state.dateRange;
  if (!start && !end) return state.result.records;
  return state.result.records.filter((r) => {
    const d = new Date(r.timeCreated);
    if (isNaN(d)) return true;
    const ts = localDateTimeStr(d);
    if (start && ts < start) return false;
    if (end && ts > end) return false;
    return true;
  });
}

function shortName(name, max = 24) {
  if (!name) return "—";
  return name.length > max ? name.slice(0, max - 1) + "…" : name;
}

/* ---------- Toast ---------- */

let toastTimer = null;
function toast(msg, isErr = false) {
  const el = $("toast");
  el.textContent = msg;
  el.className = "toast" + (isErr ? " err" : "") + " show";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
}

/* ---------- 数据装载 ---------- */

function loadHarFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const har = JSON.parse(reader.result);
      processHar(har, file.name);
    } catch {
      toast("HAR 解析失败：文件不是有效的 JSON", true);
    }
  };
  reader.readAsText(file);
}

function processHar(har, name) {
  toast("解析中…");
  setTimeout(() => {
    try {
      const result = analyzeHar(har);
      if (!result.records.length && result.keyMap.size === 0) {
        throw new Error("未找到 opencode.ai/_server 的响应数据");
      }
      state.result = result;
      // 初始化全局日期区间：以调用明细的实际时间跨度为边界
      const times = result.records.map((r) => new Date(r.timeCreated)).filter((d) => !isNaN(d));
      if (times.length) {
        state.rangeMin = localDateTimeStr(new Date(Math.min(...times)));
        state.rangeMax = localDateTimeStr(new Date(Math.max(...times)));
        state.dateRange = { start: state.rangeMin, end: state.rangeMax };
        for (const id of ["dateFrom", "dateTo"]) {
          $(id).min = state.rangeMin;
          $(id).max = state.rangeMax;
        }
        $("dateFrom").value = state.rangeMin;
        $("dateTo").value = state.rangeMax;
        $("dateRange").classList.remove("hidden");
      }
      buildDerived();
      // 先显示容器，再渲染图表：否则 ECharts 初始化时容器宽度为 0
      $("dropzone").classList.add("hidden");
      $("harGuide").classList.add("hidden");
      $("result").classList.remove("hidden");
      $("keyPanel").classList.remove("hidden");
      setKeyPanel(true);
      renderAll();
      // 布局稳定后强制刷新一次尺寸，避免首次宽度不足
      requestAnimationFrame(() =>
        setTimeout(() => Object.values(charts).forEach((c) => c.resize()), 30)
      );
      $("fileName").textContent = name;
      $("fileMeta").textContent =
        `${result.records.length} 条调用 · ${result.keyMap.size} 个 key · ${result.har.serverCalls} 次 server 请求`;
      if (result.errors.length) {
        toast(`解析完成，但有 ${result.errors.length} 条响应解析失败（已跳过）`);
      } else {
        toast(`解析完成：${result.records.length} 条调用 · ${result.keyMap.size} 个 key`);
      }
    } catch (err) {
      toast("分析失败：" + err.message, true);
    }
  }, 30);
}

/* ---------- 派生数据 ---------- */

function buildDerived() {
  const records = recordsInRange();
  const { keyMap } = state.result;
  state.byKey = aggregateByKey(records, keyMap);
  state.byTime = aggregateByTime(records, keyMap, state.granularity);
  state.byModel = aggregateByModel(records, keyMap);

  // 颜色：按 keyId 字典序稳定分配
  const sortedIds = [...keyMap.keys()].sort();
  state.colorOf = new Map();
  sortedIds.forEach((kid, i) => state.colorOf.set(kid, KEY_COLORS[i % KEY_COLORS.length]));

  // 保留用户已选的 key；新增 key 默认可见
  const ids = new Set(state.byKey.map((a) => a.keyId));
  if (!state.visible.size && ids.size) state.visible = new Set(ids);
  else state.visible = new Set([...state.visible].filter((k) => ids.has(k)));
}

/* ---------- ECharts 工具 ---------- */

const charts = {};
const chartResizeObs = new Map(); // el -> ResizeObserver：容器尺寸变化自动重绘，覆盖所有时机

function initChart(id) {
  if (typeof echarts === "undefined") {
    toast("图表库 (ECharts) 加载失败，请检查网络后刷新页面", true);
    return null;
  }
  const el = $(id);
  if (!charts[id]) {
    charts[id] = echarts.init(el, null, { renderer: "canvas" });
    // 容器尺寸变化（含 hidden→显示、窗口变化、字体加载）时自动 resize
    if (!chartResizeObs.has(el)) {
      const ro = new ResizeObserver(() => {
        if (charts[id]) charts[id].resize();
      });
      ro.observe(el);
      chartResizeObs.set(el, ro);
    }
    // 初始化时若容器尚未完成布局（宽度为 0），下一帧核对一次
    requestAnimationFrame(() => {
      if (charts[id] && el.offsetWidth > 0 && charts[id].getWidth() !== el.offsetWidth) {
        charts[id].resize();
      }
    });
  }
  return charts[id];
}


function baseTooltip(extra) {
  return Object.assign(
    {
      backgroundColor: "#182131",
      borderColor: "#31415c",
      borderWidth: 1,
      padding: [10, 14],
      textStyle: { color: "#e6ecf5", fontSize: 12 },
      confine: true,
    },
    extra || {}
  );
}

function keySeriesName(a) {
  return shortName(a.displayName, 20);
}

/* 按 key 的时间序列 series（堆叠） */
function timeSeries(buckets, visibleKeys, valueFn, displayFn, stack) {
  const perKey = new Map();
  for (const b of buckets) {
    for (const c of b.cells) {
      if (!visibleKeys.has(c.keyId)) continue;
      if (!perKey.has(c.keyId)) perKey.set(c.keyId, []);
      perKey.get(c.keyId).push(displayFn(valueFn(c)));
    }
  }
  return [...perKey.entries()].map(([kid, data]) => ({
    name: keySeriesName(state.byKey.find((a) => a.keyId === kid) || { displayName: kid }),
    type: "bar",
    stack,
    barMaxWidth: 26,
    itemStyle: { color: state.colorOf.get(kid) },
    emphasis: { focus: "series" },
    data,
  }));
}

/* ---------- 渲染：统计卡 ---------- */

function renderStats() {
  const recs = recordsInRange();
  const total = state.byKey.reduce(
    (s, a) => ({ cost: s.cost + a.cost, input: s.input + a.input, output: s.output + a.output }),
    { cost: 0, input: 0, output: 0 }
  );
  const times = recs.map((r) => new Date(r.timeCreated)).filter((d) => !isNaN(d));
  const minT = times.length ? Math.min(...times) : null;
  const maxT = times.length ? Math.max(...times) : null;

  const cards = [
    { k: "calls", label: "调用次数", value: fmtInt(recs.length), sub: `server 请求 ${state.result.har.serverCalls} 次` },
    { k: "cost", label: costTitle(), value: fmtCost(total.cost), sub: state.costUnit === "usd" ? "按 1e-6 换算" : "除以 1e6 可得美元" },
    { k: "input", label: "输入 token", value: fmtInt(total.input), sub: "含缓存读取" },
    { k: "output", label: "输出 token", value: fmtInt(total.output), sub: "含推理 token" },
    { k: "keys", label: "涉及 key", value: fmtInt(state.result.keyMap.size), sub: `${state.byKey.length} 个产生调用` },
    { k: "span", label: "时间跨度", value: minT && maxT ? localDateStr(new Date(minT)) : "—", sub: minT && maxT ? `至 ${fmtTime(maxT)}` : "" },
  ];
  $("stats").innerHTML = cards
    .map(
      (c) => `<div class="stat" style="--stat-accent:${STAT_ACCENTS[c.k]}">
        <div class="stat-label">${c.label}</div>
        <div class="stat-value" title="${c.value}">${c.value}</div>
        <div class="stat-sub">${c.sub}</div>
      </div>`
    )
    .join("");
}

/* ---------- 渲染：磁带图（每小时，按 key 堆叠） ---------- */

function renderTape() {
  const chart = initChart("tapeChart");
  if (!chart) return;
  const hourly = aggregateByTime(recordsInRange(), state.result.keyMap, "hour");
  const visibleKeys = state.visible;
  const buckets = hourly;
  const series = timeSeries(buckets, visibleKeys, (c) => c.calls, (v) => v, "tape");
  const totalPerBucket = buckets.map((b) =>
    b.cells.reduce((s, c) => s + (visibleKeys.has(c.keyId) ? c.calls : 0), 0)
  );
  const maxCalls = Math.max(1, ...totalPerBucket);

  const range = buckets.length
    ? `${fmtBucket(buckets[0].bucket)} → ${fmtBucket(buckets[buckets.length - 1].bucket)}`
    : "无数据";
  $("tapeRange").textContent = range;

  chart.setOption(
    {
      animation: !REDUCED,
      animationDuration: 600,
      tooltip: baseTooltip({
        trigger: "axis",
        axisPointer: { type: "shadow", shadowStyle: { color: "rgba(62,216,176,0.06)" } },
        formatter(params) {
          let html = `<div style="font-weight:600;margin-bottom:6px">${params[0].axisValue}</div>`;
          const rows = params
            .slice()
            .sort((a, b) => b.value - a.value)
            .filter((p) => p.value > 0);
          if (!rows.length) return html + "无调用";
          html += rows
            .map((p) => {
              return `<div style="display:flex;align-items:center;gap:6px;padding:2px 0">
                <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${p.color}"></span>
                <span>${p.seriesName}</span>
                <span style="margin-left:auto;font-family:var(--font-mono);font-weight:600">${fmtInt(p.value)} 次</span>
              </div>`;
            })
            .join("");
          html += `<div style="border-top:1px solid #31415c;margin-top:6px;padding-top:6px;font-family:var(--font-mono)">合计 ${fmtInt(params[0] ? totalPerBucket[params[0].dataIndex] ?? 0 : 0)} 次</div>`;
          return html;
        },
      }),
      grid: { left: 2, right: 2, top: 4, bottom: 18 },
      xAxis: {
        type: "category",
        data: buckets.map((b) => fmtBucket(b.bucket)),
        axisLine: { lineStyle: { color: "#31415c" } },
        axisTick: { show: false },
        axisLabel: { color: "#64748c", fontSize: 9, fontFamily: "JetBrains Mono", interval: "auto" },
      },
      yAxis: {
        type: "value",
        show: false,
        max: (v) => Math.ceil(v.max * 1.15),
      },
      series: series.length
        ? series
        : [{ name: "", type: "bar", data: [], itemStyle: { color: "#31415c" } }],
    },
    true
  );
  // 峰值标注：显示最大值
  const maxIdx = totalPerBucket.indexOf(Math.max(...totalPerBucket));
  chart.setOption({
    graphic: maxIdx >= 0 ? [
      {
        type: "text",
        right: 4,
        top: 0,
        style: {
          text: `峰值 ${fmtInt(totalPerBucket[maxIdx])} 次 · ${fmtBucket(buckets[maxIdx].bucket)}`,
          fill: "#64748c",
          font: "10px JetBrains Mono",
        },
      },
    ] : [],
  });
}

/* ---------- 渲染：图表 A / B（时间序列） ---------- */

function renderTimeCharts() {
  const buckets = state.byTime;
  const visibleKeys = state.visible;
  const gLabel = state.granularity === "hour" ? "小时" : "天";

  // A: 调用量
  const chartA = initChart("chartA");
  if (chartA) {
    $("chartATitle").textContent = `按时调用量（每${gLabel}）`;
    const series = timeSeries(buckets, visibleKeys, (c) => c.calls, (v) => v, "a");
    chartA.setOption(
      {
        animation: !REDUCED,
        tooltip: baseTooltip({
          trigger: "axis",
          axisPointer: { type: "shadow" },
          valueFormatter: (v) => fmtInt(v) + " 次",
        }),
        legend: {
          top: 0, type: "scroll", textStyle: { color: "#9aa8bc", fontSize: 11 },
          icon: "circle", itemWidth: 9, itemHeight: 9, itemGap: 14,
        },
        grid: { left: 46, right: 14, top: 34, bottom: 26 },
        xAxis: {
          type: "category",
          data: buckets.map((b) => fmtBucket(b.bucket)),
          axisLine: { lineStyle: { color: "#31415c" } },
          axisTick: { show: false },
          axisLabel: { color: "#9aa8bc", fontSize: 10, fontFamily: "JetBrains Mono", interval: "auto", rotate: buckets.length > 24 ? 40 : 0 },
        },
        yAxis: {
          type: "value",
          axisLabel: { color: "#9aa8bc", fontSize: 10, fontFamily: "JetBrains Mono" },
          splitLine: { lineStyle: { color: "rgba(49,65,92,0.35)" } },
        },
        dataZoom: buckets.length > 40 ? [{ type: "inside", start: 0, end: 100 }] : [],
        series,
      },
      true
    );
  }

  // B: 成本
  const chartB = initChart("chartB");
  if (chartB) {
    $("chartBTitle").textContent = `按时成本消耗（每${gLabel}）`;
    const series = timeSeries(buckets, visibleKeys, (c) => c.cost, (v) => v, "b");
    chartB.setOption(
      {
        animation: !REDUCED,
        tooltip: baseTooltip({
          trigger: "axis",
          axisPointer: { type: "shadow" },
          valueFormatter: (v) => fmtCost(v),
        }),
        legend: {
          top: 0, type: "scroll", textStyle: { color: "#9aa8bc", fontSize: 11 },
          icon: "circle", itemWidth: 9, itemHeight: 9, itemGap: 14,
        },
        grid: { left: 70, right: 14, top: 34, bottom: 26 },
        xAxis: {
          type: "category",
          data: buckets.map((b) => fmtBucket(b.bucket)),
          axisLine: { lineStyle: { color: "#31415c" } },
          axisTick: { show: false },
          axisLabel: { color: "#9aa8bc", fontSize: 10, fontFamily: "JetBrains Mono", interval: "auto", rotate: buckets.length > 24 ? 40 : 0 },
        },
        yAxis: {
          type: "value",
          axisLabel: { color: "#9aa8bc", fontSize: 10, fontFamily: "JetBrains Mono", formatter: (v) => fmtCost(v) },
          splitLine: { lineStyle: { color: "rgba(49,65,92,0.35)" } },
        },
        dataZoom: buckets.length > 40 ? [{ type: "inside", start: 0, end: 100 }] : [],
        series,
      },
      true
    );
  }
}

/* ---------- 渲染：图表 C（按 key 汇总，指标可切换） ---------- */

const METRIC_META = {
  calls: { label: "调用次数", fmt: (v) => fmtInt(v) + " 次" },
  input: { label: "输入 token", fmt: (v) => fmtInt(v) },
  output: { label: "输出 token", fmt: (v) => fmtInt(v) },
  cost: { label: "成本", fmt: (v) => fmtCost(v) },
};

function renderChartC() {
  const chart = initChart("chartC");
  if (!chart) return;
  const meta = METRIC_META[state.metric];
  $("chartCTitle").textContent = `按 key 汇总 · ${meta.label}`;
  const rows = state.byKey
    .filter((a) => state.visible.has(a.keyId))
    .map((a) => ({ name: a.displayName, kid: a.keyId, value: a[state.metric] }))
    .sort((a, b) => b.value - a.value);

  chart.setOption(
    {
      animation: !REDUCED,
      tooltip: baseTooltip({
        trigger: "axis",
        axisPointer: { type: "shadow" },
        formatter(params) {
          const p = params[0];
          const a = state.byKey.find((x) => x.keyId === p.data.kid);
          return `<div style="font-weight:600;margin-bottom:4px">${a ? a.displayName : ""}</div>
            <div style="font-family:var(--font-mono);font-size:11px;color:#9aa8bc;margin-bottom:6px">${p.data.kid}</div>
            ${meta.label}: <b style="font-family:var(--font-mono)">${meta.fmt(p.value)}</b>`;
        },
      }),
      grid: { left: 8, right: 60, top: 8, bottom: 26 },
      xAxis: {
        type: "value",
        axisLabel: { color: "#9aa8bc", fontSize: 10, fontFamily: "JetBrains Mono", formatter: (v) => fmtInt(v) },
        splitLine: { lineStyle: { color: "rgba(49,65,92,0.35)" } },
      },
      yAxis: {
        type: "category",
        data: rows.map((r) => shortName(r.name, 26)),
        axisLine: { lineStyle: { color: "#31415c" } },
        axisTick: { show: false },
        axisLabel: { color: "#9aa8bc", fontSize: 11 },
      },
      series: [
        {
          type: "bar",
          data: rows.map((r) => ({ value: r.value, kid: r.kid })),
          barMaxWidth: 22,
          itemStyle: {
            borderRadius: [0, 4, 4, 0],
            color: (p) => state.colorOf.get(p.data.kid) || "#31415c",
          },
          label: { show: true, position: "right", color: "#9aa8bc", fontSize: 10, fontFamily: "JetBrains Mono", formatter: (p) => fmtInt(p.value) },
        },
      ],
    },
    true
  );
}

/* ---------- 渲染：图表 D（按模型） ---------- */

function renderChartD() {
  const chart = initChart("chartD");
  if (!chart) return;
  const rows = state.byModel.filter((m) => m.calls > 0);
  chart.setOption(
    {
      animation: !REDUCED,
      tooltip: baseTooltip({
        trigger: "axis",
        axisPointer: { type: "shadow" },
        formatter(params) {
          const p = params[0];
          const m = rows[p.dataIndex];
          return `<div style="font-weight:600;margin-bottom:6px">${m.model}</div>
            <div>调用 <b style="font-family:var(--font-mono)">${fmtInt(m.calls)}</b> 次</div>
            <div>成本 <b style="font-family:var(--font-mono)">${fmtCost(m.cost)}</b></div>
            <div style="margin-top:4px;color:#9aa8bc;font-size:11px">${m.keys.join(" · ")}</div>`;
        },
      }),
      legend: {
        top: 0, textStyle: { color: "#9aa8bc", fontSize: 11 }, icon: "circle", itemWidth: 9, itemHeight: 9,
      },
      grid: { left: 46, right: 70, top: 34, bottom: 26 },
      xAxis: {
        type: "category",
        data: rows.map((r) => shortName(r.model, 16)),
        axisLine: { lineStyle: { color: "#31415c" } },
        axisTick: { show: false },
        axisLabel: { color: "#9aa8bc", fontSize: 10, fontFamily: "JetBrains Mono", rotate: rows.length > 4 ? 30 : 0 },
      },
      yAxis: [
        {
          type: "value", name: "调用", nameTextStyle: { color: "#64748c", fontSize: 10 },
          axisLabel: { color: "#9aa8bc", fontSize: 10, fontFamily: "JetBrains Mono" },
          splitLine: { lineStyle: { color: "rgba(49,65,92,0.35)" } },
        },
        {
          type: "value", name: "成本", nameTextStyle: { color: "#64748c", fontSize: 10 },
          axisLabel: { color: "#9aa8bc", fontSize: 10, fontFamily: "JetBrains Mono", formatter: (v) => fmtCost(v) },
          splitLine: { show: false },
        },
      ],
      series: [
        {
          name: "调用次数", type: "bar", data: rows.map((r) => r.calls),
          itemStyle: { color: "#6ea8ff", borderRadius: [3, 3, 0, 0] }, barMaxWidth: 30,
        },
        {
          name: "成本", type: "line", yAxisIndex: 1, data: rows.map((r) => r.cost),
          itemStyle: { color: "#f2a93b" }, lineStyle: { color: "#f2a93b", width: 2 },
          symbolSize: 6,
        },
      ],
    },
    true
  );
}

/* ---------- 渲染：key chips ---------- */

/* 顶栏「Key 筛选」按钮：显示当前选中的 key 色点、名字与计数 */
function updateKeyToggle() {
  const dots = $("kptDots");
  const names = $("kptNames");
  const cnt = $("kptCount");
  dots.innerHTML = "";
  names.textContent = "";
  names.title = "";
  if (!state.result || !state.byKey.length) {
    cnt.textContent = "";
    return;
  }
  const rows = [...state.byKey].sort((a, b) => b.cost - a.cost);
  const sel = rows.filter((a) => state.visible.has(a.keyId));
  for (const a of sel) {
    const d = document.createElement("span");
    d.className = "kpt-dot";
    d.style.background = state.colorOf.get(a.keyId) || "#64748c";
    d.title = a.displayName;
    dots.appendChild(d);
  }
  if (sel.length) {
    names.textContent = sel.map((a) => a.displayName).join("、");
    names.title = sel.map((a) => a.displayName).join("、");
  }
  cnt.textContent = `${sel.length}/${rows.length}`;
}

function renderChips() {
  const rows = [...state.byKey].sort((a, b) => b.cost - a.cost);
  $("keyChips").innerHTML = rows
    .map(
      (a) => `<button class="chip${state.visible.has(a.keyId) ? "" : " off"}" data-kid="${a.keyId}" style="--chip-color:${state.colorOf.get(a.keyId)}">
        <span class="dot"></span>
        <span class="chip-name">${a.displayName}</span>
        <span class="chip-count">${fmtInt(a.calls)} 次 · ${fmtCost(a.cost)}</span>
      </button>`
    )
    .join("");
  document.querySelectorAll("#keyChips .chip").forEach((el) => {
    el.addEventListener("click", () => {
      const kid = el.dataset.kid;
      if (state.visible.has(kid)) state.visible.delete(kid);
      else state.visible.add(kid);
      renderChips();
      updateKeyToggle();
      renderTape();
      renderTimeCharts();
      renderChartC();
      renderRecords();
      runAnomaly();
    });
  });
}

/* ---------- 渲染：异常分析 ---------- */

let anomEvents = [];
let anomExpanded = new Set(); // 展开的行索引
let anomOpts = {};           // 异常检测当前参数
let livenessOpts = { maxInput: 100, maxOutput: 100 }; // 测活阈值
let livenessRows = [];
let livenessExpanded = new Set(); // 展开的行索引

function runAnomaly() {
  if (!state.result) return;
  anomOpts = {
    mergeGapMin: parseInt($("anomGap").value, 10) || 1,
    minCalls: parseInt($("anomMin").value, 10) || 8,
    multiplier: parseInt($("anomMult").value, 10) || 3,
  };
  livenessOpts = {
    maxInput: parseInt($("liveIn").value, 10),
    maxOutput: parseInt($("liveOut").value, 10),
  };
  if (!(livenessOpts.maxInput >= 0)) livenessOpts.maxInput = 100;
  if (!(livenessOpts.maxOutput >= 0)) livenessOpts.maxOutput = 100;
  // 同时遵循全局日期区间与 key 筛选
  const recs = recordsInRange().filter((r) => state.visible.has(r.keyID || r.keyId || ""));
  anomEvents = detectAnomalies(recs, state.result.keyMap, anomOpts);
  livenessRows = detectLiveness(recs, state.result.keyMap, livenessOpts);
  anomExpanded.clear();
  livenessExpanded.clear();
  renderAnomaly(anomOpts);
}

function renderAnomaly(opts) {
  // 摘要卡
  const keys = new Set(anomEvents.map((e) => e.keyId));
  const totalCalls = anomEvents.reduce((s, e) => s + e.calls, 0);
  const maxRate = anomEvents.length ? Math.max(...anomEvents.map((e) => e.ratePerMin)) : 0;
  const cards = [
    { k: "calls", label: "异常事件", value: fmtInt(anomEvents.length), sub: "分钟级高频调用" },
    { k: "keys", label: "涉及 key", value: fmtInt(keys.size), sub: `间隔 ≤ ${opts.mergeGapMin} 分钟合并` },
    { k: "cost", label: "异常调用数", value: fmtInt(totalCalls), sub: "事件内合计" },
    { k: "span", label: "最高频率", value: maxRate ? maxRate.toFixed(1) : "—", sub: "次 / 分钟" },
  ];
  $("anomSummary").innerHTML = anomEvents.length
    ? `<div class="stats">${cards
        .map(
          (c) => `<div class="stat" style="--stat-accent:${STAT_ACCENTS[c.k]}">
            <div class="stat-label">${c.label}</div>
            <div class="stat-value">${c.value}</div>
            <div class="stat-sub">${c.sub}</div>
          </div>`
        )
        .join("")}</div>`
    : !state.visible.size
    ? `<p class="empty-note">⚠ 未选择任何 key，请在右侧「Key 筛选」面板勾选后再检测</p>`
    : `<p class="empty-note">✓ 所选 key 与时间区间内未检测到异常分钟（当前参数：每分钟 ≥ ${opts.minCalls} 次且 ≥ 均值 ${opts.multiplier} 倍）</p>`;

  renderAnomTable();
  renderAnomChart();
  renderLiveness();
}

function renderAnomTable() {
  const tbody = document.querySelector("#anomTable tbody");
  if (!anomEvents.length) {
    tbody.innerHTML = "";
    return;
  }
  tbody.innerHTML = anomEvents
    .map((e, idx) => {
      const color = state.colorOf.get(e.keyId) || "#64748c";
      const models = e.models.map(([m, c]) => `${m}×${c}`).join(" · ");
      const range = `${fmtTime(e.startIso)} ～ ${fmtTime(e.endIso)}`;
      return `<tr class="anom-row" data-idx="${idx}">
        <td><button class="anom-toggle" type="button" aria-label="展开详情">${anomExpanded.has(idx) ? "▾" : "▸"}</button></td>
        <td class="td-time">${range}<br><span class="kc-id">持续 ${((e.end - e.start) / 1000).toFixed(0)} 秒</span></td>
        <td>
          <div class="key-cell">
            <span class="dot" style="background:${color}"></span>
            <span><span class="kc-name">${e.displayName}</span><span class="kc-id">${e.keyId}</span></span>
          </div>
        </td>
        <td class="td-num" style="color:var(--red);font-weight:600">${fmtInt(e.calls)}</td>
        <td class="td-num">${e.ratePerMin.toFixed(1)}</td>
        <td class="mono-cell" style="font-size:11px;color:var(--text-2)">${models}</td>
        <td class="td-num">${e.pctOfKey}%</td>
      </tr>` + (anomExpanded.has(idx) ? renderAnomDetail(e, idx) : "");
    })
    .join("");

  tbody.querySelectorAll(".anom-row").forEach((tr) => {
    tr.addEventListener("click", () => {
      const idx = parseInt(tr.dataset.idx, 10);
      if (anomExpanded.has(idx)) anomExpanded.delete(idx);
      else anomExpanded.add(idx);
      renderAnomTable();
    });
  });
}

function renderAnomDetail(e, idx) {
  const recs = e.records.slice(0, 20);
  const rows = recs
    .map(
      (r) => `<tr class="anom-detail">
        <td></td>
        <td class="td-time">${fmtTime(r.timeCreated)}</td>
        <td class="mono-cell">${r.model || "—"}${isLivenessCall(r, livenessOpts) ? ' <span class="badge liveness">测活</span>' : ""}</td>
        <td class="td-num">${fmtInt(r.inputTokens)} / ${fmtInt(r.outputTokens)}</td>
        <td class="td-num">${fmtCost(r.cost)}</td>
        <td class="mono-cell" style="color:var(--text-3)" title="${r.id}">${shortName(r.id, 20)}</td>
        <td></td>
      </tr>`
    )
    .join("");
  const more = e.records.length > 20 ? `<tr class="anom-detail"><td colspan="7" class="meta" style="text-align:center">… 另有 ${e.records.length - 20} 条，共 ${e.records.length} 条</td></tr>` : "";
  return `<tr class="anom-detail-head"><td colspan="7" class="meta">窗口内调用明细（前 20 条 · 时间 / 模型 / 输入·输出 token / 成本 / id，<span class="badge liveness">测活</span> = 短输入短输出）</td></tr>` + rows + more;
}

function renderAnomChart() {
  const chart = initChart("anomChart");
  if (!chart) return;
  if (!anomEvents.length) {
    chart.clear();
    return;
  }
  const pad = (x) => String(x).padStart(2, "0");
  chart.setOption(
    {
      animation: !REDUCED,
      tooltip: baseTooltip({
        trigger: "axis",
        axisPointer: { type: "shadow" },
        formatter(params) {
          const e = anomEvents[params[0].dataIndex];
          return `<div style="font-weight:600;margin-bottom:4px">${e.displayName}</div>
            <div class="meta">${fmtTime(e.startIso)} ～ ${fmtTime(e.endIso)}</div>
            <div style="margin-top:6px">调用 <b style="font-family:var(--font-mono)">${fmtInt(e.calls)}</b> 次 · 频率 ${e.ratePerMin.toFixed(1)} 次/分</div>
            <div style="color:#9aa8bc;font-size:11px;margin-top:4px">${e.models.map(([m, c]) => `${m}×${c}`).join(" · ")}</div>`;
        },
      }),
      grid: { left: 46, right: 16, top: 12, bottom: 60 },
      xAxis: {
        type: "category",
        data: anomEvents.map((e) => {
          const d = new Date(e.start);
          return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
        }),
        axisLine: { lineStyle: { color: "#31415c" } },
        axisTick: { show: false },
        axisLabel: { color: "#9aa8bc", fontSize: 10, fontFamily: "JetBrains Mono", rotate: anomEvents.length > 6 ? 45 : 0 },
      },
      yAxis: {
        type: "value",
        name: "调用次数",
        nameTextStyle: { color: "#64748c", fontSize: 10 },
        axisLabel: { color: "#9aa8bc", fontSize: 10, fontFamily: "JetBrains Mono" },
        splitLine: { lineStyle: { color: "rgba(49,65,92,0.35)" } },
      },
      series: [
        {
          name: "异常窗口",
          type: "bar",
          barMaxWidth: 34,
          data: anomEvents.map((e) => e.calls),
          itemStyle: {
            borderRadius: [3, 3, 0, 0],
            color: (p) => state.colorOf.get(anomEvents[p.dataIndex].keyId) || "#e06a74",
          },
          label: { show: anomEvents.length <= 12, position: "top", color: "#9aa8bc", fontSize: 10, fontFamily: "JetBrains Mono" },
        },
      ],
    },
    true
  );
}

/* ---------- 渲染：测活标注（短输入短输出） ---------- */

function renderLiveness() {
  const totalCalls = livenessRows.reduce((s, r) => s + r.calls, 0);
  const totalCost = livenessRows.reduce((s, r) => s + r.cost, 0);
  const totalInput = livenessRows.reduce((s, r) => s + r.input, 0);
  const totalOutput = livenessRows.reduce((s, r) => s + r.output, 0);
  const maxPct = livenessRows.length ? Math.max(...livenessRows.map((r) => r.pctOfKey)) : 0;
  const cards = [
    { k: "calls", label: "测活调用", value: fmtInt(totalCalls), sub: `输入≤${livenessOpts.maxInput} 且 输出≤${livenessOpts.maxOutput} token` },
    { k: "keys", label: "涉及 key", value: fmtInt(livenessRows.length), sub: "短输入短输出调用" },
    { k: "cost", label: "测活成本", value: fmtCost(totalCost), sub: `输入 ${fmtInt(totalInput)} · 输出 ${fmtInt(totalOutput)} token` },
    { k: "span", label: "最高占比", value: maxPct ? `${maxPct}%` : "—", sub: "占该 key 总调用" },
  ];
  $("liveSummary").innerHTML = totalCalls
    ? `<div class="stats">${cards
        .map(
          (c) => `<div class="stat" style="--stat-accent:${STAT_ACCENTS[c.k]}">
            <div class="stat-label">${c.label}</div>
            <div class="stat-value">${c.value}</div>
            <div class="stat-sub">${c.sub}</div>
          </div>`
        )
        .join("")}</div>`
    : !state.visible.size
    ? `<p class="empty-note">⚠ 未选择任何 key，请在右侧「Key 筛选」面板勾选后再检测</p>`
    : `<p class="empty-note">✓ 所选 key 与时间区间内未发现短输入短输出调用（输入 ≤ ${livenessOpts.maxInput} 且 输出 ≤ ${livenessOpts.maxOutput} token）</p>`;
  renderLivenessTable();
}

function renderLivenessTable() {
  const tbody = document.querySelector("#livenessTable tbody");
  if (!livenessRows.length) {
    tbody.innerHTML = "";
    return;
  }
  tbody.innerHTML = livenessRows
    .map((r, idx) => {
      const color = state.colorOf.get(r.keyId) || "#64748c";
      const models = r.models.map(([m, c]) => `${m}×${c}`).join(" · ");
      const range = `${fmtTime(r.startIso)} ～ ${fmtTime(r.endIso)}`;
      return `<tr class="live-row" data-idx="${idx}">
        <td><button class="anom-toggle" type="button" aria-label="展开详情">${livenessExpanded.has(idx) ? "▾" : "▸"}</button></td>
        <td class="td-time">${range}<br><span class="kc-id">共 ${fmtInt(r.records.length)} 条</span></td>
        <td>
          <div class="key-cell">
            <span class="dot" style="background:${color}"></span>
            <span><span class="kc-name">${r.displayName}</span><span class="kc-id">${r.keyId}</span></span>
          </div>
        </td>
        <td class="td-num" style="color:var(--amber);font-weight:600">${fmtInt(r.calls)}</td>
        <td class="td-num">${r.pctOfKey}%</td>
        <td class="mono-cell" style="font-size:11px;color:var(--text-2)">${models}</td>
        <td class="td-num">${fmtInt(r.input)}</td>
        <td class="td-num">${fmtInt(r.output)}</td>
        <td class="td-num" style="color:var(--amber)">${fmtCost(r.cost)}</td>
      </tr>` + (livenessExpanded.has(idx) ? renderLivenessDetail(r, idx) : "");
    })
    .join("");

  tbody.querySelectorAll(".live-row").forEach((tr) => {
    tr.addEventListener("click", () => {
      const idx = parseInt(tr.dataset.idx, 10);
      if (livenessExpanded.has(idx)) livenessExpanded.delete(idx);
      else livenessExpanded.add(idx);
      renderLivenessTable();
    });
  });
}

function renderLivenessDetail(r, idx) {
  const recs = r.records.slice(0, 20);
  const rows = recs
    .map(
      (rec) => `<tr class="anom-detail">
        <td></td>
        <td class="td-time">${fmtTime(rec.timeCreated)}</td>
        <td class="mono-cell">${rec.model || "—"}</td>
        <td class="td-num">${fmtInt(rec.inputTokens)} / ${fmtInt(rec.outputTokens)}</td>
        <td class="td-num"></td>
        <td class="mono-cell" style="font-size:11px;color:var(--text-3)" title="${rec.id}">${shortName(rec.id, 20)}</td>
        <td class="td-num">${fmtInt(rec.inputTokens)}</td>
        <td class="td-num">${fmtInt(rec.outputTokens)}</td>
        <td class="td-num" style="color:var(--amber)">${fmtCost(rec.cost)}</td>
      </tr>`
    )
    .join("");
  const more = r.records.length > 20 ? `<tr class="anom-detail"><td colspan="9" class="meta" style="text-align:center">… 另有 ${r.records.length - 20} 条，共 ${r.records.length} 条</td></tr>` : "";
  return `<tr class="anom-detail-head"><td colspan="9" class="meta">测活调用明细（前 20 条 · 时间 / 模型 / 输入·输出 token / id / 成本）</td></tr>` + rows + more;
}

/* ---------- 渲染：key 映射表 ---------- */

function renderKeyMapTable() {
  const rows = state.byKey.length
    ? state.byKey.map((a) => {
        const info = state.result.keyMap.get(a.keyId) || {};
        return { keyId: a.keyId, displayName: info.displayName || a.displayName, deleted: !!info.deleted, plan: info.plan, calls: a.calls, cost: a.cost };
      })
    : [...state.result.keyMap.entries()].map(([keyId, info]) => ({
        keyId, displayName: info.displayName, deleted: !!info.deleted, plan: info.plan, calls: 0, cost: 0,
      }));
  rows.sort((a, b) => b.cost - a.cost);
  const tbody = document.querySelector("#keyMapTable tbody");
  tbody.innerHTML = rows
    .map(
      (r) => `<tr>
        <td class="mono-cell">${r.keyId}</td>
        <td>
          <div class="key-cell">
            <span class="dot" style="background:${state.colorOf.get(r.keyId) || "#64748c"}"></span>
            <span class="kc-name">${r.displayName}</span>
          </div>
        </td>
        <td>${r.deleted ? '<span class="badge deleted">已删除</span>' : '<span class="badge ok">正常</span>'}</td>
        <td>${r.plan ? `<span class="badge plan">${r.plan}</span>` : "—"}</td>
        <td class="td-num">${fmtInt(r.calls)}</td>
        <td class="td-num">${fmtCost(r.cost)}</td>
      </tr>`
    )
    .join("");
}

/* ---------- 渲染：调用明细表 ---------- */

function filteredRecords() {
  const q = state.search.trim().toLowerCase();
  return recordsInRange().filter((r) => {
    const kid = r.keyID || r.keyId || "";
    if (!state.visible.has(kid)) return false;
    if (!q) return true;
    const info = state.result.keyMap.get(kid) || {};
    return (
      (info.displayName || "").toLowerCase().includes(q) ||
      kid.toLowerCase().includes(q) ||
      (r.model || "").toLowerCase().includes(q) ||
      (r.provider || "").toLowerCase().includes(q) ||
      (r.id || "").toLowerCase().includes(q) ||
      ((r.enrichment && r.enrichment.plan) || "").toLowerCase().includes(q)
    );
  });
}

function renderRecords() {
  const list = filteredRecords();
  const dir = state.sortDir === "asc" ? 1 : -1;
  list.sort((a, b) => {
    let va = a[state.sortKey];
    let vb = b[state.sortKey];
    if (state.sortKey === "timeCreated") { va = String(va || ""); vb = String(vb || ""); }
    else { va = va || 0; vb = vb || 0; }
    if (va < vb) return -dir;
    if (va > vb) return dir;
    return 0;
  });

  const totalPages = Math.max(1, Math.ceil(list.length / state.pageSize));
  state.page = Math.min(state.page, totalPages);
  const start = (state.page - 1) * state.pageSize;
  const pageRows = list.slice(start, start + state.pageSize);

  const tbody = document.querySelector("#recordsTable tbody");
  tbody.innerHTML = pageRows
    .map((r) => {
      const kid = r.keyID || r.keyId || "";
      const info = state.result.keyMap.get(kid) || {};
      const color = state.colorOf.get(kid) || "#64748c";
      const plan = (r.enrichment && r.enrichment.plan) || "—";
      return `<tr>
        <td class="td-time">${fmtTime(r.timeCreated)}</td>
        <td>
          <div class="key-cell">
            <span class="dot" style="background:${color}"></span>
            <span>
              <span class="kc-name">${info.displayName || kid}</span>
              <span class="kc-id">${kid}</span>
            </span>
          </div>
        </td>
        <td class="mono-cell">${r.model || "—"}</td>
        <td class="mono-cell" style="color:var(--text-3)">${r.provider || "—"}</td>
        <td class="td-num">${fmtInt(r.inputTokens)}</td>
        <td class="td-num">${fmtInt(r.outputTokens)}</td>
        <td class="td-num" style="color:var(--text-3)">${fmtInt(r.reasoningTokens)}</td>
        <td class="td-num" style="color:var(--text-3)">${fmtInt(r.cacheReadTokens)}</td>
        <td class="td-num" style="color:var(--amber)">${fmtCost(r.cost)}</td>
        <td>${plan !== "—" ? `<span class="badge plan">${plan}</span>` : "—"}</td>
        <td>${isLivenessCall(r, livenessOpts) ? '<span class="badge liveness">测活</span>' : "—"}</td>
        <td class="mono-cell" style="color:var(--text-3)" title="${r.id}">${shortName(r.id, 24)}</td>
      </tr>`;
    })
    .join("");

  $("pageInfo").textContent = `共 ${fmtInt(list.length)} 条`;
  $("pageNum").textContent = `${state.page} / ${totalPages}`;
  $("prevBtn").disabled = state.page <= 1;
  $("nextBtn").disabled = state.page >= totalPages;
  updateSortHeaders();
}

function updateSortHeaders() {
  document.querySelectorAll("#recordsTable th.sortable").forEach((th) => {
    th.classList.remove("sorted-asc", "sorted-desc");
    if (th.dataset.sort === state.sortKey) th.classList.add(state.sortDir === "asc" ? "sorted-asc" : "sorted-desc");
  });
}

/* ---------- 渲染：每日汇总表 ---------- */

function renderDaily() {
  const tbody = document.querySelector("#dailyTable tbody");
  const sDay = state.dateRange.start ? state.dateRange.start.slice(0, 10) : "";
  const eDay = state.dateRange.end ? state.dateRange.end.slice(0, 10) : "";
  const rows = state.result.daily.filter((r) => {
    if (sDay && r.date < sDay) return false;
    if (eDay && r.date > eDay) return false;
    return true;
  });
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="meta" style="text-align:center;padding:18px">该 HAR 未包含服务端每日汇总（server-fn:0）</td></tr>`;
    return;
  }
  tbody.innerHTML = rows
    .map((r) => {
      const info = state.result.keyMap.get(r.keyId) || {};
      const color = state.colorOf.get(r.keyId) || "#64748c";
      return `<tr>
        <td class="mono-cell">${r.date}</td>
        <td class="mono-cell">${r.model}</td>
        <td>
          <div class="key-cell">
            <span class="dot" style="background:${color}"></span>
            <span class="kc-name">${info.displayName || r.keyId}</span>
            <span class="kc-id">${r.keyId}</span>
          </div>
        </td>
        <td class="td-num" style="color:var(--amber)">${fmtCost(r.totalCost)}</td>
      </tr>`;
    })
    .join("");
}

/* ---------- 渲染总入口 ---------- */

function renderAll() {
  renderStats();
  renderTape();
  renderTimeCharts();
  renderChartC();
  renderChartD();
  renderChips();
  updateKeyToggle();
  renderKeyMapTable();
  renderRecords();
  renderDaily();
  runAnomaly();
}

/* ---------- Key 悬浮面板 ---------- */

function setKeyPanel(open) {
  $("keyPanel").classList.toggle("collapsed", !open);
  document.body.classList.toggle("panel-open", open);
  $("keyPanelToggle").classList.toggle("active", open);
  $("keyPanelToggle").setAttribute("aria-expanded", open ? "true" : "false");
}

/* ---------- 导出 CSV ---------- */

function exportCSV() {
  const rows = filteredRecords();
  if (!rows.length) { toast("没有可导出的数据", true); return; }
  const head = ["time", "displayName", "keyID", "model", "provider", "inputTokens", "outputTokens", "reasoningTokens", "cacheReadTokens", "cost", "plan", "liveness", "id"];
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [head.map(esc).join(",")];
  for (const r of rows) {
    const kid = r.keyID || r.keyId || "";
    const info = state.result.keyMap.get(kid) || {};
    lines.push(
      [r.timeCreated, info.displayName || kid, kid, r.model, r.provider, r.inputTokens, r.outputTokens, r.reasoningTokens, r.cacheReadTokens, r.cost, (r.enrichment && r.enrichment.plan) || "", isLivenessCall(r, livenessOpts) ? 1 : 0, r.id].map(esc).join(",")
    );
  }
  const blob = new Blob(["\uFEFF" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `opencode-usage-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast(`已导出 ${rows.length} 条记录`);
}

/* ---------- 事件绑定 ---------- */

function bindEvents() {
  const dz = $("dropzone");
  const fi = $("fileInput");

  $("uploadBtn").addEventListener("click", () => fi.click());
  dz.addEventListener("click", () => fi.click());
  dz.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fi.click(); }
  });

  fi.addEventListener("change", () => {
    if (fi.files[0]) loadHarFile(fi.files[0]);
    fi.value = "";
  });

  ["dragenter", "dragover"].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("drag"); })
  );
  ["dragleave", "drop"].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("drag"); })
  );
  dz.addEventListener("drop", (e) => {
    const f = e.dataTransfer.files[0];
    if (f) loadHarFile(f);
  });

  $("keyPanelToggle").addEventListener("click", () => {
    setKeyPanel($("keyPanel").classList.contains("collapsed"));
  });
  $("kpClose").addEventListener("click", () => setKeyPanel(false));

  /* 全局日期区间：钳制在 HAR 数据跨度内，超出自动修正 */
  function applyRange() {
    const from = $("dateFrom");
    const to = $("dateTo");
    let vf = from.value || state.rangeMin;
    let vt = to.value || state.rangeMax;
    if (vf < state.rangeMin) vf = state.rangeMin;
    if (vf > state.rangeMax) vf = state.rangeMax;
    if (vt < state.rangeMin) vt = state.rangeMin;
    if (vt > state.rangeMax) vt = state.rangeMax;
    if (vf > vt) [vf, vt] = [vt, vf]; // 开始晚于结束则交换
    from.value = vf;
    to.value = vt;
    state.dateRange = { start: vf, end: vt };
    buildDerived();
    renderAll();
    if (!recordsInRange().length) toast("所选时间区间内没有调用记录", true);
  }
  $("dateFrom").addEventListener("change", applyRange);
  $("dateTo").addEventListener("change", applyRange);

  /* 异常分析参数调整 + 测活阈值调整 */
  for (const id of ["anomGap", "anomMin", "anomMult", "liveIn", "liveOut"]) {
    $(id).addEventListener("change", () => {
      runAnomaly();
      renderRecords(); // 同步刷新调用明细表的测活标注
    });
  }

  $("reloadBtn").addEventListener("click", () => {
    state.result = null;
    $("result").classList.add("hidden");
    $("dropzone").classList.remove("hidden");
    $("harGuide").classList.remove("hidden");
    $("keyPanel").classList.add("hidden");
    setKeyPanel(false);
    state.byKey = [];
    state.dateRange = { start: "", end: "" };
    $("dateRange").classList.add("hidden");
    updateKeyToggle();
    Object.values(charts).forEach((c) => c.dispose());
    chartResizeObs.forEach((ro) => ro.disconnect());
    chartResizeObs.clear();
    for (const k in charts) delete charts[k];
    window.scrollTo({ top: 0, behavior: REDUCED ? "auto" : "smooth" });
  });

  $("granularitySeg").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-g]");
    if (!btn) return;
    state.granularity = btn.dataset.g;
    document.querySelectorAll("#granularitySeg button").forEach((b) => b.classList.toggle("active", b === btn));
    state.byTime = aggregateByTime(recordsInRange(), state.result.keyMap, state.granularity);
    renderTimeCharts();
  });

  $("metricSeg").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-m]");
    if (!btn) return;
    state.metric = btn.dataset.m;
    document.querySelectorAll("#metricSeg button").forEach((b) => b.classList.toggle("active", b === btn));
    renderChartC();
  });

  $("costUnitSel").addEventListener("change", (e) => {
    state.costUnit = e.target.value;
    renderAll();
  });

  $("searchInput").addEventListener("input", (e) => {
    state.search = e.target.value;
    state.page = 1;
    renderRecords();
  });

  $("pageSizeSel").addEventListener("change", (e) => {
    state.pageSize = parseInt(e.target.value, 10);
    state.page = 1;
    renderRecords();
  });
  $("prevBtn").addEventListener("click", () => { state.page--; renderRecords(); });
  $("nextBtn").addEventListener("click", () => { state.page++; renderRecords(); });

  document.querySelectorAll("#recordsTable th.sortable").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (state.sortKey === key) state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
      else { state.sortKey = key; state.sortDir = key === "timeCreated" ? "desc" : "desc"; }
      state.page = 1;
      renderRecords();
    });
  });

  $("csvBtn").addEventListener("click", exportCSV);

  window.addEventListener("resize", () => Object.values(charts).forEach((c) => c.resize()));
}

document.addEventListener("DOMContentLoaded", () => {
  if (typeof echarts === "undefined") {
    toast("图表库 ECharts 未能从 CDN 加载，请检查网络后刷新", true);
  }
  bindEvents();
});
