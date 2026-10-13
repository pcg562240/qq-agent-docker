// Shared DOM dialog for Electron and browsers without window.prompt() support.
window.askGroupAlias = function (current = '') {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog'); dialog.className = 'group-alias-dialog';
    dialog.setAttribute('aria-label', '设置本地群备注');
    const form = document.createElement('form');
    const title = document.createElement('h2'); title.textContent = '设置本地群备注';
    const hint = document.createElement('p'); hint.textContent = '仅改变控制台显示，不修改 QQ 群名。最多 80 字，留空清除备注。';
    const label = document.createElement('label'); label.textContent = '群备注名';
    const input = document.createElement('input'); input.maxLength = 80; input.value = current; input.autocomplete = 'off';
    label.append(input);
    const actions = document.createElement('div'); actions.className = 'group-alias-actions';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = '取消';
    const save = document.createElement('button'); save.type = 'submit'; save.textContent = '保存备注';
    actions.append(cancel, save); form.append(title, hint, label, actions); dialog.append(form);
    let finished = false;
    const finish = value => { if (finished) return; finished = true; dialog.close(); dialog.remove(); resolve(value); };
    form.addEventListener('submit', event => { event.preventDefault(); finish(input.value); });
    cancel.addEventListener('click', () => finish(null));
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
    document.body.append(dialog); dialog.showModal(); input.focus(); input.select();
  });
};
