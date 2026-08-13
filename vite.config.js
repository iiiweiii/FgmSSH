import { defineConfig } from 'vite';

// FgmSSH Tauri v2 前端构建配置
// - 与 tauri.conf.json 配合: dev 指向 http://localhost:1420, 生产读取 dist/
// - envPrefix 同时暴露 VITE_ 与 TAURI_ 开头的环境变量 (Tauri 官方约定)
// - build.target chrome105: 与 Tauri v2 捆绑的 WebView2 (Windows) 最低 Chromium 基线一致
export default defineConfig({
  // 防止 vite 清空终端输出 (tauri dev 需要看到 Rust 编译日志)
  clearScreen: false,
  server: {
    // 固定端口: tauri.conf.json build.devUrl 必须与此一致
    port: 1420,
    strictPort: true,
    watch: {
      // tauri dev 下 src-tauri 的 Rust 文件变化由 cargo 自行监听, 不触发 vite 重载
      ignored: ['**/src-tauri/**'],
    },
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: 'chrome105',
    minify: process.env.TAURI_DEBUG ? false : 'esbuild',
    sourcemap: !!process.env.TAURI_DEBUG,
  },
});
