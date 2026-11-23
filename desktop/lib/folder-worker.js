// Runs only on an explicit directory selection. Store entries incrementally in a
// ZIP without transforming media, extracting archives or flattening duplicate leaves.
self.onmessage = async ({ data: { items, limit } }) => {
  try {
    const paths = new Set();
    let inputBytes = 0, outputBytes = 0, root;
    if (!items.length || items.length >= 65535) throw new Error('文件夹为空或条目过多。');
    for (const { path, file } of items) {
      const parts = path.split('/');
      root ??= parts[0];
      if (parts.length < 2 || parts[0] !== root || parts.at(-1) !== file.name || paths.has(path) ||
          parts.some(p => !p || p === '.' || p === '..' || /[\\:\x00-\x1f]/.test(p))) throw new Error('文件夹路径无效或重复。');
      paths.add(path); inputBytes += file.size;
    }
    if (inputBytes > limit) throw new Error('文件夹打包后不能超过 200 MB。');
    const chunks = [];
    const zip = new fflate.Zip((err, chunk) => {
      if (err) throw err;
      outputBytes += chunk.length;
      if (outputBytes > limit) throw new Error('文件夹打包后不能超过 200 MB。');
      chunks.push(new Blob([chunk]));
    });
    for (const { path, file } of items) {
      const entry = new fflate.ZipPassThrough(path); zip.add(entry);
      // Slicing also works in WebViews without async iteration on Blob.stream().
      for (let pos=0; pos<file.size; pos+=1024*1024) {
        entry.push(new Uint8Array(await file.slice(pos,pos+1024*1024).arrayBuffer()));
      }
      entry.push(new Uint8Array(), true);
    }
    zip.end();
    self.postMessage({ archive:new File(chunks, root+'.zip', {type:'application/zip'}) });
  } catch (error) { self.postMessage({ error:error.message || '无法读取文件夹。' }); }
};
