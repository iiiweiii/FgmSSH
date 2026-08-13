// tauri-build 构建脚本: 生成 tauri.conf.json 的编译期上下文 (icons/windows/csp 等)。
// 缺少本文件时 tauri::generate_context!() 无法解析配置, 属 Tauri v2 必需文件。
fn main() {
    tauri_build::build()
}
