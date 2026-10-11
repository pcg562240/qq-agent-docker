// Docker 的镜像目录只读；第三方扩展与当前机器人一起持久化到 /data。
// 安装、加载、监听、发布和卸载必须共用这里的路径，不能各自拼 /app/skills。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, DATA_DIR } from './config.js';

export const BUNDLED_DIRS = { skills: path.join(ROOT, 'skills'), plugins: path.join(ROOT, 'plugins') };
export const INSTALL_ROOT = process.env.QQ_AGENT_DOCKER === '1' ? path.join(DATA_DIR, 'extensions') : ROOT;
export const INSTALL_DIRS = { skills: path.join(INSTALL_ROOT, 'skills'), plugins: path.join(INSTALL_ROOT, 'plugins') };
export const hasExternalModules = INSTALL_ROOT !== ROOT;
export const moduleInstallDir = kind => INSTALL_DIRS[kind === 'plugin' ? 'plugins' : 'skills'];

export function ensureModuleDirs() {
  for (const dir of Object.values(INSTALL_DIRS)) fs.mkdirSync(dir, { recursive: true });
  if (!hasExternalModules) return;
  // 社区包原本位于 <app>/skills/<id>，继承 type:module，并可能 import
  // ../../src/config.js 或运行时依赖。保留布局兼容性，不复制旧核心代码/依赖。
  const packageFile = path.join(INSTALL_ROOT, 'package.json');
  try { fs.writeFileSync(packageFile, '{"private":true,"type":"module"}\n', { flag: 'wx' }); }
  catch (e) { if (e.code !== 'EEXIST') throw e; }
  for (const name of ['src', 'node_modules']) {
    const link = path.join(INSTALL_ROOT, name), target = path.join(ROOT, name);
    try { fs.symlinkSync(target, link, 'dir'); }
    catch (e) {
      if (e.code !== 'EEXIST' || !fs.lstatSync(link).isSymbolicLink() || path.resolve(path.dirname(link), fs.readlinkSync(link)) !== target) {
        throw new Error(`扩展兼容路径被占用：${link}`);
      }
    }
  }
}

export function moduleLoadRoots(roots = null) {
  // 测试/自定义根只扫描调用方指定的目录，不混入真实数据。
  if (roots) return ['skills', 'plugins'].map(key => path.resolve(roots[key] || BUNDLED_DIRS[key]));
  if (hasExternalModules) ensureModuleDirs();
  return [...new Set([...Object.values(BUNDLED_DIRS), ...Object.values(INSTALL_DIRS)])];
}

export function isModuleDir(dir, roots = Object.values(INSTALL_DIRS)) {
  return roots.some(root => {
    if (path.dirname(path.resolve(dir)) !== path.resolve(root)) return false;
    try {
      return !fs.lstatSync(dir).isSymbolicLink() && fs.statSync(dir).isDirectory()
        && path.dirname(fs.realpathSync(dir)) === fs.realpathSync(root);
    } catch { return false; }
  });
}
