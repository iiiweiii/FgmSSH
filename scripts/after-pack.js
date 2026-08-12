/**
 * electron-builder afterPack hook
 * 打包完成后禁用 asar integrity 校验 fuse:
 * 某些环境下 (容器/沙箱/远程桌面) 打包 exe 的 asar integrity 校验会静默失败导致应用无法启动,
 * 禁用后可确保任何环境双击即用。
 */
const path = require('path');

exports.default = async function (context) {
  const { appOutDir, packager } = context;
  const exeName = `${packager.appInfo.productFilename}.exe`;
  const exePath = path.join(appOutDir, exeName);

  try {
    const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');
    flipFuses(exePath, {
      version: FuseVersion.V1,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: false,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    });
    console.log(`[afterPack] fuses flipped: asar integrity validation disabled for ${exeName}`);
  } catch (e) {
    console.warn(`[afterPack] flipFuses skipped: ${e.message}`);
  }
};
