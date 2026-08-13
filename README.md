# OpenCode AI 用量台 · HAR 分析器

解析 `opencode.ai/_server` 接口的 HAR 抓包数据，还原每个 **API key（key_xxx）** 的调用记录与消耗：
自动识别 `key_xxx → displayName` 映射、逐次调用明细、按小时/按天聚合的调用量与成本图表。

## 文件结构

```
opencode-har-analyzer/
├── index.html     # Web 页面（上传 HAR → 表格 + 图表）
├── styles.css     # 设计系统
├── analyzer.js    # 前端解析引擎（server-fn $R 序列化格式）
├── app.js         # UI 逻辑（ECharts 图表、分页、筛选、导出）
└── parse_har.py   # Python 命令行分析脚本（同一套解析逻辑）
```

## 方式一：Web 页面（推荐）

```bash
cd opencode-har-analyzer
python3 -m http.server 8080
# 浏览器打开 http://localhost:8080
```

> 直接双击打开 `index.html` 也可以正常使用。

使用：
1. 把浏览器 DevTools（Network 面板）导出的 `.har` 文件拖入页面，或点击上传；
2. 页面立即展示：
   - **调用磁带** —— 每小时调用量的堆叠色带，颜色 = key；
   - **统计卡** —— 调用次数 / 成本 / token / key 数 / 时间跨度；
   - **图表** —— 按时调用量、按时成本（可切 小时/天）、按 key 汇总（可切 调用/输入/输出/成本 指标）、按模型汇总；
   - **key_xxx → displayName 映射表** —— 完整标识每个 key 的 displayName 与删除状态；
   - **调用明细表** —— 全量记录，支持搜索、按列排序、分页、导出 CSV；
   - **每日汇总** —— 服务端 usage 统计。
3. 顶部「成本单位」可在 原始值 / 美元(÷1e6) 之间切换。

## 方式二：Python 命令行脚本

```bash
python3 parse_har.py opencode.ai.har                # 控制台汇总
python3 parse_har.py opencode.ai.har --json out.json --csv records.csv
```

输出：key 映射表、按 key / 按模型 / 按小时聚合、调用明细 CSV。

## 解析原理

`opencode.ai/_server` 的响应是 SolidStart 的 server-fn 序列化格式
（`;0x…;((self.$R=… )["server-fn:N"]=[],($R=>…)(…))`），其中：

- `server-fn:0` 返回 **usage 每日汇总** + **keys 数组**（`id: key_xxx` ↔ `displayName`）；
- `server-fn:1..N` 返回逐次调用记录（`timeCreated / model / tokens / cost / keyID`）。

`analyzer.js` / `parse_har.py` 内置 `$R` 引用数组解析器，把该格式还原为普通 JSON。

## 部署到 GitHub Pages

项目为纯静态站点，已内置 GitHub Actions 工作流（`.github/workflows/deploy-pages.yml`）：

1. 把仓库推送到 GitHub（推送到 `main` 分支即自动构建）；
2. 仓库 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**；
3. 等待 Actions 完成后，即可通过 `https://<用户名>.github.io/<仓库名>/` 访问；
4. 也可以手动触发：Actions → Deploy to GitHub Pages → Run workflow。

> 图表库（ECharts）与字体通过 CDN 加载，在线访问需要网络。

## 数据说明

- 调用明细按 `timeCreated`（UTC）换算为浏览器本地时区后分桶；
- `cost` 为服务端原始数值，单位可在界面中切换为美元（÷1e6）；
- 全程在浏览器本地解析，文件不会上传。
