/**
 * 测试辅助：自动定位本机 pi 安装并构建与 pi 扩展加载器一致的 jiti alias。
 *
 * 兼容范围：
 *   - @mariozechner/pi-coding-agent 0.67.0 ~ 0.73.1（旧包名时代）
 *   - @earendil-works/pi-coding-agent 0.80.0+（新包名时代）
 *   - Windows / Linux / macOS
 *
 * 定位顺序：
 *   1. 项目本地 node_modules（若把 pi 装成了 devDependency）
 *   2. 全局 npm root（`npm root -g`）
 *   3. 常见安装位置（mise / volta / nvm / 系统目录）
 */
const { execSync } = require("node:child_process");
const { createRequire } = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PI_PACKAGE_NAMES = [
	"@earendil-works/pi-coding-agent",
	"@mariozechner/pi-coding-agent",
];

/** 收集所有候选全局 node_modules 目录 */
function candidateRoots() {
	const roots = new Set();
	// 项目本地 node_modules
	const local = path.resolve(__dirname, "..", "node_modules");
	if (fs.existsSync(local)) roots.add(local);
	// npm 全局 root
	try {
		roots.add(execSync("npm root -g", { encoding: "utf8" }).trim());
	} catch {
		/* 忽略 */
	}
	try {
		const prefix = execSync("npm config get prefix", { encoding: "utf8" }).trim();
		if (prefix) roots.add(path.join(prefix, "node_modules"));
	} catch {
		/* 忽略 */
	}
	// mise
	try {
		const mise = path.join(os.homedir(), ".local", "share", "mise", "installs");
		if (fs.existsSync(mise)) {
			for (const nodeVer of fs.readdirSync(mise)) {
				const p = path.join(mise, nodeVer, "lib", "node_modules");
				if (fs.existsSync(p)) roots.add(p);
			}
		}
	} catch {
		/* 忽略 */
	}
	// volta
	try {
		const volta = path.join(os.homedir(), ".volta", "tools", "image", "node_modules");
		if (fs.existsSync(volta)) roots.add(volta);
	} catch {
		/* 忽略 */
	}
	// nvm (linux/mac)
	try {
		const nvm = path.join(os.homedir(), ".nvm", "versions", "node");
		if (fs.existsSync(nvm)) {
			for (const nodeVer of fs.readdirSync(nvm)) {
				const p = path.join(nvm, nodeVer, "lib", "node_modules");
				if (fs.existsSync(p)) roots.add(p);
			}
		}
	} catch {
		/* 忽略 */
	}
	// /usr/local/lib/node_modules
	for (const p of ["/usr/local/lib/node_modules", "/usr/lib/node_modules"]) {
		if (fs.existsSync(p)) roots.add(p);
	}
	return [...roots];
}

/** 查找 pi 包目录，返回 { dir, index } 或 null */
function findPiPackage() {
	for (const root of candidateRoots()) {
		for (const name of PI_PACKAGE_NAMES) {
			const dir = path.join(root, name);
			const pkgJson = path.join(dir, "package.json");
			if (fs.existsSync(pkgJson)) {
				const pkg = JSON.parse(fs.readFileSync(pkgJson, "utf8"));
				const index = pkg.main ? path.join(dir, pkg.main) : path.join(dir, "index.js");
				if (fs.existsSync(index)) return { dir, index, version: pkg.version };
			}
		}
	}
	return null;
}

/** 从 pi 包上下文解析一个依赖（返回绝对路径或 null） */
function resolveFromPi(pi, specifier) {
	try {
		const req = createRequire(path.join(pi.dir, "package.json"));
		return req.resolve(specifier);
	} catch {
		return null;
	}
}

const pi = findPiPackage();
if (!pi) {
	console.error(
		"❌ 未找到 pi 安装。请先安装 pi-coding-agent（npm i -g @mariozechner/pi-coding-agent 或 @earendil-works/pi-coding-agent），" +
			"或在本项目 npm install 时将其加入 devDependencies。",
	);
	process.exit(1);
}

// 定位 jiti（0.73+ 为 jiti，0.67 为 @mariozechner/jiti）
const jitiEntry =
	resolveFromPi(pi, "jiti") ||
	resolveFromPi(pi, "@mariozechner/jiti") ||
	resolveFromPi(pi, "@earendil-works/jiti") ||
	(() => {
		try {
			return require.resolve("jiti");
		} catch {
			return null;
		}
	})();
if (!jitiEntry) {
	console.error("❌ 无法在 pi 包内定位 jiti。");
	process.exit(1);
}

// 解析 pi-tui 与 typebox（新旧包名都试）
const piTuiEntry =
	resolveFromPi(pi, "@mariozechner/pi-tui") || resolveFromPi(pi, "@earendil-works/pi-tui");
const typeboxEntry =
	resolveFromPi(pi, "@sinclair/typebox") ||
	resolveFromPi(pi, "typebox") ||
	(() => {
		try {
			return require.resolve("@sinclair/typebox");
		} catch {
			return null;
		}
	})();

if (!piTuiEntry || !typeboxEntry) {
	console.error("❌ 无法在 pi 包内解析 pi-tui / typebox。", { piTuiEntry, typeboxEntry });
	process.exit(1);
}
const piTui = {
	entry: piTuiEntry,
	dir: (() => {
		// 从入口文件向上找到包根目录（含 package.json）
		let dir = path.dirname(piTuiEntry);
		while (!fs.existsSync(path.join(dir, "package.json"))) {
			const parent = path.dirname(dir);
			if (parent === dir) return null;
			dir = parent;
		}
		return dir;
	})(),
};

/**
 * 与 pi 扩展加载器相同的 alias 映射（新旧包名 + typebox 双名）。
 * goal.ts 只用到 @mariozechner/pi-coding-agent / @mariozechner/pi-tui / @sinclair/typebox，
 * 这里把两代包名全部映射，保证任意 pi 版本下测试行为一致。
 */
const ALIASES = {
	"@earendil-works/pi-coding-agent": pi.index,
	"@mariozechner/pi-coding-agent": pi.index,
	"@earendil-works/pi-tui": piTuiEntry,
	"@mariozechner/pi-tui": piTuiEntry,
	"@earendil-works/pi-agent-core": resolveFromPi(pi, "@earendil-works/pi-agent-core"),
	"@mariozechner/pi-agent-core": resolveFromPi(pi, "@mariozechner/pi-agent-core"),
	"@earendil-works/pi-ai": resolveFromPi(pi, "@earendil-works/pi-ai"),
	"@mariozechner/pi-ai": resolveFromPi(pi, "@mariozechner/pi-ai"),
	typebox: typeboxEntry,
	"@sinclair/typebox": typeboxEntry,
};

const { createJiti } = require(jitiEntry);
const jiti = createJiti(__filename, { alias: ALIASES });

module.exports = { pi, piTui, typeboxEntry, jiti, ALIASES };
