// Environment overlays never become part of the persisted config.
import { parseConsoleAllowedHosts } from './console-auth.js';
export function dockerEnvironment(config, env = process.env) {
  if (env.QQ_AGENT_DOCKER !== '1') return config;
  const out = structuredClone(config);
  out.channel = { type: env.QQ_AGENT_CHANNEL || 'qqbot' };
  out.server = { ...out.server, host: '0.0.0.0', port: Number(env.QQ_AGENT_INTERNAL_PORT) || 3210,
    token: env.QQ_AGENT_CONSOLE_TOKEN || '',
    allowedHosts: parseConsoleAllowedHosts(env.QQ_AGENT_ALLOWED_HOSTS || '') };
  out.snowluma = { ...out.snowluma, autoLaunch: false, account: '' };
  out.extensions = { ...out.extensions, hotReload: false };
  out.qqbot = { enabled: true, appId: '', clientSecret: '', requireMention: true,
    markdown: false, ...out.qqbot };
  for (const [key, name] of Object.entries({ appId: 'QQBOT_APP_ID', clientSecret: 'QQBOT_APP_SECRET' })) {
    if (env[name]) out.qqbot[key] = env[name];
  }
  for (const [key, name] of Object.entries({ wsUrl: 'ONEBOT_WS_URL', httpUrl: 'ONEBOT_HTTP_URL',
    accessToken: 'ONEBOT_ACCESS_TOKEN', httpAccessToken: 'ONEBOT_HTTP_TOKEN' })) {
    if (env[name]) out.snowluma[key] = env[name];
  }
  return out;
}
