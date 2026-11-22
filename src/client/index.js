/**
 * dsh-live-doc — browser half.
 *
 * One floating panel (plus a full-page workspace) with tabs, an optional split
 * pane, a floating outline, and the same block list the agent writes through.
 * Each pane polls `/live-doc/api/state` for its own document, merges server
 * blocks into the ones being typed on, and saves back with a per-block base
 * revision, so an agent write and a user edit can land on different paragraphs
 * without either side losing text.
 *
 * Images live in the document's asset folder and are served over GET; tables
 * are kept as a rectangular grid so the panel and the DOCX writer agree.
 */
window.__ModuleLoader__.load({
  id: 'dsh-live-doc',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useCallback } = React;

    // ---- text -----------------------------------------------------------
    const ZH = {
      title: '协作文档',
      open: '协作文档',
      close: '收起',
      create: '新建',
      export: '导出 DOCX',
      empty: '还没有打开的文档',
      emptyHint: '在对话里让我写一份文档，或者点「新建」自己起个头。',
      add: '＋ 段落',
      addImage: '＋ 图片',
      addTable: '＋ 表格',
      sync: '已同步',
      busy: 'AI 正在写入…',
      offline: '连接失败',
      saved: '已保存',
      words: '字',
      pending: '你的修改会在 AI 下次读取时出现',
      stale: 'AI 改过这段，点击更新',
      conflict: '这段刚被 AI 改过，已保留你的版本',
      exported: '已导出',
      copied: '路径已复制',
      newDoc: '未命名文档',
      outline: '目录',
      split: '分栏',
      unsplit: '取消分栏',
      figAlt: '图注',
      del: '删除',
      addRow: '＋ 行',
      addCol: '＋ 列',
      delRow: '删 行',
      delCol: '删 列',
      dropHint: '松开即可插入图片',
      upload: '插入图片…',
      copyPath: '复制路径',
      maximize: '放大',
      restore: '还原大小',
      dragHint: '拖动这里移动；双击复位；边缘和角可缩放',
      h1: '标题 1', h2: '标题 2', h3: '标题 3', p: '正文',
      ul: '项目符号', ol: '编号', quote: '引用', code: '代码', hr: '分隔线',
    };
    const EN = {
      title: 'Live document',
      open: 'Live document',
      close: 'Hide',
      create: 'New',
      export: 'Export DOCX',
      empty: 'No document open',
      emptyHint: 'Ask the agent to write one, or start a blank document.',
      add: '+ Paragraph',
      addImage: '+ Image',
      addTable: '+ Table',
      sync: 'Synced',
      busy: 'Agent is writing…',
      offline: 'Disconnected',
      saved: 'Saved',
      words: 'chars',
      pending: 'Your edits are visible to the agent on its next read',
      stale: 'The agent changed this paragraph — click to update',
      conflict: 'The agent changed this paragraph; your version was kept',
      exported: 'Exported',
      copied: 'Path copied',
      newDoc: 'Untitled document',
      outline: 'Outline',
      split: 'Split',
      unsplit: 'Unsplit',
      figAlt: 'Caption',
      del: 'Delete',
      addRow: '+ Row',
      addCol: '+ Col',
      delRow: 'Del row',
      delCol: 'Del col',
      dropHint: 'Drop to insert the image',
      upload: 'Insert image…',
      copyPath: 'Copy path',
      maximize: 'Maximize',
      restore: 'Restore size',
      dragHint: 'Drag here to move; double-click to reset; edges and corners resize',
      h1: 'Heading 1', h2: 'Heading 2', h3: 'Heading 3', p: 'Body',
      ul: 'Bulleted list', ol: 'Numbered list', quote: 'Quote', code: 'Code', hr: 'Divider',
    };
    let T = ZH;

    // ---- cross-slot store ----------------------------------------------
    const openState = { value: false, listeners: new Set(), lastAuto: null };
    function setOpenState(next) {
      if (openState.value === next) return;
      openState.value = next;
      for (const listener of openState.listeners) listener(next);
    }
    function useOpenState() {
      const [value, setValue] = useState(openState.value);
      useEffect(() => {
        openState.listeners.add(setValue);
        return () => openState.listeners.delete(setValue);
      }, []);
      return [value, setOpenState];
    }

    // ---- api -------------------------------------------------------------
    async function api(method, params) {
      const response = await fetch(`/live-doc/api/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-live-doc': '1' },
        body: JSON.stringify(params ?? {}),
      });
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        // fall through
      }
      if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`);
      return payload;
    }

    // ---- helpers ---------------------------------------------------------
    function textOf(html) {
      return String(html ?? '')
        .replace(/<br\s*\/?>/gi, '')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&');
    }

    /** Text of one block, table cells included. */
    function blockText(block) {
      if (block.type === 'table') {
        return (block.rows ?? []).map((row) => row.map((cell) => textOf(cell)).join(' ')).join(' ');
      }
      if (block.type === 'image') return String(block.alt ?? '');
      return textOf(block.html);
    }

    function wordCount(blocks) {
      return blocks.reduce((total, block) => total + blockText(block).replace(/\s+/g, '').length, 0);
    }

    /** The URL an image block's `src` should load from. */
    function assetUrl(docId, src) {
      const value = String(src ?? '');
      if (value.startsWith('asset:')) {
        const name = value.slice('asset:'.length);
        return `/live-doc/asset?doc=${encodeURIComponent(docId ?? '')}&name=${encodeURIComponent(name)}`;
      }
      return value;
    }

    /** Deep-enough copy of a table grid. */
    function cloneRows(rows) {
      return (Array.isArray(rows) ? rows : []).map((row) => (Array.isArray(row) ? row.slice() : []));
    }

    function DocumentIcon(size) {
      return h('svg', { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true, fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('path', { d: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z' }),
        h('path', { d: 'M14 3v5h5' }),
        h('path', { d: 'M9 13h6M9 17h4' }));
    }

    const CSS = `
.ld-toggle{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 10px;flex:none;white-space:nowrap;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}
.ld-toggle:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1)}
.ld-toggle.is-on{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-brand-primary)}
.ld-toggle .dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary);display:none}
.ld-toggle.has-doc .dot{display:block}
.ld-layer{position:fixed;inset:0;z-index:80;pointer-events:none}
.ld-layer.is-embedded{position:static;inset:auto;z-index:auto;pointer-events:auto;height:100%;min-height:0;display:flex}
.ld-layer.is-embedded .ld-panel{position:static;width:auto!important;min-width:0;max-width:none;height:100%;max-height:none;flex:1;border:0;border-radius:0;box-shadow:none}
.ld-main{height:100%;min-height:calc(100vh - 120px);display:flex;background:var(--dsw-alias-bg-base)}
.ld-panel{pointer-events:auto;position:absolute;display:flex;flex-direction:column;min-width:360px;min-height:280px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);border-radius:14px;box-shadow:0 24px 70px rgba(0,0,0,.32);overflow:hidden;color:var(--dsw-alias-label-primary);font-family:"PingFang SC","Microsoft YaHei",system-ui,sans-serif}
.ld-panel.is-maximized{border-radius:10px}
.ld-head{cursor:move;touch-action:none}
.ld-resize{position:absolute;z-index:6;touch-action:none}
.ld-resize-n{left:12px;right:12px;top:-4px;height:9px;cursor:ns-resize}
.ld-resize-s{left:12px;right:12px;bottom:-4px;height:9px;cursor:ns-resize}
.ld-resize-e{top:12px;bottom:12px;right:-4px;width:9px;cursor:ew-resize}
.ld-resize-w{top:12px;bottom:12px;left:-4px;width:9px;cursor:ew-resize}
.ld-resize-ne{right:-4px;top:-4px;width:16px;height:16px;cursor:nesw-resize}
.ld-resize-nw{left:-4px;top:-4px;width:16px;height:16px;cursor:nwse-resize}
.ld-resize-se{right:-4px;bottom:-4px;width:16px;height:16px;cursor:nwse-resize}
.ld-resize-sw{left:-4px;bottom:-4px;width:16px;height:16px;cursor:nesw-resize}
.ld-head{display:flex;align-items:center;gap:12px;padding:10px 14px 8px 18px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.ld-brand{display:flex;align-items:center;gap:7px;font-size:13px;font-weight:600;white-space:nowrap}
.ld-head-actions{display:flex;align-items:center;gap:6px;margin-left:auto}
.ld-btn{height:28px;padding:0 10px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.ld-btn:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}
.ld-btn.primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.ld-btn.primary:hover{background:var(--dsw-alias-brand-primary);color:#fff}
.ld-btn.on{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent)}
.ld-tabs{display:flex;align-items:center;gap:4px;padding:6px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);overflow-x:auto;scrollbar-width:thin}
.ld-tab{display:inline-flex;align-items:center;gap:6px;height:25px;padding:0 8px;border-radius:6px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap;max-width:190px;flex:none}
.ld-tab:hover{background:var(--dsw-alias-bg-layer-2)}
.ld-tab.on{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}
.ld-tab .label{overflow:hidden;text-overflow:ellipsis}
.ld-tab .x{opacity:.45;padding:0 2px;border-radius:4px}
.ld-tab .x:hover{opacity:1;background:var(--dsw-alias-bg-layer-1)}
.ld-panes{flex:1;display:flex;min-height:0}
.ld-pane{flex:1;min-width:0;display:flex;flex-direction:column;border-right:1px solid var(--dsw-alias-border-l1)}
.ld-pane:last-child{border-right:0}
.ld-panehead{display:flex;align-items:flex-start;gap:10px;padding:10px 14px 8px}
.ld-titles{flex:1;min-width:0}
.ld-title{border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:15px;font-weight:600;width:100%;padding:2px 4px;border-radius:6px;outline:none}
.ld-title:hover{background:var(--dsw-alias-bg-layer-2)}
.ld-title:focus{background:var(--dsw-alias-bg-layer-2);box-shadow:0 0 0 1px var(--dsw-alias-brand-primary)}
.ld-status{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:2px}
.ld-status .pulse{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}
.ld-status.busy .pulse{background:var(--dsw-alias-brand-primary);animation:ld-pulse 1.1s infinite}
.ld-status.err .pulse{background:var(--dsw-alias-state-error-primary)}
@keyframes ld-pulse{0%,100%{opacity:.35;transform:scale(.9)}50%{opacity:1;transform:scale(1.25)}}
.ld-tools{display:flex;align-items:center;gap:4px;padding:8px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);flex-wrap:wrap}
.ld-tool{height:26px;min-width:26px;padding:0 8px;border-radius:6px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.ld-tool:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.ld-tool.bold{font-weight:700}.ld-tool.italic{font-style:italic}.ld-tool.under{text-decoration:underline}
.ld-sep{width:1px;height:16px;background:var(--dsw-alias-border-l1);margin:0 4px}
.ld-body{flex:1;overflow:auto;background:var(--dsw-alias-bg-base);padding:22px 26px 90px;scroll-behavior:smooth;display:flex;gap:14px;justify-content:center;align-items:flex-start}
.ld-body.is-dropping{outline:2px dashed var(--dsw-alias-brand-primary);outline-offset:-8px}
.ld-outline{position:sticky;top:0;flex:none;width:168px;max-height:calc(100vh - 300px);overflow:auto;padding:4px 2px;scrollbar-width:thin}
.ld-outline-item{display:block;width:100%;text-align:left;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1.5;padding:3px 6px;border-radius:5px;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ld-outline-item:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.ld-outline-item.on{color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent)}
.ld-outline-item[data-level="2"]{padding-left:16px}
.ld-outline-item[data-level="3"]{padding-left:26px}
.ld-page{flex:1;min-width:0;max-width:760px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:40px 48px 60px;min-height:70%;box-shadow:0 8px 30px rgba(0,0,0,.08)}
.ld-block{position:relative;margin:0 0 10px;border-radius:6px;outline:none}
.ld-block[data-type="p"]{font-size:15px;line-height:1.95;text-align:justify}
.ld-block[data-type="h1"]{font-size:25px;font-weight:700;line-height:1.45;margin:26px 0 14px}
.ld-block[data-type="h2"]{font-size:19px;font-weight:700;line-height:1.5;margin:22px 0 10px}
.ld-block[data-type="h3"]{font-size:16px;font-weight:700;line-height:1.6;margin:18px 0 8px}
.ld-block[data-type="ul"],.ld-block[data-type="ol"]{display:flex;gap:8px;font-size:15px;line-height:1.9}
.ld-block[data-type="quote"]{border-left:3px solid var(--dsw-alias-border-l2);padding-left:12px;color:var(--dsw-alias-label-secondary);font-style:italic;font-size:14.5px}
.ld-block[data-type="code"]{font-family:"SF Mono",Consolas,monospace;font-size:13px;line-height:1.7;background:var(--dsw-alias-bg-layer-2);border-radius:8px;padding:10px 12px;white-space:pre-wrap}
.ld-block[data-type="hr"]{border-top:1px solid var(--dsw-alias-border-l2);margin:18px 0}
.ld-block[contenteditable]:empty:before{content:attr(data-placeholder);color:var(--dsw-alias-label-secondary);opacity:.45}
.ld-marker{flex:none;width:18px;color:var(--dsw-alias-label-secondary);user-select:none;text-align:right}
.ld-text{flex:1;min-width:0;outline:none;white-space:pre-wrap;word-break:break-word}
.ld-block:focus-within{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 6%,transparent)}
.ld-flash{animation:ld-flash 1.6s ease-out}
@keyframes ld-flash{0%{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent)}100%{background:transparent}}
.ld-add{display:block;width:100%;margin:6px 0 0;padding:8px;border-radius:8px;border:1px dashed var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;opacity:.55}
.ld-add:hover{opacity:1;border-color:var(--dsw-alias-brand-primary)}
.ld-stale{display:inline-flex;align-items:center;gap:4px;margin-left:8px;font-size:11px;color:var(--dsw-alias-state-warn-primary);cursor:pointer;background:transparent;border:0;font-family:inherit;padding:0;text-decoration:underline}
.ld-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 18px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.ld-toast{position:absolute;right:16px;bottom:54px;max-width:80%;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);box-shadow:0 12px 30px rgba(0,0,0,.25);border-radius:9px;padding:9px 12px;font-size:12px;color:var(--dsw-alias-label-primary);z-index:5;display:flex;gap:10px;align-items:center}
.ld-toast button{border:0;background:transparent;color:var(--dsw-alias-brand-primary);cursor:pointer;font:inherit;font-size:12px}
.ld-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;flex:1;color:var(--dsw-alias-label-secondary);text-align:center;padding:40px}
.ld-empty h3{margin:0;font-size:15px;color:var(--dsw-alias-label-primary)}
.ld-empty p{margin:0;font-size:12.5px;max-width:320px;line-height:1.7}
.ld-error{color:var(--dsw-alias-state-error-primary);font-size:12px}
.ld-figure{margin:14px 0;text-align:center}
.ld-figure img{max-width:100%;display:block;margin:0 auto;border-radius:6px;border:1px solid var(--dsw-alias-border-l1)}
.ld-figbar{display:flex;gap:6px;align-items:center;justify-content:center;margin-top:6px;flex-wrap:wrap}
.ld-figcap{flex:1;min-width:120px;max-width:420px;text-align:center;border:0;border-bottom:1px dashed transparent;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;padding:2px 4px;border-radius:0}
.ld-figcap:focus{outline:none;border-bottom-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
.ld-table-wrap{margin:12px 0;overflow-x:auto}
.ld-table{border-collapse:collapse;width:100%;font-size:13.5px;line-height:1.7}
.ld-table td,.ld-table th{border:1px solid var(--dsw-alias-border-l2);padding:6px 8px;min-width:70px;vertical-align:top;text-align:left;outline:none}
.ld-table th{background:var(--dsw-alias-bg-layer-2);font-weight:600}
.ld-table td:focus,.ld-table th:focus{box-shadow:inset 0 0 0 2px var(--dsw-alias-brand-primary)}
.ld-table td:empty:before{content:attr(data-placeholder);opacity:.35}
.ld-tablebar{display:flex;gap:4px;margin-top:5px;flex-wrap:wrap;align-items:center}
.ld-tbl-btn{height:22px;padding:0 8px;border-radius:5px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;cursor:pointer;white-space:nowrap}
.ld-tbl-btn:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}
.ld-tbl-btn.on{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
`;

    function Style() {
      return h('style', null, CSS);
    }

    // ---- text block ------------------------------------------------------

    function TextBlock({ block, marker, onInput, onSplit, onDelete, onFocusBlock, staleHtml, onRefresh }) {
      const textRef = useRef(null);

      useEffect(() => {
        const element = textRef.current;
        if (element === null) return;
        if (element.innerHTML === block.html) return;
        if (document.activeElement === element) return;
        element.innerHTML = block.html;
      }, [block.html, block.id]);

      const handleKeyDown = (event) => {
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
          event.preventDefault();
          onSplit(block.id);
          return;
        }
        if (event.key === 'Backspace' && textOf(block.html).length === 0 && block.type !== 'hr') {
          event.preventDefault();
          onDelete(block.id);
        }
      };

      const type = block.type;
      const content = type === 'hr'
        ? null
        : h('div', {
          ref: textRef,
          className: 'ld-text',
          contentEditable: true,
          suppressContentEditableWarning: true,
          spellCheck: true,
          'data-placeholder': type === 'h1' ? T.h1 : type === 'h2' ? T.h2 : type === 'h3' ? T.h3 : '',
          onInput: () => {
            const element = textRef.current;
            if (element !== null) onInput(block.id, element.innerHTML);
          },
          onKeyDown: handleKeyDown,
          onFocus: () => onFocusBlock(block.id),
          onPaste: (event) => {
            if (Array.from(event.clipboardData?.files ?? []).some((file) => file.type.startsWith('image/'))) return;
            event.preventDefault();
            const text = event.clipboardData.getData('text/plain');
            document.execCommand('insertText', false, text);
          },
        });

      return h('div', {
        className: 'ld-block',
        'data-type': type,
        'data-block-id': block.id,
        onClick: type === 'hr' ? () => onFocusBlock(block.id) : undefined,
      },
      type === 'ul' || type === 'ol' ? h('span', { className: 'ld-marker' }, marker) : null,
      content,
      staleHtml !== undefined
        ? h('button', { className: 'ld-stale', onClick: () => onRefresh(block.id, staleHtml), title: T.stale }, '↻ ', T.stale)
        : null);
    }

    // ---- image block -----------------------------------------------------

    function ImageBlock({ block, docId, onPatch, onDelete }) {
      const [caption, setCaption] = useState(block.alt ?? '');
      useEffect(() => setCaption(block.alt ?? ''), [block.alt, block.id]);
      const src = assetUrl(docId, block.src);
      const width = Number.isFinite(block.width) ? block.width : 100;
      return h('div', { className: 'ld-block', 'data-type': 'image', 'data-block-id': block.id },
        h('figure', { className: 'ld-figure' },
          src.length > 0
            ? h('img', { src, alt: caption, style: { width: `${width}%` }, loading: 'lazy' })
            : h('div', { className: 'ld-error' }, '图片地址为空'),
          h('div', { className: 'ld-figbar' },
            h('input', {
              className: 'ld-figcap',
              value: caption,
              placeholder: T.figAlt,
              onChange: (event) => setCaption(event.target.value),
              onBlur: () => {
                if (caption !== (block.alt ?? '')) onPatch(block, { alt: caption });
              },
            }),
            ...[25, 50, 75, 100].map((percent) => h('button', {
              key: percent,
              className: `ld-tbl-btn${width === percent ? ' on' : ''}`,
              onClick: () => onPatch(block, { width: percent }),
            }, `${percent}%`)),
            h('button', { className: 'ld-tbl-btn', onClick: () => onDelete(block.id) }, T.del))));
    }

    // ---- table block -----------------------------------------------------

    /**
     * Render a table grid imperatively.
     *
     * Cells are built as DOM nodes instead of React elements on purpose: a
     * controlled `dangerouslySetInnerHTML` cell would rewrite the node on every
     * keystroke and move the caret. React owns the wrapper, this function owns
     * the grid.
     */
    function renderTableDom(table, rows) {
      if (table === null) return;
      const owner = table.ownerDocument;
      table.textContent = '';
      const head = owner.createElement('thead');
      const body = owner.createElement('tbody');
      rows.forEach((row, rowIndex) => {
        const tr = owner.createElement('tr');
        row.forEach((cell, columnIndex) => {
          const node = owner.createElement(rowIndex === 0 ? 'th' : 'td');
          node.contentEditable = 'true';
          node.spellcheck = true;
          node.dataset.r = String(rowIndex);
          node.dataset.c = String(columnIndex);
          if (rowIndex === 0) node.dataset.placeholder = '';
          node.innerHTML = cell;
          tr.appendChild(node);
        });
        (rowIndex === 0 ? head : body).appendChild(tr);
      });
      table.appendChild(head);
      table.appendChild(body);
    }

    function TableBlock({ block, onRows, blockId }) {
      const rowsRef = useRef(cloneRows(block.rows));
      const tableRef = useRef(null);
      const focusRef = useRef(null);
      const containerRef = useRef(null);
      const signature = JSON.stringify(block.rows ?? []);

      // Adopt a server-side change only when no cell is being typed in.
      useEffect(() => {
        const container = containerRef.current;
        const inside = container !== null && document.activeElement !== null
          && typeof container.contains === 'function' && container.contains(document.activeElement);
        if (inside) return;
        rowsRef.current = cloneRows(block.rows);
        renderTableDom(tableRef.current, rowsRef.current);
      }, [signature]);

      useEffect(() => {
        renderTableDom(tableRef.current, rowsRef.current);
      }, []);

      const commit = () => {
        renderTableDom(tableRef.current, rowsRef.current);
        onRows(blockId, rowsRef.current.map((row) => row.slice()));
      };

      const remember = (event) => {
        const cell = event.target?.closest?.('td,th');
        if (!cell || cell.dataset?.r === undefined) return;
        focusRef.current = { r: Number(cell.dataset.r), c: Number(cell.dataset.c) };
      };

      const addRow = () => {
        const rows = rowsRef.current;
        const at = focusRef.current?.r ?? rows.length - 1;
        rows.splice(at + 1, 0, new Array(rows[0]?.length ?? 1).fill(''));
        commit();
      };
      const addColumn = () => {
        const rows = rowsRef.current;
        const at = focusRef.current?.c ?? (rows[0]?.length ?? 1) - 1;
        for (const row of rows) row.splice(at + 1, 0, '');
        commit();
      };
      const removeRow = () => {
        if (rowsRef.current.length <= 1) return;
        const at = focusRef.current?.r ?? rowsRef.current.length - 1;
        rowsRef.current.splice(at, 1);
        commit();
      };
      const removeColumn = () => {
        if ((rowsRef.current[0]?.length ?? 0) <= 1) return;
        const at = focusRef.current?.c ?? rowsRef.current[0].length - 1;
        for (const row of rowsRef.current) row.splice(at, 1);
        commit();
      };

      return h('div', { className: 'ld-block', 'data-type': 'table', 'data-block-id': block.id, ref: containerRef },
        h('div', { className: 'ld-table-wrap' },
          h('table', {
            className: 'ld-table',
            ref: tableRef,
            contentEditable: false,
            onInput: (event) => {
              const cell = event.target?.closest?.('td,th');
              if (!cell || cell.dataset?.r === undefined) return;
              const r = Number(cell.dataset.r);
              const c = Number(cell.dataset.c);
              if (rowsRef.current[r] === undefined) return;
              rowsRef.current[r][c] = cell.innerHTML;
              focusRef.current = { r, c };
              onRows(blockId, rowsRef.current.map((row) => row.slice()));
            },
            onFocus: remember,
            onMouseDown: remember,
          })),
        h('div', { className: 'ld-tablebar' },
          h('button', { className: 'ld-tbl-btn', onClick: addRow, onMouseDown: (e) => e.preventDefault() }, T.addRow),
          h('button', { className: 'ld-tbl-btn', onClick: addColumn, onMouseDown: (e) => e.preventDefault() }, T.addCol),
          h('button', { className: 'ld-tbl-btn', onClick: removeRow, onMouseDown: (e) => e.preventDefault() }, T.delRow),
          h('button', { className: 'ld-tbl-btn', onClick: removeColumn, onMouseDown: (e) => e.preventDefault() }, T.delCol)));
    }

    // ---- outline ---------------------------------------------------------

    function Outline({ blocks, activeId, onJump }) {
      const items = blocks
        .filter((block) => block.type === 'h1' || block.type === 'h2' || block.type === 'h3')
        .map((block) => ({ id: block.id, level: Number(block.type.slice(1)), text: blockText(block).trim() }))
        .filter((item) => item.text.length > 0);
      if (items.length < 2) return null;
      return h('nav', { className: 'ld-outline', 'aria-label': T.outline },
        items.map((item) => h('button', {
          key: item.id,
          className: `ld-outline-item${item.id === activeId ? ' on' : ''}`,
          'data-level': item.level,
          title: item.text,
          onClick: () => onJump(item.id),
        }, item.text)));
    }

    // ---- one document pane ----------------------------------------------

    function DocPane({ docId, isPrimary, embedded, docs, onPickDoc, onState, onActive, toast }) {
      const [doc, setDoc] = useState(null);
      const [busy, setBusy] = useState(false);
      const [title, setTitle] = useState('');
      const [error, setError] = useState(null);
      const [stale, setStale] = useState({});
      const [focusId, setFocusId] = useState(null);
      const [outlineOn, setOutlineOn] = useState(() => window.localStorage.getItem('dsh.liveDoc.outline') !== '0');
      const [activeHeading, setActiveHeading] = useState(null);
      const [dropping, setDropping] = useState(false);

      const bodyRef = useRef(null);
      const titleRef = useRef(null);
      const lastBlockRef = useRef(null);
      const docIdRef = useRef(docId ?? null);
      const dirtyRef = useRef(new Set());
      const timersRef = useRef(new Map());
      const tableTimersRef = useRef(new Map());
      const tableRowsRef = useRef(new Map());
      const staleRef = useRef({});
      const docRef = useRef(null);
      const fileRef = useRef(null);
      const dropDepth = useRef(0);

      docRef.current = doc;
      docIdRef.current = docId ?? doc?.id ?? null;

      useEffect(() => {
        window.localStorage.setItem('dsh.liveDoc.outline', outlineOn ? '1' : '0');
      }, [outlineOn]);

      const applyState = useCallback((payload) => {
        onState?.(payload);
        setBusy(Boolean(payload.busy));
        const incoming = payload.doc;
        if (incoming === null || incoming === undefined) {
          setDoc(null);
          return;
        }
        onActive?.(payload.activeId ?? null);
        setTitle((current) => (document.activeElement === titleRef.current ? current : incoming.title));

        const previous = docRef.current;
        if (previous === null || previous.id !== incoming.id) {
          dirtyRef.current.clear();
          staleRef.current = {};
          setStale({});
          setDoc(incoming);
          return;
        }
        const activeElement = document.activeElement;
        const focusedBlock = activeElement !== null && typeof activeElement.closest === 'function'
          ? activeElement.closest('[data-block-id]')
          : null;
        const focusedId = focusedBlock === null ? null : focusedBlock.getAttribute('data-block-id');
        const localMap = new Map(previous.blocks.map((block) => [block.id, block]));
        const nextStale = { ...staleRef.current };
        const blocks = incoming.blocks.map((serverBlock) => {
          const local = localMap.get(serverBlock.id);
          if (local === undefined) return serverBlock;
          const keepLocal = dirtyRef.current.has(serverBlock.id) || serverBlock.id === focusedId;
          const differs = local.html !== serverBlock.html
            || JSON.stringify(local.rows ?? null) !== JSON.stringify(serverBlock.rows ?? null)
            || local.alt !== serverBlock.alt
            || local.width !== serverBlock.width;
          if (keepLocal && differs) nextStale[serverBlock.id] = serverBlock.html ?? '';
          if (keepLocal) return { ...serverBlock, ...local, rev: serverBlock.rev };
          delete nextStale[serverBlock.id];
          return serverBlock;
        });
        staleRef.current = nextStale;
        setStale(nextStale);
        setDoc({ ...incoming, blocks });
      }, [onState, onActive]);

      // Poll this pane's document.
      useEffect(() => {
        let alive = true;
        let timer = null;
        const tick = async () => {
          try {
            const payload = await api('state', { docId: docIdRef.current ?? undefined });
            if (!alive) return;
            setError(null);
            applyState(payload);
          } catch (cause) {
            if (!alive) return;
            setError(cause.message);
          }
          if (alive) timer = setTimeout(tick, 900);
        };
        tick();
        return () => {
          alive = false;
          if (timer !== null) clearTimeout(timer);
        };
      }, [applyState, docId]);

      // Focus a newly created text block.
      useEffect(() => {
        if (focusId === null) return;
        const root = bodyRef.current;
        if (root === null) return;
        const element = root.querySelector(`[data-block-id="${focusId}"] .ld-text`);
        if (element !== null) {
          element.focus();
          const range = document.createRange();
          range.selectNodeContents(element);
          range.collapse(false);
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
        }
        setFocusId(null);
      }, [focusId, doc]);

      // Scroll spy for the outline.
      const scanRef = useRef(0);
      const onScroll = useCallback(() => {
        if (scanRef.current !== 0) return;
        scanRef.current = window.requestAnimationFrame(() => {
          scanRef.current = 0;
          const body = bodyRef.current;
          if (body === null) return;
          const headings = [...body.querySelectorAll('[data-type="h1"],[data-type="h2"],[data-type="h3"]')];
          const top = body.getBoundingClientRect().top;
          let current = null;
          for (const element of headings) {
            if (element.getBoundingClientRect().top - top <= 96) current = element.getAttribute('data-block-id');
            else break;
          }
          setActiveHeading(current);
        });
      }, []);

      const saveBlock = useCallback(async (blockId) => {
        const current = docRef.current;
        if (current === null) return;
        const block = current.blocks.find((entry) => entry.id === blockId);
        if (block === undefined) return;
        const sentHtml = block.html;
        try {
          const result = await api('patch', { docId: current.id, blockId, html: sentHtml, baseRev: block.rev });
          const latest = docRef.current;
          if (latest !== null) {
            const now = latest.blocks.find((entry) => entry.id === blockId);
            if (now !== undefined && now.html === sentHtml) dirtyRef.current.delete(blockId);
            setDoc({
              ...latest,
              rev: result.rev,
              blocks: latest.blocks.map((entry) => (
                entry.id === blockId ? { ...entry, rev: result.block.rev, by: 'user' } : entry
              )),
            });
          }
          if (result.conflict) toast(T.conflict);
        } catch (cause) {
          toast(`${T.offline}：${cause.message}`);
        }
      }, [toast]);

      const saveTable = useCallback(async (blockId, rows) => {
        const current = docRef.current;
        if (current === null) return;
        const block = current.blocks.find((entry) => entry.id === blockId);
        if (block === undefined) return;
        try {
          const result = await api('patch', { docId: current.id, blockId, rows, baseRev: block.rev });
          const latest = docRef.current;
          dirtyRef.current.delete(blockId);
          if (latest !== null) {
            setDoc({
              ...latest,
              rev: result.rev,
              blocks: latest.blocks.map((entry) => (
                entry.id === blockId ? { ...entry, rows: result.block.rows, rev: result.block.rev, by: 'user' } : entry
              )),
            });
          }
          if (result.conflict) toast(T.conflict);
        } catch (cause) {
          toast(`${T.offline}：${cause.message}`);
        }
      }, [toast]);

      const queueTableSave = useCallback((blockId, rows) => {
        dirtyRef.current.add(blockId);
        tableRowsRef.current.set(blockId, rows);
        const existing = tableTimersRef.current.get(blockId);
        if (existing !== undefined) clearTimeout(existing);
        tableTimersRef.current.set(blockId, setTimeout(() => {
          tableTimersRef.current.delete(blockId);
          const latest = tableRowsRef.current.get(blockId);
          if (latest !== undefined) void saveTable(blockId, latest);
        }, 500));
      }, [saveTable]);

      const patchImage = useCallback(async (block, patch) => {
        const current = docRef.current;
        if (current === null) return;
        try {
          const result = await api('patch', {
            docId: current.id,
            blockId: block.id,
            alt: patch.alt,
            width: patch.width,
            baseRev: block.rev,
          });
          const latest = docRef.current;
          if (latest !== null) {
            setDoc({
              ...latest,
              rev: result.rev,
              blocks: latest.blocks.map((entry) => (
                entry.id === block.id
                  ? { ...entry, alt: result.block.alt, width: result.block.width, rev: result.block.rev, by: 'user' }
                  : entry
              )),
            });
          }
          if (result.conflict) toast(T.conflict);
        } catch (cause) {
          toast(cause.message);
        }
      }, [toast]);

      const handleInput = useCallback((blockId, html) => {
        dirtyRef.current.add(blockId);
        setDoc((current) => {
          if (current === null) return current;
          return {
            ...current,
            blocks: current.blocks.map((block) => (block.id === blockId ? { ...block, html } : block)),
          };
        });
        const existing = timersRef.current.get(blockId);
        if (existing !== undefined) clearTimeout(existing);
        timersRef.current.set(blockId, setTimeout(() => {
          timersRef.current.delete(blockId);
          void saveBlock(blockId);
        }, 450));
      }, [saveBlock]);

      const createBlock = useCallback(async (afterId, type, extra) => {
        const current = docRef.current;
        if (current === null) return;
        try {
          const result = await api('insertBlock', {
            docId: current.id,
            after: afterId,
            type: type ?? 'p',
            html: '',
            ...(extra ?? {}),
          });
          if (result.block === undefined) return;
          setDoc((value) => {
            if (value === null) return value;
            const index = value.blocks.findIndex((entry) => entry.id === afterId);
            const blocks = [...value.blocks];
            blocks.splice(index < 0 ? blocks.length : index + 1, 0, result.block);
            return { ...value, rev: result.rev, blocks };
          });
          if (type === 'p' || type === undefined) setFocusId(result.block.id);
        } catch (cause) {
          toast(cause.message);
        }
      }, [toast]);

      const insertTable = useCallback(() => {
        const current = docRef.current;
        if (current === null) return;
        const anchor = lastBlockRef.current ?? (current.blocks.length > 0 ? current.blocks[current.blocks.length - 1].id : undefined);
        void createBlock(anchor, 'table', {
          rows: [['列 1', '列 2', '列 3'], ['', '', ''], ['', '', '']],
        });
      }, [createBlock]);

      const uploadImage = useCallback(async (file) => {
        const current = docRef.current;
        if (current === null || file === undefined || file === null) return;
        if (!String(file.type ?? '').startsWith('image/')) {
          toast('只支持图片文件。');
          return;
        }
        try {
          const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result ?? ''));
            reader.onerror = () => reject(new Error('读取图片失败'));
            reader.readAsDataURL(file);
          });
          const anchor = lastBlockRef.current ?? (current.blocks.length > 0 ? current.blocks[current.blocks.length - 1].id : undefined);
          const result = await api('uploadImage', {
            docId: current.id,
            after: anchor,
            dataUrl,
            alt: String(file.name ?? '').replace(/\.[a-z0-9]+$/i, ''),
          });
          setDoc((value) => {
            if (value === null || result.block === undefined) return value;
            const index = value.blocks.findIndex((entry) => entry.id === anchor);
            const blocks = [...value.blocks];
            blocks.splice(index < 0 ? blocks.length : index + 1, 0, result.block);
            return { ...value, rev: result.rev, blocks };
          });
        } catch (cause) {
          toast(cause.message);
        }
      }, [toast]);

      const deleteBlock = useCallback(async (blockId) => {
        const current = docRef.current;
        if (current === null) return;
        const index = current.blocks.findIndex((entry) => entry.id === blockId);
        const previous = index > 0 ? current.blocks[index - 1] : null;
        try {
          await api('deleteBlock', { docId: current.id, blockId });
          dirtyRef.current.delete(blockId);
          setDoc((value) => {
            if (value === null) return value;
            return { ...value, blocks: value.blocks.filter((entry) => entry.id !== blockId) };
          });
          if (previous !== null) setFocusId(previous.id);
        } catch (cause) {
          toast(cause.message);
        }
      }, [toast]);

      const retype = useCallback(async (type) => {
        const current = docRef.current;
        if (current === null) return;
        const activeElement = document.activeElement;
        const wrapper = activeElement !== null && typeof activeElement.closest === 'function'
          ? activeElement.closest('[data-block-id]')
          : null;
        const blockId = wrapper !== null ? wrapper.getAttribute('data-block-id') : lastBlockRef.current;
        if (blockId === null) {
          toast('先把光标放进一段里');
          return;
        }
        try {
          const result = await api('retype', { docId: current.id, blockId, type });
          setDoc((value) => value === null ? value : {
            ...value,
            blocks: value.blocks.map((entry) => (entry.id === blockId ? { ...entry, type: result.block.type } : entry)),
          });
        } catch (cause) {
          toast(cause.message);
        }
      }, [toast]);

      const exec = useCallback((command) => {
        document.execCommand(command, false, undefined);
        const activeElement = document.activeElement;
        const wrapper = activeElement !== null && typeof activeElement.closest === 'function'
          ? activeElement.closest('[data-block-id]')
          : null;
        if (wrapper !== null) {
          const blockId = wrapper.getAttribute('data-block-id');
          const text = wrapper.querySelector('.ld-text');
          if (text !== null) handleInput(blockId, text.innerHTML);
        }
      }, [handleInput]);

      const rename = useCallback(async () => {
        const current = docRef.current;
        if (current === null) return;
        const next = title.trim();
        if (next.length === 0 || next === current.title) {
          setTitle(current.title);
          return;
        }
        try {
          await api('rename', { docId: current.id, title: next });
          setDoc({ ...current, title: next });
        } catch (cause) {
          toast(cause.message);
        }
      }, [title, toast]);

      /** Flush every pending keystroke before the host reads the document. */
      const flush = useCallback(async () => {
        const pendingText = [...dirtyRef.current].filter((id) => !tableTimersRef.current.has(id));
        const pendingTables = [...tableTimersRef.current.keys()];
        for (const id of pendingTables) {
          const timer = tableTimersRef.current.get(id);
          if (timer !== undefined) clearTimeout(timer);
          tableTimersRef.current.delete(id);
        }
        await Promise.all([
          ...pendingText.map((id) => saveBlock(id)),
          ...pendingTables.map((id) => {
            const rows = tableRowsRef.current.get(id);
            return rows === undefined ? Promise.resolve() : saveTable(id, rows);
          }),
        ]);
      }, [saveBlock, saveTable]);

      const exportDoc = useCallback(async () => {
        const current = docRef.current;
        if (current === null) return;
        await flush();
        try {
          const result = await api('export', { docId: current.id });
          setDoc((value) => value === null ? value : { ...value, exportedAt: Date.now(), path: result.path });
          toast(`${T.exported}：${result.path}`, {
            label: T.copyPath,
            run: () => {
              void navigator.clipboard?.writeText(result.path);
              toast(T.copied);
            },
          });
        } catch (cause) {
          toast(cause.message);
        }
      }, [flush, toast]);

      const toolButton = (label, run, extra) => h('button', {
        className: `ld-tool${extra !== undefined ? ` ${extra}` : ''}`,
        onMouseDown: (event) => event.preventDefault(),
        onClick: () => void run(),
      }, label);

      if (doc === null) {
        return h('div', { className: 'ld-empty' },
          h(DocumentIcon, { size: 42 }),
          h('h3', null, T.empty),
          h('p', null, T.emptyHint),
          (docs ?? []).length > 0
            ? h('div', { className: 'ld-tablebar' },
              (docs ?? []).slice(0, 8).map((entry) => h('button', {
                key: entry.id,
                className: 'ld-btn',
                onClick: () => onPickDoc?.(entry.id),
              }, entry.title)))
            : null);
      }

      const blocks = doc.blocks ?? [];
      let olIndex = 0;
      const rendered = blocks.map((block) => {
        if (block.type === 'ol') olIndex += 1;
        else olIndex = 0;
        const marker = block.type === 'ul' ? '•' : block.type === 'ol' ? `${olIndex}.` : null;
        if (block.type === 'image') {
          return h(ImageBlock, {
            key: block.id,
            block,
            docId: doc.id,
            onPatch: patchImage,
            onDelete: (id) => void deleteBlock(id),
          });
        }
        if (block.type === 'table') {
          return h(TableBlock, {
            key: block.id,
            block,
            blockId: block.id,
            onRows: queueTableSave,
          });
        }
        return h(TextBlock, {
          key: block.id,
          block,
          marker,
          staleHtml: stale[block.id],
          onInput: handleInput,
          onSplit: (id) => void createBlock(id, 'p'),
          onDelete: (id) => void deleteBlock(id),
          onFocusBlock: (id) => {
            lastBlockRef.current = id;
          },
          onRefresh: (id, html) => {
            setDoc((current) => current === null ? current : {
              ...current,
              blocks: current.blocks.map((entry) => (entry.id === id ? { ...entry, html } : entry)),
            });
            const next = { ...staleRef.current };
            delete next[id];
            staleRef.current = next;
            setStale(next);
            dirtyRef.current.delete(id);
          },
        });
      });

      const jump = (blockId) => {
        const root = bodyRef.current;
        if (root === null) return;
        const target = root.querySelector(`[data-block-id="${blockId}"]`);
        if (target !== null) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      };

      return h(React.Fragment, null,
        h('div', { className: 'ld-panehead' },
          h('div', { className: 'ld-titles' },
            h('input', {
              ref: titleRef,
              className: 'ld-title',
              value: title,
              onChange: (event) => setTitle(event.target.value),
              onBlur: () => void rename(),
              onKeyDown: (event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  event.currentTarget.blur();
                }
              },
              'aria-label': T.title,
            }),
            h('div', { className: `ld-status${busy ? ' busy' : ''}${error !== null ? ' err' : ''}` },
              h('span', { className: 'pulse' }),
              error !== null ? `${T.offline}：${error}` : busy ? T.busy : `${T.sync} · rev ${doc.rev}`)),
          h('div', { className: 'ld-head-actions' },
            h('button', { className: 'ld-btn primary', onClick: () => void exportDoc() }, T.export))),
        h('div', { className: 'ld-tools' },
          toolButton(T.p, () => retype('p')),
          toolButton(T.h1, () => retype('h1')),
          toolButton(T.h2, () => retype('h2')),
          toolButton(T.h3, () => retype('h3')),
          h('span', { className: 'ld-sep' }),
          toolButton(T.ul, () => retype('ul')),
          toolButton(T.ol, () => retype('ol')),
          toolButton(T.quote, () => retype('quote')),
          toolButton(T.code, () => retype('code')),
          h('span', { className: 'ld-sep' }),
          toolButton('B', () => exec('bold'), 'bold'),
          toolButton('I', () => exec('italic'), 'italic'),
          toolButton('U', () => exec('underline'), 'under'),
          h('span', { className: 'ld-sep' }),
          toolButton(T.addImage, () => fileRef.current?.click()),
          toolButton(T.addTable, () => insertTable()),
          h('span', { className: 'ld-sep' }),
          h('button', {
            className: `ld-tool${outlineOn ? ' bold' : ''}`,
            style: outlineOn ? { color: 'var(--dsw-alias-brand-primary)' } : undefined,
            onMouseDown: (event) => event.preventDefault(),
            onClick: () => setOutlineOn(!outlineOn),
          }, T.outline),
          h('input', {
            ref: fileRef,
            type: 'file',
            accept: 'image/png,image/jpeg,image/gif,image/webp,image/bmp',
            style: { display: 'none' },
            onChange: (event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              void uploadImage(file);
            },
          })),
        h('div', {
          className: `ld-body${dropping ? ' is-dropping' : ''}`,
          ref: bodyRef,
          onScroll: onScroll,
          onPaste: (event) => {
            const file = Array.from(event.clipboardData?.files ?? []).find((item) => item.type.startsWith('image/'));
            if (file === undefined) return;
            event.preventDefault();
            void uploadImage(file);
          },
          onDragEnter: (event) => {
            if (!Array.from(event.dataTransfer?.items ?? []).some((item) => item.kind === 'file')) return;
            dropDepth.current += 1;
            setDropping(true);
          },
          onDragLeave: () => {
            dropDepth.current = Math.max(0, dropDepth.current - 1);
            if (dropDepth.current === 0) setDropping(false);
          },
          onDragOver: (event) => {
            if (!Array.from(event.dataTransfer?.items ?? []).some((item) => item.kind === 'file')) return;
            event.preventDefault();
          },
          onDrop: (event) => {
            const file = Array.from(event.dataTransfer?.files ?? []).find((item) => item.type.startsWith('image/'));
            dropDepth.current = 0;
            setDropping(false);
            if (file === undefined) return;
            event.preventDefault();
            void uploadImage(file);
          },
        },
        outlineOn ? h(Outline, { blocks, activeId: activeHeading, onJump: jump }) : null,
        h('div', { className: 'ld-page' },
          rendered,
          h('button', {
            className: 'ld-add',
            onClick: () => void createBlock(blocks.length > 0 ? blocks[blocks.length - 1].id : undefined, 'p'),
          }, T.add))),
        h('div', { className: 'ld-foot' },
          h('span', null, T.pending),
          h('span', null, `${wordCount(blocks)} ${T.words}${doc.exportedAt ? ` · ${T.exported}` : ''}`)));
    }

    // ---- panel shell -----------------------------------------------------

    /** Resize handles, in CSS class order. */
    const RESIZE_HANDLES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
    const MIN_WIDTH = 360;
    const MIN_HEIGHT = 280;
    /** Gap kept from a snapped edge. */
    const EDGE_GAP = 12;
    /** How close a drag has to end to snap flush to an edge. */
    const SNAP_DISTANCE = 22;

    /** The panel's default spot: a full-height column hugging the right edge. */
    function defaultGeometry() {
      const width = Math.min(760, Math.max(MIN_WIDTH, window.innerWidth - 140));
      const height = Math.max(MIN_HEIGHT, window.innerHeight - 2 * EDGE_GAP - 60);
      return {
        x: Math.max(EDGE_GAP, window.innerWidth - width - EDGE_GAP - 6),
        y: 72,
        w: width,
        h: height,
      };
    }

    /**
     * Keep a geometry usable: never smaller than the minimum, never larger than
     * the viewport, and never fully off screen (the header must stay reachable).
     */
    function clampGeometry(value) {
      const source = value !== null && typeof value === 'object' ? value : {};
      const w = Math.min(Math.max(Number(source.w) || MIN_WIDTH, MIN_WIDTH), Math.max(MIN_WIDTH, window.innerWidth - 2 * EDGE_GAP));
      const h = Math.min(Math.max(Number(source.h) || MIN_HEIGHT, MIN_HEIGHT), Math.max(MIN_HEIGHT, window.innerHeight - 2 * EDGE_GAP));
      const x = Math.min(Math.max(Number(source.x) || 0, 120 - w), window.innerWidth - 120);
      const y = Math.min(Math.max(Number(source.y) || 0, 0), window.innerHeight - 48);
      return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
    }

    /** Apply one pointer delta to a geometry for a move or an edge resize. */
    function geometryAfter(start, mode, direction, dx, dy) {
      if (mode === 'move') return { ...start, x: start.x + dx, y: start.y + dy };
      const next = { ...start };
      if (direction.includes('e')) next.w = start.w + dx;
      if (direction.includes('s')) next.h = start.h + dy;
      if (direction.includes('w')) {
        next.w = start.w - dx;
        next.x = start.x + dx;
      }
      if (direction.includes('n')) {
        next.h = start.h - dy;
        next.y = start.y + dy;
      }
      return next;
    }

    /** Snap a released panel flush to a nearby edge, so it can sit as a sidebar. */
    function snapGeometry(value) {
      const next = { ...value };
      if (Math.abs(next.x - EDGE_GAP) < SNAP_DISTANCE) next.x = EDGE_GAP;
      if (Math.abs(next.x + next.w - (window.innerWidth - EDGE_GAP)) < SNAP_DISTANCE) {
        next.x = window.innerWidth - next.w - EDGE_GAP;
      }
      if (Math.abs(next.y - EDGE_GAP) < SNAP_DISTANCE) next.y = EDGE_GAP;
      if (Math.abs(next.y + next.h - (window.innerHeight - EDGE_GAP)) < SNAP_DISTANCE) {
        next.y = window.innerHeight - next.h - EDGE_GAP;
      }
      return clampGeometry(next);
    }

    /** Restore the saved geometry, falling back to the legacy width key. */
    function readGeometry() {
      try {
        const parsed = JSON.parse(window.localStorage.getItem('dsh.liveDoc.geom') ?? 'null');
        if (parsed !== null && typeof parsed === 'object') return clampGeometry(parsed);
      } catch {
        // A damaged value falls through to the defaults.
      }
      const base = defaultGeometry();
      const legacy = Number(window.localStorage.getItem('dsh.liveDoc.width') ?? '');
      if (Number.isFinite(legacy) && legacy >= MIN_WIDTH) {
        const w = Math.min(legacy, window.innerWidth - 2 * EDGE_GAP);
        return clampGeometry({ ...base, w, x: window.innerWidth - w - EDGE_GAP - 6 });
      }
      return base;
    }

    function readTabs() {
      try {
        const parsed = JSON.parse(window.localStorage.getItem('dsh.liveDoc.tabs') ?? '[]');
        return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [];
      } catch {
        return [];
      }
    }

    function Panel(props = {}) {
      const embedded = props.embedded === true;
      const [open] = useOpenState();
      const [docs, setDocs] = useState([]);
      const [openIds, setOpenIds] = useState(readTabs);
      const [primaryId, setPrimaryId] = useState(null);
      const [splitId, setSplitId] = useState(() => window.localStorage.getItem('dsh.liveDoc.split'));
      const [toast, setToast] = useState(null);
      const [geometry, setGeometry] = useState(readGeometry);
      const [maximized, setMaximized] = useState(false);
      const restoreRef = useRef(null);
      const toastTimer = useRef(null);
      const closedRef = useRef(new Set());

      const showToast = useCallback((text, action) => {
        setToast({ text, action });
        if (toastTimer.current !== null) clearTimeout(toastTimer.current);
        toastTimer.current = setTimeout(() => setToast(null), 4200);
      }, []);

      useEffect(() => () => {
        if (toastTimer.current !== null) clearTimeout(toastTimer.current);
      }, []);

      useEffect(() => {
        if (embedded) return;
        window.localStorage.setItem('dsh.liveDoc.geom', JSON.stringify(geometry));
      }, [geometry, embedded]);

      // A shrunken window must not leave the panel unreachable.
      useEffect(() => {
        if (embedded) return undefined;
        const onResize = () => setGeometry((current) => clampGeometry(current));
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
      }, [embedded]);

      useEffect(() => {
        window.localStorage.setItem('dsh.liveDoc.tabs', JSON.stringify(openIds.slice(-8)));
      }, [openIds]);

      useEffect(() => {
        if (splitId === null || splitId === '') window.localStorage.removeItem('dsh.liveDoc.split');
        else window.localStorage.setItem('dsh.liveDoc.split', splitId);
      }, [splitId]);

      const onState = useCallback((payload) => {
        setDocs(payload.docs ?? []);
      }, []);

      const onActive = useCallback((activeId) => {
        if (typeof activeId !== 'string' || activeId.length === 0) return;
        if (closedRef.current.has(activeId)) return;
        setPrimaryId(activeId);
        setOpenIds((previous) => (previous.includes(activeId) ? previous : [...previous, activeId].slice(-8)));
      }, []);

      // Auto-open when a new document is created while the panel is closed.
      useEffect(() => {
        if (open || embedded) return undefined;
        let alive = true;
        let timer = null;
        const tick = async () => {
          try {
            const probe = await api('probe', {});
            if (!alive) return;
            const recent = probe.updatedAt > Date.now() - 12 * 60 * 60 * 1000;
            const dismissed = window.sessionStorage.getItem('dsh.liveDoc.dismissed') === probe.id;
            if (probe.id !== null && probe.id !== openState.lastAuto && recent && !dismissed) {
              openState.lastAuto = probe.id;
              setOpenState(true);
            }
          } catch {
            // The host may not have mounted yet; retry quietly.
          }
          if (alive) timer = setTimeout(tick, 2000);
        };
        timer = setTimeout(tick, 1200);
        return () => {
          alive = false;
          if (timer !== null) clearTimeout(timer);
        };
      }, [open, embedded]);

      const dismiss = useCallback(() => {
        if (primaryId !== null) window.sessionStorage.setItem('dsh.liveDoc.dismissed', primaryId);
        setOpenState(false);
      }, [primaryId]);

      const createDoc = useCallback(async () => {
        try {
          const result = await api('create', { title: T.newDoc });
          window.sessionStorage.removeItem('dsh.liveDoc.dismissed');
          if (result.doc !== undefined) {
            closedRef.current.delete(result.doc.id);
            setPrimaryId(result.doc.id);
            setOpenIds((previous) => (previous.includes(result.doc.id) ? previous : [...previous, result.doc.id].slice(-8)));
          }
          setDocs(result.docs ?? []);
        } catch (cause) {
          showToast(cause.message);
        }
      }, [showToast]);

      const selectDoc = useCallback(async (docId) => {
        try {
          closedRef.current.delete(docId);
          await api('select', { docId });
          setPrimaryId(docId);
          setOpenIds((previous) => (previous.includes(docId) ? previous : [...previous, docId].slice(-8)));
        } catch (cause) {
          showToast(cause.message);
        }
      }, [showToast]);

      const closeTab = useCallback((docId) => {
        closedRef.current.add(docId);
        setOpenIds((previous) => {
          const next = previous.filter((id) => id !== docId);
          if (next.length > 0 && docId === primaryId) {
            void selectDoc(next[next.length - 1]);
          }
          if (next.length === 0) setPrimaryId(null);
          return next;
        });
        setSplitId((previous) => (previous === docId ? null : previous));
      }, [primaryId, selectDoc]);

      const toggleSplit = useCallback(() => {
        if (splitId !== null) {
          setSplitId(null);
          return;
        }
        const other = openIds.find((id) => id !== primaryId) ?? docs.find((entry) => entry.id !== primaryId)?.id;
        if (other === undefined) {
          showToast('先至少打开两份文档，再分栏。');
          return;
        }
        setSplitId(other);
      }, [splitId, openIds, docs, primaryId, showToast]);

      /** Drag the header to move the panel, or a handle to resize it. */
      const beginInteraction = useCallback((event, mode, direction) => {
        if (embedded) return;
        if (typeof event.button === 'number' && event.button !== 0) return;
        const start = { ...geometry };
        const origin = { x: event.clientX, y: event.clientY };
        const move = (moveEvent) => {
          const dx = moveEvent.clientX - origin.x;
          const dy = moveEvent.clientY - origin.y;
          setGeometry(clampGeometry(geometryAfter(start, mode, direction, dx, dy)));
        };
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          setMaximized(false);
          if (mode === 'move') setGeometry((current) => snapGeometry(current));
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      }, [embedded, geometry]);

      const toggleMaximize = useCallback(() => {
        if (embedded) return;
        if (maximized) {
          setGeometry(clampGeometry(restoreRef.current ?? defaultGeometry()));
          setMaximized(false);
          return;
        }
        restoreRef.current = geometry;
        setGeometry(clampGeometry({ x: EDGE_GAP, y: EDGE_GAP, w: window.innerWidth - 2 * EDGE_GAP, h: window.innerHeight - 2 * EDGE_GAP }));
        setMaximized(true);
      }, [embedded, maximized, geometry]);

      const resetGeometry = useCallback(() => {
        if (embedded) return;
        setMaximized(false);
        setGeometry(defaultGeometry());
      }, [embedded]);

      if (!open && !embedded) return null;

      const tabs = openIds
        .map((id) => ({ id, title: docs.find((entry) => entry.id === id)?.title ?? T.newDoc }))
        .filter((tab) => tab !== undefined);

      return h(React.Fragment, null,
        h(Style),
        h('div', { className: `ld-layer${embedded ? ' is-embedded' : ''}` },
          h('div', {
            className: `ld-panel${maximized ? ' is-maximized' : ''}`,
            ...(embedded ? {} : {
              style: {
                left: `${geometry.x}px`,
                top: `${geometry.y}px`,
                width: `${geometry.w}px`,
                height: `${geometry.h}px`,
              },
            }),
          },
            embedded ? null : RESIZE_HANDLES.map((direction) => h('div', {
              key: direction,
              className: `ld-resize ld-resize-${direction}`,
              onPointerDown: (event) => {
                event.stopPropagation();
                beginInteraction(event, 'resize', direction);
              },
            })),
            h('div', {
              className: 'ld-head',
              onPointerDown: (event) => {
                if (embedded) return;
                const target = event.target;
                if (target !== null && typeof target.closest === 'function'
                  && target.closest('button, input, select, textarea, a, .ld-tab') !== null) return;
                beginInteraction(event, 'move');
              },
              onDoubleClick: () => resetGeometry(),
              title: T.dragHint,
            },
              h('div', { className: 'ld-brand' }, h(DocumentIcon, { size: 15 }), T.title),
              h('div', { className: 'ld-head-actions' },
                h('button', {
                  className: `ld-btn${splitId !== null ? ' on' : ''}`,
                  onClick: toggleSplit,
                  title: T.split,
                }, splitId !== null ? T.unsplit : T.split),
                h('button', { className: 'ld-btn primary', onClick: () => void createDoc() }, T.create),
                embedded ? null : h('button', {
                  className: `ld-btn${maximized ? ' on' : ''}`,
                  onClick: toggleMaximize,
                  title: maximized ? T.restore : T.maximize,
                }, maximized ? '⤡' : '⤢'),
                embedded ? null : h('button', { className: 'ld-btn', onClick: dismiss }, T.close))),
            tabs.length > 0
              ? h('div', { className: 'ld-tabs' },
                tabs.map((tab) => h('button', {
                  key: tab.id,
                  className: `ld-tab${tab.id === primaryId ? ' on' : ''}`,
                  onClick: () => void selectDoc(tab.id),
                  title: tab.title,
                },
                h('span', { className: 'label' }, tab.title),
                h('span', {
                  className: 'x',
                  onClick: (event) => {
                    event.stopPropagation();
                    closeTab(tab.id);
                  },
                }, '×'))))
              : null,
            h('div', { className: 'ld-panes' },
              h('div', { className: 'ld-pane' },
                h(DocPane, {
                  key: 'primary',
                  docId: primaryId,
                  isPrimary: true,
                  embedded,
                  docs,
                  onPickDoc: selectDoc,
                  onState,
                  onActive,
                  toast: showToast,
                })),
              splitId !== null
                ? h('div', { className: 'ld-pane' },
                  h(DocPane, {
                    key: `split-${splitId}`,
                    docId: splitId,
                    isPrimary: false,
                    embedded,
                    onState,
                    onActive: undefined,
                    toast: showToast,
                  }))
                : null),
            toast !== null
              ? h('div', { className: 'ld-toast' },
                h('span', null, toast.text),
                toast.action !== undefined && toast.action !== null
                  ? h('button', { onClick: toast.action.run }, toast.action.label)
                  : null)
              : null)));
    }

    // ---- header toggle ---------------------------------------------------

    function HeaderButton() {
      const [open, setOpen] = useOpenState();
      const [hasDoc, setHasDoc] = useState(false);
      useEffect(() => {
        let alive = true;
        let timer = null;
        const tick = async () => {
          try {
            const probe = await api('probe', {});
            if (alive) setHasDoc(probe.id !== null);
          } catch {
            if (alive) setHasDoc(false);
          }
          if (alive) timer = setTimeout(tick, 5000);
        };
        void tick();
        return () => {
          alive = false;
          if (timer !== null) clearTimeout(timer);
        };
      }, []);
      return h(React.Fragment, null,
        h(Style),
        h('button', {
          className: `ld-toggle${open ? ' is-on' : ''}${hasDoc ? ' has-doc' : ''}`,
          onClick: () => setOpenState(!open),
          title: T.open,
          'aria-pressed': open,
        },
        h(DocumentIcon, { size: 15 }),
        h('span', null, T.open),
        h('span', { className: 'dot' })));
    }

    // ---- left sidebar / full-page app ------------------------------------

    /** The glyph used by the left sidebar's global panel row. */
    function SidebarIcon(props = {}) {
      return DocumentIcon(props.size ?? 18);
    }

    /** The full-page document workspace opened from the left sidebar. */
    function LiveDocPage() {
      return h('div', { className: 'ld-main' }, h(Panel, { embedded: true }));
    }

    // ---- plugin ----------------------------------------------------------

    return {
      name: 'dsh-live-doc',
      inject: ['slots'],
      apply(ctx) {
        try {
          const locale = ctx.get('locale');
          const snapshot = typeof locale?.getLocale === 'function' ? locale.getLocale() : undefined;
          const id = String(snapshot?.id ?? snapshot?.locale ?? 'zh');
          T = id.toLowerCase().startsWith('en') ? EN : ZH;
        } catch {
          T = ZH;
        }

        ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'live-doc.panel',
          order: 20,
          label: () => T.title,
        }, Panel)), 'live-doc: panel');

        ctx.effect(() => ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
          name: 'conversation.session.header.actions',
          id: 'live-doc.toggle',
          order: 25,
          label: () => T.open,
        }, HeaderButton)), 'live-doc: toggle');

        // The left sidebar row addresses this main panel by the same id.
        ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'live-doc',
          label: () => T.title,
        }, LiveDocPage)), 'live-doc: main panel');

        ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'live-doc',
          order: 35,
          label: () => T.title,
        }, SidebarIcon)), 'live-doc: sidebar row');
      },
    };
  },
});
