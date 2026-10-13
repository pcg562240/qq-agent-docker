// Docker-specific entrypoint. Never launches a desktop QQ client or changes sysctl.
import { parseConsoleAllowedHosts, validConsoleToken } from './console-auth.js';
process.umask(0o077);
process.env.QQ_AGENT_DOCKER = '1';
process.env.QQ_AGENT_DATA_DIR ||= '/data';
if (!validConsoleToken(process.env.QQ_AGENT_CONSOLE_TOKEN)) {
  console.error('QQ_AGENT_CONSOLE_TOKEN 应为 8–256 位字母、数字、下划线或连字符；建议使用至少 24 位随机密码，可运行 npm run docker:init 生成。');
  process.exit(1);
}
if (!['qqbot', 'onebot'].includes(process.env.QQ_AGENT_CHANNEL || 'qqbot')) {
  console.error('QQ_AGENT_CHANNEL 只支持 qqbot / onebot。');
  process.exit(1);
}
parseConsoleAllowedHosts(process.env.QQ_AGENT_ALLOWED_HOSTS || '');
if ((process.env.QQ_AGENT_CHANNEL || 'qqbot') === 'qqbot') {
  // Recover an interrupted directory swap before profile validation sees it.
  const fs = await import('node:fs'); const path = await import('node:path');
  const index = path.join(process.env.QQ_AGENT_DATA_DIR, 'robot-profiles.json');
  if (fs.existsSync(index)) {
    const { runBackupJob } = await import('./profile-backup.js');
    const active = JSON.parse(fs.readFileSync(index, 'utf8')).active;
    if (active !== 'setup') await runBackupJob(process.env.QQ_AGENT_DATA_DIR, active);
  }
  const { prepareRobotProfiles } = await import('./robot-profiles.js');
  const profile = prepareRobotProfiles(process.env.QQ_AGENT_DATA_DIR);
  process.env.QQ_AGENT_PROFILES_ROOT = profile.root;
  process.env.QQ_AGENT_ACTIVE_ROBOT = profile.id;
  process.env.QQ_AGENT_DATA_DIR = profile.dir;
}
if (process.env.QQ_AGENT_ACTIVE_ROBOT && process.env.QQ_AGENT_ACTIVE_ROBOT !== 'setup') {
  const { runBackupJob } = await import('./profile-backup.js');
  await runBackupJob(process.env.QQ_AGENT_PROFILES_ROOT, process.env.QQ_AGENT_ACTIVE_ROBOT);
}
await import('./server.js');
