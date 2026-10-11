const $ = id => document.getElementById(id);
const base = value => String(value || '').trim().replace(/\/+$/, '');

export class ConnectionModels {
  constructor({ api, isBlocked, onBusyChange }) {
    Object.assign(this, { api, isBlocked, onBusyChange });
    this.busy = false; this.dirty = false; this.loaded = false;
    this.items = []; this.providerId = ''; this.useCurrent = false; this.selected = '';
    $('saved-model').addEventListener('change', () => {
      const value = $('saved-model').value;
      if (this.dirty && !window.confirm('模型表单有未保存的修改，放弃修改并载入所选模型？')) {
        $('saved-model').value = this.selected; return;
      }
      this.selected = value;
      this.fill(value === '' ? {} : this.items[Number(value)]);
      this.message(value === '' ? '填写新模型的地址、Key 和模型 ID。' : '仅载入表单，尚未切换；点击「启用所选模型」生效。'); this.controls();
    });
    $('model-new').addEventListener('click', () => {
      if (this.dirty && !window.confirm('放弃未保存的模型修改，填写新模型？')) return;
      this.selected = ''; $('saved-model').value = ''; this.fill({}); this.message('填写地址和模型，点击获取列表或手动输入；保存后可反复切换。');
      $('baseUrl').focus(); this.controls();
    });
    for (const id of ['baseUrl', 'apiKey', 'model']) $(id).addEventListener('input', () => {
      this.dirty = true;
      if (id === 'baseUrl' && base($('baseUrl').value) !== this.boundBase) {
        this.providerId = ''; this.useCurrent = false;
        $('apiKey').placeholder = '新地址不会沿用旧服务的 Key；无鉴权服务可留空';
        $('model-list-label').hidden = true;
      }
      this.message('模型表单已修改，尚未保存或启用。'); this.controls();
    });
    $('model-list').addEventListener('change', () => {
      if (!$('model-list').value) return;
      $('model').value = $('model-list').value; this.dirty = true;
      this.message('已选入表单，可先测试，再保存或启用。'); this.controls();
    });
    $('model-fetch').addEventListener('click', () => this.perform(async () => {
      this.message('正在获取模型列表…');
      const result = await api('/api/connection/models/fetch', this.input());
      const empty = document.createElement('option'); empty.value = ''; empty.textContent = '请选择模型（也可手动输入）';
      $('model-list').replaceChildren(empty, ...result.models.map(model => {
        const option = document.createElement('option'); option.value = model; option.textContent = model; return option;
      }));
      if (result.models.includes($('model').value)) $('model-list').value = $('model').value;
      $('model-list-label').hidden = false;
      this.message(`已获取 ${result.models.length} 个模型，请从下方列表选择。获取列表不会更改当前模型。`, 'success');
    }).catch(() => {}));
    $('model-test').addEventListener('click', () => this.perform(async () => {
      this.message('正在测试所填模型（发送一条简短测试请求，不向 QQ 发消息）…');
      const { result } = await api('/api/connection/models/test', this.input());
      const latency = Number.isFinite(result.latencyMs) ? ` · ${result.latencyMs} ms` : '';
      this.message(`${result.ok ? '连接测试成功' : '连接测试失败'}${latency}\n${result.note || ''}`, result.ok ? 'success' : 'error');
    }).catch(() => {}));
    $('model-save').addEventListener('click', () => this.save(false).catch(() => {}));
    $('model-save-use').addEventListener('click', () => this.save(true).catch(() => {}));
    $('model-use').addEventListener('click', () => this.perform(async () => {
      const item = this.items[Number($('saved-model').value)];
      if (!item || this.dirty || item.legacy) throw new Error('请先保存当前模型表单，或重新选择已保存模型。');
      const result = await api('/api/connection/models/select', { providerId: item.providerId, model: item.model });
      this.render(result); this.message(`已启用 ${result.current.model}，后续模型请求生效，无需重启 QQ。`, 'success');
    }).catch(() => {}));
    this.controls();
  }
  input() {
    return { baseUrl: $('baseUrl').value.trim(), model: $('model').value.trim(), apiKey: $('apiKey').value.trim(),
      providerId: this.providerId, useCurrent: this.useCurrent };
  }
  message(text, state = '') { $('model-message').textContent = text; $('model-message').dataset.state = state; }
  fill(item) {
    this.providerId = item.providerId || ''; this.useCurrent = item.legacy === true; this.boundBase = base(item.baseUrl);
    $('baseUrl').value = item.baseUrl || ''; $('model').value = item.model || ''; $('apiKey').value = '';
    $('apiKey').placeholder = item.hasKey ? '此服务已保存 Key，留空保留；不回显明文' : '填写此服务的 API Key；无鉴权服务可留空';
    $('model-list-label').hidden = true; this.dirty = false;
  }
  render(data, selected = data.current) {
    this.items = data.items; this.current = data.current; this.loaded = true;
    $('active-model').textContent = data.current.model ? `当前：${data.current.model}` : '当前未设置模型';
    $('active-model-endpoint').textContent = data.current.baseUrl || '';
    const empty = document.createElement('option'); empty.value = ''; empty.textContent = '选择已保存模型，或点击新增';
    $('saved-model').replaceChildren(empty, ...data.items.map((item, i) => {
      const option = document.createElement('option'); option.value = String(i);
      option.textContent = `${item.name} · ${item.providerName}${item.active ? '（当前）' : ''}`; return option;
    }));
    const index = data.items.findIndex(m => m.providerId === selected?.providerId && m.model === selected?.model);
    this.selected = index < 0 ? '' : String(index); $('saved-model').value = this.selected;
    this.fill(index < 0 ? data.current : data.items[index]); this.controls();
  }
  async load() { this.render(await this.api('/api/connection/models')); }
  async perform(fn, fromSettings = false) {
    if (this.busy || (!fromSettings && this.isBlocked())) throw new Error('请等待当前操作完成。');
    this.busy = true; this.controls(); this.onBusyChange();
    try { return await fn(); }
    catch (error) { this.message(error.message, 'error'); throw error; }
    finally { this.busy = false; this.controls(); this.onBusyChange(); }
  }
  save(activate, fromSettings = false) {
    return this.perform(async () => {
      this.message(activate ? '正在保存并启用模型…' : '正在保存模型…');
      const data = await this.api('/api/connection/models/save', { ...this.input(), activate });
      this.render(data, data.saved);
      this.message(activate ? `已保存并启用 ${data.current.model}。` : `已保存 ${data.saved.model}，当前使用的模型未切换。`, 'success');
    }, fromSettings);
  }
  controls() {
    const locked = this.busy || this.isBlocked() || !this.loaded;
    for (const id of ['saved-model', 'model-new', 'baseUrl', 'apiKey', 'model', 'model-list']) $(id).disabled = locked;
    const hasBase = Boolean($('baseUrl').value.trim()), hasModel = Boolean($('model').value.trim());
    $('model-fetch').disabled = locked || !hasBase;
    for (const id of ['model-test', 'model-save', 'model-save-use']) $(id).disabled = locked || !hasBase || !hasModel;
    const selected = $('saved-model').value === '' ? null : this.items[Number($('saved-model').value)];
    $('model-use').disabled = locked || this.dirty || !selected || selected.active || selected.legacy;
  }
}
