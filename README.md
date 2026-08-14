# OpenCode AI 用量台 · HAR 分析器

解析 `opencode.ai/_server` 接口的 HAR 抓包数据，还原每个 **API key（key_xxx）** 的调用记录与消耗。
自动识别 `key_xxx → displayName` 映射、逐次调用明细、分钟/小时/天级聚合图表，并内置**异常分析**（分钟级高频调用检测）。

> 纯静态站点，全程浏览器本地解析，文件不会上传。可部署到 GitHub Pages。

---

## 快速开始

### Web 页面（推荐）

```bash
cd opencode-har-analyzer
python3 -m http.server 8080
# 浏览器打开 http://localhost:8080
```

直接双击 `index.html` 也可以正常使用（图表库与字体走 CDN，需网络）。

### Python 命令行

```bash
python3 parse_har.py opencode.ai.har                            # 控制台汇总
python3 parse_har.py opencode.ai.har --json out.json --csv records.csv   # 导出
```

---

## 如何生成 HAR 文件

导入页内附完整操作指引：

1. 打开浏览器开发者工具（`F12`）→ **Network** 面板 → 勾选 **Preserve log**；
2. 打开 `opencode.ai` 的**使用量（Usage）**页面；
3. 在**使用历史**中持续往下翻页，直到所有记录加载完（每次翻页会请求 `opencode.ai/_server`）；
4. 请求列表右键 → **Save all as HAR**，保存为 `.har` 文件。

> 只需保留含 `_server` 的请求，其他资源请求会自动忽略。

---

## 功能总览

| 模块 | 说明 |
|---|---|
| 全局时间区间筛选 | 顶栏开始/结束时间选择器，精确到秒，不能超出 HAR 数据跨度 |
| Key 全局筛选 | 右侧悬浮面板，chips 点选；顶栏按钮实时显示选中 key 的色点/名字/计数 |
| 调用磁带 | 每小时调用量堆叠色带，按 key 着色，峰值标注 |
| 统计卡 | 调用次数 / 成本 / 输入·输出 token / key 数 / 时间跨度 |
| 图表区 | 按时调用量、按时成本（小时/天切换）、按 key 汇总（指标切换）、按模型汇总 |
| 异常分析 | 分钟级调用次数检测，短时高频自动标记，可调参数、可展开明细；内置**测活标注**（短输入短输出调用识别，可调阈值） |
| Key 映射表 | `key_xxx → displayName`、删除状态、plan、调用数、成本 |
| 调用明细 | 全量记录：搜索 / 排序 / 分页 / 展开 key 信息 / 导出 CSV |
| 每日汇总 | 服务端 usage 统计（server-fn:0） |

---

## 详细功能

### 1. 全局时间区间筛选（精确到秒）

- 顶栏 `datetime-local` 选择器，支持秒级输入；
- 边界钳制在调用明细的实际时间跨度（最早/最晚记录时间戳），超出自动修正；
- 开始晚于结束自动交换；
- **全局联动**：磁带图、全部图表、统计卡、异常分析、明细表、每日汇总同步过滤；
- 所选区间无记录时给出提示。

### 2. Key 全局筛选（悬浮面板）

- 右侧固定悬浮面板，滚动页面时始终可见，可折叠（顶栏「Key 筛选」按钮或面板 `›` 收起）；
- 每个 key 一个 chip：颜色圆点 + displayName + 调用次数 + 成本，点击切换；
- 顶栏按钮实时反映选中状态：**色点列表 + 名字列表 + 计数（n/m）**，hover 看完整名字；
- 联动图表、明细表、异常分析；跨时间区间切换时保留选择。

### 3. 调用磁带（英雄图）

- 全宽每小时调用量堆叠柱，每列 = 一小时，颜色 = key；
- 峰值标注（最高小时调用量）；tooltip 显示每 key 分解与合计。

### 4. 统计卡

调用次数、总成本、输入 token、输出 token、涉及 key 数、时间跨度 —— 随全局筛选实时更新。

### 5. 图表区

| 图表 | 说明 |
|---|---|
| 按时调用量 | 堆叠柱状，粒度可切 **小时/天**，图例点选隐藏 |
| 按时成本消耗 | 同上，纵轴为成本 |
| 按 key 汇总 | 横向柱状，指标可切 **调用次数 / 输入 token / 输出 token / 成本** |
| 按模型汇总 | 调用次数柱 + 成本线双轴，tooltip 显示涉及 key |

### 6. 异常分析（分钟级）+ 测活标注

检测**短时间内多频次调用**，并标注**短输入短输出**的测活类调用：

- **算法**：按分钟统计每个 key 的调用次数，某分钟调用数 **≥ max(最少次数, 该 key 平均每分钟 × 倍率)** 即标记异常分钟；相邻异常分钟（间隔 ≤ 合并间隔）合并为一个异常事件；
- **参数**（卡片右上角可调）：合并间隔（分钟）、最少次数（次/分）、倍率（×）、**测活阈值**（输入 ≤ N、输出 ≤ N token）；
- **展示**：
  - 摘要卡：异常事件数、涉及 key、异常调用合计、最高频率（次/分）；
  - 异常表格：时间窗口（含持续时长）、key、调用次数、频率、模型分布、占该 key 总量 %；**点击行展开**窗口内调用明细，短输入短输出记录带 `测活` 徽标；
  - 异常时间线图表：每事件调用次数柱状，按 key 着色；
- **测活标注**：识别 `input ≤ 阈值 且 output ≤ 阈值` 的调用（典型如 ping / hi / hello 探活请求），按 key 聚合为表格：测活次数、占该 key 总调用比例、模型分布、token、成本，可展开明细；
- **调用明细表**新增「标注」列，每条短输入短输出记录以 `测活` 徽标标注；导出 CSV 附带 `liveness` 列（1/0）；
- **联动**：遵循全局 key 与时间区间筛选；无异常 / 未选 key 分别提示。

### 7. 调用明细表

- 列：时间、Key（displayName + 完整 keyID）、模型、Provider、输入/输出/推理/缓存 token、成本、Plan、**标注（测活）**、记录 ID；
- 顶部搜索框：按 displayName / keyID / 模型 / provider / ID 模糊匹配；
- 点击表头排序（时间/模型/输入/输出/成本）；
- 分页（每页 20/50/100/200），导出 CSV（UTF-8 BOM，Excel 直接打开）；
- 遵循全局 key 与时间区间筛选。

### 8. Key 映射与每日汇总

- **Key 汇总**：完整 `key_xxx ↔ displayName` 关系、删除状态徽标、plan、调用数、成本；
- **每日汇总**：服务端 usage 统计（日期 / 模型 / key / 成本）。

### 9. 成本单位

顶栏「成本单位」切换 **原始值 / 美元（÷1e6）**，全局生效。

---

## 解析原理

`opencode.ai/_server` 的响应是 SolidStart 的 **server-fn** 序列化格式：

```
;0x00001192;((self.$R=self.$R||{})["server-fn:0"]=[],($R=>$R[0]={...})($R["server-fn:0"]))
```

- `server-fn:0` 返回 **usage 每日汇总** + **keys 数组**（`id: key_xxx` ↔ `displayName`，含删除状态）；
- `server-fn:1..N` 返回逐次调用记录（`timeCreated / model / tokens / cost / keyID / enrichment.plan`）；
- `$R[n]` 为引用数组：`$R[n]=<值>` 赋值、裸 `$R[n]` 复用，用于对象去重。

`analyzer.js` / `parse_har.py` 内置完整的 `$R` 递归下降解析器，将上述格式还原为普通 JSON。
`displayName` 自动截取 `账户名 - 别名` 中的别名部分。

---

## 文件结构

```
opencode-har-analyzer/
├── index.html                # Web 页面（上传 HAR → 表格 + 图表 + 异常分析）
├── styles.css                # 设计系统（深色仪表盘主题）
├── analyzer.js               # 前端解析引擎（$R 序列化 + 聚合 + 异常检测，纯逻辑）
├── app.js                    # UI 逻辑（ECharts、分页、筛选、悬浮面板、异常模块）
├── parse_har.py              # Python 命令行分析脚本（同一套解析逻辑）
├── .github/workflows/
│   └── deploy-pages.yml      # GitHub Pages 自动部署
└── README.md
```

---

## 部署到 GitHub Pages

项目为纯静态站点，内置 GitHub Actions 工作流（`.github/workflows/deploy-pages.yml`）：

1. 推送到 GitHub（`main` 分支即自动构建）；
2. 仓库 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**；
3. 完成后访问 `https://<用户名>.github.io/<仓库名>/`；
4. 也可手动触发：Actions → Deploy to GitHub Pages → Run workflow。

> 图表库（ECharts）与字体通过 CDN 加载，在线访问需要网络。

---

## 数据说明

- 调用明细按 `timeCreated`（UTC）换算为浏览器本地时区后分桶与筛选；
- `cost` 为服务端原始数值（除以 1e6 约等于美元），界面可切换单位；
- 所有解析、聚合、异常检测均在浏览器本地完成，**文件不会上传到任何服务器**；
- 异常检测按 key 独立计算阈值，适配不同 key 的使用强度。
