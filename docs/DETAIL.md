# 协作文档 · dsh-live-doc

AI 在写，你在改，改的是**同一份文档**。右侧「协作文档」面板会随着 agent 的 `doc_*` 工具调用实时出现内容；你直接在段落里改字、加段、换样式，插件按段保存；agent 下一次 `doc_read` / `doc_append` 前读到的就是你改过的版本，不需要另存 Word 再贴回对话。

## 怎么用

1. 在对话里说「写一份……，我们边写边改」，或直接让我写报告 / 论文 / 方案。
2. agent 调 `doc_create` 新建文档，右侧面板自动打开；也可以点会话标题栏的「协作文档」按钮。
3. agent 用 `doc_append` 一段一段写，你随时点进去修改、加段落、换样式。
4. agent 继续写之前会先 `doc_read`，看到「用户在你上次读取后改了 N 段」，并顺着你的版本写。
5. 需要成品时说「导出」，agent 调 `doc_export` 生成 `.docx`；面板不关闭，你可以接着改，再导出会覆盖同一文件。

## Agent 工具

| 工具 | 作用 |
|---|---|
| `doc_create` | 新建文档并打开面板；可指定导出路径 |
| `doc_append` | 追加 Markdown 段落（标题 / 列表 / 引用 / 代码） |
| `doc_insert` | 在指定段之后插入，后面段落的 id 不变 |
| `doc_replace` | 重写某一段，`expect` 防止改错位置 |
| `doc_delete` | 删除某一段 |
| `doc_read` | 读当前全文 + 报告用户改过的段落（`withIds` 可带段 id） |
| `doc_export` | 导出 `.docx` 或 `.md` |
| `doc_list` | 列出本机所有协作文档 |

## 面板

- 入口：左侧栏的「协作文档」应用行（整页工作区，随时可开）；右侧浮层面板仍可从会话标题栏打开；agent 新建文档时浮层自动打开
- 头部：标题（可直接改）、同步状态（AI 正在写入 / 已同步 rev N）、文档切换、新建、导出 DOCX、收起
- 工具栏：正文 / 标题 1–3 / 项目符号 / 编号 / 引用 / 代码，B / I / U
- 正文：一块一段，Enter 新建下一段，空段 Backspace 删除；外面粘进来的文字只保留纯文本
- AI 改到你正在编辑的段落时保留你的文字，并提示「AI 改过这段，点击更新」

## 数据与边界

- 文档保存在 `$DSH_HOME/live-doc/`（默认 `~/.dsh/live-doc/`），一份文档一个 JSON；可用 `DSH_LIVE_DOC_DIR` 改目录
- 导出由你或 agent 触发，写到工作区里的 `.docx`；导出器自带 OOXML 写入，不依赖 Office
- 只支持本插件新建的协作文档，不解析已有的 `.docx`；已有文件仍可用 DSH 自带的 Office 工具处理
- 面板是单页滚动，不模拟 Word 的分页、页眉页脚和脚注；导出按 A4、宋体正文、1.5 倍行距生成，复杂版式需要在 Word 里再调
- 同一段同时被 AI 和用户改写时，以用户输入为准并通知模型，不会静默覆盖
- 没有网络请求、没有遥测

## 开发

```bash
npm test
node --check src/host/index.js
node --check src/client/index.js
```

源码与详细文档：<https://github.com/jiayiliust-ops/dsh-live-doc>
