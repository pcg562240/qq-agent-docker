import { ConnectionModels } from './connection-models.js';
const $ = id => document.getElementById(id);
let integration;
let modelsUI, settingsBusy = false;
let profiles, profileBusy = false, switching = false, settingsDirty = false;
let deletingRobot = null;
let qrId = '', qrTimer, qrBusy = false, qrApplying = false, qrConfirmError = '';
async function api(url, data) {
  const response = await fetch(url, data ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) } : {});
  if (response.status === 401) { location.href = '/login.html'; throw new Error('请重新登录'); }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}
function ids(field) { return $(field).value.split(/[\s,，]+/).filter(Boolean); }
function profileControls() {
  const modelLocked = modelsUI?.busy || settingsBusy;
  const locked = profileBusy || switching || qrBusy || qrApplying || modelLocked || profiles?.environmentManaged;
  for (const id of ['robot-save', 'robot-save-switch', 'robot-select']) $(id).disabled = Boolean(locked);
  $('robot-switch').disabled = Boolean(locked || !$('robot-select').value || $('robot-select').value === profiles?.active);
  $('robot-delete').disabled = Boolean(locked || !$('robot-select').value);
  $('qr-start').disabled = Boolean(profileBusy || switching || qrBusy || modelLocked || profiles?.environmentManaged);
  $('save').disabled = Boolean(profileBusy || switching || qrBusy || qrApplying || modelLocked);
  modelsUI?.controls();
}
async function loadProfiles() {
  profiles = await api('/api/robots');
  $('robot-profiles').hidden = !profiles.enabled;
  $('shared-model-label').hidden = !profiles.enabled;
  if (!profiles.enabled) return;
  $('appId').readOnly = true;
  $('appId').placeholder = '请用扫码或上方新增机器人入口';
  $('active-robot').textContent = profiles.active === 'setup' ? '尚未选择机器人' : `当前 AppID · ${profiles.active}`;
  $('profile-environment').hidden = !profiles.environmentManaged;
  const previous = $('robot-select').value;
  $('robot-select').replaceChildren(...profiles.accounts.map(account => {
    const option = document.createElement('option'); option.value = account.id;
    option.textContent = `${account.name} · ${account.id}${account.active ? '（当前）' : ''}`; return option;
  }));
  if (!profiles.accounts.length) {
    const option = document.createElement('option'); option.value = ''; option.textContent = '暂无已保存的机器人';
    $('robot-select').append(option);
  }
  $('robot-select').value = profiles.accounts.some(a => a.id === previous) ? previous
    : profiles.accounts.some(a => a.id === profiles.active) ? profiles.active : (profiles.accounts[0]?.id || '');
  $('identity-help').textContent = '当前 AppID 固定在独立的数据空间。更换请用上方新增 / 切换，或扫码授权；旧机器人的配置与历史会保留。加群及全量群消息以平台权限为准。';
  profileControls();
}
function checkSwitch() {
  if (settingsDirty || modelsUI?.dirty) throw new Error('当前表单有未保存的设置，请先保存，或刷新页面放弃修改后再切换或删除当前机器人。');
}
async function waitForRestart({ deleted = false } = {}) {
  switching = true; clearTimeout(qrTimer); qrId = ''; profileControls();
  document.querySelectorAll('#settings button, #settings input, #settings select, #settings textarea').forEach(el => { el.disabled = true; });
  $('profile-message').textContent = deleted ? '机器人已移出列表，数据已保留。正在停止连接并重启服务，完成后自动刷新…' : '正在切换：保存旧机器人的状态并重启服务，完成后自动刷新…';
  $('qr-status').textContent = deleted ? '' : '凭据已保存，正在切换机器人…';
  const context = document.querySelector('meta[name="qq-profile-context"]')?.content;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    try {
      const response = await fetch('/healthz', { cache: 'no-store', signal: AbortSignal.timeout(3000) });
      const state = await response.json();
      if (response.ok && state.ok && state.instance && state.instance !== context) { location.reload(); return; }
    } catch { /* Worker is intentionally offline during the switch. */ }
  }
  $('profile-message').textContent = '配置已保存，但服务尚未就绪。请稍后刷新页面；若持续未恢复，请检查 Docker 容器状态与日志（Compose 需保留 restart: unless-stopped）。';
}
$('settings').addEventListener('input', event => {
  if (!event.target.closest('#robot-profiles') && !event.target.closest('#qr-confirm-panel') && !event.target.closest('#model-settings')) settingsDirty = true;
});
$('robot-select').addEventListener('change', profileControls);
$('robot-delete').addEventListener('click', () => {
  try {
    const selected = profiles?.accounts.find(a => a.id === $('robot-select').value);
    if (!selected || profileBusy || switching || qrBusy || qrApplying || profiles.environmentManaged) return;
    if (selected.active) checkSwitch();
    deletingRobot = { ...selected };
    $('delete-robot-name').textContent = `${selected.name} · ${selected.id}`;
    $('delete-active-warning').hidden = !selected.active;
    $('delete-confirm-id').value = ''; $('delete-confirm-id').placeholder = selected.id;
    $('delete-error').textContent = ''; $('robot-delete-confirm').disabled = true;
    $('robot-delete-dialog').showModal(); $('delete-confirm-id').focus();
  } catch (error) { $('profile-message').textContent = error.message; }
});
$('delete-confirm-id').addEventListener('input', () => {
  $('robot-delete-confirm').disabled = profileBusy || $('delete-confirm-id').value.trim() !== deletingRobot?.id;
});
$('robot-delete-cancel').addEventListener('click', () => { if (!profileBusy) $('robot-delete-dialog').close(); });
$('robot-delete-dialog').addEventListener('cancel', event => { if (profileBusy) event.preventDefault(); });
$('robot-delete-dialog').addEventListener('close', () => { deletingRobot = null; });
$('robot-delete-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!deletingRobot || profileBusy || $('delete-confirm-id').value.trim() !== deletingRobot.id) return;
  try {
    if (deletingRobot.active) checkSwitch();
    profileBusy = true; profileControls();
    $('robot-delete-confirm').disabled = true; $('robot-delete-cancel').disabled = true;
    const result = await api('/api/robots/delete', { appId: deletingRobot.id, confirmAppId: $('delete-confirm-id').value.trim() });
    $('robot-delete-dialog').close();
    if (result.switching) { await waitForRestart({ deleted: true }); return; }
    await loadProfiles();
    $('profile-message').textContent = `机器人 ${result.appId} 已删除，原数据保留；重新添加同一 AppID 可恢复。当前机器人连接未改变。`;
  } catch (error) { $('delete-error').textContent = error.message; }
  finally {
    profileBusy = false; profileControls(); $('robot-delete-cancel').disabled = false;
    $('robot-delete-confirm').disabled = $('delete-confirm-id').value.trim() !== deletingRobot?.id;
  }
});
$('robot-switch').addEventListener('click', async () => {
  try {
    checkSwitch(); profileBusy = true; profileControls();
    const result = await api('/api/robots/switch', { appId: $('robot-select').value });
    if (result.switching) await waitForRestart();
  } catch (error) { $('profile-message').textContent = error.message; }
  finally { profileBusy = false; profileControls(); }
});
for (const [id, activate] of [['robot-save', false], ['robot-save-switch', true]]) {
  $(id).addEventListener('click', async () => {
    try {
      if (activate) checkSwitch();
      profileBusy = true; profileControls();
      const result = await api('/api/robots/save', { appId: $('new-app-id').value.trim(), appSecret: $('new-secret').value.trim(), name: $('new-name').value.trim(), activate });
      $('new-secret').value = '';
      if (result.switching) { await waitForRestart(); return; }
      await loadProfiles(); $('robot-select').value = result.appId;
      $('profile-message').textContent = `机器人 ${result.appId} 已保存。选择后点击「切换到所选机器人」即可启用。`;
    } catch (error) { $('profile-message').textContent = error.message; }
    finally { profileBusy = false; profileControls(); }
  });
}
async function refresh() {
  integration = await api('/api/integration');
  $('status').textContent = `${integration.type === 'qqbot' ? 'QQ 官方机器人' : '外部 OneBot'} · ${integration.connected ? '已连接' : '未连接'}${integration.error ? ` · ${integration.error}` : ''}`;
  $('official').hidden = integration.type !== 'qqbot';
  $('connection-help').textContent = integration.hint || '';
  $('connection-help').hidden = !integration.hint;
  if (integration.type !== 'qqbot') return;
  const peers = $('peers'); peers.replaceChildren();
  if (!integration.peers.length) peers.textContent = '暂无。请先向机器人发一条消息，再刷新。';
  for (const peer of integration.peers) {
    const row = document.createElement('div'); row.className = 'peer';
    const label = document.createElement('div');
    const title = document.createElement('span'); title.textContent = `${peer.kind === 'group' ? '群聊' : '私聊'} · ${peer.id}`;
    label.append(title);
    if (peer.lastSeenAt) {
      const detail = document.createElement('div'); detail.className = 'muted small';
      const states = { not_allowed: '该条消息被白名单 / 黑名单拦截，保存名单后请重发', not_mentioned: '该条消息未识别到 @ 本机器人',
        processing: '正在交给消息处理器', forwarded: '已通过通道筛选（不等于模型已回复）', error: '消息处理异常，请查看日志' };
      detail.textContent = `${new Date(peer.lastSeenAt).toLocaleString()} · ${peer.lastEventType}${peer.kind === 'group' ? ` · @识别：${peer.lastAtMe ? '是' : '否'}` : ''} · ${states[peer.lastIngress] || '已收到'}`;
      label.append(detail);
    }
    const add = document.createElement('button'); add.type = 'button'; add.textContent = '加入白名单';
    add.addEventListener('click', () => {
      const field = peer.kind === 'group' ? 'groups' : 'private';
      $(field).value = [...new Set([...ids(field), peer.id])].join('\n');
      settingsDirty = true;
      $('message').textContent = '已添加到表单，请点击「保存并应用」。';
    });
    row.append(label, add); peers.append(row);
  }
}
async function init() {
  const cfg = await api('/api/config');
  const c = cfg.config || cfg;
  $('appId').value = c.qqbot?.appId || '';
  $('enabled').checked = c.qqbot?.enabled !== false;
  $('requireMention').checked = c.qqbot?.requireMention !== false;
  $('secret').placeholder = c.qqbot?.hasClientSecret ? '已配置，留空保留' : '填写 AppSecret';
  $('private').value = (c.allow?.private || []).join('\n');
  $('groups').value = (c.allow?.groups || []).join('\n');
  await modelsUI.load(); await loadProfiles(); await refresh();
}
$('settings').addEventListener('submit', async event => {
  event.preventDefault(); $('save').disabled = true;
  try {
    if (qrBusy || qrApplying || profileBusy || switching || modelsUI.busy || settingsBusy) throw new Error('请先完成或取消扫码 / 切换 / 模型操作，再保存其他设置。');
    const allowed = [...ids('private'), ...ids('groups')];
    if (allowed.some(id => !/^[A-Za-z0-9_-]{1,256}$/.test(id))) throw new Error('OpenID 只接受字母、数字、下划线和连字符');
    const patch = { allow: { private: ids('private'), groups: ids('groups') }, allowAllWhenEmpty: false };
    if (integration?.type === 'qqbot') {
      patch.qqbot = { appId: $('appId').value.trim(), enabled: $('enabled').checked, requireMention: $('requireMention').checked };
      if (patch.qqbot.appId && !/^\d+$/.test(patch.qqbot.appId)) throw new Error('AppID 应为数字字符串');
      if ($('secret').value.trim()) patch.qqbot.clientSecret = $('secret').value.trim();
    }
    settingsBusy = true; profileControls();
    if (modelsUI.dirty) await modelsUI.save(true, true);
    await api('/api/config', patch);
    settingsDirty = false;
    $('secret').value = ''; $('apiKey').value = '';
    $('message').textContent = '配置已保存。连接可能需要数秒，请刷新状态；加入白名单后请重新发送消息。';
    await refresh();
  } catch (error) { $('message').textContent = error.message; }
  finally { settingsBusy = false; profileControls(); }
});
$('refresh').addEventListener('click', () => refresh().catch(e => { $('message').textContent = e.message; }));
function stopQrUi() {
  clearTimeout(qrTimer); qrId = ''; qrBusy = false;
  $('qr-image').hidden = true; $('qr-image').removeAttribute('src');
  $('qr-confirm-panel').hidden = true; $('qr-cancel').hidden = true;
  $('qr-start').disabled = false; $('save').disabled = false;
  profileControls();
}
function showQr(state) {
  $('qr-panel').hidden = false;
  $('qr-image').hidden = !state.qrImage;
  if (state.qrImage) $('qr-image').src = state.qrImage;
  else $('qr-image').removeAttribute('src');
  const messages = { creating: '正在向腾讯申请二维码…', waiting: '请用手机 QQ 扫码并确认授权。本次任务最长保留 5 分钟。',
    authorized: '扫码授权已完成。请选择并确认保存；尚未连接 QQ Gateway。',
    expired: '二维码任务已过期，请重新生成。', failed: state.error || '扫码失败，请重试。', cancelled: '扫码已取消。', applied: '凭据已保存，正在连接 QQ…' };
  $('qr-status').textContent = (state.status === 'authorized' && qrConfirmError) || messages[state.status] || '未知扫码状态，请重新生成。';
  if (state.status === 'authorized') {
    $('qr-confirm-panel').hidden = false;
    $('qr-account').replaceChildren(...state.accounts.map(account => {
      const option = document.createElement('option'); option.value = account.appId;
      option.textContent = `AppID ${account.appId}${account.hasScanUser ? '' : '（未返回扫码用户标识）'}`;
      return option;
    }));
    // Keep polling the local status until confirmation, so pending secrets expire visibly.
  } else $('qr-confirm-panel').hidden = true;
  if (['expired', 'failed', 'cancelled', 'applied'].includes(state.status)) stopQrUi();
}
async function pollQr(id) {
  if (qrId !== id) return;
  try {
    const state = await api('/api/qq/login/status', { id });
    if (qrId !== id || qrApplying) return;
    const selected = $('qr-account').value;
    showQr(state);
    if (state.accounts.some(a => a.appId === selected)) $('qr-account').value = selected;
    if (qrId === id) qrTimer = setTimeout(() => pollQr(id), 2000);
  } catch (error) {
    if (qrId !== id) return;
    stopQrUi(); $('qr-status').textContent = `${error.message} 请重新生成二维码。`;
  }
}
$('qr-start').addEventListener('click', async () => {
  qrConfirmError = '';
  stopQrUi(); qrBusy = true; $('save').disabled = true; $('qr-start').disabled = true;
  profileControls();
  $('qr-panel').hidden = false; $('qr-status').textContent = '正在创建扫码任务…';
  try {
    const state = await api('/api/qq/login/start', {});
    qrId = state.id; showQr(state); $('qr-cancel').hidden = !qrId;
    if (qrId) qrTimer = setTimeout(() => pollQr(state.id), 1000);
  } catch (error) { stopQrUi(); $('qr-status').textContent = error.message; }
});
$('qr-cancel').addEventListener('click', async () => {
  const id = qrId; stopQrUi(); $('qr-status').textContent = '扫码已取消，原配置保持不变。';
  if (id) try { await api('/api/qq/login/cancel', { id }); } catch { /* Backend TTL also cleans up. */ }
});
$('qr-confirm').addEventListener('click', async () => {
  if (!qrId || qrApplying) return;
  qrApplying = true; clearTimeout(qrTimer);
  $('qr-confirm').disabled = true; $('qr-cancel').disabled = true;
  try {
    if (profiles?.enabled && $('qr-account').value !== profiles.active) checkSwitch();
    const result = await api('/api/qq/login/confirm', { id: qrId, appId: $('qr-account').value, allowScanUser: $('qr-allow-user').checked });
    if (result.switching) { await waitForRestart(); return; }
    stopQrUi(); $('appId').value = result.appId; $('secret').value = ''; $('secret').placeholder = '扫码密钥已保存，留空保留'; $('enabled').checked = true;
    // Only refresh persisted QQ fields; do not discard unsaved model settings.
    const cfg = await api('/api/config'); $('private').value = (cfg.allow?.private || []).join('\n');
    $('qr-status').textContent = '扫码凭据已保存。正在连接，请刷新连接状态；不需要再填写 AppID / AppSecret。';
    await refresh();
  } catch (error) {
    qrConfirmError = error.message; $('qr-status').textContent = error.message;
    if (qrId) qrTimer = setTimeout(() => pollQr(qrId), 8000);
  } finally { qrApplying = false; $('qr-confirm').disabled = switching; $('qr-cancel').disabled = switching; profileControls(); }
});
window.addEventListener('pagehide', () => {
  if (qrId && !qrApplying) fetch('/api/qq/login/cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: qrId }), keepalive: true }).catch(() => {});
});
$('logout').addEventListener('click', async () => {
  if (qrApplying) return;
  if (qrId) await api('/api/qq/login/cancel', { id: qrId }).catch(() => {});
  stopQrUi(); await api('/auth/logout', {}); location.href = '/login.html';
});
modelsUI = new ConnectionModels({ api, isBlocked: () => Boolean(profileBusy || switching || qrBusy || qrApplying || settingsBusy), onBusyChange: profileControls });
init().catch(error => { $('message').textContent = error.message; });
