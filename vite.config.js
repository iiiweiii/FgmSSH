import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';

// 应用版本号 (package.json) -> 构建期注入 __APP_VERSION__, 供设置面板离线显示当前版本
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// FgmSSH Tauri v2 前端构建配置
// - 与 tauri.conf.json 配合: dev 指向 http://localhost:1420, 生产读取 dist/
// - envPrefix 同时暴露 VITE_ 与 TAURI_ 开头的环境变量 (Tauri 官方约定)
// - build.target chrome105: 与 Tauri v2 捆绑的 WebView2 (Windows) 最低 Chromium 基线一致
export default defineConfig({
  // 防止 vite 清空终端输出 (tauri dev 需要看到 Rust 编译日志)
  clearScreen: false,
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version || '0.0.0'),
  },
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
