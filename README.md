# pi-goal-tool

Pi Coding Agent 的 **目标管理 + Autopilot 自动推进** 扩展（`/goal` slash command）。

在长会话、多轮 autopilot 执行中防止跑偏：把任务拆成编号目标，mission（任务要点）每轮注入上下文最前方，目标全部完成自动停止。

## 功能

- **目标管理**：添加 / 标记完成 / 撤销 / 删除 / 清空，状态随会话持久化
- **任务要点（mission）**：把原始任务浓缩成一句话的方向锚，每轮注入上下文，autopilot 每轮重申
- **Autopilot 自动推进**：目标未完成就自动发起下一轮，直到全部完成
- **上下文注入**：每轮自动把未完成目标注入上下文（可开关）
- **TUI 组件**：目标列表 UI（Esc 关闭），autopilot 运行状态可见

## 兼容性

| pi 版本 | 包名 | 支持 |
|---|---|---|
| ≥ 0.80.0 | `@earendil-works/pi-coding-agent` | ✅ |
| 0.67.0 ~ 0.73.1 | `@mariozechner/pi-coding-agent` | ✅ |

扩展通过 `@mariozechner/*`（旧包名）导入：旧版 pi 原生解析，新版 pi 的扩展加载器内置了旧包名映射，因此**一份代码全版本通用**。测试与类型检查会自动定位本机 pi 安装（支持 npm 全局、mise、volta、nvm 等常见布局，Windows / Linux / macOS）。

## 安装

### 方式一：一键脚本（推荐）

```bash
git clone https://github.com/KatouMegumi-dar/pi-goal-tool
cd pi-goal-tool
npm run setup          # 安装到全局 ~/.pi/agent/extensions/
# 或 npm run setup:local     # 安装到当前项目 ./.pi/extensions/
```

安装后**重启 pi**（或会话内执行 `/reload`）即可使用 `/goal`。

卸载：`npm run setup -- --uninstall`

### 方式二：手动复制

把 `goal.ts` 复制到 pi 的扩展目录：

- 全局：`~/.pi/agent/extensions/`（可用环境变量 `PI_CODING_AGENT_DIR` 覆盖）
- 项目级：`<项目>/.pi/extensions/`

然后重启 pi（或 `/reload`）。

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

agent 侧还注册了 `goal_add` / `goal_complete` / `goal_list` / `goal_set_mission` / `goal_auto_on` / `goal_auto_off` / `goal_undo` / `goal_rm` / `goal_clear_done` 等工具，autopilot 模式下每完成一个目标应调用 `goal_complete` 标记。

### Autopilot 规则

- 每轮 agent 结束后检查未完成目标，有则自动发起下一轮
- agent 完成目标后调用 `goal_complete` 工具标记，全部完成即停止
- 任务要点（mission）随每一轮注入上下文最前方，防止跑偏
- 安全阀：达到最大轮数 / 连续 3 轮无进展 / 模型报错或被打断 → 自动停止
- autopilot 状态不持久化，重启后默认关闭

## 开发

```bash
npm install          # 安装 typescript / jiti / typebox（仅开发用）
npm test             # 子命令 + 状态恢复 + 上下文注入 + autopilot 全量测试
npm run typecheck    # 类型检查（自动定位本机 pi 的类型声明）
```

测试无需预装任何全局依赖以外的 pi：`test/helpers.cjs` 会自动定位本机 pi 安装（`npm root -g`、mise、volta、nvm 等），并构建与 pi 扩展加载器一致的 jiti alias（新旧包名 + typebox 双名），在任何机器、任何 pi 版本上都能跑。

## License

MIT
