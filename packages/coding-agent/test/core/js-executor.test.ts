import { afterAll, afterEach, beforeAll, describe, expect, it, setDefaultTimeout, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { executeJs, type JsResult } from "@oh-my-pi/pi-coding-agent/eval/js/executor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";

// JS eval cold-starts a Bun worker; under --isolate + high CI concurrency that startup
// can exceed Bun's 5s default per-test timeout, flaking the suite. Give the worker-backed
// tests headroom above the worker-init floor (context-manager WORKER_INIT_TIMEOUT_MS).
setDefaultTimeout(20_000);

function createTool(
	name: string,
	execute: (toolCallId: string, args: unknown, signal?: AbortSignal) => Promise<AgentToolResult>,
): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: type({}),
		concurrency: "parallel",
		execute,
	} as unknown as AgentTool;
}

function getJsonData(result: JsResult): unknown {
	const jsonOutputs = result.displayOutputs.filter(
		(output): output is Extract<JsResult["displayOutputs"][number], { type: "json" }> => output.type === "json",
	);
	expect(jsonOutputs).toHaveLength(1);
	return jsonOutputs[0].data;
}

function getStatusEvents(result: JsResult) {
	return result.displayOutputs.filter(
		(output): output is Extract<JsResult["displayOutputs"][number], { type: "status" }> => output.type === "status",
	);
}

describe("executeJs", () => {
	let tempDir: TempDir;
	let session: ToolSession;
	let sessionFile: string;
	let sessionId: string;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@js-executor-");
		sessionFile = path.join(tempDir.path(), "session.jsonl");
		sessionId = `session:${sessionFile}:cwd:${tempDir.path()}`;
		session = {
			cwd: tempDir.path(),
			hasUI: false,
			getSessionFile: () => sessionFile,
			getSessionSpawns: () => null,
			settings: Settings.isolated(),
		};

		await Bun.write(
			path.join(tempDir.path(), "config.json"),
			JSON.stringify({ name: "demo", enabled: true }, null, 2),
		);
		await Bun.write(path.join(tempDir.path(), "config.yaml"), "name: demo\nenabled: true\n");
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		await disposeAllVmContexts();
		tempDir.removeSync();
	});

	it("persists bindings across calls and reset clears them", async () => {
		await executeJs("const answer = 2;", { sessionId, session, sessionFile });

		const persisted = await executeJs("return answer + 2;", { sessionId, session, sessionFile });
		expect(persisted.exitCode).toBe(0);
		expect(persisted.output.trim()).toBe("4");

		const resetResult = await executeJs("return typeof answer;", {
			sessionId,
			session,
			sessionFile,
			reset: true,
		});
		expect(resetResult.exitCode).toBe(0);
		expect(resetResult.output.trim()).toBe("undefined");
	});

	it("parallel() barriers until every thunk settles and throws the lowest-index error", async () => {
		const result = await executeJs(
			[
				"const settled = [];",
				"try {",
				"	await parallel([",
				"		async () => { await new Promise(r => setTimeout(r, 30)); settled.push('slow'); },",
				"		async () => { settled.push('bad1'); throw new Error('bad1'); },",
				"		async () => { settled.push('bad2'); throw new Error('bad2'); },",
				"	]);",
				"	return 'no-throw';",
				"} catch (err) {",
				"	return JSON.stringify([err.message, settled.sort()]);",
				"}",
			].join("\n"),
			{ sessionId, session, sessionFile },
		);
		expect(result.exitCode).toBe(0);
		// Every thunk ran to completion (the slow one was not orphaned by the
		// early rejections), and the lowest-index error propagated.
		expect(JSON.parse(result.output.trim())).toEqual(["bad1", ["bad1", "bad2", "slow"]]);
	});

	it("persists bindings from cells that contain nested returns", async () => {
		const first = await executeJs(
			[
				"const nestedReturnCarry = { value: 11 };",
				"const readCarry = () => {",
				"  return nestedReturnCarry.value;",
				"};",
				"readCarry();",
			].join("\n"),
			{ sessionId, session, sessionFile },
		);
		expect(first.exitCode).toBe(0);
		expect(first.output.trim()).toBe("11");

		const persisted = await executeJs("return nestedReturnCarry.value + 1;", { sessionId, session, sessionFile });
		expect(persisted.exitCode).toBe(0);
		expect(persisted.output.trim()).toBe("12");
	});

	it("persists bindings from cells that need the async wrapper", async () => {
		const awaited = await executeJs(
			"const { value: awaitedCarry } = await Promise.resolve({ value: 6 }); awaitedCarry;",
			{
				sessionId,
				session,
				sessionFile,
			},
		);
		expect(awaited.exitCode).toBe(0);
		expect(awaited.output.trim()).toBe("6");

		const returned = await executeJs("const returnedCarry = 7; return returnedCarry;", {
			sessionId,
			session,
			sessionFile,
		});
		expect(returned.exitCode).toBe(0);
		expect(returned.output.trim()).toBe("7");

		const persisted = await executeJs("return awaitedCarry * returnedCarry;", { sessionId, session, sessionFile });
		expect(persisted.exitCode).toBe(0);
		expect(persisted.output.trim()).toBe("42");
	});

	it("persists bindings when auto-displaying the final expression", async () => {
		const first = await executeJs("const inspected = 40; inspected + 2;", { sessionId, session, sessionFile });
		expect(first.exitCode).toBe(0);
		expect(first.output.trim()).toBe("42");

		const persisted = await executeJs("return inspected + 1;", { sessionId, session, sessionFile });
		expect(persisted.exitCode).toBe(0);
		expect(persisted.output.trim()).toBe("41");
	});

	it("does not expose the final expression marker as a global property", async () => {
		const result = await executeJs("const localOnly = 7; localOnly;", { sessionId, session, sessionFile });
		expect(result.exitCode).toBe(0);
		expect(result.output.trim()).toBe("7");

		const marker = await executeJs("return Object.hasOwn(globalThis, '__omp_final_expr__');", {
			sessionId,
			session,
			sessionFile,
		});
		expect(marker.exitCode).toBe(0);
		expect(marker.output.trim()).toBe("false");

		const persisted = await executeJs("return localOnly;", { sessionId, session, sessionFile });
		expect(persisted.exitCode).toBe(0);
		expect(persisted.output.trim()).toBe("7");
	});

	it("ignores user-assigned final expression markers without a rewritten final expression", async () => {
		const result = await executeJs("globalThis.__omp_final_expr__ = 'manual'; return 'actual';", {
			sessionId,
			session,
			sessionFile,
		});

		expect(result.exitCode).toBe(0);
		expect(result.output.trim()).toBe("actual");
	});

	it("captures promise-valued final expression before promise callbacks can mutate the marker", async () => {
		const result = await executeJs(
			"const pending = Promise.resolve(1).then(value => { globalThis.__omp_final_expr__ = 999; return value; }); pending;",
			{ sessionId, session, sessionFile },
		);

		expect(result.exitCode).toBe(0);
		expect(result.output.trim()).toBe("1");
	});

	it("awaits rewritten thenable final expressions once", async () => {
		const result = await executeJs(
			[
				"globalThis.thenCalls = 0;",
				"const thenable = {",
				"  then(resolve) {",
				"    globalThis.thenCalls++;",
				"    resolve('done');",
				"  },",
				"};",
				"thenable;",
			].join("\n"),
			{ sessionId, session, sessionFile },
		);
		expect(result.exitCode).toBe(0);
		expect(result.output.trim()).toBe("done");

		const calls = await executeJs("return globalThis.thenCalls;", { sessionId, session, sessionFile });
		expect(calls.exitCode).toBe(0);
		expect(calls.output.trim()).toBe("1");
	});

	it("does not auto-display side-effect import rewrites", async () => {
		const result = await executeJs('import "node:path";', { sessionId, session, sessionFile });

		expect(result.exitCode).toBe(0);
		expect(result.output.trim()).toBe("");
		expect(result.displayOutputs).toEqual([]);
	});

	it("exposes the worker's real process object", async () => {
		const result = await executeJs(
			[
				"return {",
				"  version: process.version,",
				"  versionsNode: typeof process.versions.node,",
				"  platform: process.platform,",
				"  arch: process.arch,",
				"  hasEnv: 'env' in process,",
				"  hasExit: 'exit' in process,",
				"};",
			].join("\n"),
			{ sessionId, session, sessionFile },
		);

		expect(result.exitCode).toBe(0);
		expect(getJsonData(result)).toEqual({
			version: process.version,
			versionsNode: "string",
			platform: process.platform,
			arch: process.arch,
			hasEnv: true,
			hasExit: true,
		});
	});

	it("exposes common web globals and the raw Node fs module", async () => {
		const result = await executeJs(
			[
				"const uuid = crypto.randomUUID();",
				"const digest = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode('ok'));",
				"const base = __omp_session__.cwd;",
				"fs.mkdirSync(base + '/nested', { recursive: true });",
				"fs.writeFileSync(base + '/nested/value.txt', 'hello');",
				"await fs.promises.copyFile(base + '/nested/value.txt', base + '/nested/copy.txt');",
				"const text = fs.readFileSync(base + '/nested/copy.txt', 'utf8');",
				"const bytes = await fs.promises.readFile(base + '/nested/copy.txt');",
				"const stat = fs.statSync(base + '/nested/copy.txt');",
				"const entries = fs.readdirSync(base + '/nested');",
				"const start = performance.now();",
				"return {",
				"  uuid: typeof uuid,",
				"  digestBytes: digest.byteLength,",
				"  text,",
				"  byteLength: bytes.byteLength,",
				"  isFile: stat.isFile(),",
				"  entries: entries.sort(),",
				"  hasConstants: typeof fs.constants.R_OK,",
				"  buffer: Buffer.from('ok').toString('hex'),",
				"  performance: typeof start,",
				"};",
			].join("\n"),
			{ sessionId, session, sessionFile },
		);

		expect(result.exitCode).toBe(0);
		expect(getJsonData(result)).toEqual({
			uuid: "string",
			digestBytes: 32,
			text: "hello",
			byteLength: 5,
			isFile: true,
			entries: ["copy.txt", "value.txt"],
			hasConstants: "number",
			buffer: "6f6b",
			performance: "number",
		});
	});

	it("reads files as text and supports offset/limit slicing", async () => {
		const result = await executeJs(
			[
				"const full = await read('config.json');",
				"const objectSliced = await read('config.json', { offset: 2, limit: 1 });",
				"const positionalSliced = await read('config.json', 3, 1);",
				"const nullOffsetLimit = await read('config.json', null, 2);",
				"const undefinedOffsetLimit = await read('config.json', undefined, 1);",
				"return { isString: typeof full === 'string', full, objectSliced, positionalSliced, nullOffsetLimit, undefinedOffsetLimit };",
			].join("\n"),
			{
				sessionId,
				session,
				sessionFile,
			},
		);

		expect(result.exitCode).toBe(0);
		expect(getStatusEvents(result)).toHaveLength(5);
		expect(getJsonData(result)).toEqual({
			isString: true,
			full: '{\n  "name": "demo",\n  "enabled": true\n}',
			objectSliced: '  "name": "demo",',
			positionalSliced: '  "enabled": true',
			nullOffsetLimit: '{\n  "name": "demo",',
			undefinedOffsetLimit: "{",
		});
	});

	it("delegates URI reads through the read tool with positional slicing", async () => {
		const execute = vi.fn(async (_toolCallId: string, args: unknown): Promise<AgentToolResult> => {
			const record = args as { path: string };
			return { content: [{ type: "text", text: record.path.endsWith(":1-1400") ? "wide" : "limited" }] };
		});
		const toolSession: ToolSession = {
			...session,
			getToolByName: name => (name === "read" ? createTool("read", execute) : undefined),
		};

		const result = await executeJs(
			[
				"const wide = await read('artifact://15:raw', 1, 1400);",
				"const limited = await read('artifact://15:raw', null, 2);",
				"return { wide, limited };",
			].join("\n"),
			{
				sessionId,
				session: toolSession,
				sessionFile,
			},
		);

		expect(result.exitCode).toBe(0);
		expect(getStatusEvents(result)).toHaveLength(2);
		expect(getJsonData(result)).toEqual({ wide: "wide", limited: "limited" });
		expect(execute).toHaveBeenNthCalledWith(
			1,
			expect.stringMatching(/^js-read-/),
			{ path: "artifact://15:raw:1-1400", [INTENT_FIELD]: "js prelude" },
			expect.any(AbortSignal),
			undefined,
			undefined,
		);
		expect(execute).toHaveBeenNthCalledWith(
			2,
			expect.stringMatching(/^js-read-/),
			{ path: "artifact://15:raw:1-2", [INTENT_FIELD]: "js prelude" },
			expect.any(AbortSignal),
			undefined,
			undefined,
		);
	});

	it("rejects directory reads from native read()", async () => {
		const directoryResult = await executeJs("await read('.');", {
			sessionId,
			session,
			sessionFile,
		});
		expect(directoryResult.exitCode).toBe(1);
		expect(directoryResult.output).toContain("Directory paths are not supported");
	});

	it("routes output() through tool.read and keeps tool.* results normalized", async () => {
		const execute = vi.fn(async (_toolCallId: string, args: unknown): Promise<AgentToolResult> => {
			const record = args as { path: string };
			if (record.path.startsWith("agent://")) {
				return { content: [{ type: "text", text: "from-agent" }] };
			}
			return {
				content: [{ type: "text", text: "annotated" }],
				details: { path: record.path, kind: "tool-result" },
			};
		});
		const toolSession: ToolSession = {
			...session,
			getToolByName: name => (name === "read" ? createTool("read", execute) : undefined),
		};

		const result = await executeJs(
			"return { toolResult: await tool.read({ path: 'package.json' }), agentOutput: await output('agent-42') };",
			{
				sessionId,
				session: toolSession,
				sessionFile,
			},
		);

		expect(result.exitCode).toBe(0);
		expect(getStatusEvents(result)).toHaveLength(2);
		expect(getJsonData(result)).toEqual({
			toolResult: {
				text: "annotated",
				details: { path: "package.json", kind: "tool-result" },
				images: undefined,
			},
			agentOutput: "from-agent",
		});
		expect(execute).toHaveBeenCalledTimes(2);
		expect(execute.mock.calls[0]?.[1]).toEqual({ path: "package.json", [INTENT_FIELD]: "js prelude" });
		expect(execute.mock.calls[1]?.[1]).toEqual({ path: "agent://agent-42", [INTENT_FIELD]: "js prelude" });
	});

	it("auto-displays the final awaited expression result", async () => {
		const execute = vi.fn(async (): Promise<AgentToolResult> => ({
			content: [{ type: "text", text: "tool output" }],
			details: { kind: "tool-result" },
		}));
		const toolSession: ToolSession = {
			...session,
			getToolByName: name => (name === "read" ? createTool("read", execute) : undefined),
		};

		const result = await executeJs("await tool.read({ path: 'package.json' });", {
			sessionId,
			session: toolSession,
			sessionFile,
		});

		expect(result.exitCode).toBe(0);
		expect(getJsonData(result)).toEqual({
			text: "tool output",
			details: { kind: "tool-result" },
			images: undefined,
		});
	});

	it("awaits promise-valued final expressions before displaying", async () => {
		const result = await executeJs("read('config.json');", {
			sessionId,
			session,
			sessionFile,
		});

		expect(result.exitCode).toBe(0);
		expect(result.output.trim()).toBe('{\n  "name": "demo",\n  "enabled": true\n}');
	});

	it("awaits identifier promise final expressions before displaying", async () => {
		const result = await executeJs("const pending = read('config.json'); pending;", {
			sessionId,
			session,
			sessionFile,
		});

		expect(result.exitCode).toBe(0);
		expect(result.output.trim()).toBe('{\n  "name": "demo",\n  "enabled": true\n}');
	});

	it("auto-displays returned objects as structured output", async () => {
		const result = await executeJs("return { answer: 42, nested: { ok: true } };", {
			sessionId,
			session,
			sessionFile,
		});

		expect(result.exitCode).toBe(0);
		expect(result.output).toBe("");
		expect(result.displayOutputs).toEqual([{ type: "json", data: { answer: 42, nested: { ok: true } } }]);
	});

	it('rewrites static `import { x } from "pkg"` to dynamic import', async () => {
		const result = await executeJs('import { join } from "node:path";\nreturn join("a", "b");', {
			sessionId,
			session,
			sessionFile,
		});
		expect(result.exitCode).toBe(0);
		expect(result.output.trim()).toBe(path.join("a", "b"));
	});

	it("strips TypeScript syntax before executing user code", async () => {
		const result = await executeJs(
			[
				"interface Pair { a: number; b: number }",
				"const make = (a: number, b: number): Pair => ({ a, b });",
				"const p = make(3, 4) as Pair;",
				"return p.a + p.b;",
			].join("\n"),
			{ sessionId, session, sessionFile },
		);
		expect(result.exitCode).toBe(0);
		expect(result.output.trim()).toBe("7");
	});
	it("falls back to text display when the final expression value is not structured-cloneable", async () => {
		const result = await executeJs("({ fn: () => 1 });", { sessionId, session, sessionFile });
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("[object Object]");
		// No JSON display because structuredClone fails on the embedded function.
		expect(result.displayOutputs.filter(o => o.type === "json")).toHaveLength(0);
	});

	it("cancels execution when the timeout expires", async () => {
		const result = await executeJs("await new Promise(() => {})", {
			sessionId,
			session,
			sessionFile,
			timeoutMs: 20,
		});

		expect(result.cancelled).toBe(true);
		expect(result.exitCode).toBeUndefined();
		expect(result.output).toContain("Command timed out");
	});
});
