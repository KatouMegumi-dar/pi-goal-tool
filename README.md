# pi-goal-tool

Pi Coding Agent 的 **目标管理 + Autopilot 自动推进** 扩展（`/goal` slash command）。

在长会话、多轮 autopilot 执行中防止跑偏：把任务拆成编号目标，mission（任务要点）每轮注入上下文最前方，目标全部完成自动停止。

## 功能

- **目标管理**：添加 / 标记完成 / 撤销 / 删除 / 清空，状态随会话持久化
- **任务要点（mission）**：把原始任务浓缩成一句话的方向锚，每轮注入上下文，autopilot 每轮重申
- **Autopilot 自动推进**：目标未完成就自动发起下一轮，直到全部完成
- **上下文注入**：每轮自动把未完成目标注入上下文（可开关）
- **TUI 组件**：目标列表 UI（Esc 关闭），autopilot 运行状态可见

## 安装

1. 把 `goal.ts` 复制到 pi 的扩展目录（如 `~/.pi/agent/extensions/`）
2. 确认安装了 pi 依赖（`@mariozechner/pi-coding-agent`、`@mariozechner/pi-tui`、`typebox`）
3. 重启 pi，`/goal` 即可用

## 用法

```
/goal                   列出所有目标（含任务要点）
/goal add <文本>        添加目标
/goal mission <文本>    设置任务要点（总纲）
/goal mission clear     清除任务要点
/goal done <n>          手动标记完成
/goal undo <n>          撤销完成
/goal rm <n>            删除目标
/goal clear             清空所有已完成目标
/goal on|off            开/关「每轮注入未完成目标到上下文」(默认开)
/goal auto              查看 autopilot 状态
/goal auto on [N]       开启自动推进: 最多 N 轮（默认 0 = 无限，连续 3 轮无进展自动停）
/goal auto off          关闭自动推进
```

### Autopilot 规则

- 每轮 agent 结束后检查未完成目标，有则自动发起下一轮
- agent 完成目标后调用 `goal_complete` 工具标记，全部完成即停止
- 任务要点（mission）随每一轮注入上下文最前方，防止跑偏
- 安全阀：达到最大轮数 / 连续 3 轮无进展 / 模型报错或被打断 → 自动停止
- autopilot 状态不持久化，重启后默认关闭

## 开发

```bash
npm install          # 安装依赖（用于类型检查/测试）
npx tsc --noEmit     # 类型检查
node test/goal.test.cjs          # 子命令 + 状态恢复 + 上下文注入测试
node test/autopilot.test.cjs     # autopilot 专项测试
```

## License

MIT
