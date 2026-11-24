export const MOBILE_FILE_LIMIT = 200 * 1024 * 1024;

// Only installed on the paired mobile composer. Deliver Files to the official
// input so DSH still owns draft sessions, progress, retries and receipt binding.
export function installAttachmentPicker(showToast, limit) {
  let menu, closeTimer = 0;
  function close(immediate = false) {
    clearTimeout(closeTimer);
    if (!menu) return;
    const target = menu;
    menu = null;
    if (immediate || globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) {
      target.remove();
      return;
    }
    target.removeAttribute('data-open');
    target.setAttribute('data-closing', 'true');
    closeTimer = setTimeout(() => target.remove(), 150);
  }
  const valid = (input, snapshot) => input.isConnected && !input.disabled &&
    snapshot === globalThis.__DSH_MOBILE_CORDIS__?.getCurrentSessionId?.();

  async function picked(kind, files, input, session) {
    if (!files.length || !valid(input, session)) return;
    if (files.some(file => file.size > limit)) throw new Error('单个附件不能超过 200 MB。');
    if (kind === 'folder') {
      showToast('正在打包文件夹…');
      const items = files.map(file => ({ path: file.webkitRelativePath, file }));
      const archive = await new Promise((resolve, reject) => {
        const worker = new Worker('/mobile/v1/folder-worker.js');
        const finish = (callback, value) => { worker.terminate(); callback(value); };
        worker.onmessage = ({ data }) => data.error ? finish(reject, new Error(data.error)) : finish(resolve, data.archive);
        worker.onerror = () => finish(reject, new Error('文件夹打包失败，请重新选择。'));
        try { worker.postMessage({ items, limit }); } catch (error) { finish(reject, error); }
      });
      files = [archive];
    } else {
      // “选择文件” always preserves original bytes. DSH's default inline-image
      // budget is 50 MiB; a larger photo is still a valid binary attachment.
      files = files.map(file => (kind === 'files' || file.size > 50 * 1024 * 1024) && file.type.startsWith('image/')
        ? new File([file], file.name, {type:'application/octet-stream', lastModified:file.lastModified}) : file);
    }
    if (!valid(input, session)) throw new Error('会话已切换，请在目标会话重新选择附件。');
    const transfer = new DataTransfer();
    for (const file of files) transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles:true }));
  }
  function choose(kind, input) {
    const session = globalThis.__DSH_MOBILE_CORDIS__?.getCurrentSessionId?.();
    const picker = document.createElement('input');
    picker.type = 'file'; picker.multiple = true;
    if (kind === 'media') picker.accept = 'image/*,video/*';
    if (kind === 'camera') { picker.accept = 'image/*,video/*'; picker.capture = 'environment'; picker.multiple = false; }
    if (kind === 'folder') {
      if (!('webkitdirectory' in picker)) { showToast('当前系统不支持选择文件夹，请压缩为 ZIP 后选择文件。'); return; }
      picker.webkitdirectory = true;
    }
    picker.onchange = () => picked(kind, Array.from(picker.files), input, session).catch(error => showToast(error.message));
    picker.click();
  }
  const ICONS = {
    media: '<svg viewBox="0 0 20 20" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="3.5" width="15" height="13" rx="2.5"/><circle cx="7.2" cy="8" r="1.4"/><path d="m17.5 13-3.8-3.6a1.2 1.2 0 0 0-1.7 0L5.5 16"/></svg>',
    camera: '<svg viewBox="0 0 20 20" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h1.6l1.1-1.6a1 1 0 0 1 .8-.4h3a1 1 0 0 1 .8.4L13.4 5H15a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/><circle cx="10" cy="10.8" r="2.8"/></svg>',
    files: '<svg viewBox="0 0 20 20" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.5 2.5h5.8l4.2 4.2v9.8a1.5 1.5 0 0 1-1.5 1.5h-8.5A1.5 1.5 0 0 1 4 16.5V4a1.5 1.5 0 0 1 1.5-1.5Z"/><path d="M11 2.5V7h4.5"/></svg>',
    folder: '<svg viewBox="0 0 20 20" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 5.5A1.5 1.5 0 0 1 4 4h3.8l1.6 2H16a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 16 16H4a1.5 1.5 0 0 1-1.5-1.5v-9Z"/></svg>',
  };
  document.addEventListener('click', event => {
    const input = event.target;
    // Do not intercept importers in plugins or a picker's own click.
    if (!input.matches?.('[data-composer-card] input[type="file"][multiple][hidden]') || input.disabled) return;
    const anchor = input.parentElement.querySelector('button[aria-haspopup="listbox"]');
    if (!anchor) return;
    event.preventDefault(); event.stopImmediatePropagation(); close(true);
    menu = document.createElement('div'); menu.className = 'dml-attachment-choices';
    menu.setAttribute('role', 'group'); menu.setAttribute('aria-label','添加附件');
    for (const [kind, label] of [['media','照片或视频'],['camera','拍摄'],['files','选择文件'],['folder','选择文件夹（ZIP）']]) {
      const button = document.createElement('button'); button.type='button'; button.dataset.kind = kind;
      button.innerHTML = '<span class="dml-attach-ico">' + ICONS[kind] + '</span><span class="dml-attach-label">' + label + '</span>';
      button.onclick = () => { close(true); choose(kind, input); }; menu.append(button);
    }
    const box = anchor.getBoundingClientRect();
    document.body.append(menu);
    const left = Math.max(8, Math.min(box.left, document.documentElement.clientWidth-menu.offsetWidth-8));
    const above = box.top >= menu.offsetHeight + 10;
    const top = above ? box.top - menu.offsetHeight - 8 : box.bottom + 8;
    const originX = Math.max(16, Math.min(menu.offsetWidth - 16, Math.round(box.left + box.width / 2 - left)));
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
    menu.style.transformOrigin = originX + 'px ' + (above ? 'bottom' : 'top');
    requestAnimationFrame(() => { menu?.setAttribute('data-open', 'true'); });
    menu.firstElementChild.focus({preventScroll:true});
  }, true);
  document.addEventListener('pointerdown', event => { if (menu && !menu.contains(event.target)) close(); }, true);
  document.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
  globalThis.addEventListener?.('resize', () => close(true));
}

export const ATTACHMENT_PICKER_CSS = `
.dml-attachment-choices{
  position:fixed;z-index:2147483020;padding:6px;min-width:196px;
  border:0.5px solid var(--dsw-alias-border-l3,color-mix(in srgb,currentColor 16%,transparent));
  border-radius:16px;
  background:var(--dsw-menu-surface-fill,var(--dsw-alias-bg-layer-2,Canvas));
  color:var(--dsw-alias-label-primary,CanvasText);
  box-shadow:0 12px 32px rgba(0,0,0,0.18),0 2px 6px rgba(0,0,0,0.08);
  opacity:0;transform:translate3d(0,6px,0) scale(0.92);
  will-change:transform,opacity;
  transition:opacity 180ms cubic-bezier(0.22,1,0.36,1),transform 220ms cubic-bezier(0.22,1.12,0.36,1);
}
.dml-attachment-choices[data-open="true"]{opacity:1;transform:translate3d(0,0,0) scale(1);}
.dml-attachment-choices[data-closing="true"]{opacity:0;transform:translate3d(0,4px,0) scale(0.95);pointer-events:none;transition-duration:140ms;transition-timing-function:cubic-bezier(0.4,0,1,1);}
.dml-attachment-choices button{
  display:flex;align-items:center;gap:10px;text-align:start;width:100%;padding:0 11px;min-height:42px;
  border:0;background:none;color:inherit;font:inherit;font-size:14px;font-weight:500;border-radius:10px;cursor:pointer;
  transition:background 140ms ease,transform 140ms cubic-bezier(0.22,1,0.36,1);
}
.dml-attachment-choices button[data-kind="folder"]{margin-top:4px;padding-top:4px;position:relative;}
.dml-attachment-choices button[data-kind="folder"]::before{
  content:"";position:absolute;top:0;left:10px;right:10px;height:0.5px;
  background:var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 10%,transparent));
}
.dml-attachment-choices .dml-attach-ico{
  display:inline-grid;place-items:center;width:26px;height:26px;border-radius:7px;flex:none;
  background:color-mix(in srgb,currentColor 7%,transparent);color:var(--dsw-alias-label-secondary,inherit);
}
.dml-attachment-choices button[data-kind="media"] .dml-attach-ico{color:#3b82f6;background:rgba(59,130,246,0.12);}
.dml-attachment-choices button[data-kind="camera"] .dml-attach-ico{color:#10b981;background:rgba(16,185,129,0.12);}
.dml-attachment-choices button[data-kind="files"] .dml-attach-ico{color:#6366f1;background:rgba(99,102,241,0.12);}
.dml-attachment-choices button[data-kind="folder"] .dml-attach-ico{color:#f59e0b;background:rgba(245,158,11,0.12);}
.dml-attachment-choices button:active{background:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,currentColor 11%,transparent));transform:scale(0.97);}
@media(prefers-reduced-motion:reduce){.dml-attachment-choices,.dml-attachment-choices button{transition:none!important;}}
`;
