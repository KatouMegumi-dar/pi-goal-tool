/**
 * 跨环境类型检查：自动定位本机 pi 安装，把两代包名映射到真实类型后跑 tsc。
 *
 * 用法: npm run typecheck
 * 生成的 tsconfig.typecheck.json 用后即删，不污染仓库。
 */
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

// helpers.cjs 会自动定位全局 pi（找不到会 exit 1 并给出提示）
const { pi, piTui, typeboxEntry } = require("../test/helpers.cjs");

// 类型入口（dist/index.d.ts，0.67 ~ 0.84 布局一致）
const piTypes = path.join(pi.dir, "dist", "index.d.ts");
const piTuiTypes = path.join(piTui.dir, "dist", "index.d.ts");
// typebox 1.x 声明文件为 build/index.d.mts（与入口 index.mjs 同名）
const typeboxTypes = typeboxEntry.replace(/\.mjs$/, ".d.mts").replace(/\.js$/, ".d.ts");

const tsconfig = {
	extends: "./tsconfig.json",
	compilerOptions: {
		baseUrl: ".",
		paths: {
			"@mariozechner/pi-coding-agent": [piTypes],
			"@earendil-works/pi-coding-agent": [piTypes],
			"@mariozechner/pi-tui": [piTuiTypes],
			"@earendil-works/pi-tui": [piTuiTypes],
			"@sinclair/typebox": [typeboxTypes],
			"typebox": [typeboxTypes],
		},
	},
	include: ["goal.ts"],
};

const out = path.join(root, "tsconfig.typecheck.json");
fs.writeFileSync(out, JSON.stringify(tsconfig, null, 2));
try {
	execSync(`npx tsc -p ${JSON.stringify(out)}`, { stdio: "inherit", cwd: root });
	console.log(`✅ 类型检查通过（pi ${pi.version} @ ${pi.dir}）`);
} finally {
	fs.rmSync(out, { force: true });
}
