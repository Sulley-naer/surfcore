/**
 * 桥接功能开关（纯逻辑，不碰 fs）。
 *
 * 开关定义在代码里、状态存在桥接的 config.json 里：插件只负责"读出来给 UI"和
 * "把改动写回去"，真正的生效在重启桥接之后。之所以不给每个开关加一层缓存文件，
 * 是因为桥接本来就是 config.json 的唯一写者，多一份影子状态只会让两边打架。
 */

/** 开关清单：path 是 config.json 里的路径数组；缺省一律视为开启。 */
export const FEATURE_TOGGLES = [
  { id: 'runCode', group: 'tools', path: ['socialV2', 'tools', 'runCode'], label: '执行命令 qq_run_code' },
  { id: 'taskRun', group: 'tools', path: ['socialV2', 'tools', 'taskRun'], label: '后台任务 qq_task_run' },
  { id: 'taskStatus', group: 'tools', path: ['socialV2', 'tools', 'taskStatus'], label: '任务状态 qq_task_status' },
  { id: 'taskCancel', group: 'tools', path: ['socialV2', 'tools', 'taskCancel'], label: '撤销任务 qq_task_cancel' },
  { id: 'scheduleAdd', group: 'tools', path: ['socialV2', 'tools', 'scheduleAdd'], label: '日程新增 qq_schedule_add' },
  { id: 'scheduleList', group: 'tools', path: ['socialV2', 'tools', 'scheduleList'], label: '日程查询 qq_schedule_list' },
  { id: 'scheduleCancel', group: 'tools', path: ['socialV2', 'tools', 'scheduleCancel'], label: '日程取消 qq_schedule_cancel' },
  { id: 'wakePhone', group: 'tools', path: ['socialV2', 'tools', 'wakePhone'], label: '派活给手机 qq_wake_phone' },
  { id: 'phoneResult', group: 'tools', path: ['socialV2', 'tools', 'phoneResult'], label: '手机结果 qq_phone_result' },
  { id: 'sendImage', group: 'tools', path: ['socialV2', 'tools', 'sendImage'], label: '发图到 QQ qq_send_image' },
  { id: 'sendSticker', group: 'tools', path: ['socialV2', 'tools', 'sendSticker'], label: '发表情 qq_send_sticker' },
  { id: 'sendVoice', group: 'tools', path: ['socialV2', 'tools', 'sendVoice'], label: '发语音 qq_send_voice' },
  { id: 'getImages', group: 'tools', path: ['socialV2', 'tools', 'getImages'], label: '看图 qq_get_message_images' },
  { id: 'execEnabled', group: 'systems', path: ['socialV2', 'exec', 'enabled'], label: '命令执行总开关' },
  { id: 'ownerTasksEnabled', group: 'systems', path: ['socialV2', 'ownerTasks', 'enabled'], label: '后台任务队列总开关' },
  { id: 'schedulesEnabled', group: 'systems', path: ['socialV2', 'schedules', 'enabled'], label: '日程/定时器总开关' },
  { id: 'phoneWakeEnabled', group: 'systems', path: ['socialV2', 'phoneWake', 'enabled'], label: '手机唤醒通道总开关' },
];

export function readPath(obj, keys) {
  let cur = obj;
  for (const key of keys) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[key];
  }
  return cur;
}

export function writePath(obj, keys, value) {
  let cur = obj;
  for (let index = 0; index < keys.length - 1; index += 1) {
    const key = keys[index];
    if (cur[key] == null || typeof cur[key] !== 'object') cur[key] = {};
    cur = cur[key];
  }
  cur[keys[keys.length - 1]] = value;
}

/**
 * 读当前开关状态。
 * @param {object} cfg 桥接 config.json 的内容
 * @returns {Array<{id,group,label,path,value,explicit}>} 缺省视为 true（与桥接 v2ToolEnabled 一致）
 */
export function readFeatureState(cfg) {
  const source = cfg && typeof cfg === 'object' ? cfg : {};
  return FEATURE_TOGGLES.map((item) => {
    const raw = readPath(source, item.path);
    const explicit = raw !== undefined && raw !== null;
    return {
      id: item.id,
      group: item.group,
      label: item.label,
      path: item.path.join('.'),
      value: explicit ? Boolean(raw) : true,
      explicit,
    };
  });
}

/**
 * 把 values 里的开关写进 cfg（就地修改）。
 * @returns {{ok:boolean, changed:number, ids:string[], unknown:string[], error?:string}}
 */
export function applyFeatureState(cfg, values) {
  if (!cfg || typeof cfg !== 'object') return { ok: false, changed: 0, ids: [], unknown: [], error: '配置不是对象' };
  if (!values || typeof values !== 'object') return { ok: false, changed: 0, ids: [], unknown: [], error: 'values 必须是对象' };
  const known = new Set(FEATURE_TOGGLES.map((item) => item.id));
  const unknown = Object.keys(values).filter((id) => !known.has(id));
  const changedIds = [];
  for (const item of FEATURE_TOGGLES) {
    if (!Object.prototype.hasOwnProperty.call(values, item.id)) continue;
    writePath(cfg, item.path, Boolean(values[item.id]));
    changedIds.push(item.id);
  }
  if (!changedIds.length) {
    return { ok: false, changed: 0, ids: [], unknown, error: unknown.length ? `未知开关：${unknown.join(', ')}` : '没有匹配到任何开关' };
  }
  return { ok: true, changed: changedIds.length, ids: changedIds, unknown };
}
