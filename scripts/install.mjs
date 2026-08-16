/**
 * pi-goal-tool 一键安装脚本（跨平台：Windows / Linux / macOS）
 *
 * 用法:
 *   node scripts/install.mjs            安装到全局扩展目录（~/.pi/agent/extensions/）
 *   node scripts/install.mjs --local    安装到当前项目（./.pi/extensions/）
 *   node scripts/install.mjs --path X   安装到指定目录
 *   node scripts/install.mjs --uninstall   从目标目录移除 goal.ts
 *
 * 兼容所有 pi 版本（@mariozechner/pi-coding-agent ≥0.67 与 @earendil-works/pi-coding-agent ≥0.80）。
 * 安装后重启 pi（或在 pi 内执行 /reload）即可使用 /goal。
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const SOURCE = path.join(root, "goal.ts");
const EXT_NAME = "goal.ts";

const args = process.argv.slice(2);
const uninstall = args.includes("--uninstall");
const local = args.includes("--local");
const pathFlag = args.find((a) => a.startsWith("--path="));
const explicitPath = pathFlag ? pathFlag.slice("--path=".length) : null;

// pi 扩展目录：可用 PI_CODING_AGENT_DIR 环境变量覆盖（与 pi 的 getAgentDir() 一致）
// 全局为 ~/.pi/agent/extensions/，项目级为 ./.pi/extensions/
const envAgentDir = process.env.PI_CODING_AGENT_DIR;
const agentDir =
	explicitPath ||
	(local ? path.join(process.cwd(), ".pi") : envAgentDir || path.join(os.homedir(), ".pi", "agent"));
const targetDir = path.join(agentDir, "extensions");
const target = path.join(targetDir, EXT_NAME);

function fail(msg) {
	console.error(`❌ ${msg}`);
	process.exit(1);
}

if (!fs.existsSync(SOURCE)) fail(`找不到 ${SOURCE}，请从仓库根目录运行本脚本。`);

if (uninstall) {
	if (!fs.existsSync(target)) {
		console.log(`ℹ️  未安装（${target} 不存在），无需卸载。`);
		process.exit(0);
	}
	fs.rmSync(target);
	console.log(`🗑️  已卸载 ${target}`);
	console.log("提示：重启 pi 或执行 /reload 生效。");
	process.exit(0);
}

fs.mkdirSync(targetDir, { recursive: true });
fs.copyFileSync(SOURCE, target);
console.log(`✅ 已安装 goal.ts → ${target}`);
console.log("");
console.log("  重启 pi，或在 pi 内执行 /reload 后即可使用：");
console.log("    /goal                   列出所有目标");
console.log("    /goal add <文本>        添加目标");
console.log("    /goal mission <文本>    设置任务要点");
console.log("    /goal auto on [N]       开启自动推进（autopilot）");
console.log("    /goal auto off          关闭自动推进");
console.log("");
console.log(`  卸载：node scripts/install.mjs --uninstall${local ? " --local" : ""}`);
