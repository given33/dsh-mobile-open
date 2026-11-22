// An isolated example; use real plugin storage in a production panel.
export const name = 'dsh-mobile-panel-example';
export const inject = ['mobilePanels'];

export function apply(ctx) {
  let revision = 0;
  let note = '初始值';
  ctx.effect(() => ctx.mobilePanels.register('dsh-mobile-panel-example', {
    id: 'note',
    title: '原生插件示例',
    detail: '修改下方字段，然后保存到电脑上的示例插件。',
    fields: [{ id: 'note', title: '备注', kind: 'text', required: true }],
    read() {
      return { revision, values: { note }, info: [{ title: '更新次数', value: String(revision) }] };
    },
    actions: [{
      id: 'save', title: '保存备注', confirm: true,
      run(values, { expectedRevision }) {
        if (String(revision) !== expectedRevision) throw new Error('State changed');
        note = values.note;
        revision++;
        return '已保存。';
      },
    }],
  }), 'native phone example');
}
