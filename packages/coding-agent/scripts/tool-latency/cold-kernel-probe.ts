/** One fresh host process: report a cold cell and a second cell in the same kernel. */
import { Settings } from "../../src/config/settings";
import { disposeAllVmContexts } from "../../src/eval/js/context-manager";
import { executeJs } from "../../src/eval/js/executor";
import { disposeAllKernelSessions, executePython } from "../../src/eval/py/executor";
import { disposePyToolBridge } from "../../src/eval/py/tool-bridge";
import type { ToolSession } from "../../src/tools";

const [route, interpreter] = process.argv.slice(2);
if (route !== "js" && route !== "python") throw new Error("Expected js or python route");
const settings = await Settings.init({ inMemory: true, cwd: process.cwd() });
const session: ToolSession = {
	cwd: process.cwd(),
	hasUI: false,
	settings,
	getSessionFile: () => null,
	getSessionSpawns: () => null,
};
async function cell(): Promise<number> {
	const started = performance.now();
	const result =
		route === "js"
			? await executeJs('console.log("kernel-ready")', { sessionId: "cold-benchmark", session, timeoutMs: 30_000 })
			: await executePython('print("kernel-ready")', {
					sessionId: "cold-benchmark",
					toolSession: session,
					interpreter,
					timeoutMs: 30_000,
				});
	if (result.exitCode !== 0 || result.cancelled || result.truncated || result.output.trim() !== "kernel-ready") {
		throw new Error(`${route} cell failed: ${result.output}`);
	}
	return performance.now() - started;
}
try {
	const firstCellMs = await cell();
	const secondCellMs = await cell();
	console.log(JSON.stringify({ firstCellMs, secondCellMs }));
} finally {
	await disposeAllVmContexts();
	await disposeAllKernelSessions();
	await disposePyToolBridge();
}
