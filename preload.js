/**
 * NimbusSSH - Preload 脚本
 * 通过 contextBridge 安全暴露 IPC API 给渲染进程
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('nimbus', {
  // SSH 连接
  connect: (sessionId, config) => ipcRenderer.invoke('ssh:connect', { sessionId, config }),
  write: (sessionId, data) => ipcRenderer.invoke('ssh:write', { sessionId, data }),
  resize: (sessionId, rows, cols) => ipcRenderer.invoke('ssh:resize', { sessionId, rows, cols }),
  disconnect: (sessionId) => ipcRenderer.invoke('ssh:disconnect', { sessionId }),
  createTunnel: (sessionId, tunnelCfg) => ipcRenderer.invoke('ssh:tunnel', { sessionId, tunnelCfg }),
  // 端口转发隧道面板 (复用 ssh:tunnel 通道; 新增查询/停止桥接)
  tunnelStart: (sessionId, cfg) => ipcRenderer.invoke('ssh:tunnel', { sessionId, tunnelCfg: cfg }),
  tunnelList: (sessionId) => ipcRenderer.invoke('ssh:tunnel:list', { sessionId }),
  tunnelStop: (sessionId, tunnelId) => ipcRenderer.invoke('ssh:tunnel:stop', { sessionId, tunnelId }),
  // 服务器健康监控 (Roadmap: 健康监控面板): 主进程采集并解析为结构化指标, 返回 {ok, info, load, memory, disks, cpu, errors}
  monitorFetch: (sessionId) => ipcRenderer.invoke('ssh:monitor:fetch', { sessionId }),
  selectKeyFile: () => ipcRenderer.invoke('dialog:selectKey'),
  checkAgent: () => ipcRenderer.invoke('ssh:chooseSshAgent'),

  // SFTP 文件浏览
  sftpList: (sessionId, path) => ipcRenderer.invoke('sftp:list', { sessionId, path }),
  sftpDownload: (sessionId, remotePath, localPath) => ipcRenderer.invoke('sftp:download', { sessionId, remotePath, localPath }),
  sftpUpload: (sessionId, localPath, remotePath) => ipcRenderer.invoke('sftp:upload', { sessionId, localPath, remotePath }),
  // Roadmap ③: SFTP 拖拽上传
  // 取拖入文件的真实本地路径。必须同步调用 webUtils.getPathForFile (接收渲染进程真实拖拽产生的
  // File 对象, 返回其磁盘路径字符串; 对伪造/内存 File 返回空串, 这是拖拽上传的安全边界)。
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || '';
    } catch (err) {
      return '';
    }
  },
  // 拖拽路径登记: 主进程校验存在性/普通文件后登记到 approvedLocalPaths, 供 sftp:upload 消费校验
  // (与对话框流程同等安全, 文件夹在此被过滤, 不做目录递归上传)
  sftpRegisterUploadPaths: (paths) => ipcRenderer.invoke('sftp:registerUploadPaths', { paths }),
  sftpMkdir: (sessionId, path) => ipcRenderer.invoke('sftp:mkdir', { sessionId, path }),
  sftpDelete: (sessionId, path) => ipcRenderer.invoke('sftp:delete', { sessionId, path }),
  sftpRename: (sessionId, oldPath, newPath) => ipcRenderer.invoke('sftp:rename', { sessionId, oldPath, newPath }),
  sftpDownloadFolder: (sessionId, remotePath, localZipPath) => ipcRenderer.invoke('sftp:downloadFolder', { sessionId, remotePath, localZipPath }),
  // R3: 终端 cd 同步 (解析 cd 目标为安全绝对路径, 供 SFTP 面板跟随)
  sftpCdSync: (sessionId, rawPath) => ipcRenderer.invoke('sftp:cdSync', { sessionId, rawPath }),
  // Roadmap 第三梯队 ① (M): SFTP 服务端递归搜索 (find; 关键字白名单 + maxdepth 钳制在主进程)
  sftpSearch: (sessionId, path, keyword, maxDepth) => ipcRenderer.invoke('sftp:search', { sessionId, path, keyword, maxDepth }),
  selectFile: () => ipcRenderer.invoke('dialog:selectFile'),
  selectSavePath: (defaultName) => ipcRenderer.invoke('dialog:selectSavePath', defaultName),

  // 图片预览
  previewOpen: (sessionId, remotePath) => ipcRenderer.invoke('preview:open', { sessionId, remotePath }),
  previewClose: (filename) => ipcRenderer.invoke('preview:close', filename),
  previewSaveAs: (sessionId, remotePath) => ipcRenderer.invoke('preview:saveAs', { sessionId, remotePath }),

  // 内置文档查看器
  docOpen: (sessionId, remotePath) => ipcRenderer.invoke('doc:open', { sessionId, remotePath }),
  docSave: (sessionId, remotePath, content) => ipcRenderer.invoke('doc:save', { sessionId, remotePath, content }),
  docClose: (filename) => ipcRenderer.invoke('doc:close', filename),
  // Roadmap 第一梯队 ③ (M): 大文件分段预览「加载全部」 (主进程追加剩余字节到临时文件)
  docLoadFull: (sessionId, filename) => ipcRenderer.invoke('doc:loadFull', { sessionId, filename }),

  // 数据事件 (主进程 -> 渲染进程)
  onData: (cb) => ipcRenderer.on('ssh:data', (e, payload) => cb(payload)),
  onEvent: (cb) => ipcRenderer.on('ssh:event', (e, payload) => cb(payload)),
  // Roadmap 第一梯队 ③ (S): 更新检查结果事件 (主进程广播, 非会话级)
  onUpdateCheck: (cb) => ipcRenderer.on('update:check', (e, payload) => cb(payload)),

  // 连接配置存储
  storeLoad: () => ipcRenderer.invoke('store:load'),
  storeSave: (list) => ipcRenderer.invoke('store:save', list),

  // 全局设置 (更新检查开关等, 与连接配置无关)
  settingsLoad: () => ipcRenderer.invoke('settings:load'),
  settingsSave: (settings) => ipcRenderer.invoke('settings:save', settings),

  // 配置加密导出/导入 (Roadmap ⑤)
  // 系统对话框/加解密/落盘均在主进程完成; 渲染层只负责输入密码与展示结果。
  // 返回 {ok, count?, error?}: 导出成功含 count (导出条数), 导入成功含 count (导入条数);
  // 失败 error 为固定文案 (密码错误或文件已损坏 / 文件格式无效 / 已取消 等)。
  configExport: (password) => ipcRenderer.invoke('config:export', { password }),
  configImport: (password) => ipcRenderer.invoke('config:import', { password }),

  // 其他
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  // 操作日志
  // 渲染进程手动补充记录 (如打开日志面板等 UI 事件); 主进程内做白名单+脱敏
  auditLog: (entry) => ipcRenderer.invoke('audit:log', entry),
  // 查询: {from,to,user,type,result,limit,offset} -> {ok, total, items}
  auditQuery: (filters) => ipcRenderer.invoke('audit:query', filters),
});
