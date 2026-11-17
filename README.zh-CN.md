# dsh-live-doc · 协作文档

**DeepSeek Harness 的实时协作文档插件。** AI 在写，你在改，改的是同一份文档；下一次 AI 动笔之前会先读到你改过的版本——不用等它写完、不用另存 Word、也不用把改动重新贴回对话。

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-0.2.x-4c6ef5.svg)](https://github.com/deepseek-ai/deepseek-harness)
[![Node](https://img.shields.io/badge/node-%3E%3D22.19-339933.svg)](package.json)

> English documentation: [README.md](README.md)

<p align="center"><img src="docs/hero.svg" alt="AI 在写，你在改，改的是同一份文档" width="860"></p>

## 为什么做这个

长文档一次性生成很难用：模型哗哗写完 5000 字，你读一遍、改三段，然后还得把每一处改动解释回去。这个插件把顺序倒过来：

- 文档在对话旁边的面板里，`doc_append` 一返回就能看到；
- AI 还在往下写的时候，你就能改任意一段；
- 下一次 `doc_read` 会带着「你改过哪几段」的改前/改后，AI 顺着你的版本写。

## 功能

- **左侧常驻入口**：左侧栏新增「协作文档」应用行，随时打开整页文档工作区，不需要先有对话；右侧浮层面板与标题栏按钮保留，用于边聊边改
- **段落级协作编辑**：标题 1–3、正文、项目符号、编号、引用、代码、分隔线；加粗/斜体/下划线；Enter 新建下一段，空段 Backspace 删除
- **同一份文档**：Agent 工具和浏览器面板读写同一个块列表；浏览器保存时带每段的 `baseRev`，两边同时改也不会静默覆盖
- **编辑日志**：`doc_read` 会报告「用户在你上次读取后改了 N 段」并给出改前/改后，提示模型以用户版本为准
- **防错位改写**：`doc_replace` 必须带 `expect` 前缀，段落文字对不上就拒绝，要求先重新读
- **零依赖 DOCX 导出**：自带 OOXML 写入器，生成真正的 `.docx`（A4、宋体正文、1.5 倍行距、Word 标题大纲、真项目符号/编号），不需要 Office、`python-docx` 或构建步骤；也支持 `.md`
- **重启不丢**：每份文档一个 JSON 文件，存在 `$DSH_HOME/live-doc/`；面板会重新打开你上次在改的那份
- **无遥测、不联网**：插件只和加载它的 DSH 宿主通信

## 要求

- DeepSeek Harness `>= 0.2.1-rc.2 < 0.3.0`（在 `0.2.2-rc.3` 的 Desktop profile 上验证）
- Node.js `>= 22.19.0`（DOCX 写入器用到 `node:zlib` 的 `crc32`）
- 没有其他运行时依赖；浏览器半边用宿主提供的 React 模块

## 安装

### DSH 桌面版

**插件 → 添加插件**，输入 `dsh-live-doc`。装完刷新一次页面（`Cmd+R` / `Ctrl+R`），让浏览器半边注册。

### 命令行

```bash
dsh plugin --profile web add dsh-live-doc
# 或者直接从 GitHub 安装：
dsh plugin --profile web add github:jiayiliust-ops/dsh-live-doc
```

如果插件管理器提示需要重启，就重启 DSH。

### 从本地目录

```bash
npm pack                       # 生成 dsh-live-doc-1.0.0.tgz
dsh plugin --profile web add file:/绝对路径/dsh-live-doc-1.0.0.tgz
```

这是最「抗折腾」的装法：profile 里保存自己的一份副本，之后移动或删除源码目录都不会影响插件。

## 快速开始

1. 这样提需求：

   > 写一份课程论文，题目是……，我们边写边改。

2. Agent 调 `doc_create`，右侧「协作文档」面板自动打开；也可以从左侧栏的「协作文档」打开整页工作区，或点会话标题栏的「协作文档」按钮。
3. Agent 每次 `doc_append` 写 1–3 段，你随时在面板里改。
4. Agent 继续写之前会先 `doc_read`，看到你的修改并顺着写。
5. 要成品时说一声，`doc_export` 导出 `<工作区>/<标题>.docx`；面板不关，再导出覆盖同一个文件。

面板上的「导出 DOCX」按钮会先等未保存的按键落盘，再导出。

## 工具

| 工具 | 作用 | 必填 |
| --- | --- | --- |
| `doc_create` | 新建文档并打开面板，可指定导出路径 | `title` |
| `doc_append` | 追加 Markdown 段落（标题/列表/引用/代码块） | `markdown` |
| `doc_insert` | 在某段之后插入，`after: "end"` 表示文末 | `after`、`markdown` |
| `doc_replace` | 重写一段，`expect` 防错位 | `blockId`、`markdown` |
| `doc_delete` | 删除一段 | `blockId` |
| `doc_read` | 读当前 Markdown + 未读的用户修改 | – |
| `doc_export` | 导出 `.docx` 或 `.md` | – |
| `doc_list` | 列出所有协作文档 | – |

所有工具都可以带 `docId`；不带就用面板当前打开的文档。

## 实现

一份文档是一个扁平的块列表：

```json
{ "id": "b_...", "type": "p", "html": "正文 <strong>加粗</strong>", "rev": 7, "by": "user", "ts": 1794... }
```

- 宿主为每个 profile 维护一个 `DocumentStore`，用原子写落到 `~/.dsh/live-doc/<docId>.json`
- 浏览器每 900 ms 轮询 `POST /live-doc/api/state`，渲染块列表
- 你的编辑通过 `POST /live-doc/api/patch` 回传，带这一段的 `baseRev`；如果这段在你读取后被 AI 改过，宿主保留你的文字、标记 `conflict`，并在模型下次读取时告知
- `doc_read` 取走待读编辑日志并返回改前/改后；Agent 自己 `doc_replace` 会清掉这一段的日志，避免改完后还反复报告旧改动
- 路由只接受同源、带 `x-live-doc: 1` 头的请求，并且位于 DSH 正常的浏览器认证之后

块模型、RPC 面、导出流水线详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## DOCX 输出

导出器自己拼整个包（`[Content_Types].xml`、关系、`document.xml`、`styles.xml`、`numbering.xml`、`settings.xml`、文档属性），再用 `node:zlib` 打成 zip。产物是标准 Word 文件：

- A4 纸张、2.54 cm 页边距
- 宋体 / Times New Roman 正文 12 pt、1.5 倍行距
- 标题 1–3 与引用是真正的 Word 样式
- 项目符号、编号走 `numbering.xml`
- 行内加粗、斜体、下划线、删除线、代码、超链接
- 围栏代码块是带底纹的等宽样式

## 数据与隐私

- 文档在 `$DSH_HOME/live-doc/`（默认 `~/.dsh/live-doc/`），一份文档一个 JSON；可用 `DSH_LIVE_DOC_DIR` 改目录
- 只有你或 Agent 明确要求时才导出；插件不会扫描磁盘上的 `.docx`
- 不联网、无遥测、不碰凭据

## 已知边界

- 只有文本块：表格、图片、脚注、页码、页眉页脚、分页都没有建模；这些交给 Word 或 DSH 自带的 Office 工具
- 不导入已有的 `.docx`；插件只管自己创建的文档
- 面板跟随 profile 的「当前活跃文档」，多个会话同时改不同文档时共用一个 active id
- DOCX 使用保守默认版式，精细排版仍在 Word 里做
- 更新插件后需要刷新一次页面

## 开发

没有构建步骤：宿主是普通 ESM，客户端是普通浏览器模块。

```bash
npm test          # node:test：store、DOCX 包、工具编译器、清单
node --check src/host/index.js
node --check src/client/index.js
```

对着运行中的实例迭代时，用本地目录安装，改完宿主代码后重新启用插件那一行；Node 会缓存已导入的 ESM 模块，最稳的是重启 DSH。见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

MIT © dsh-live-doc contributors
