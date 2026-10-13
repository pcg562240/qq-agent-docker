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
  const { prepareRobotProfiles } = await import('./robot-profiles.js');
  const profile = prepareRobotProfiles(process.env.QQ_AGENT_DATA_DIR);
  process.env.QQ_AGENT_PROFILES_ROOT = profile.root;
  process.env.QQ_AGENT_ACTIVE_ROBOT = profile.id;
  process.env.QQ_AGENT_DATA_DIR = profile.dir;
}
await import('./server.js');
