/**
 * NimbusSSH - SFTP 断点续传核心逻辑 (纯 node, 无 Electron 依赖)
 * ============================================================
 * 职责:
 *   - 下载续传: 本地以 `目标路径 + '.part'` 文件记录已下载字节。
 *     中断时保留 .part (不删除); 再次下载同一文件到同一路径时检测 .part
 *     存在 -> 从 offset 继续 (sftp.createReadStream({start: offset}) + 追加写),
 *     完成后 rename .part -> 目标文件。
 *   - 上传续传: 以远端大小为准 (sftp.stat 得到已传 offset), 本地从 offset
 *     继续读 (fs.createReadStream({start: offset})), 远端以 flags:'a' 追加写
 *     (ssh2 WriteStream 对 'a' 标志在 open 时 fstat 定位到 EOF, 天然续写)。
 *     中断保留远端半成品, 下次 stat 继续; 完成即远端已完整, 无需改名。
 *   - 进度: onProgress({phase:'downloading'|'uploading', done, total, currentName})
 *     回调, done 为「当前传输总进度」 (含已续传的 offset), total 为文件总大小。
 *   - 边界: 仅支持普通文件续传 (目录 ZIP 下载走 main.js 自研实现, 不在此列);
 *     目标已存在且无 .part 时按现有行为覆盖/全量上传 (续传仅针对 .part 场景)。
 *
 * 设计要点:
 *   - 本模块不 require('electron') 与不直接依赖 ssh2 类型: sftp/fs 均由调用方
 *     注入, tests/resume-test.js 可注入 mock sftp 流与真实 fs (临时目录) node 直跑。
 *   - 返回值统一 { ok, resumed, offset, error? }: resumed=是否发生了断点续传,
 *     offset=续传起点字节数 (未续传为 0)。
 */

// 下载续传中间文件路径: 目标路径 + '.part'
function downloadPartPath(localPath) {
  return `${localPath}.part`;
}

/**
 * 检测本地 .part 是否可用于下载续传。
 * @param {object} fs - fs 模块 (可注入 mock)
 * @param {string} localPath - 下载目标路径
 * @param {number} remoteSize - 远端文件大小 (sftp.stat)
 * @returns {{partPath: string, offset: number, resume: boolean, complete: boolean}}
 *   - complete=true: .part 已写满 (size === remoteSize), 仅需改名, 无需再传输
 *   - resume=true:   0 < size < remoteSize, 从 size 续传
 *   - resume=false:  无 .part / size 异常 (>= remoteSize 或 0), 从头下载
 */
function resolveDownloadResume(fs, localPath, remoteSize) {
  const partPath = downloadPartPath(localPath);
  let partSize = -1;
  try {
    if (fs.existsSync(partPath)) {
      const st = fs.statSync(partPath);
      partSize = (st && typeof st.size === 'number') ? st.size : -1;
    }
  } catch (e) {
    partSize = -1; // stat 失败视为无有效 .part
  }
  const total = (typeof remoteSize === 'number' && remoteSize >= 0) ? remoteSize : 0;
  if (partSize > 0 && partSize < total) {
    return { partPath, offset: partSize, resume: true, complete: false };
  }
  if (partSize === total && total > 0) {
    return { partPath, offset: total, resume: true, complete: true };
  }
  return { partPath, offset: 0, resume: false, complete: false };
}

/**
 * 断点续传下载远端文件 -> 本地。
 * 流程: 检测 .part -> (续传) sftp.createReadStream({start: offset}) + 追加写
 *       -> 完成后 rename .part -> localPath; 中断保留 .part。
 * @param {object} deps
 *   - sftp: SFTP 通道 (须提供 createReadStream)
 *   - fs:   fs 模块
 *   - remotePath / localPath: 远端 / 本地路径
 *   - remoteSize: 远端文件大小 (调用方先 stat 得到; 0 表示未知/空文件)
 *   - onProgress: ({phase, done, total, currentName}) => void (可选)
 * @returns {Promise<{ok:boolean, resumed:boolean, offset:number, error?:string}>}
 */
function downloadFileResumable(deps) {
  const { sftp, fs, remotePath, localPath, remoteSize } = deps || {};
  const report = (typeof deps.onProgress === 'function') ? deps.onProgress : () => {};

  const resolved = resolveDownloadResume(fs, localPath, remoteSize);
  const partPath = resolved.partPath;
  const offset = resolved.offset;

  // .part 已完整: 仅改名即完成 (上次下载已完成但中断在改名前)
  if (resolved.complete) {
    return new Promise((resolve) => {
      fs.rename(partPath, localPath, (err) => {
        if (err) {
          resolve({ ok: false, resumed: true, offset, error: `重命名失败: ${err.message}` });
          return;
        }
        resolve({ ok: true, resumed: true, offset });
      });
    });
  }

  return new Promise((resolve) => {
    let settled = false;
    const settle = (ok, error) => {
      if (settled) return;
      settled = true;
      resolve(ok
        ? { ok: true, resumed: offset > 0, offset }
        : { ok: false, resumed: offset > 0, offset, error });
    };

    // 续传: 远端从 offset 开始读, 本地 .part 追加写; 从头: 覆盖写
    let rs;
    try {
      rs = sftp.createReadStream(remotePath, offset > 0 ? { start: offset } : {});
    } catch (e) {
      settle(false, `创建下载流失败: ${e.message}`);
      return;
    }
    let ws;
    try {
      ws = fs.createWriteStream(partPath, { flags: offset > 0 ? 'a' : 'w' });
    } catch (e) {
      try { rs.destroy(); } catch (e2) {}
      settle(false, `创建本地文件失败: ${e.message}`);
      return;
    }

    rs.on('error', (err) => {
      // 断流: 保留 .part (下次续传), 不删除
      try { ws.destroy(); } catch (e) {}
      settle(false, `下载失败: ${err.message}`);
    });
    ws.on('error', (err) => {
      try { rs.destroy(); } catch (e) {}
      settle(false, `写入本地文件失败: ${err.message}`);
    });
    ws.on('close', () => {
      // 正常完成 (未出错): 改名 .part -> 目标
      if (settled) return;
      fs.rename(partPath, localPath, (err) => {
        if (err) {
          settle(false, `重命名失败: ${err.message}`);
          return;
        }
        settle(true, null);
      });
    });

    let transferred = offset;
    const total = (typeof remoteSize === 'number' && remoteSize >= 0) ? remoteSize : 0;
    const name = String(remotePath).split('/').filter(Boolean).pop() || remotePath;
    rs.on('data', (chunk) => {
      transferred += chunk.length;
      report({ phase: 'downloading', done: transferred, total, currentName: name });
    });
    rs.pipe(ws);
  });
}

/**
 * 检测上传续传起点: 以远端 stat 为基准 (远端大小即已传 offset)。
 * @param {object} deps
 *   - sftp: SFTP 通道 (提供 stat; 可注入 statFn 便于测试)
 *   - localSize: 本地文件大小
 *   - remotePath: 远端路径
 *   - statFn?: (path, cb) => void  可选 stat 实现 (默认 sftp.stat)
 * @returns {Promise<{offset:number, resume:boolean}>}
 *   - 远端不存在 / stat 失败      -> {offset:0, resume:false} (从头上传)
 *   - 远端 0 < size < localSize   -> {offset:size, resume:true}  (续传)
 *   - 远端 size >= localSize      -> {offset:0, resume:false}  (远端已完整/更大, 全量覆盖)
 */
function resolveUploadResume(deps) {
  const { sftp, localSize, remotePath } = deps || {};
  const stat = (typeof deps.statFn === 'function') ? deps.statFn : (p, cb) => sftp.stat(p, cb);
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    try {
      stat(remotePath, (err, st) => {
        if (err || !st || typeof st.size !== 'number') {
          done({ offset: 0, resume: false });
          return;
        }
        const size = st.size || 0;
        if (size > 0 && size < localSize) {
          done({ offset: size, resume: true });
          return;
        }
        done({ offset: 0, resume: false });
      });
    } catch (e) {
      done({ offset: 0, resume: false });
    }
  });
}

/**
 * 断点续传上传本地文件 -> 远端。
 * 流程: stat 远端 -> (续传) 本地从 offset 读 + 远端 flags:'a' 追加写;
 *       无远端/远端已完整 -> 全量覆盖写。中断保留远端半成品 (下次 stat 继续)。
 * @param {object} deps
 *   - sftp: SFTP 通道 (须提供 createWriteStream / stat)
 *   - fs:   fs 模块
 *   - localPath / remotePath: 本地 / 远端路径
 *   - onProgress: ({phase, done, total, currentName}) => void (可选)
 *   - statFn?: (path, cb) => void  可选 stat 实现 (测试注入)
 * @returns {Promise<{ok:boolean, resumed:boolean, offset:number, error?:string}>}
 */
function uploadFileResumable(deps) {
  const { sftp, fs, localPath, remotePath } = deps || {};
  const report = (typeof deps.onProgress === 'function') ? deps.onProgress : () => {};

  let localSize = 0;
  try {
    const st = fs.statSync(localPath);
    if (!st || !st.isFile()) {
      return Promise.resolve({ ok: false, resumed: false, offset: 0, error: '本地文件不存在或不是普通文件' });
    }
    localSize = st.size || 0;
  } catch (e) {
    return Promise.resolve({ ok: false, resumed: false, offset: 0, error: '本地文件不存在' });
  }

  return resolveUploadResume({ sftp, localSize, remotePath, statFn: deps.statFn }).then((r) => {
    const offset = r.offset;
    return new Promise((resolve) => {
      let settled = false;
      const settle = (ok, error) => {
        if (settled) return;
        settled = true;
        resolve(ok
          ? { ok: true, resumed: offset > 0, offset }
          : { ok: false, resumed: offset > 0, offset, error });
      };

      // 续传: 本地从 offset 读剩余部分; 远端 flags:'a' 追加写 (ssh2 自动定位 EOF)
      let rs;
      try {
        rs = fs.createReadStream(localPath, offset > 0 ? { start: offset } : {});
      } catch (e) {
        settle(false, `创建本地读取流失败: ${e.message}`);
        return;
      }
      let ws;
      try {
        ws = sftp.createWriteStream(remotePath, offset > 0 ? { flags: 'a' } : {});
      } catch (e) {
        try { rs.destroy(); } catch (e2) {}
        settle(false, `创建远端写入流失败: ${e.message}`);
        return;
      }

      rs.on('error', (err) => {
        // 断流: 保留远端半成品 (下次 stat 继续), 不删除
        try { ws.destroy(); } catch (e) {}
        settle(false, `读取本地文件失败: ${err.message}`);
      });
      ws.on('error', (err) => {
        try { rs.destroy(); } catch (e) {}
        settle(false, `上传失败: ${err.message}`);
      });
      ws.on('close', () => settle(true, null));

      let transferred = offset;
      const name = String(localPath).split(/[\\/]/).filter(Boolean).pop() || localPath;
      rs.on('data', (chunk) => {
        transferred += chunk.length;
        report({ phase: 'uploading', done: transferred, total: localSize, currentName: name });
      });
      rs.pipe(ws);
    });
  });
}

module.exports = {
  downloadPartPath,
  resolveDownloadResume,
  downloadFileResumable,
  resolveUploadResume,
  uploadFileResumable,
};
