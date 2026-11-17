# dsh-live-doc 1.0.0

**DeepSeek Harness 的实时协作文档插件：AI 在写，你同时改，改的是同一份文档；AI 下一次落笔前会读到你改过的版本。**

不用等整篇生成完、不用另存 Word、也不用把改动重新贴回对话。

## 这版有什么

- **实时面板**：对话右侧的「协作文档」面板随着 `doc_*` 调用即时出现内容；支持标题 1–3、正文、项目符号、编号、引用、代码、分隔线，以及加粗/斜体/下划线
- **同一份文档**：每段有独立修订号和作者；浏览器保存带 `baseRev`，两边同时改不会静默覆盖
- **编辑回读**：`doc_read` 返回「你改过哪几段」的改前/改后，AI 顺着你的版本写；`doc_replace` 用 `expect` 防止改错位置
- **8 个工具**：`doc_create` / `doc_append` / `doc_insert` / `doc_replace` / `doc_delete` / `doc_read` / `doc_export` / `doc_list`
- **零依赖 DOCX**：自带 OOXML 写入器，A4、宋体正文、1.5 倍行距、Word 标题样式、真正的项目符号/编号，不需要 Office 或 python-docx；也支持 `.md`
- **持久化**：每份文档一个 JSON，存在 `$DSH_HOME/live-doc/`（可用 `DSH_LIVE_DOC_DIR` 改目录），重启不丢
- **无遥测、不联网**

## 安装

```bash
# npm（发布后）
dsh plugin --profile web add dsh-live-doc

# 或直接从 GitHub
dsh plugin --profile web add github:jiayiliust-ops/dsh-live-doc
```

DSH 桌面版也可以走「插件 → 添加插件」。装完刷新一次页面，让浏览器半边注册。

要求：DSH `>= 0.2.1-rc.2 < 0.3.0`，Node `>= 22.19`。

## 快速开始

> 写一份课程论文，题目是……，我们边写边改。

AI 会新建协作文档并打开面板，一段一段写；你随时改；要成品时说「导出」，生成标准 `.docx`。

## 已知边界

- 只有文本块：表格、图片、脚注、页码、页眉页脚、分页没有建模
- 不导入已有的 `.docx`
- 面板跟随 profile 的当前活跃文档
- DOCX 使用保守默认版式，精细排版仍在 Word 里做

## 验证

21 个 `node:test` 用例覆盖块模型、冲突规则、插入顺序、编辑日志、DOCX 包结构、工具编译、清单与真实 Host 启动；CI 在 Node 22.19 和 24 上运行。

完整说明：[README.zh-CN.md](../README.zh-CN.md) · 实现细节：[docs/ARCHITECTURE.md](ARCHITECTURE.md) · 安全策略：[SECURITY.md](../SECURITY.md)
