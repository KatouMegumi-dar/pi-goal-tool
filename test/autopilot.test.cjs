// autopilot 模式专项测试：自动续跑 / 停止条件 / goal_complete 工具
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
  const state = { entries: [], handlers: {}, commands: {}, tools: {}, sent: [] };
  const pi = {
    on: (ev, fn) => { state.handlers[ev] = fn; },
    registerCommand: (name, opts) => { state.commands[name] = opts; },
    registerTool: (def) => { state.tools[def.name] = def; },
    appendEntry: (type, data) => { state.entries.push({ type: 'custom', customType: type, data: structuredClone(data) }); },
    sendUserMessage: async (msg, opts) => { state.sent.push({ msg, opts }); },
  };
  return { pi, state };
}

function makeCtx(state, logs) {
  return {
    hasUI: false,
    ui: {
      notify: (msg, t) => logs.push(`notify(${t}): ${msg}`),
      setStatus: () => {},
      custom: async () => { throw new Error('no ui'); },
    },
    sessionManager: { getEntries: () => state.entries, getBranch: () => state.entries },
  };
}

// 构造 agent_end 的 messages: 模拟一轮含工具调用/纯文本的 assistant 消息
function fakeMessages(toolCalls = 0, stopReason = "stop") {
  const content = [];
  for (let i = 0; i < toolCalls; i++) content.push({ type: "toolCall", name: "bash", arguments: { command: "echo" } });
  content.push({ type: "text", text: "done" });
  return [{ role: "user", content: [{ type: "text", text: "x" }] }, { role: "assistant", content, stopReason }];
}

const noProgMsg = (n) => `⏹️ 连续 ${n} 轮无进展`;

(async () => {
  const { pi, state } = makePi();
  factory(pi);
  const logs = [];
  const ctx = makeCtx(state, logs);
  await state.handlers.session_start({}, ctx);

  // --- 工具注册 ---
  assert(typeof state.tools.goal_complete === 'object', '注册了 goal_complete 工具');
  assert(typeof state.tools.goal_complete.execute === 'function', 'goal_complete 有 execute');

  // --- goal_complete 工具行为 ---
  await state.commands.goal.handler('add 目标一', ctx);
  await state.commands.goal.handler('add 目标二', ctx);
  const r1 = await state.tools.goal_complete.execute('id1', { goalId: 1 }, undefined, undefined, ctx);
  assert(r1.content[0].text.includes('已标记完成') && r1.content[0].text.includes('剩余 1'), 'goal_complete 标记完成并报告剩余数');
  assert(state.entries[state.entries.length - 1].data.goals[0].done === true, 'goal_complete 后状态已持久化');
  const r2 = await state.tools.goal_complete.execute('id2', { goalId: 99 }, undefined, undefined, ctx);
  assert(r2.content[0].text.includes('不存在'), 'goal_complete 对不存在编号报错');
  const r3 = await state.tools.goal_complete.execute('id3', { goalId: 1 }, undefined, undefined, ctx);
  assert(r3.content[0].text.includes('已经是完成状态'), 'goal_complete 幂等');
  // 恢复: 目标一 done, 目标二未完成
  await state.commands.goal.handler('undo 1', ctx);

  // --- auto on: 无目标时不开启 ---
  const state2 = { ...state, entries: [], sent: [], commands: state.commands, handlers: state.handlers, tools: state.tools };
  // 独立实例测无目标场景
  const { pi: pi3, state: st3 } = makePi();
  factory(pi3);
  const logs3 = [];
  const ctx3 = makeCtx(st3, logs3);
  await st3.handlers.session_start({}, ctx3);
  await st3.commands.goal.handler('auto on', ctx3);
  assert(logs3.some(l => l.includes('没有未完成目标')), '无目标时 auto on 被拒绝');
  assert(st3.sent.length === 0, '无目标时不触发自动回合');

  // --- auto on: 正常开启并触发第一轮 ---
  const { pi: pi4, state: st4 } = makePi();
  factory(pi4);
  const logs4 = [];
  const ctx4 = makeCtx(st4, logs4);
  await st4.handlers.session_start({}, ctx4);
  await st4.commands.goal.handler('add 修复 bug A', ctx4);
  await st4.commands.goal.handler('auto on', ctx4);
  assert(logs4.some(l => l.includes('autopilot 开启')), 'auto on 给出开启反馈');
  assert(st4.sent.length === 1, 'auto on 立即触发第一轮');
  assert(st4.sent[0].msg.includes('[自动推进模式]') && st4.sent[0].msg.includes('#1'), '自动消息包含目标与指令');
  assert(st4.sent[0].opts.deliverAs === 'followUp', '自动消息以 followUp 投递');

  // --- agent_end: 有工具调用 → 继续续跑 ---
  await st4.handlers.agent_end({ messages: fakeMessages(2) }, ctx4);
  assert(st4.sent.length === 2, '有工具调用时自动发起下一轮');
  assert(logs4.some(l => l.includes('剩余')), '续跑通知');
  // 此时 rounds=1

  // --- agent_end: 全部完成 → 停止 ---
  await st4.handlers.agent_end({ messages: fakeMessages(1) }, ctx4);
  const before = st4.sent.length;
  await st4.tools.goal_complete.execute('id', { goalId: 1 }, undefined, undefined, ctx4); // 完成唯一目标
  await st4.handlers.agent_end({ messages: fakeMessages(1) }, ctx4);
  assert(st4.sent.length === before, '全部完成后不再触发新轮');
  assert(logs4.some(l => l.includes('所有目标已完成')), '全部完成给出结束通知');

  // --- 轮数上限 ---
  const { pi: pi5, state: st5 } = makePi();
  factory(pi5);
  const logs5 = [];
  const ctx5 = makeCtx(st5, logs5);
  await st5.handlers.session_start({}, ctx5);
  await st5.commands.goal.handler('add 目标X', ctx5);
  await st5.commands.goal.handler('auto on 2', ctx5); // 上限 2 轮
  st5.sent.length = 0;
  await st5.handlers.agent_end({ messages: fakeMessages(1) }, ctx5); // rounds=1 → 继续
  assert(st5.sent.length === 1, '未达上限继续');
  await st5.handlers.agent_end({ messages: fakeMessages(1) }, ctx5); // rounds=2 → 停止
  assert(st5.sent.length === 1, '达到上限后停止续跑');
  assert(logs5.some(l => l.includes('达到最大轮数 2')), '给出达上限通知');
  // 再触发 agent_end 也不跑
  await st5.handlers.agent_end({ messages: fakeMessages(1) }, ctx5);
  assert(st5.sent.length === 1, '停止后不再续跑');

  // --- 无限轮次: 有进展时持续续跑 (不指定轮数) ---
  const { pi: piI, state: stI } = makePi();
  factory(piI);
  const logsI = [];
  const ctxI = makeCtx(stI, logsI);
  await stI.handlers.session_start({}, ctxI);
  await stI.commands.goal.handler('add 无限目标', ctxI);
  await stI.commands.goal.handler('auto on', ctxI);
  assert(logsI.some(l => l.includes('不限轮数')), '未指定轮数时提示不限轮数');
  stI.sent.length = 0;
  for (let i = 0; i < 6; i++) {
    await stI.handlers.agent_end({ messages: fakeMessages(1) }, ctxI); // 每轮都有工具调用
  }
  assert(stI.sent.length === 6, '无限模式: 6 轮有进展后仍持续续跑');
  assert(!logsI.some(l => l.includes('达到最大轮数')), '无限模式不触发轮数上限');

  // 无限模式 + 全部完成 → 停止
  const beforeI = stI.sent.length;
  await stI.tools.goal_complete.execute('id', { goalId: 1 }, undefined, undefined, ctxI);
  await stI.handlers.agent_end({ messages: fakeMessages(1) }, ctxI);
  assert(stI.sent.length === beforeI, '无限模式: 全部完成后停止');

  // --- 无进展检测 ---
  const { pi: pi6, state: st6 } = makePi();
  factory(pi6);
  const logs6 = [];
  const ctx6 = makeCtx(st6, logs6);
  await st6.handlers.session_start({}, ctx6);
  await st6.commands.goal.handler('add 目标Y', ctx6);
  await st6.commands.goal.handler('auto on', ctx6); // 无限轮次
  st6.sent.length = 0;
  // 3 轮纯文本（无工具调用、无完成）
  await st6.handlers.agent_end({ messages: fakeMessages(0) }, ctx6);
  await st6.handlers.agent_end({ messages: fakeMessages(0) }, ctx6);
  assert(st6.sent.length === 2, '前两轮无进展仍继续');
  await st6.handlers.agent_end({ messages: fakeMessages(0) }, ctx6);
  assert(st6.sent.length === 2, '连续 3 轮无进展停止');
  assert(logs6.some(l => l.includes(noProgMsg(3))), '给出无进展停止通知');

  // --- 模型报错/中断 ---
  const { pi: pi7, state: st7 } = makePi();
  factory(pi7);
  const logs7 = [];
  const ctx7 = makeCtx(st7, logs7);
  await st7.handlers.session_start({}, ctx7);
  await st7.commands.goal.handler('add 目标Z', ctx7);
  await st7.commands.goal.handler('auto on', ctx7);
  st7.sent.length = 0;
  await st7.handlers.agent_end({ messages: fakeMessages(1, "error") }, ctx7);
  assert(st7.sent.length === 0, '模型报错时停止');
  assert(logs7.some(l => l.includes('模型异常')), '给出报错停止通知');
  const { pi: pi8, state: st8 } = makePi();
  factory(pi8);
  const logs8 = [];
  const ctx8 = makeCtx(st8, logs8);
  await st8.handlers.session_start({}, ctx8);
  await st8.commands.goal.handler('add 目标W', ctx8);
  await st8.commands.goal.handler('auto on', ctx8);
  st8.sent.length = 0;
  await st8.handlers.agent_end({ messages: fakeMessages(1, "abort") }, ctx8);
  assert(st8.sent.length === 0, '用户中断(abort)时停止');

  // --- auto off ---
  const { pi: pi9, state: st9 } = makePi();
  factory(pi9);
  const logs9 = [];
  const ctx9 = makeCtx(st9, logs9);
  await st9.handlers.session_start({}, ctx9);
  await st9.commands.goal.handler('add 目标V', ctx9);
  await st9.commands.goal.handler('auto on', ctx9);
  await st9.commands.goal.handler('auto off', ctx9);
  const before2 = st9.sent.length;
  await st9.handlers.agent_end({ messages: fakeMessages(1) }, ctx9);
  assert(st9.sent.length === before2, 'auto off 后 agent_end 不续跑');

  // --- auto 状态查询 ---
  const { pi: piA, state: stA } = makePi();
  factory(piA);
  const logsA = [];
  const ctxA = makeCtx(stA, logsA);
  await stA.handlers.session_start({}, ctxA);
  await stA.commands.goal.handler('add 目标U', ctxA);
  await stA.commands.goal.handler('auto', ctxA);
  assert(logsA.some(l => l.includes('autopilot 关闭')), 'auto 查询显示关闭状态');
  await stA.commands.goal.handler('auto on', ctxA);
  logsA.length = 0;
  await stA.commands.goal.handler('auto', ctxA);
  assert(logsA.some(l => l.includes('autopilot 运行中')), 'auto 查询显示运行状态与轮数');

  // --- 重启不保留 autopilot ---
  const { pi: piB, state: stB } = makePi();
  factory(piB);
  stB.entries = structuredClone(stA.entries); // 携带 autopilot 开启时的会话条目
  const logsB = [];
  const ctxB = makeCtx(stB, logsB);
  await stB.handlers.session_start({}, ctxB);
  await stB.commands.goal.handler('auto', ctxB);
  assert(logsB.some(l => l.includes('autopilot 关闭')), '新会话后 autopilot 不恢复（必须手动开启）');
  // 但目标本身恢复了
  await stB.commands.goal.handler('done 1', ctxB);
  assert(stB.entries[stB.entries.length - 1].data.goals[0].done === true, '目标状态仍可恢复操作');

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed > 0 ? 1 : 0);
})();
