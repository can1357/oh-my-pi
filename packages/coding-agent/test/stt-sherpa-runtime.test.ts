import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadSourceSherpaRuntime } from "@oh-my-pi/pi-coding-agent/stt/sherpa-runtime";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const PLATFORM_PACKAGE = `sherpa-onnx-${os.platform() === "win32" ? "win" : os.platform()}-${os.arch()}`;

async function writePackage(nodeModules: string, name: string, source: string): Promise<void> {
	const dir = path.join(nodeModules, name);
	await Bun.write(path.join(dir, "package.json"), JSON.stringify({ name, main: "index.js" }));
	await Bun.write(path.join(dir, "index.js"), source);
}

describe("sherpa source runtime resolution", () => {
	let tmp = "";

	afterEach(async () => {
		await removeWithRetries(tmp);
	});

	it("loads the wrapper colocated with a workspace-hoisted platform addon", async () => {
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-sherpa-source-"));
		const rootNodeModules = path.join(tmp, "node_modules");
		const packageNodeModules = path.join(tmp, "packages", "coding-agent", "node_modules");
		await writePackage(
			rootNodeModules,
			"sherpa-onnx-node",
			"module.exports = { OfflineRecognizer: { createAsync() {} } };\n",
		);
		await writePackage(rootNodeModules, PLATFORM_PACKAGE, "module.exports = {};\n");
		await writePackage(
			packageNodeModules,
			"sherpa-onnx-node",
			"throw new Error('Could not find sherpa-onnx-node. Tried');\n",
		);

		const sourceUrl = path.join(tmp, "packages", "coding-agent", "src", "stt", "asr-worker.ts");
		const runtime = loadSourceSherpaRuntime(sourceUrl);

		expect(runtime.OfflineRecognizer.createAsync).toBeTypeOf("function");
	});

	it("prefers the nearest wrapper when its nested platform addon is loadable", async () => {
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-sherpa-source-"));
		const rootNodeModules = path.join(tmp, "node_modules");
		const packageNodeModules = path.join(tmp, "packages", "coding-agent", "node_modules");
		await writePackage(
			rootNodeModules,
			"sherpa-onnx-node",
			"module.exports = { OfflineRecognizer: { createAsync: function rootRuntime() {} } };\n",
		);
		await writePackage(rootNodeModules, PLATFORM_PACKAGE, "module.exports = {};\n");
		await writePackage(
			packageNodeModules,
			"sherpa-onnx-node",
			`require("./node_modules/${PLATFORM_PACKAGE}"); module.exports = { OfflineRecognizer: { createAsync: function nestedRuntime() {} } };\n`,
		);
		await writePackage(
			path.join(packageNodeModules, "sherpa-onnx-node", "node_modules"),
			PLATFORM_PACKAGE,
			"module.exports = {};\n",
		);

		const sourceUrl = path.join(tmp, "packages", "coding-agent", "src", "stt", "asr-worker.ts");
		const runtime = loadSourceSherpaRuntime(sourceUrl);

		expect(runtime.OfflineRecognizer.createAsync.name).toBe("nestedRuntime");
	});
});
