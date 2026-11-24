export const MOBILE_FILE_LIMIT = 200 * 1024 * 1024;

// Only installed on the paired mobile composer. Deliver Files to the official
// input so DSH still owns draft sessions, progress, retries and receipt binding.
export function installAttachmentPicker(showToast, limit) {
  let menu;
  function close() { menu?.remove(); menu = null; }
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
  document.addEventListener('click', event => {
    const input = event.target;
    // Do not intercept importers in plugins or a picker's own click.
    if (!input.matches?.('[data-composer-card] input[type="file"][multiple][hidden]') || input.disabled) return;
    const anchor = input.parentElement.querySelector('button[aria-haspopup="listbox"]');
    if (!anchor) return;
    event.preventDefault(); event.stopImmediatePropagation(); close();
    menu = document.createElement('div'); menu.className = 'dml-attachment-choices';
    menu.setAttribute('role', 'group'); menu.setAttribute('aria-label','添加附件');
    for (const [kind, label] of [['media','照片或视频'],['camera','拍摄'],['files','选择文件'],['folder','选择文件夹（ZIP）']]) {
      const button = document.createElement('button'); button.type='button'; button.textContent=label;
      button.onclick = () => { close(); choose(kind, input); }; menu.append(button);
    }
    const box = anchor.getBoundingClientRect();
    document.body.append(menu);
    menu.style.left = Math.max(8, Math.min(box.left, document.documentElement.clientWidth-menu.offsetWidth-8))+'px';
    menu.style.top = (box.top >= menu.offsetHeight+8 ? box.top-menu.offsetHeight-6 : box.bottom+6)+'px';
    menu.firstElementChild.focus({preventScroll:true});
  }, true);
  document.addEventListener('pointerdown', event => { if (menu && !menu.contains(event.target)) close(); }, true);
  document.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
  globalThis.addEventListener?.('resize', close);
}

export const ATTACHMENT_PICKER_CSS = `
.dml-attachment-choices{position:fixed;z-index:2147483020;padding:4px;min-width:150px;border:1px solid color-mix(in srgb,currentColor 16%,transparent);border-radius:14px;background:Canvas;color:CanvasText;box-shadow:0 6px 24px #0003}
.dml-attachment-choices button{display:block;text-align:start;width:100%;padding:0 12px;min-height:44px;border:0;background:none;color:inherit;font:inherit;border-radius:8px}
.dml-attachment-choices button:active{background:color-mix(in srgb,currentColor 12%,transparent)}
`;
