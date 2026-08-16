// /goal 扩展 mock 测试：驱动真实扩展逻辑，验证全部子命令 + 状态恢复 + 上下文注入
// 自动定位本机 pi 安装并构建 jiti alias（见 helpers.cjs）
const { jiti } = require('./helpers.cjs');
const mod = jiti(require('path').join(__dirname, '..', 'goal.ts'));
const factory = mod.default;

let passed = 0, failed = 0;
function assert(cond, name, extra) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${extra ? " :: " + extra : ""}`); }
}

function makePi() {
  const state = { entries: [], handlers: {}, commands: {}, tools: {} };
  const pi = {
    on: (ev, fn) => { state.handlers[ev] = fn; },
    registerCommand: (name, opts) => { state.commands[name] = opts; },
    registerTool: (def) => { state.tools[def.name] = def; },
    appendEntry: (type, data) => { state.entries.push({ type: 'custom', customType: type, data: structuredClone(data) }); },
  };
  return { pi, state };
}

function makeCtx(state, logs, opts = {}) {
  return {
    hasUI: opts.hasUI ?? true,
    ui: {
      notify: (msg, t) => logs.push(`notify(${t}): ${msg}`),
      setStatus: (k, v) => logs.push(`status ${k}: ${v}`),
      custom: async (fn) => {
        const fakeTheme = { fg: (_c, s) => s, bold: (s) => s };
        const component = fn({}, fakeTheme, {}, () => {});
        for (const line of component.render(80)) logs.push(`ui: ${line}`);
      },
    },
    sessionManager: { getEntries: () => state.entries, getBranch: () => state.entries },
  };
}

(async () => {
  const { pi, state } = makePi();
  factory(pi);
  assert(typeof state.commands.goal === 'object', '扩展注册了 /goal 命令');
  assert(typeof state.handlers.session_start === 'function', '注册了 session_start 恢复逻辑');
  assert(typeof state.handlers.before_agent_start === 'function', '注册了 before_agent_start 注入逻辑');

  const logs = [];
  const ctx = makeCtx(state, logs);
  await state.handlers.session_start({}, ctx); // 初始恢复

  // --- add ---
  await state.commands.goal.handler('add 编写 /goal 扩展', ctx);
  await state.commands.goal.handler('add 完成全部测试', ctx);
  await state.commands.goal.handler('add 提交上线', ctx);
  const lastEntry = state.entries[state.entries.length - 1];
  assert(lastEntry.customType === 'goal-state', '状态通过 appendEntry 持久化');
  assert(lastEntry.data.goals.length === 3, '3 个目标已添加');
  assert(lastEntry.data.nextId === 4, 'nextId 正确递增');
  assert(logs.some(l => l.includes('目标 #1 已添加')), 'add 给出反馈通知');

  // --- 空参数校验 ---
  logs.length = 0;
  await state.commands.goal.handler('add', ctx);
  assert(logs.some(l => l.includes('用法')), 'add 无文本时提示用法');

  // --- done / undo / rm ---
  logs.length = 0;
  await state.commands.goal.handler('done 1', ctx);
  assert(logs.some(l => l.includes('已标记完成')), 'done 标记完成');
  await state.commands.goal.handler('undo 1', ctx);
  assert(logs.some(l => l.includes('已恢复未完成')), 'undo 撤销完成');
  await state.commands.goal.handler('rm 3', ctx);
  assert(logs.some(l => l.includes('已删除')), 'rm 删除目标');
  assert(state.entries[state.entries.length - 1].data.goals.length === 2, '删除后剩 2 个目标');
  await state.commands.goal.handler('done 99', ctx);
  assert(logs.some(l => l.includes('不存在')), '不存在的编号给出错误');

  // --- 非法编号 ---
  logs.length = 0;
  await state.commands.goal.handler('done abc', ctx);
  assert(logs.some(l => l.includes('用法')), '非法编号提示用法');

  // --- 列表输出 (hasUI=true 走 ui.custom 组件) ---
  logs.length = 0;
  await state.commands.goal.handler('', ctx);
  assert(logs.some(l => l.includes('#1')) && logs.some(l => l.includes('#2')), '列表显示目标');
  assert(logs.some(l => l.includes('0/2')), '列表显示进度 0/2');
  assert(logs.some(l => l.includes('Goals')), '列表组件渲染标题');

  // --- 状态栏: done 2 后应显示 1/2 (在清空 logs 前断言) ---
  await state.commands.goal.handler('done 2', ctx);
  assert(logs.some(l => l === 'status goal: 🎯 1/2'), '状态栏显示 1/2');
  logs.length = 0;
  await state.commands.goal.handler('', ctx);
  assert(logs.some(l => l.includes('✓') && l.includes('#2')), '列表标记已完成项');
  assert(logs.some(l => l.includes('1/2')), '列表显示进度 1/2');

  // --- 无 UI 环境 (print/rpc): 列表走 console.log ---
  const logsNoUI = [];
  const ctxNoUI = makeCtx(state, logsNoUI, { hasUI: false });
  const listOut = [];
  const origLog = console.log;
  console.log = (s) => listOut.push(String(s));
  await state.commands.goal.handler('', ctxNoUI);
  console.log = origLog;
  assert(listOut.some(l => l.includes('#1') && l.includes('1/2')), '无 UI 时列表仍可输出');

  // --- 新会话恢复 (模拟 /new 后 session_start) ---
  const { pi: pi2, state: state2 } = makePi();
  factory(pi2);
  state2.entries = structuredClone(state.entries); // 携带旧会话的 goal-state 条目
  const logs2 = [];
  const ctx2 = makeCtx(state2, logs2);
  await state2.handlers.session_start({}, ctx2);
  assert(logs2.some(l => l === 'status goal: 🎯 1/2'), '恢复后状态栏正确');
  logs2.length = 0;
  await state2.commands.goal.handler('', ctx2);
  assert(logs2.some(l => l.includes('#1')), '新会话从 entries 恢复目标');
  assert(logs2.some(l => l.includes('1/2')), '恢复后进度正确 (1/2)');

  // --- before_agent_start 注入 ---
  const r1 = await state2.handlers.before_agent_start({ systemPrompt: 'BASE' }, ctx2);
  assert(typeof r1 === 'object' && r1.systemPrompt.includes('[#1]'), '未完成目标注入系统提示');
  assert(typeof r1 === 'object' && r1.systemPrompt.includes('BASE'), '注入保留原系统提示');
  // 全部完成 → 不注入
  await state2.commands.goal.handler('done 1', ctx2);
  const r2 = await state2.handlers.before_agent_start({ systemPrompt: 'BASE' }, ctx2);
  assert(r2 === undefined, '全部完成后不注入');
  // 关闭注入
  await state2.commands.goal.handler('undo 1', ctx2);
  await state2.commands.goal.handler('off', ctx2);
  const r3 = await state2.handlers.before_agent_start({ systemPrompt: 'BASE' }, ctx2);
  assert(r3 === undefined, 'off 后不注入');
  await state2.commands.goal.handler('on', ctx2);
  const r4 = await state2.handlers.before_agent_start({ systemPrompt: 'BASE' }, ctx2);
  assert(typeof r4 === 'object', 'on 后恢复注入');

  // --- clear ---
  logs.length = 0;
  await state.commands.goal.handler('done 1', ctx);
  await state.commands.goal.handler('clear', ctx);
  assert(logs.some(l => l.includes('已清空 2 个已完成目标')), 'clear 清空已完成');
  const afterClear = state.entries[state.entries.length - 1].data;
  assert(afterClear.goals.length === 0, 'clear 只删已完成');

  // --- 未知子命令 ---
  logs.length = 0;
  await state.commands.goal.handler('frobnicate', ctx);
  assert(logs.some(l => l.includes('未知子命令')), '未知子命令提示错误');

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed > 0 ? 1 : 0);
})();
