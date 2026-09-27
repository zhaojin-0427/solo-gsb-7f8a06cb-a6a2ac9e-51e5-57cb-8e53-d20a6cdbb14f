# ICU 多语言消息审计

本地运行的多语言消息审计工具：粘贴一份基准和 1～4 份译文 JSON（均为**消息键 → ICU MessageFormat 字符串**的平铺对象），逐键比对并报告差异。数据不出本机。

技术栈：Node.js + Express + [`@formatjs/icu-messageformat-parser`](https://formatjs.github.io/docs/icu-messageformat-parser/)，前端为原生 HTML/CSS/JS，无构建步骤。

## 快速开始

### 方式一：Docker Compose（推荐）

```bash
docker compose up --build
```

### 方式二：纯 Docker

```bash
docker build -t icu-audit .
docker run --rm -p 3000:3000 icu-audit
```

### 方式三：本地 Node.js（≥ 18）

```bash
npm install
npm start
```

启动后打开 **http://localhost:3000**。

## 使用说明

1. 在「基准消息」中粘贴基准 JSON，例如：
   ```json
   {
     "app.title": "消息审计台",
     "inbox.summary": "{name}，你有 {count, plural, =0{没有新消息} other{# 条新消息}}。"
   }
   ```
2. 为每份译文（1～4 份）填写**语言代码**（如 `zh-CN`、`ja`）并粘贴译文 JSON。
3. 点击「开始审计」。也可以先点「填入示例」查看演示效果（示例数据同时存放在 `examples/` 目录）。
4. 结果按**语言 → 消息键**排序，可用下拉框或点击统计徽章**按错误类型筛选**。

## 审计规则

| 错误类型 | 说明 |
| --- | --- |
| 缺失消息 | 键存在于基准、不存在于译文 |
| 额外消息 | 键存在于译文、不存在于基准（该键若有语法错误会一并报告） |
| 语法错误 | 消息不是合法 ICU MessageFormat（含非字符串值）；基准与译文都会检查 |
| JSON 解析失败 | 整个文件不是合法 JSON / 不是平铺对象 / 语言代码重复 |
| 参数签名不一致 | 递归解析 `select` / `plural` / `selectordinal` 分支后，参数名或用法类型（普通、number、date、time、select、plural、selectordinal）与基准不同；译文在某结构路径整处新增/删除同名同类型分支节点（其余节点选项均完整）时，也按双侧数量差报此项 |
| 同名参数混用 | 同一消息内同一参数名以多种用法类型出现（基准与译文都会检查） |
| select 选项不一致 | 同一结构路径下该 `select` 的选项名集合与基准不一致 |
| 复数 =n 选项不一致 | 同一结构路径下该 `plural` / `selectordinal` 的显式 `=n` 选项与基准不一致 |
| 缺少 other 分支 | 复数类参数的每一处分支都需有 `other`（复数语言类别 zero/one/two/few/many 允许与基准不同） |

每条发现都会标明**语言、消息键、错误类型和差异详情**；分支类差异的详情中带「位置」，如 `g(select)=male › n(plural)（第 2 处）`。

### 结构路径与整处增删核对

- 结构路径覆盖**消息顶层**及**祖先全部为 `select`** 的 `select` / `plural` / `selectordinal` 节点（位于 `plural` 分支之下的节点暂不按结构路径核对，但仍参与参数与 `other` 自检）。
- 路径由各祖先的**参数名、类型、同层同名同类型出现序号和选项名**组成；选项的书写顺序不改变路径。
- 按**路径 + 当前参数名 + 类型**归组，核对基准与译文两侧的节点数量：不同路径的一增一减**不能相互抵消**。数量差计入「参数签名不一致」，详情列出语言、消息键、路径与基准、译文数量，如「路径 `g(select)=female › n(plural)`，n（plural）基准 1 处、译文 0 处」。
- 数量一致的已配对节点继续逐处检查 `select` 选项、显式 `=n` 和 `other`；其中复数语言类别仍可随语言变化。同层出现多对同名同类型节点时按出现序号一一配对。
- 若某参数名在一侧整体不存在（或类型已改变），只报参数名/用法差异，不重复报数量。

## 项目结构

```
├── server.js            # Express 服务：静态页面 + POST /api/audit
├── lib/audit.js         # 审计核心：ICU 解析、签名提取与比对
├── public/              # 原生前端（index.html / app.js / style.css）
├── test/audit.test.js   # 单元测试（node:test）
├── examples/            # 示例基准与译文
├── Dockerfile
└── docker-compose.yml
```

## 测试

```bash
npm test
```

## API

`POST /api/audit`

```json
{
  "baseline": "{\"a\":\"你好 {name}\"}",
  "translations": [
    { "lang": "ja", "messages": "{\"a\":\"こんにちは {name}\"}" }
  ]
}
```

响应：`{ findings: [{ language, key, type, detail }], summary: { <type>: <count> }, types: { <type>: 中文标签 } }`，`findings` 已按语言、键排序。
