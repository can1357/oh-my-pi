import * as fs from "node:fs";
import type { DaemonRpcResult } from "../../src/launch/protocol";
import { renderLaunchLogTerminalRows } from "../../src/tools/hub/launch";

const result: Extract<DaemonRpcResult, { op: "logs" }> = {
	op: "logs",
	name: "web",
	text: "ready",
	terminalText: "old\r\x1b[2K\x1b[1;32mready\x1b[0m",
	cursor: 42,
	timedOut: false,
	state: "running",
};
const terminalRows = await renderLaunchLogTerminalRows(result, { head: false, lines: 10 });
const paths = Object.keys(require.cache)
	.filter(modulePath => modulePath.replaceAll("\\", "/").includes("/packages/utils/src/vterm"))
	.sort();
const bytes = paths.reduce((total, modulePath) => total + fs.statSync(modulePath).size, 0);
const memory = process.memoryUsage();
await Bun.write(
	Bun.stdout,
	JSON.stringify({ modules: paths.length, bytes, rss: memory.rss, heapUsed: memory.heapUsed, paths, terminalRows }),
);
