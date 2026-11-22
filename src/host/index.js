/**
 * dsh-live-doc — Host half.
 *
 * Publishes:
 *   - the `doc_*` agent tools that create, extend, rewrite and export a live
 *     document while the browser panel shows it;
 *   - the `/live-doc/api/*` routes the panel calls to read state and to save the
 *     user's edits;
 *   - one system-prompt section explaining the co-editing contract.
 *
 * The important property: both sides read and write the same block list. When
 * the user edits a paragraph, the next `doc_read`/`doc_append` call already sees
 * it, so no "copy my version back into the chat" round trip is needed.
 *
 * @module dsh-live-doc
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DocumentStore, blockText, blocksToMarkdown, htmlToText, safeFileName } from './store.js';
import {
  MAX_IMAGE_BYTES,
  assetName,
  assetPath,
  isAssetSrc,
  isSafeAssetName,
  mimeOf,
  readAsset,
  saveAsset,
} from './assets.js';
import { buildDocx } from './docx.js';
import { defineTool } from './tool.js';

/** Loader row name; the client module id is the package name. */
export const name = 'live-doc';

/** Services the plugin needs from the profile. */
export const inject = ['tools', 'webServer', 'systemPrompt', 'workingDirectory'];

/** Where the document files live. */
function storeDirectory() {
  const override = process.env.DSH_LIVE_DOC_DIR;
  if (override !== undefined && override.length > 0) return override;
  const home = process.env.DSH_HOME && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : path.join(os.homedir(), '.dsh');
  return path.join(home, 'live-doc');
}

/** Whether a Markdown image target is a remote URL we leave alone. */
function isRemoteSrc(src) {
  return /^(https?:)?\/\//i.test(String(src ?? ''));
}

/**
 * Copy the images an agent referenced by local path into the document's asset
 * folder, so the panel can show them and the DOCX export can embed them.
 *
 * Markdown is the agent's normal input, and the useful thing it can write is a
 * workspace path (`![图](figures/f1.png)`) — a file it just generated. Files are
 * copied, never linked: the document then survives the workspace being moved.
 * @param store - the document store (for its directory).
 * @param docId - owning document.
 * @param blocks - parsed blocks about to be stored (mutated in place).
 * @param cwd - session working directory for relative paths.
 */
function importLocalImages(store, docId, blocks, cwd) {
  for (const block of blocks) {
    if (block.type !== 'image') continue;
    const src = String(block.src ?? '');
    if (src.length === 0 || isAssetSrc(src) || isRemoteSrc(src)) continue;
    const resolved = path.isAbsolute(src) ? src : path.resolve(cwd, src);
    if (!existsSync(resolved) || !statSync(resolved).isFile()) {
      throw new Error(`找不到图片文件：${src}（按工作区解析为 ${resolved}）。请确认路径存在，或改用 http(s) 图片地址。`);
    }
    if (statSync(resolved).size > MAX_IMAGE_BYTES) {
      throw new Error(`图片 ${src} 超过 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB，请先压缩。`);
    }
    const saved = saveAsset(store.directory, docId, readFileSync(resolved));
    block.src = saved.src;
    block.px = saved.px;
    block.py = saved.py;
    if (String(block.alt ?? '').length === 0) block.alt = path.basename(resolved);
  }
}

/** Short block-id list for tool results. */
function idsOf(blocks) {
  return blocks.map((block) => block.id).join(', ');
}

/** First text of a block, for edit summaries. */
function snippet(html, limit = 40) {
  const text = htmlToText(html).replace(/\s+/g, ' ');
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** Describe unseen user edits for the model. */
function describeEdits(edits) {
  if (edits.length === 0) return '';
  const lines = [`用户在你上次读取后改了 ${edits.length} 段（以用户版本为准）：`];
  for (const edit of edits.slice(0, 8)) {
    lines.push(`- ${edit.blockId}${edit.conflict ? '（与你的写入冲突，已保留用户版本）' : ''}：`
      + `「${snippet(edit.before, 30)}」→「${snippet(edit.after, 30)}」`);
  }
  if (edits.length > 8) lines.push(`…另有 ${edits.length - 8} 段`);
  lines.push('继续写之前先 doc_read 确认当前全文。');
  return lines.join('\n');
}

/** Agent-facing description shared by the writing tools. */
const COEDIT_NOTE = '用户可以在右侧「协作文档」面板里同时修改同一份文档；'
  + '每次写入后按 1–3 个自然段调用，不要一次贴完整篇长文，让用户能边看边改。';

/** Prompt section text. */
function promptSectionText() {
  return [
    '## 协作文档（dsh-live-doc）',
    '',
    '当用户要写 Word / 报告 / 论文 / 方案等成篇文档，或说「一起改」「边写边看」时，用 `doc_*` 工具把内容写进实时协作文档，而不是先写完再用 write_document 交文件。',
    '',
    '规则：',
    '- `doc_create` 新建 → 用 `doc_append` 分段写（每次 1–3 段，可按标题、正文逐步展开）；',
    '- 每次继续写之前先 `doc_read`：它会列出用户刚改过的段落（用户版本为准），先顺着用户的修改写；',
    '- 用户改过的段落（`by: "user"`）不要整段覆盖，除非用户明确要求重写；',
    '- 需要局部改时用 `doc_replace`（带 `expect` 防错位），插入用 `doc_insert`；',
    '- 插图：`![说明](相对工作区的图片路径)` 单独占一行，会复制进文档并嵌入导出的 .docx（也接受 http(s) 地址，但远程图片不会打进 DOCX）；',
    '- 表格：在 `doc_append` 里写标准 GFM 表格（`| 列 | 列 |` + `| --- | --- |`），面板里会显示成可编辑的真表格，导出时是 Word 表格；',
    '- 写完调用 `doc_export` 导出 .docx；导出后仍可继续在同一面板改，再导出会覆盖同一个文件。',
    '',
    '面板是实时的：工具一返回，用户就能看到新内容；用户改的字也会在下次工具调用时回到你这里。',
  ].join('\n');
}

/**
 * Plugin entry.
 * @param ctx - owning context.
 */
export function apply(ctx) {
  const store = new DocumentStore(storeDirectory());
  console.log(`[live-doc] 文档目录：${store.directory}；已加载 ${store.docs.size} 份`);

  /** Resolve the session working directory for a tool call. */
  async function cwdOf(exec) {
    if (exec?.agent !== undefined) {
      try {
        return await ctx.workingDirectory.ensure(exec.agent, exec.signal);
      } catch {
        // Fall through to the process directory.
      }
    }
    return process.cwd();
  }

  /** Wrap a write so the panel can show "AI 正在写入". */
  async function whileBusy(docId, task) {
    store.setBusy(docId, true);
    try {
      return await task();
    } finally {
      store.setBusy(docId, false);
    }
  }

  // ---- Agent tools -------------------------------------------------------

  ctx.inject(['tools'], (toolCtx) => {
    const disposers = [];

    disposers.push(toolCtx.tools.register(defineTool({
      name: 'doc_create',
      description: '新建一份实时协作文档，并让它在右侧「协作文档」面板中打开。之后用 doc_append 分段写内容，用户可以在面板里同时改。文件路径默认在工作区，导出时生成 .docx。',
      parameters: {
        title: { type: 'string', description: '文档标题，例如「课程论文：…」' },
        file: { type: 'string', description: '导出目标路径（可选，.docx 或 .md；相对路径按工作区解析）。留空则默认「工作区/标题.docx」' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      async execute(args, exec) {
        const cwd = await cwdOf(exec);
        const title = String(args.title ?? '').trim() || '未命名文档';
        const file = String(args.file ?? '').trim();
        const target = file.length > 0
          ? (path.isAbsolute(file) ? file : path.resolve(cwd, file))
          : path.join(cwd, `${safeFileName(title)}.docx`);
        const doc = store.create({ title, file: target, cwd });
        return [
          `已新建协作文档《${doc.title}》。`,
          `docId: ${doc.id}`,
          `导出目标：${target}`,
          '右侧面板已打开。请用 doc_append 分段写第一段，用户会实时看到。',
        ].join('\n');
      },
    })));

    disposers.push(toolCtx.tools.register(defineTool({
      name: 'doc_append',
      description: `向协作文档末尾追加内容。参数 markdown 支持 # / ## / ### 标题、- 列表、1. 编号、> 引用、\`\`\` 代码块、GFM 表格（| 列 | + | --- |）、单独一行的 ![说明](图片路径)（工作区相对路径会被复制进文档）和行内 **加粗** *斜体* \`代码\` [链接](url)；一行一个段落。${COEDIT_NOTE}`,
      parameters: {
        docId: { type: 'string', description: '文档 id；留空则用当前面板里的文档' },
        markdown: { type: 'string', required: true, description: '要追加的 Markdown 文本（一行一段，可含标题/列表/表格/图片）' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      async execute(args, exec) {
        const doc = store.require(args.docId);
        const cwd = await cwdOf(exec);
        return whileBusy(doc.id, async () => {
          const before = doc.rev;
          const { doc: next, added } = store.append(
            doc.id,
            String(args.markdown ?? ''),
            (parsed) => importLocalImages(store, doc.id, parsed, cwd),
          );
          const edits = next.pending.filter((entry) => entry.seen !== true);
          const lines = [
            `已追加 ${added.length} 段到《${next.title}》：${idsOf(added)}`,
            `revision ${before} → ${next.rev}；面板已实时更新。`,
          ];
          if (edits.length > 0) lines.push('', describeEdits(edits));
          return lines.join('\n');
        });
      },
    })));

    disposers.push(toolCtx.tools.register(defineTool({
      name: 'doc_insert',
      description: '在指定段落之后插入内容（不改动后面的段落 id）。适合在已有小节中间补写。',
      parameters: {
        docId: { type: 'string', description: '文档 id；留空则用当前文档' },
        after: { type: 'string', required: true, description: '插在这一段之后；用 "end" 表示文末' },
        markdown: { type: 'string', required: true, description: '要插入的 Markdown 文本' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      async execute(args, exec) {
        const doc = store.require(args.docId);
        const cwd = await cwdOf(exec);
        return whileBusy(doc.id, async () => {
          const after = String(args.after ?? '').trim() === 'end' ? undefined : String(args.after ?? '');
          const { doc: next, added } = store.insertAfter(
            doc.id,
            after,
            String(args.markdown ?? ''),
            (parsed) => importLocalImages(store, doc.id, parsed, cwd),
          );
          return `已插入 ${added.length} 段（${idsOf(added)}）到《${next.title}》，revision ${next.rev}。`;
        });
      },
    })));

    disposers.push(toolCtx.tools.register(defineTool({
      name: 'doc_replace',
      description: '重写某一段的内容（保留段落 id 和类型）。expect 是该段当前开头的一小段文字，对不上会拒绝，避免改错位置。',
      parameters: {
        docId: { type: 'string', description: '文档 id；留空则用当前文档' },
        blockId: { type: 'string', required: true, description: '要改的段 id，从 doc_read（withIds）获得' },
        markdown: { type: 'string', required: true, description: '新的段落文本（行内 Markdown 即可，不要多段）' },
        expect: { type: 'string', description: '该段当前开头文字，用于防错位（推荐填写）' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      async execute(args) {
        const doc = store.require(args.docId);
        return whileBusy(doc.id, async () => {
          const { doc: next, block } = store.replace(doc.id, String(args.blockId ?? ''), String(args.markdown ?? ''), args.expect);
          return `已改写 ${block.id}（《${next.title}》），revision ${next.rev}。`;
        });
      },
    })));

    disposers.push(toolCtx.tools.register(defineTool({
      name: 'doc_delete',
      description: '删除一段。用户手动改过的段落删除前先用 doc_read 确认。',
      parameters: {
        docId: { type: 'string', description: '文档 id；留空则用当前文档' },
        blockId: { type: 'string', required: true, description: '要删除的段 id' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      async execute(args) {
        const doc = store.require(args.docId);
        return whileBusy(doc.id, async () => {
          const next = store.remove(doc.id, String(args.blockId ?? ''));
          return `已删除 ${String(args.blockId ?? '')}，《${next.title}》现在 ${next.blocks.length} 段，revision ${next.rev}。`;
        });
      },
    })));

    disposers.push(toolCtx.tools.register(defineTool({
      name: 'doc_read',
      description: '读取协作文档当前全文（Markdown），并报告用户在你上次读取后手动改了哪些段。继续写作前先调用它，以用户的修改为准。',
      parameters: {
        docId: { type: 'string', description: '文档 id；留空则用当前文档' },
        withIds: { type: 'boolean', description: '是否在每段前标出 [段id|类型|作者]，便于之后 doc_replace/doc_delete' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      async execute(args) {
        const doc = store.require(args.docId);
        const result = store.read(doc.id, { withIds: args.withIds === true, markSeen: true });
        const lines = [
          `# ${result.doc.title}`,
          `docId: ${result.doc.id} · revision ${result.doc.rev} · ${result.doc.blocks.length} 段 · 约 ${result.wordCount} 字`,
          '',
        ];
        const edits = describeEdits(result.edits);
        if (edits.length > 0) lines.push(edits, '');
        lines.push(result.markdown.length > 0 ? result.markdown : '（空文档）');
        return lines.join('\n');
      },
    })));

    disposers.push(toolCtx.tools.register(defineTool({
      name: 'doc_export',
      description: '把协作文档导出成 .docx（或 .md）。导出不会关闭面板：用户还可以继续改，再导出会覆盖同一个文件。',
      parameters: {
        docId: { type: 'string', description: '文档 id；留空则用当前文档' },
        file: { type: 'string', description: '目标路径；留空用创建时的路径（默认「工作区/标题.docx」）' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      async execute(args, exec) {
        const doc = store.require(args.docId);
        const cwd = await cwdOf(exec);
        const raw = String(args.file ?? '').trim();
        const target = raw.length > 0
          ? (path.isAbsolute(raw) ? raw : path.resolve(cwd, raw))
          : (doc.path ?? path.join(cwd, `${safeFileName(doc.title)}.docx`));
        exportDocument(doc, target);
        return `已导出《${doc.title}》（revision ${doc.rev}，${doc.blocks.length} 段）到：${target}\n面板仍然打开，用户可以继续改，再次导出会覆盖该文件。`;
      },
    })));

    disposers.push(toolCtx.tools.register(defineTool({
      name: 'doc_list',
      description: '列出本机所有协作文档（标题、段数、最近修改、导出路径），以及当前面板打开的是哪一份。',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      async execute() {
        const docs = store.list();
        if (docs.length === 0) return '还没有协作文档。用 doc_create 新建一份。';
        const lines = ['协作文档：'];
        for (const doc of docs) {
          const when = new Date(doc.updatedAt).toLocaleString('zh-CN', { hour12: false });
          lines.push(`- ${doc.active ? '▶ ' : ''}${doc.title}（${doc.id}，rev ${doc.rev}，${when}）${doc.path !== undefined ? ` → ${doc.path}` : ''}`);
          if (doc.preview.length > 0) lines.push(`  ${doc.preview}`);
        }
        return lines.join('\n');
      },
    })));

    toolCtx.effect(() => () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose();
        } catch {
          // Disposal is best-effort.
        }
      }
    }, 'live-doc: tools');
  });

  // ---- Prompt section ----------------------------------------------------

  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.systemPrompt.section({
      name: 'live-doc:coedit',
      order: 6,
      text: () => promptSectionText(),
    });
  });

  // ---- Browser routes ----------------------------------------------------

  /** Read a bounded JSON body from a Node request. */
  function readBody(req, limit = 2_000_000) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > limit) {
          reject(new Error('请求体过大'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (text.trim().length === 0) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch {
          reject(new Error('请求体不是 JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  /** Write a JSON response. */
  function send(res, status, payload) {
    if (res.headersSent) return;
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(JSON.stringify(payload));
  }

  /** The directory the panel's new documents and default exports belong to. */
  function defaultCwd() {
    const value = ctx.workingDirectory?.defaultDirectory;
    return typeof value === 'string' && value.length > 0 ? value : process.cwd();
  }

  /** Resolve a browser-supplied export path against the document's workspace. */
  function resolveExport(doc, requested) {
    const raw = String(requested ?? '').trim();
    if (raw.length === 0) return doc.path ?? path.join(doc.cwd ?? defaultCwd(), `${safeFileName(doc.title)}.docx`);
    if (path.isAbsolute(raw)) return raw;
    return path.resolve(doc.cwd ?? defaultCwd(), raw);
  }

  /** Image extension of a stored asset name. */
  function assetExt(name) {
    const ext = String(name ?? '').split('.').pop()?.toLowerCase() ?? '';
    return ext === 'jpeg' ? 'jpg' : ext;
  }

  /**
   * Hand the DOCX writer the bytes for one `asset:` source.
   *
   * Remote images and missing files resolve to `undefined`, and the exporter
   * skips them: exporting a document must never make a network request.
   */
  function assetResolver(doc) {
    return (src) => {
      const name = assetName(src);
      if (name.length === 0) return undefined;
      const data = readAsset(store.directory, doc.id, name);
      return data === undefined ? undefined : { data, ext: assetExt(name) };
    };
  }

  /** Markdown with stored image links rewritten to absolute paths. */
  function markdownForExport(doc) {
    return blocksToMarkdown(doc.blocks).replace(
      /\(asset:([a-z0-9]+\.[a-z]+)\)/gi,
      (_match, name) => `(${assetPath(store.directory, doc.id, name)})`,
    );
  }

  /** Write one document to disk as .docx or .md, and remember the destination. */
  function exportDocument(doc, target) {
    mkdirSync(path.dirname(target), { recursive: true });
    const lower = target.toLowerCase();
    if (lower.endsWith('.md') || lower.endsWith('.markdown')) {
      writeFileSync(target, markdownForExport(doc), 'utf8');
    } else {
      writeFileSync(target, buildDocx({
        title: doc.title,
        blocks: doc.blocks,
        createdAt: doc.createdAt,
        resolveAsset: assetResolver(doc),
      }));
    }
    store.markExported(doc.id, target);
    return target;
  }

  /** One route method. */
  async function dispatch(method, body) {
    switch (method) {
      case 'state': {
        const docId = typeof body.docId === 'string' && body.docId.length > 0 ? body.docId : undefined;
        // A pane that names a document reads it without taking over the host's
        // active document; the pane with no id follows whatever is active.
        return store.view(docId, { select: docId === undefined });
      }
      case 'probe':
        return store.probe();
      case 'create': {
        const cwd = typeof body.cwd === 'string' && body.cwd.length > 0
          ? body.cwd
          : (store.active()?.cwd ?? defaultCwd());
        const doc = store.create({ title: body.title, cwd });
        return { doc: store.view(doc.id).doc, docs: store.list() };
      }
      case 'select': {
        store.select(String(body.docId ?? ''));
        return store.view(String(body.docId ?? ''));
      }
      case 'patch': {
        const value = body.rows !== undefined
          ? { rows: body.rows }
          : (body.alt !== undefined || body.width !== undefined
            ? { alt: body.alt, width: body.width }
            : { html: String(body.html ?? '') });
        const result = store.patchFromUser(String(body.docId ?? ''), String(body.blockId ?? ''), value, body.baseRev);
        return {
          ok: true,
          changed: result.changed,
          conflict: result.conflict,
          rev: result.doc.rev,
          block: result.block,
        };
      }
      case 'uploadImage': {
        const doc = store.require(body.docId);
        const match = /^data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(body.dataUrl ?? ''));
        if (match === null) throw new Error('图片数据不是 base64 data URL。');
        const saved = saveAsset(store.directory, doc.id, Buffer.from(match[1], 'base64'));
        const result = store.insertBlockAfter(doc.id, body.after, {
          type: 'image',
          src: saved.src,
          alt: String(body.alt ?? ''),
          px: saved.px,
          py: saved.py,
          width: 100,
        }, 'user');
        return { ok: true, rev: result.doc.rev, block: result.block };
      }
      case 'retype': {
        const result = store.retype(String(body.docId ?? ''), String(body.blockId ?? ''), String(body.type ?? 'p'));
        return { ok: true, rev: result.doc.rev, block: result.block };
      }
      case 'insertBlock': {
        const doc = store.require(body.docId);
        const result = store.insertBlockAfter(doc.id, body.after, {
          type: body.type,
          html: body.html,
          rows: body.rows,
          src: body.src,
          alt: body.alt,
          width: body.width,
        }, 'user');
        return { ok: true, rev: result.doc.rev, block: result.block };
      }
      case 'insertAfter': {
        const doc = store.require(body.docId);
        // `after: "end"` means append, exactly as the doc_insert tool documents.
        const after = String(body.after ?? '').trim() === 'end' ? undefined : body.after;
        const added = store.insertAfter(doc.id, after, String(body.markdown ?? ''));
        return { ok: true, rev: added.doc.rev, blocks: added.added };
      }
      case 'deleteBlock': {
        const doc = store.require(body.docId);
        const next = store.remove(doc.id, String(body.blockId ?? ''));
        return { ok: true, rev: next.rev };
      }
      case 'rename': {
        const doc = store.rename(String(body.docId ?? ''), String(body.title ?? ''));
        return { ok: true, title: doc.title, rev: doc.rev };
      }
      case 'export': {
        const doc = store.require(body.docId);
        const target = resolveExport(doc, body.file);
        exportDocument(doc, target);
        const stat = existsSync(target) ? statSync(target) : undefined;
        return { ok: true, path: target, bytes: stat?.size ?? 0, rev: doc.rev };
      }
      default:
        throw new Error(`未知方法：${method}`);
    }
  }

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: '/live-doc/api',
      handler: async (req, res) => {
        try {
          if (req.method !== 'POST') {
            send(res, 405, { error: '只接受 POST' });
            return;
          }
          const origin = req.headers.origin;
          const expected = typeof webCtx.webServer.getOrigin === 'function' ? webCtx.webServer.getOrigin() : undefined;
          if (typeof origin === 'string' && origin.length > 0 && typeof expected === 'string' && origin !== expected) {
            send(res, 403, { error: 'origin 不匹配' });
            return;
          }
          if (req.headers['x-live-doc'] !== '1') {
            send(res, 403, { error: '缺少 x-live-doc 头' });
            return;
          }
          const url = new URL(req.url ?? '/', 'http://localhost');
          const method = url.pathname.slice('/live-doc/api/'.length).replace(/\/+$/, '');
          // Only an image upload needs a large body; everything else stays small
          // so a malformed request cannot make the host buffer megabytes.
          const limit = method === 'uploadImage' ? 16 * 1024 * 1024 : 2_000_000;
          const body = await readBody(req, limit);
          const result = await dispatch(method, body);
          send(res, 200, result);
        } catch (error) {
          send(res, 400, { error: String(error?.message ?? error) });
        }
      },
    }), 'live-doc: routes');

    // Images are served over GET because `<img src>` cannot send the panel's
    // POST header. The route only ever reads inside one document's asset folder
    // (strict name shape + a document id that must already exist), and refuses
    // cross-site subresource loads, so it cannot become a general file reader.
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/live-doc/asset',
      handler: (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const docId = String(url.searchParams.get('doc') ?? '');
        const name = String(url.searchParams.get('name') ?? '');
        const site = req.headers['sec-fetch-site'];
        if (typeof site === 'string' && site.length > 0 && site !== 'same-origin' && site !== 'none') {
          res.statusCode = 403;
          res.end();
          return;
        }
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(docId) || !isSafeAssetName(name)) {
          res.statusCode = 404;
          res.end();
          return;
        }
        const data = readAsset(store.directory, docId, name);
        if (data === undefined) {
          res.statusCode = 404;
          res.end();
          return;
        }
        res.writeHead(200, {
          'content-type': mimeOf(name),
          'content-length': data.length,
          'cache-control': 'private, max-age=31536000, immutable',
        });
        res.end(req.method === 'HEAD' ? undefined : data);
      },
    }), 'live-doc: asset route');
  });
}
