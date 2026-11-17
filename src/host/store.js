/**
 * dsh-live-doc — document model shared by the agent tools and the browser panel.
 *
 * A document is a flat list of blocks. Each block has its own revision and an
 * author (`ai` or `user`), which is what makes concurrent editing safe: the
 * agent appends or rewrites the blocks it owns, the user edits any block, and
 * neither side ever has to hand its text back to the other through the chat.
 *
 * The store is intentionally a plain JSON file per document under
 * `$DSH_HOME/live-doc/`, written atomically. Plugin memory is a cache; the
 * files are the source of truth across restarts.
 *
 * @module dsh-live-doc/store
 */

import { randomBytes } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

/** Block kinds the editor and the DOCX writer understand. */
export const BLOCK_TYPES = new Set(['h1', 'h2', 'h3', 'p', 'ul', 'ol', 'quote', 'code', 'hr']);

/** Longest text a single block may hold. */
const MAX_BLOCK_CHARS = 40_000;
/** Longest user-edit journal kept per document. */
const MAX_PENDING = 200;

let counter = 0;

/** A short, collision-free id used for documents and blocks. */
function newId(prefix) {
  counter = (counter + 1) % 0xffff;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${randomBytes(3).toString('hex')}`;
}

/** Escape text for HTML text nodes and attribute values. */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Decode the entities the sanitizer itself may have produced. */
export function decodeEntities(value) {
  return String(value ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/** Only absolute web/mail links survive sanitization. */
function safeHref(raw) {
  const value = String(raw ?? '').trim();
  if (/^https?:\/\//i.test(value) || /^mailto:/i.test(value)) return value.slice(0, 2_000);
  return '';
}

/**
 * Reduce arbitrary pasted HTML to the small inline vocabulary the model and
 * the DOCX writer understand. Unknown tags are dropped, text is kept.
 * @param input - raw HTML from a contenteditable block.
 * @returns sanitized inline HTML.
 */
export function sanitizeHtml(input) {
  let html = String(input ?? '').slice(0, MAX_BLOCK_CHARS);
  if (html.length === 0) return '';
  html = html.replace(/<!--[\s\S]*?-->/g, '');
  html = html.replace(/<\s*(script|style|iframe|object|embed|link|meta|svg)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '');
  html = html.replace(/<\s*(script|style|iframe|object|embed|link|meta|svg)[^>]*\/?\s*>/gi, '');
  html = html.replace(/<\/?([a-zA-Z][a-zA-Z0-9:-]*)((?:\s[^>]*)?)>/g, (match, rawTag, rawAttrs) => {
    const tag = rawTag.toLowerCase();
    if (tag === 'br') return '<br>';
    const allowed = ['strong', 'b', 'em', 'i', 'u', 's', 'del', 'code', 'a'];
    if (!allowed.includes(tag)) return '';
    if (tag === 'a') {
      if (match.startsWith('</')) return '</a>';
      const href = /href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(rawAttrs ?? '');
      const safe = safeHref(href?.[1] ?? href?.[2] ?? href?.[3] ?? '');
      return safe.length > 0 ? `<a href="${escapeHtml(safe)}">` : '';
    }
    return match.startsWith('</') ? `</${tag}>` : `<${tag}>`;
  });
  return html.trim();
}

/**
 * Convert the small Markdown subset the agent writes into inline HTML.
 * @param text - markdown text for one block.
 * @returns sanitized inline HTML.
 */
export function mdToHtml(text) {
  let html = escapeHtml(String(text ?? '').slice(0, MAX_BLOCK_CHARS));
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  html = html.replace(/~~([^~]+)~~/g, '<s>$1</s>');
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
  html = html.replace(/\n/g, '<br>');
  return html.trim();
}

/**
 * Convert inline HTML back into the Markdown subset the agent reads.
 * @param html - sanitized inline HTML.
 * @returns markdown text.
 */
export function htmlToMd(html) {
  let text = String(html ?? '');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/?(strong|b)>/gi, '**');
  text = text.replace(/<\/?(em|i)>/gi, '*');
  text = text.replace(/<\/?(s|del)>/gi, '~~');
  text = text.replace(/<(u)>/gi, '<u>').replace(/<\/u>/gi, '</u>');
  text = text.replace(/<code>/gi, '`').replace(/<\/code>/gi, '`');
  text = text.replace(/<a\s+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, label) => `[${decodeEntities(label)}](${decodeEntities(href)})`);
  text = text.replace(/<[^>]+>/g, '');
  return decodeEntities(text).trim();
}

/** Plain text for word counts and compact readouts. */
export function htmlToText(html) {
  return decodeEntities(String(html ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).trim();
}

/** Render one block as a Markdown line. */
export function blockToMarkdown(block) {
  const text = htmlToMd(block.html);
  switch (block.type) {
    case 'h1': return `# ${text}`;
    case 'h2': return `## ${text}`;
    case 'h3': return `### ${text}`;
    case 'ul': return `- ${text}`;
    case 'ol': return `1. ${text}`;
    case 'quote': return `> ${text}`;
    case 'code': return `\`\`\`\n${text}\n\`\`\``;
    case 'hr': return '---';
    default: return text;
  }
}

/** Render the whole document as Markdown, keeping list runs compact. */
export function blocksToMarkdown(blocks) {
  let output = '';
  let previousType;
  let ordinal = 0;
  for (const block of blocks) {
    ordinal = block.type === 'ol' ? ordinal + 1 : 0;
    let line = blockToMarkdown(block);
    if (block.type === 'ol') line = line.replace(/^1\./, `${ordinal}.`);
    const listRun = (block.type === 'ul' || block.type === 'ol')
      && (previousType === 'ul' || previousType === 'ol');
    output += output.length === 0 ? line : `${listRun ? '\n' : '\n\n'}${line}`;
    previousType = block.type;
  }
  return output;
}

/**
 * Parse the Markdown subset into blocks. One non-empty line is one block;
 * blank lines separate paragraphs and are otherwise ignored. Fenced code
 * keeps its internal lines.
 * @param markdown - Markdown written by the agent.
 * @returns blocks without ids (the store assigns them).
 */
export function markdownToBlocks(markdown) {
  const source = String(markdown ?? '').replace(/\r\n?/g, '\n');
  const lines = source.split('\n');
  const blocks = [];
  let fence = null;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    if (fence !== null) {
      if (/^```/.test(line.trim())) {
        blocks.push({ type: 'code', html: mdToHtml(fence.join('\n')) });
        fence = null;
      } else {
        fence.push(line);
      }
      continue;
    }
    if (/^```/.test(line.trim())) {
      fence = [];
      continue;
    }
    if (line.trim().length === 0) continue;
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      blocks.push({ type: 'hr', html: '' });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading !== null) {
      const level = Math.min(heading[1].length, 3);
      blocks.push({ type: `h${level}`, html: mdToHtml(heading[2]) });
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet !== null) {
      blocks.push({ type: 'ul', html: mdToHtml(bullet[1]) });
      continue;
    }
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (numbered !== null) {
      blocks.push({ type: 'ol', html: mdToHtml(numbered[1]) });
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote !== null) {
      blocks.push({ type: 'quote', html: mdToHtml(quote[1]) });
      continue;
    }
    blocks.push({ type: 'p', html: mdToHtml(line.trim()) });
  }
  if (fence !== null) blocks.push({ type: 'code', html: mdToHtml(fence.join('\n')) });
  return blocks;
}

/** Normalize an agent- or UI-supplied block type. */
export function normalizeType(type) {
  const value = String(type ?? 'p').toLowerCase().trim();
  if (value === 'h4' || value === 'h5' || value === 'h6') return 'h3';
  if (value === 'bullet' || value === 'list') return 'ul';
  if (value === 'number' || value === 'numbered') return 'ol';
  if (value === 'paragraph' || value === 'text') return 'p';
  return BLOCK_TYPES.has(value) ? value : 'p';
}

/** Keep file names usable across platforms. */
export function safeFileName(title) {
  const cleaned = String(title ?? '')
    .replace(/[\\/:*?"<>|\n\r\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > 0 ? cleaned.slice(0, 80) : '协作文档';
}

/** Short preview text for the document list. */
function previewOf(blocks) {
  for (const block of blocks) {
    const text = htmlToText(block.html);
    if (text.length > 0) return text.slice(0, 60);
  }
  return '';
}

/** One shared document. */
export class DocumentStore {
  /** @param directory - directory holding one JSON file per document. */
  constructor(directory) {
    this.directory = directory;
    this.docs = new Map();
    this.activeId = undefined;
    this.busy = new Set();
    mkdirSync(this.directory, { recursive: true });
    this.#load();
  }

  /** Read every persisted document, newest first. */
  #load() {
    let names = [];
    try {
      names = readdirSync(this.directory).filter((name) => name.endsWith('.json'));
    } catch {
      return;
    }
    for (const name of names) {
      try {
        const doc = JSON.parse(readFileSync(path.join(this.directory, name), 'utf8'));
        if (typeof doc?.id !== 'string' || !Array.isArray(doc.blocks)) continue;
        doc.pending = Array.isArray(doc.pending) ? doc.pending : [];
        this.docs.set(doc.id, doc);
      } catch {
        // A damaged file must never keep the plugin from loading.
      }
    }
    const newest = this.#sorted()[0];
    this.activeId = newest?.id;
  }

  /** Persist one document atomically. */
  #save(doc) {
    const target = path.join(this.directory, `${doc.id}.json`);
    const temporary = `${target}.tmp`;
    writeFileSync(temporary, JSON.stringify(doc));
    renameSync(temporary, target);
  }

  /** Documents ordered by last change. */
  #sorted() {
    return [...this.docs.values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }

  /** Every document as a compact list entry. */
  list() {
    return this.#sorted().map((doc) => ({
      id: doc.id,
      title: doc.title,
      path: doc.path,
      rev: doc.rev,
      updatedAt: doc.updatedAt,
      exportedAt: doc.exportedAt,
      preview: previewOf(doc.blocks),
      active: doc.id === this.activeId,
    }));
  }

  /** The document the panel should show. */
  active() {
    return this.docs.get(this.activeId) ?? this.#sorted()[0];
  }

  /** Select the active document. */
  select(docId) {
    if (!this.docs.has(docId)) throw new Error(`文档不存在：${docId}`);
    this.activeId = docId;
    return this.docs.get(docId);
  }

  /**
   * Create a document.
   * @param options.title - display title.
   * @param options.file - target .docx path (absolute, or relative to `cwd`).
   * @param options.cwd - session working directory, used for relative paths.
   */
  create({ title, file, cwd } = {}) {
    const now = Date.now();
    const id = newId('doc');
    const resolvedTitle = String(title ?? '').trim() || '未命名文档';
    const base = cwd !== undefined && path.isAbsolute(String(file ?? '')) === false
      ? path.resolve(cwd, String(file))
      : String(file ?? '');
    const doc = {
      id,
      title: resolvedTitle.slice(0, 120),
      path: base.length > 0 ? base : undefined,
      cwd: cwd ?? undefined,
      createdAt: now,
      updatedAt: now,
      rev: 1,
      blocks: [],
      pending: [],
      exportedAt: undefined,
    };
    this.docs.set(id, doc);
    this.activeId = id;
    this.#save(doc);
    return doc;
  }

  /** Fetch a document or explain which ids exist. */
  require(docId) {
    const doc = docId !== undefined && docId !== null && docId !== ''
      ? this.docs.get(String(docId))
      : this.active();
    if (doc === undefined) throw new Error('还没有任何协作文档，请先用 doc_create 新建。');
    this.activeId = doc.id;
    return doc;
  }

  /** Mark a document as being written by the agent (drives the "AI 正在写" badge). */
  setBusy(docId, busy) {
    if (busy) this.busy.add(docId);
    else this.busy.delete(docId);
  }

  /** Whether the agent is inside a write call for this document. */
  isBusy(docId) {
    return this.busy.has(docId);
  }

  /** Append one block and return it. */
  #push(doc, block) {
    const item = {
      id: newId('b'),
      type: normalizeType(block.type),
      html: sanitizeHtml(block.html ?? ''),
      rev: doc.rev + 1,
      by: 'ai',
      ts: Date.now(),
    };
    doc.blocks.push(item);
    return item;
  }

  /** Append parsed blocks to a document. */
  append(docId, markdown) {
    const doc = this.require(docId);
    const parsed = markdownToBlocks(markdown);
    if (parsed.length === 0) throw new Error('markdown 为空，没有写入任何内容。');
    const added = parsed.map((block) => this.#push(doc, block));
    doc.rev += 1;
    doc.updatedAt = Date.now();
    this.#save(doc);
    return { doc, added };
  }

  /** Insert parsed blocks after a block id (or at the end). */
  insertAfter(docId, afterId, markdown) {
    const doc = this.require(docId);
    const parsed = markdownToBlocks(markdown);
    if (parsed.length === 0) throw new Error('markdown 为空，没有写入任何内容。');
    const index = afterId === undefined || afterId === '' || afterId === null
      ? doc.blocks.length
      : doc.blocks.findIndex((block) => block.id === afterId);
    if (index < 0) throw new Error(`找不到块 ${afterId}，请先 doc_read 查看当前块 id。`);
    const added = parsed.map((block) => {
      const item = {
        id: newId('b'),
        type: normalizeType(block.type),
        html: sanitizeHtml(block.html ?? ''),
        rev: doc.rev + 1,
        by: 'ai',
        ts: Date.now(),
      };
      return item;
    });
    doc.blocks.splice(index + 1, 0, ...added);
    doc.rev += 1;
    doc.updatedAt = Date.now();
    this.#save(doc);
    return { doc, added };
  }

  /**
   * Insert one raw block after a block id (or at the end). Used by the panel's
   * Enter key and "+ paragraph" control, where there is no Markdown to parse.
   */
  insertBlockAfter(docId, afterId, { type, html } = {}, by = 'user') {
    const doc = this.require(docId);
    const index = afterId === undefined || afterId === null || afterId === ''
      ? doc.blocks.length
      : doc.blocks.findIndex((block) => block.id === afterId);
    if (index < 0) throw new Error(`找不到块 ${afterId}。`);
    const block = {
      id: newId('b'),
      type: normalizeType(type),
      html: sanitizeHtml(html ?? ''),
      rev: doc.rev + 1,
      by,
      ts: Date.now(),
    };
    doc.blocks.splice(index + 1, 0, block);
    doc.rev += 1;
    doc.updatedAt = Date.now();
    this.#save(doc);
    return { doc, block };
  }

  /** Rewrite one block the agent owns. */
  replace(docId, blockId, markdown, expect) {
    const doc = this.require(docId);
    const block = doc.blocks.find((entry) => entry.id === blockId);
    if (block === undefined) throw new Error(`找不到块 ${blockId}，请先 doc_read 查看当前块 id。`);
    if (expect !== undefined && expect !== null && expect !== '') {
      const current = htmlToText(block.html);
      if (!current.includes(String(expect))) {
        throw new Error(`块 ${blockId} 当前内容是「${current.slice(0, 40)}」，与 expect「${String(expect).slice(0, 40)}」不一致；请重新 doc_read 后再改。`);
      }
    }
    const text = String(markdown ?? '').trim();
    if (block.type === 'hr') {
      block.type = 'p';
    }
    block.html = sanitizeHtml(mdToHtml(text));
    block.rev = doc.rev + 1;
    block.by = 'ai';
    block.ts = Date.now();
    doc.pending = doc.pending.filter((entry) => entry.blockId !== blockId);
    doc.rev += 1;
    doc.updatedAt = Date.now();
    this.#save(doc);
    return { doc, block };
  }

  /** Set a block's type without touching its text. */
  retype(docId, blockId, type) {
    const doc = this.require(docId);
    const block = doc.blocks.find((entry) => entry.id === blockId);
    if (block === undefined) throw new Error(`找不到块 ${blockId}。`);
    block.type = normalizeType(type);
    block.rev = doc.rev + 1;
    block.by = 'user';
    doc.rev += 1;
    doc.updatedAt = Date.now();
    this.#save(doc);
    return { doc, block };
  }

  /** Delete one block. */
  remove(docId, blockId) {
    const doc = this.require(docId);
    const index = doc.blocks.findIndex((entry) => entry.id === blockId);
    if (index < 0) throw new Error(`找不到块 ${blockId}。`);
    doc.blocks.splice(index, 1);
    doc.pending = doc.pending.filter((entry) => entry.blockId !== blockId);
    doc.rev += 1;
    doc.updatedAt = Date.now();
    this.#save(doc);
    return doc;
  }

  /** Rename a document. */
  rename(docId, title) {
    const doc = this.require(docId);
    const next = String(title ?? '').trim();
    if (next.length === 0) throw new Error('标题不能为空。');
    doc.title = next.slice(0, 120);
    doc.rev += 1;
    doc.updatedAt = Date.now();
    this.#save(doc);
    return doc;
  }

  /**
   * Apply a browser edit. The user's text always wins for that block; when the
   * agent changed the same block since the browser's base revision, the edit is
   * flagged as a conflict so the next `doc_read` can warn the model.
   * @returns the updated block, the document revision, and whether it conflicted.
   */
  patchFromUser(docId, blockId, html, baseRev) {
    const doc = this.require(docId);
    const block = doc.blocks.find((entry) => entry.id === blockId);
    if (block === undefined) throw new Error(`找不到块 ${blockId}，可能已被删除。`);
    const before = block.html;
    const next = sanitizeHtml(html);
    if (next === before) return { doc, block, conflict: false, changed: false };
    const conflict = typeof baseRev === 'number' && baseRev !== block.rev && block.by === 'ai';
    block.html = next;
    block.rev = doc.rev + 1;
    block.by = 'user';
    block.ts = Date.now();
    doc.rev += 1;
    doc.updatedAt = Date.now();
    doc.pending.push({
      blockId,
      before: before.slice(0, 8_000),
      after: next.slice(0, 8_000),
      at: Date.now(),
      conflict,
    });
    if (doc.pending.length > MAX_PENDING) doc.pending.splice(0, doc.pending.length - MAX_PENDING);
    this.#save(doc);
    return { doc, block, conflict, changed: true };
  }

  /**
   * Read a document, draining the user-edit journal.
   * @param docId - document id, or omitted for the active one.
   * @param options.markSeen - clear the journal after reading (default true).
   * @param options.withIds - include block ids in the rendered output.
   */
  read(docId, { markSeen = true, withIds = false } = {}) {
    const doc = this.require(docId);
    const edits = doc.pending.filter((entry) => entry.seen !== true);
    if (markSeen && edits.length > 0) {
      for (const entry of edits) entry.seen = true;
      this.#save(doc);
    }
    let markdown = '';
    let previousType = undefined;
    let ordinal = 0;
    for (const block of doc.blocks) {
      ordinal = block.type === 'ol' ? ordinal + 1 : 0;
      const rendered = blockToMarkdown(block);
      const numbered = block.type === 'ol' ? rendered.replace(/^1\./, `${ordinal}.`) : rendered;
      const line = withIds ? `[${block.id}|${block.type}|${block.by}] ${numbered}` : numbered;
      if (markdown.length === 0) markdown = line;
      else {
        const isList = (block.type === 'ul' || block.type === 'ol')
          && (previousType === 'ul' || previousType === 'ol');
        markdown += `${isList ? '\n' : '\n\n'}${line}`;
      }
      previousType = block.type;
    }
    return {
      doc,
      markdown,
      edits,
      wordCount: doc.blocks.reduce((total, block) => total + htmlToText(block.html).length, 0),
    };
  }

  /** Full state for the browser panel. */
  view(docId) {
    const doc = docId !== undefined ? this.require(docId) : this.active();
    if (doc === undefined) {
      return { doc: null, activeId: null, docs: this.list(), busy: false };
    }
    return {
      doc: {
        id: doc.id,
        title: doc.title,
        path: doc.path,
        rev: doc.rev,
        blocks: doc.blocks,
        updatedAt: doc.updatedAt,
        exportedAt: doc.exportedAt,
        pendingEdits: doc.pending.filter((entry) => entry.seen !== true).length,
      },
      activeId: doc.id,
      docs: this.list(),
      busy: this.isBusy(doc.id),
    };
  }

  /** Remember where a document was exported. */
  markExported(docId, filePath) {
    const doc = this.require(docId);
    // Keep a .docx destination as the document's default even after a Markdown
    // side-export: "导出 DOCX" must not start writing .md files by surprise.
    const current = String(doc.path ?? '').toLowerCase();
    const next = String(filePath ?? '').toLowerCase();
    if (!(current.endsWith('.docx') && (next.endsWith('.md') || next.endsWith('.markdown')))) {
      doc.path = filePath;
    }
    doc.exportedAt = Date.now();
    doc.updatedAt = Date.now();
    this.#save(doc);
    return doc;
  }

  /** Newest document mtime, for the panel's cheap "anything new?" probe. */
  probe() {
    const doc = this.active();
    if (doc === undefined) return { id: null, rev: 0, updatedAt: 0, count: this.docs.size };
    return { id: doc.id, rev: doc.rev, updatedAt: doc.updatedAt, count: this.docs.size };
  }
}
