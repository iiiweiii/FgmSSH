/**
 * FgmSSH - userData 目录迁移辅助模块 (userdata-migrate)
 * ============================================================
 * 背景 (v1.1.0 软件更名):
 *   Electron 的 app.getPath('userData') 基于 productName 计算, productName 变更后,
 *   userData 目录从更名前的旧目录变为新目录 (%APPDATA%/FgmSSH)。
 *   用户既有数据 (connections.json 加密凭据 / known_hosts.json / settings.json / logs/ 等)
 *   全部在旧目录, 若不做迁移将全部读不到 -> 必须在启动早期一次性把旧目录内容复制到新目录。
 *
 * 设计要点:
 *   - 纯 node (fs/path 依赖注入), 不依赖 Electron, 便于 tests/ 下 node 直跑 mock 测试。
 *   - 幂等: 新目录中已有真实用户数据 (connections.json 存在) -> 跳过, 不覆盖不复制。
 *   - 强化判断 (修复 initAuditLog 副作用导致的时序 Bug): 新目录可能已被其他初始化逻辑
 *     (如 audit-log 的 fs.mkdirSync(userData/logs, {recursive:true})) 连带创建 —— 此时
 *     新目录虽「存在」但为空/无关键文件, 仍必须执行复制, 否则升级用户数据丢失。
 *     因此成功条件 = 旧目录存在 && 新目录中关键文件 (connections.json) 缺失。
 *   - 保守: 旧目录不存在 -> 跳过 (首次安装/全新用户, 无迁移必要)。
 *   - 只复制不删除: 迁移后旧目录保留, 防回退 (用户可随时回到旧版本)。
 *   - 复制用 fs.cpSync (Node 16.7+; Electron 31 内置 Node 20), recursive 递归复制全部内容;
 *     新目录已存在但为空/仅含非关键文件时, cpSync 会合并复制并覆盖同名文件。
 *   - DPAPI 加密凭据与路径无关: connections.json 内 password/passphrase 是 safeStorage
 *     加密串, 复制到新目录后仍可解密 (已确认)。
 *   - 旧目录名由调用方 (main.js) 传入, 本模块不硬编码产品名。
 *
 * @module userdata-migrate
 */

'use strict';

/**
 * 判断新目录中是否已存在「真实用户数据」: 以 connections.json (加密凭据库) 为准。
 * 新目录被 mkdirSync 连带创建 (空目录) 或仅含非关键文件 -> 视为无真实数据, 需迁移。
 * @param {object} fs - fs 模块
 * @param {object} path - path 模块
 * @param {string} newDir - 新 userData 目录
 * @returns {boolean}
 */
function newDirHasRealData(fs, path, newDir) {
  try {
    if (!fs.existsSync(newDir)) return false;
    return fs.existsSync(path.join(newDir, 'connections.json'));
  } catch (e) {
    return false;
  }
}

/**
 * 递归复制目录 (兼容旧 Node 无 fs.cpSync 的环境): 逐文件/子目录复制, 保持权限位。
 * @param {object} deps - { fs, path }
 * @param {string} src - 源目录
 * @param {string} dst - 目标目录
 */
function copyDirRecursive(deps, src, dst) {
  const { fs, path } = deps;
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(deps, s, d);
    } else if (entry.isSymbolicLink()) {
      try { fs.symlinkSync(fs.readlinkSync(s), d); } catch (e) { /* 符号链接失败不阻塞整体 */ }
    } else if (entry.isFile()) {
      fs.copyFileSync(s, d);
      try { fs.chmodSync(d, fs.statSync(s).mode); } catch (e) { /* 权限复制失败不影响内容 */ }
    }
  }
}

/**
 * 执行 userData 迁移 (更名后旧目录 -> 新目录)。
 * 成功条件 (v1.1.0 强化): 旧目录存在 && 新目录中无真实用户数据 (connections.json 缺失)。
 * 幂等: 新目录已有 connections.json (真实数据, 含上次迁移完成/用户已有数据) -> 跳过。
 * @param {object} opts
 * @param {object} opts.fs - fs 模块 (可注入 mock)
 * @param {object} opts.path - path 模块 (可注入 mock)
 * @param {string} opts.oldDir - 旧 userData 目录 (更名前, 由调用方传入)
 * @param {string} opts.newDir - 新 userData 目录 (app.getPath('userData'))
 * @param {Function} [opts.log] - (message: string) => void, 审计/日志回调 (失败也回调)
 * @returns {{migrated:boolean, reason:string}}
 *   migrated=true  已执行复制 (旧目录内容复制到新目录)
 *   migrated=false 未执行复制, reason 说明原因 (new_exists / old_missing / check_error / copy_error / ...)
 */
function migrateUserData({ fs, path, oldDir, newDir, log }) {
  const logger = (typeof log === 'function') ? log : () => {};
  if (!fs || !path) {
    logger('userData 迁移: 依赖注入缺失 (fs/path), 跳过');
    return { migrated: false, reason: 'missing_deps' };
  }
  if (!oldDir || !newDir) {
    logger('userData 迁移: 目录参数为空, 跳过');
    return { migrated: false, reason: 'empty_dir' };
  }
  // 幂等 (先判真实数据再判旧目录): 新目录已有 connections.json (真实数据) -> 跳过, 不覆盖不复制
  // 注意: 不能仅凭「新目录存在」就跳过 —— initAuditLog 的 mkdirSync(recursive) 会连带创建
  // 新目录 (空), 若此时跳过将导致升级用户旧数据不迁移 (数据丢失)。
  try {
    if (newDirHasRealData(fs, path, newDir)) {
      logger('userData 迁移: 新目录已含真实数据 (connections.json), 跳过 (幂等)');
      return { migrated: false, reason: 'new_exists' };
    }
  } catch (e) {
    logger('userData 迁移: 检查新目录失败 (' + (e && e.message) + '), 跳过');
    return { migrated: false, reason: 'check_error' };
  }
  // 旧目录不存在 -> 全新安装/无历史数据, 无需迁移
  try {
    if (!fs.existsSync(oldDir)) {
      logger('userData 迁移: 旧目录不存在 (' + oldDir + '), 跳过 (无历史数据)');
      return { migrated: false, reason: 'old_missing' };
    }
  } catch (e) {
    logger('userData 迁移: 检查旧目录失败 (' + (e && e.message) + '), 跳过');
    return { migrated: false, reason: 'check_error' };
  }
  // 执行复制 (recursive): connections.json / known_hosts.json / settings.json / logs/ 等全量。
  // 新目录可能已被连带创建 (空/含非关键文件): cpSync 合并复制并覆盖同名文件, 无副作用。
  try {
    if (typeof fs.cpSync === 'function') {
      fs.cpSync(oldDir, newDir, { recursive: true });
    } else {
      copyDirRecursive({ fs, path }, oldDir, newDir); // 兼容旧 Node 兜底
    }
    logger('userData 迁移: 已从 ' + oldDir + ' 复制到 ' + newDir + ' (旧目录保留)');
    return { migrated: true, reason: 'migrated' };
  } catch (e) {
    logger('userData 迁移: 复制失败 (' + (e && e.message) + '), 新目录可能不完整');
    return { migrated: false, reason: 'copy_error' };
  }
}

module.exports = { migrateUserData, copyDirRecursive, newDirHasRealData };
