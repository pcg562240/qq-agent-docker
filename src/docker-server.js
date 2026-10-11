// Docker-specific entrypoint. Never launches a desktop QQ client or changes sysctl.
import { parseConsoleAllowedHosts } from './console-auth.js';
process.umask(0o077);
process.env.QQ_AGENT_DOCKER = '1';
process.env.QQ_AGENT_DATA_DIR ||= '/data';
if (!/^[A-Za-z0-9_-]{24,256}$/.test(process.env.QQ_AGENT_CONSOLE_TOKEN || '')) {
  console.error('QQ_AGENT_CONSOLE_TOKEN 应为 24–256 位字母、数字、下划线或连字符；先运行 npm run docker:init。');
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
