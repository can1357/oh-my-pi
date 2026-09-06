import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { Settings } from "../../src/config/settings";
import { disposeAllVmContexts } from "../../src/eval/js/context-manager";
import { executeJs } from "../../src/eval/js/executor";
import { callSessionTool } from "../../src/eval/js/tool-bridge";
import { disposeAllKernelSessions, executePython } from "../../src/eval/py/executor";
import { disposePyToolBridge } from "../../src/eval/py/tool-bridge";
import type { ToolSession } from "../../src/tools";
import { GrepTool } from "../../src/tools/grep";
import { ReadTool } from "../../src/tools/read";
import { measure, parseOptions, type Samples } from "./sampling";
import nativePackage from "../../../natives/package.json" with { type: "json" };

type Route = "direct" | "host-bridge" | "js" | "python";
interface Workload {
	name: string;
	tool: string;
	args: Record<string, unknown>;
}
interface Row extends Samples {
	name: string;
	route: Route;
	batchSize: number;
	peakConcurrency: number;
}

const options = parseOptions(process.argv.slice(2));
const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "fixtures-"));
const settings = await Settings.init({
	inMemory: true,
	cwd: fixture,
	overrides: { "read.summarize.enabled": false, "tools.outputMaxColumns": 0 },
});
const registry = new Map<string, AgentTool>();
const session: ToolSession = {
	cwd: fixture,
	hasUI: false,
	settings,
	getSessionFile: () => null,
	getSessionSpawns: () => "*",
	getToolForEvalBridge: name => registry.get(name),
};
registry.set("read", new ReadTool(session) as unknown as AgentTool);
registry.set("grep", new GrepTool(session) as unknown as AgentTool);
let active = 0;
let peak = 0;
registry.set("latency_probe", {
	name: "latency_probe",
	label: "latency_probe",
	description: "Controlled local overlap probe",
	parameters: type({}),
	async execute() {
		active++;
		peak = Math.max(peak, active);
		try {
			await Bun.sleep(50);
			return { content: [{ type: "text", text: "probe-complete" }] };
		} finally {
			active--;
		}
	},
});

// Only the documented repeat-read notice varies across identical fixture calls.
function comparableText(text: string): string {
	return text.replace(
		/\n\n\[You have received this identical output \d+ times\. Re-reading '[^\n]*' will not change it — use a narrower selector \(path:A-B\), or proceed with the edit\.\]$/,
		"",
	);
}

function resultText(result: AgentToolResult): string {
	return result.content
		.filter(c => c.type === "text")
		.map(c => c.text)
		.join("");
}
function bridgeText(value: unknown): string {
	if (typeof value === "string") return value;
	if (
		value &&
		typeof value === "object" &&
		"text" in value &&
		typeof value.text === "string" &&
		!("hasError" in value && value.hasError)
	)
		return value.text;
	throw new Error("Tool returned an invalid or failed result");
}
async function invoke(route: Route, w: Workload, count = 1, parallel = false): Promise<string[]> {
	const args = JSON.stringify(w.args);
	if (route === "direct" || route === "host-bridge") {
		const call = async () =>
			route === "direct"
				? resultText(await registry.get(w.tool)!.execute("benchmark", w.args))
				: bridgeText(await callSessionTool(w.tool, w.args, { session }));
		if (parallel) return Promise.all(Array.from({ length: count }, call));
		const results: string[] = [];
		for (let i = 0; i < count; i++) results.push(await call());
		return results;
	}
	let output: string;
	if (route === "js") {
		const call = `tool.${w.tool}(${args})`;
		const expression = parallel
			? `await Promise.all(Array.from({length:${count}},()=>${call}))`
			: `await (async()=>{const values=[];for(let i=0;i<${count};i++)values.push(await ${call});return values;})()`;
		const result = await executeJs(`console.log(JSON.stringify(${expression}));`, {
			cwd: fixture,
			sessionId: "tool-latency-js",
			session,
			timeoutMs: 10000,
		});
		if (result.exitCode !== 0 || result.cancelled || result.truncated)
			throw new Error(`JS execution failed: ${result.output}`);
		output = result.output;
	} else {
		// JSON inside a Python string literal avoids Python/JSON boolean and null differences.
		const call = `tool.${w.tool}(**json.loads(${JSON.stringify(args)}))`;
		const expression = parallel
			? `await asyncio.gather(*[${call} for _ in range(${count})])`
			: `[await ${call} for _ in range(${count})]`;
		const result = await executePython(`print(json.dumps(${expression}))`, {
			cwd: fixture,
			sessionId: "tool-latency-python",
			toolSession: session,
			interpreter: options.python,
			timeoutMs: 10000,
		});
		if (result.exitCode !== 0 || result.cancelled || result.truncated)
			throw new Error(`Python execution failed: ${result.output}`);
		output = result.output;
	}
	const values: unknown = JSON.parse(output.trim());
	if (!Array.isArray(values) || values.length !== count) throw new Error(`Expected ${count} results`);
	return values.map(bridgeText);
}

const rows: Row[] = [];
const small = Array.from({ length: 80 }, (_, i) => `line ${i + 1}: fixture alpha\n`).join("");
const large = Array.from(
	{ length: 40000 },
	(_, i) => `line ${i + 1}: fixture ${i === 20000 ? "LATENCY_NEEDLE" : "alpha"}\n`,
).join("");
const routes: Route[] = ["direct", "host-bridge", "js", ...(options.python ? ["python" as const] : [])];

try {
	await Bun.write(path.join(fixture, "small.txt"), small);
	await Bun.write(path.join(fixture, "large.txt"), large);
	const workloads: Workload[] = [
		{ name: "small-read", tool: "read", args: { path: "small.txt" } },
		{ name: "large-range", tool: "read", args: { path: "large.txt:19990-20019" } },
		{ name: "grep", tool: "grep", args: { path: "large.txt", pattern: "LATENCY_NEEDLE" } },
	];
	async function record(route: Route, w: Workload, expected: string, count = 1, parallel = false) {
		peak = 0;
		const samples = await measure(
			async () => {
				const values = await invoke(route, w, count, parallel);
				if (values.length !== count || values.some(value => comparableText(value) !== comparableText(expected)))
					throw new Error(`Output mismatch: ${w.name}`);
			},
			options.runs,
			options.warmups,
		);
		rows.push({ name: w.name, route, batchSize: count, peakConcurrency: peak, ...samples });
		console.error(
			`${route}/${w.name}: median=${samples.medianMs?.toFixed(2) ?? "n/a"} ms, errors=${samples.errors.length}`,
		);
	}
	for (const w of workloads) {
		// One canonical untimed tool call supplies the exact formatted text contract for every route.
		const [expected] = await invoke("direct", w);
		if (!expected.includes(w.name === "small-read" ? "80: fixture alpha" : "LATENCY_NEEDLE"))
			throw new Error(`Fixture validation failed: ${w.name}`);
		for (const route of routes) await record(route, w, expected);
	}
	const read = workloads[0];
	const [expected] = await invoke("direct", read);
	for (const route of routes) {
		await record(route, { ...read, name: "four-reads-sequential" }, expected, 4);
		await record(route, { ...read, name: "four-reads-parallel" }, expected, 4, true);
		await record(route, { name: "four-delays-sequential", tool: "latency_probe", args: {} }, "probe-complete", 4);
		await record(route, { name: "four-delays-parallel", tool: "latency_probe", args: {} }, "probe-complete", 4, true);
	}
	const repo = vcs.git(path.resolve(import.meta.dir, "../../../.."));
	const pythonInfo = options.python
		? await executePython("import sys; print(sys.version)", {
				cwd: fixture,
				sessionId: "tool-latency-python",
				toolSession: session,
				interpreter: options.python,
				timeoutMs: 10000,
			})
		: null;
	console.log(
		JSON.stringify(
			{
				schemaVersion: 1,
				revision: (await repo?.headSha()) ?? null,
				dirty: repo ? await repo.isDirty() : null,
				environment: {
					platform: process.platform,
					arch: process.arch,
					release: os.release(),
					cpu: os.cpus()[0]?.model,
					bun: Bun.version,
					python: options.python ?? null,
					nativeVersion: nativePackage.version,
					pythonVersion: pythonInfo?.exitCode === 0 ? pythonInfo.output.trim() : null,
				},
				options,
				fixtures: { smallBytes: Buffer.byteLength(small), largeBytes: Buffer.byteLength(large), largeLines: 40000 },
				scope: "Real read/grep tools and eval kernels with an isolated ToolSession. Excludes model, outer agent loop, approvals, hooks, shell, direnv and UI rendering. JS/Python include JSON serialization and kernel output. First-call samples exclude module startup and canonical fixture validation; only the first cell per language includes kernel startup.",
				rows,
			},
			null,
			2,
		),
	);
	if (rows.some(row => row.errors.length > 0)) process.exitCode = 1;
} finally {
	try {
		await disposeAllVmContexts();
	} finally {
		try {
			await disposeAllKernelSessions();
		} finally {
			try {
				await disposePyToolBridge();
			} finally {
				await fs.rm(fixture, { recursive: true, force: true });
			}
		}
	}
}
