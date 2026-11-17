/**
 * dsh-live-doc — browser half.
 *
 * One floating panel plus a small header toggle. The panel polls
 * `/live-doc/api/state`, renders the same block list the agent writes through,
 * and saves the user's edits back with a per-block base revision, so an agent
 * write and a user edit can land on different paragraphs without either side
 * losing text.
 */
window.__ModuleLoader__.load({
  id: 'dsh-live-doc',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useCallback } = React;

    const BOOT_AT = Date.now();

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

    function wordCount(blocks) {
      return blocks.reduce((total, block) => total + textOf(block.html).replace(/\s+/g, '').length, 0);
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
.ld-panel{pointer-events:auto;position:absolute;top:72px;right:18px;bottom:18px;display:flex;flex-direction:column;min-width:420px;max-width:calc(100vw - 48px);background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);border-radius:14px;box-shadow:0 24px 70px rgba(0,0,0,.32);overflow:hidden;color:var(--dsw-alias-label-primary);font-family:"PingFang SC","Microsoft YaHei",system-ui,sans-serif}
.ld-grip{position:absolute;left:0;top:0;bottom:0;width:8px;cursor:col-resize;z-index:2}
.ld-grip:hover{background:linear-gradient(90deg,var(--dsw-alias-brand-primary),transparent);opacity:.25}
.ld-head{display:flex;align-items:center;gap:12px;padding:12px 14px 10px 18px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.ld-titles{flex:1;min-width:0}
.ld-title{border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:15px;font-weight:600;width:100%;padding:2px 4px;border-radius:6px;outline:none}
.ld-title:hover{background:var(--dsw-alias-bg-layer-2)}
.ld-title:focus{background:var(--dsw-alias-bg-layer-2);box-shadow:0 0 0 1px var(--dsw-alias-brand-primary)}
.ld-status{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:2px}
.ld-status .pulse{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}
.ld-status.busy .pulse{background:var(--dsw-alias-brand-primary);animation:ld-pulse 1.1s infinite}
.ld-status.err .pulse{background:var(--dsw-alias-state-error-primary)}
@keyframes ld-pulse{0%,100%{opacity:.35;transform:scale(.9)}50%{opacity:1;transform:scale(1.25)}}
.ld-head-actions{display:flex;align-items:center;gap:6px}
.ld-btn{height:28px;padding:0 10px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.ld-btn:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}
.ld-btn.primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.ld-btn.primary:hover{background:var(--dsw-alias-brand-primary);color:#fff}
.ld-select{height:28px;max-width:170px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;padding:0 6px}
.ld-tools{display:flex;align-items:center;gap:4px;padding:8px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);flex-wrap:wrap}
.ld-tool{height:26px;min-width:26px;padding:0 8px;border-radius:6px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}
.ld-tool:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.ld-tool.on{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
.ld-tool.bold{font-weight:700}.ld-tool.italic{font-style:italic}.ld-tool.under{text-decoration:underline}
.ld-sep{width:1px;height:16px;background:var(--dsw-alias-border-l1);margin:0 4px}
.ld-body{flex:1;overflow:auto;background:var(--dsw-alias-bg-base);padding:22px 26px 90px;scroll-behavior:smooth}
.ld-page{max-width:760px;margin:0 auto;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:40px 48px 60px;min-height:70%;box-shadow:0 8px 30px rgba(0,0,0,.08)}
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
.ld-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;height:100%;color:var(--dsw-alias-label-secondary);text-align:center}
.ld-empty h3{margin:0;font-size:15px;color:var(--dsw-alias-label-primary)}
.ld-empty p{margin:0;font-size:12.5px;max-width:320px;line-height:1.7}
.ld-error{color:var(--dsw-alias-state-error-primary);font-size:12px}
`;

    function Style() {
      return h('style', null, CSS);
    }

    // ---- block editor ----------------------------------------------------

    function Block({ block, docId, index, marker, onInput, onSplit, onDelete, onFocusBlock, onRetype, staleHtml, onRefresh }) {
      const textRef = useRef(null);
      const appliedRef = useRef(null);

      useEffect(() => {
        const element = textRef.current;
        if (element === null) return;
        if (element.innerHTML === block.html) {
          appliedRef.current = block.html;
          return;
        }
        if (document.activeElement === element) return;
        element.innerHTML = block.html;
        appliedRef.current = block.html;
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

      const handleInput = () => {
        const element = textRef.current;
        if (element === null) return;
        onInput(block.id, element.innerHTML);
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
          onInput: handleInput,
          onKeyDown: handleKeyDown,
          onFocus: () => onFocusBlock(block.id),
          onPaste: (event) => {
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

    // ---- panel -----------------------------------------------------------

    function Panel(props = {}) {
      const embedded = props.embedded === true;
      const [open] = useOpenState();
      const [doc, setDoc] = useState(null);
      const [docs, setDocs] = useState([]);
      const [busy, setBusy] = useState(false);
      const [title, setTitle] = useState('');
      const [toast, setToast] = useState(null);
      const [focusId, setFocusId] = useState(null);
      const [width, setWidth] = useState(() => {
        const saved = Number(window.localStorage.getItem('dsh.liveDoc.width') ?? '');
        return Number.isFinite(saved) && saved >= 420 ? saved : 620;
      });
      const [stale, setStale] = useState({});
      const [error, setError] = useState(null);

      const bodyRef = useRef(null);
      const titleRef = useRef(null);
      const lastBlockRef = useRef(null);
      const docIdRef = useRef(null);
      const dirtyRef = useRef(new Set());
      const timersRef = useRef(new Map());
      const staleRef = useRef({});
      const docRef = useRef(null);
      const toastTimer = useRef(null);

      docRef.current = doc;

      const showToast = useCallback((text, action) => {
        setToast({ text, action });
        if (toastTimer.current !== null) clearTimeout(toastTimer.current);
        toastTimer.current = setTimeout(() => setToast(null), 4200);
      }, []);

      useEffect(() => () => {
        if (toastTimer.current !== null) clearTimeout(toastTimer.current);
        for (const timer of timersRef.current.values()) clearTimeout(timer);
      }, []);

      const applyState = useCallback((payload) => {
        setDocs(payload.docs ?? []);
        setBusy(Boolean(payload.busy));
        const incoming = payload.doc;
        if (incoming === null || incoming === undefined) {
          setDoc(null);
          docIdRef.current = null;
          return;
        }
        docIdRef.current = incoming.id;
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
          if (keepLocal && local.html !== serverBlock.html) nextStale[serverBlock.id] = serverBlock.html;
          if (keepLocal) return { ...serverBlock, html: local.html };
          delete nextStale[serverBlock.id];
          return serverBlock;
        });
        staleRef.current = nextStale;
        setStale(nextStale);
        setDoc({ ...incoming, blocks });
      }, []);

      // Poll while visible: the overlay is open, or the main-panel page is mounted.
      useEffect(() => {
        if (!open && !embedded) return undefined;
        let alive = true;
        let timer = null;
        const tick = async () => {
          try {
            const payload = await api('state', { docId: docIdRef.current ?? undefined });
            if (!alive) return;
            setError(null);
            // The agent may switch documents between polls (doc_create or a
            // doc_* call on another id). Follow the host's active document so a
            // new document opens in place instead of staying hidden.
            if (payload.activeId !== undefined && payload.activeId !== null
              && docIdRef.current !== null && payload.activeId !== docIdRef.current) {
              const next = await api('state', { docId: payload.activeId });
              if (!alive) return;
              applyState(next);
            } else {
              applyState(payload);
            }
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
      }, [open, embedded, applyState]);

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

      // Focus a newly created block.
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

      const saveBlock = useCallback(async (blockId) => {
        const current = docRef.current;
        if (current === null) return;
        const block = current.blocks.find((entry) => entry.id === blockId);
        if (block === undefined) return;
        const sentHtml = block.html;
        try {
          const result = await api('patch', {
            docId: current.id,
            blockId,
            html: sentHtml,
            baseRev: block.rev,
          });
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
          if (result.conflict) showToast(T.conflict);
        } catch (cause) {
          showToast(`${T.offline}：${cause.message}`);
        }
      }, [showToast]);

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

      const createBlock = useCallback(async (afterId, type) => {
        const current = docRef.current;
        if (current === null) return;
        try {
          const result = await api('insertBlock', {
            docId: current.id,
            after: afterId,
            type: type ?? 'p',
            html: '',
          });
          if (result.block === undefined) return;
          setDoc((value) => {
            if (value === null) return value;
            const index = value.blocks.findIndex((entry) => entry.id === afterId);
            const blocks = [...value.blocks];
            blocks.splice(index < 0 ? blocks.length : index + 1, 0, result.block);
            return { ...value, rev: result.rev, blocks };
          });
          setFocusId(result.block.id);
        } catch (cause) {
          showToast(cause.message);
        }
      }, [showToast]);

      const deleteBlock = useCallback(async (blockId) => {
        const current = docRef.current;
        if (current === null) return;
        const index = current.blocks.findIndex((entry) => entry.id === blockId);
        const previous = index > 0 ? current.blocks[index - 1] : null;
        try {
          await api('deleteBlock', { docId: current.id, blockId });
          setDoc((value) => {
            if (value === null) return value;
            return { ...value, blocks: value.blocks.filter((entry) => entry.id !== blockId) };
          });
          if (previous !== null) setFocusId(previous.id);
        } catch (cause) {
          showToast(cause.message);
        }
      }, [showToast]);

      const retype = useCallback(async (type) => {
        const current = docRef.current;
        if (current === null) return;
        const activeElement = document.activeElement;
        const wrapper = activeElement !== null && typeof activeElement.closest === 'function'
          ? activeElement.closest('[data-block-id]')
          : null;
        const blockId = wrapper !== null
          ? wrapper.getAttribute('data-block-id')
          : lastBlockRef.current;
        if (blockId === null) {
          showToast('先把光标放进一段里');
          return;
        }
        try {
          const result = await api('retype', { docId: current.id, blockId, type });
          setDoc((value) => value === null ? value : {
            ...value,
            blocks: value.blocks.map((entry) => (entry.id === blockId ? { ...entry, type: result.block.type } : entry)),
          });
        } catch (cause) {
          showToast(cause.message);
        }
      }, [showToast]);

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
          showToast(cause.message);
        }
      }, [title, showToast]);

      const exportDoc = useCallback(async () => {
        const current = docRef.current;
        if (current === null) return;
        // Flush edits that are still inside the debounce window before the host
        // reads the document, so "导出" always includes the last keystrokes.
        const pending = [...dirtyRef.current];
        if (pending.length > 0) await Promise.all(pending.map((id) => saveBlock(id)));
        try {
          const result = await api('export', { docId: current.id });
          setDoc((value) => value === null ? value : { ...value, exportedAt: Date.now(), path: result.path });
          showToast(`${T.exported}：${result.path}`, {
            label: '复制路径',
            run: () => {
              void navigator.clipboard?.writeText(result.path);
              showToast(T.copied);
            },
          });
        } catch (cause) {
          showToast(cause.message);
        }
      }, [saveBlock, showToast]);

      const dismiss = useCallback(() => {
        const current = docRef.current;
        if (current !== null) window.sessionStorage.setItem('dsh.liveDoc.dismissed', current.id);
        setOpenState(false);
      }, []);

      const createDoc = useCallback(async () => {
        try {
          const result = await api('create', { title: T.newDoc });
          window.sessionStorage.removeItem('dsh.liveDoc.dismissed');
          setDoc(result.doc);
          setDocs(result.docs ?? []);
          setTitle(result.doc.title);
          docIdRef.current = result.doc.id;
        } catch (cause) {
          showToast(cause.message);
        }
      }, [showToast]);

      const selectDoc = useCallback(async (docId) => {
        try {
          const result = await api('select', { docId });
          applyState(result);
        } catch (cause) {
          showToast(cause.message);
        }
      }, [applyState, showToast]);

      const toolButton = (label, run, extra) => h('button', {
        className: `ld-tool${extra !== undefined ? ` ${extra}` : ''}`,
        onMouseDown: (event) => event.preventDefault(),
        onClick: () => void run(),
      }, label);

      const startResize = useCallback((event) => {
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = width;
        const move = (moveEvent) => {
          const next = Math.min(Math.max(startWidth + (startX - moveEvent.clientX), 420), window.innerWidth - 60);
          setWidth(next);
        };
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      }, [width]);

      useEffect(() => {
        window.localStorage.setItem('dsh.liveDoc.width', String(width));
      }, [width]);

      if (!open && !embedded) return null;

      const blocks = doc?.blocks ?? [];
      let olIndex = 0;
      const rendered = blocks.map((block, index) => {
        if (block.type === 'ol') olIndex += 1;
        else olIndex = 0;
        const marker = block.type === 'ul' ? '•' : block.type === 'ol' ? `${olIndex}.` : null;
        return h(Block, {
          key: block.id,
          block,
          index,
          marker,
          docId: doc?.id,
          staleHtml: stale[block.id],
          onInput: handleInput,
          onSplit: (id) => void createBlock(id, 'p'),
          onDelete: (id) => void deleteBlock(id),
          onFocusBlock: (id) => {
            lastBlockRef.current = id;
          },
          onRetype: retype,
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

      if (doc === null) {
        return h(React.Fragment, null,
          h(Style),
          h('div', { className: `ld-layer${embedded ? ' is-embedded' : ''}` },
            h('div', { className: 'ld-panel', ...(embedded ? {} : { style: { width } }) },
              embedded ? null : h('div', { className: 'ld-grip', onPointerDown: startResize }),
              h('div', { className: 'ld-head' },
                h('div', { className: 'ld-titles' },
                  h('div', { className: 'ld-title', style: { cursor: 'default' } }, T.title),
                  h('div', { className: 'ld-status' }, h('span', { className: 'pulse' }), error ?? T.empty)),
                h('div', { className: 'ld-head-actions' },
                  h('button', { className: 'ld-btn primary', onClick: createDoc }, T.create),
                  embedded ? null : h('button', { className: 'ld-btn', onClick: dismiss }, T.close))),
              h('div', { className: 'ld-empty' },
                h(DocumentIcon, { size: 42 }),
                h('h3', null, T.empty),
                h('p', null, T.emptyHint),
                docs.length > 0
                  ? h('div', { className: 'ld-doclist' },
                    docs.map((entry) => h('button', {
                      key: entry.id,
                      className: 'ld-btn',
                      onClick: () => void selectDoc(entry.id),
                    }, entry.title)))
                  : null))));
      }

      return h(React.Fragment, null,
        h(Style),
        h('div', { className: `ld-layer${embedded ? ' is-embedded' : ''}` },
          h('div', { className: 'ld-panel', ...(embedded ? {} : { style: { width } }) },
            embedded ? null : h('div', { className: 'ld-grip', onPointerDown: startResize }),
            h('div', { className: 'ld-head' },
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
                h('select', {
                  className: 'ld-select',
                  value: doc.id,
                  onChange: (event) => void selectDoc(event.target.value),
                  'aria-label': T.title,
                }, docs.map((entry) => h('option', { key: entry.id, value: entry.id }, entry.title))),
                h('button', { className: 'ld-btn', onClick: createDoc }, T.create),
                h('button', { className: 'ld-btn primary', onClick: () => void exportDoc() }, T.export),
                embedded ? null : h('button', { className: 'ld-btn', onClick: dismiss }, T.close))),
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
              toolButton('U', () => exec('underline'), 'under')),
            h('div', { className: 'ld-body', ref: bodyRef },
              h('div', { className: 'ld-page' },
                rendered,
                h('button', { className: 'ld-add', onClick: () => void createBlock(blocks.length > 0 ? blocks[blocks.length - 1].id : undefined, 'p') }, T.add))),
            h('div', { className: 'ld-foot' },
              h('span', null, T.pending),
              h('span', null, `${wordCount(blocks)} ${T.words}${doc.exportedAt ? ` · ${T.exported}` : ''}`)),
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
