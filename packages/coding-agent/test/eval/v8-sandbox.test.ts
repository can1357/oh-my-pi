import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTool, AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeV8IsolatesByOwner, executeInV8Isolate } from "@oh-my-pi/pi-coding-agent/eval/v8/context-manager";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { resolveV8EvalBinary } from "@oh-my-pi/pi-natives";
import { getAgentDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

const hasV8Binary = resolveV8EvalBinary() !== null;
describe("V8 sandbox eval mode", () => {
	let root: TempDir;
	let cwd: string;
	let artifactsDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let originalAgentDir: string;
	let ownerCounter = 0;

	beforeAll(async () => {
		root = TempDir.createSync("@omp-v8-sandbox-");
		authStorage = await AuthStorage.create(path.join(root.path(), "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage.close();
		root.removeSync();
	});

	beforeEach(() => {
		originalAgentDir = getAgentDir();
		const runRoot = path.join(root.path(), `run-${++ownerCounter}`);
		cwd = path.join(runRoot, "cwd");
		artifactsDir = path.join(runRoot, "artifacts");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(artifactsDir, { recursive: true });
		setAgentDir(path.join(runRoot, "agent"));
	});

	afterEach(async () => {
		await disposeV8IsolatesByOwner(`v8-test-owner-${ownerCounter}`);
		setAgentDir(originalAgentDir);
	});

	function createHarness(
		settingsOverrides: Record<string, unknown>,
		selectHandler: ExtensionUIContext["select"] = async () => "Approve",
	) {
		const ownerId = `v8-test-owner-${ownerCounter}`;
		const sessionId = `v8-test-session-${ownerCounter}`;
		const settings = Settings.isolated(settingsOverrides);
		const sessionManager = SessionManager.inMemory(cwd);
		const select = vi.fn(selectHandler);
		const runner = new ExtensionRunner([], new ExtensionRuntime(), getAgentDir(), sessionManager, modelRegistry);
		runner.initialize(
			{} as Parameters<ExtensionRunner["initialize"]>[0],
			{} as Parameters<ExtensionRunner["initialize"]>[1],
			undefined,
			{ select } as unknown as ExtensionUIContext,
		);

		const wrappedTools = new Map<string, AgentTool>();
		const context = {
			sessionManager,
			modelRegistry,
			settings,
		} as unknown as AgentToolContext;

		const toolSession: ToolSession = {
			cwd,
			hasUI: true,
			settings,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getSessionId: () => sessionId,
			getEvalSessionId: () => sessionId,
			getEvalKernelOwnerId: () => ownerId,
			getArtifactsDir: () => artifactsDir,
			getToolContext: () => context,
			getToolByName: name => wrappedTools.get(name),
			getToolForEvalBridge: name => wrappedTools.get(name),
		};

		const evalTool = new EvalTool(toolSession);
		const readTool = new ReadTool(toolSession);
		const writeTool = new WriteTool(toolSession);

		wrappedTools.set("eval", new ExtensionToolWrapper(evalTool as unknown as AgentTool, runner));
		wrappedTools.set("read", new ExtensionToolWrapper(readTool as unknown as AgentTool, runner));
		wrappedTools.set("write", new ExtensionToolWrapper(writeTool as unknown as AgentTool, runner));

		return {
			evalWrapper: wrappedTools.get("eval")!,
			context,
			select,
			toolSession,
		};
	}

	function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
		return result.content
			.filter(block => block.type === "text" && typeof block.text === "string")
			.map(block => block.text)
			.join("\n");
	}

	it.skipIf(!hasV8Binary)(
		"runs v8 without prompting across always-ask, always-ask-cached, write, and restrictedFolders covering cwd, while js still prompts",
		async () => {
			for (const mode of ["always-ask", "always-ask-cached", "write"] as const) {
				const h = createHarness(
					{
						"tools.approvalMode": mode,
						"tools.restrictedFolders": [cwd],
					},
					async () => "Deny",
				);

				const res = await h.evalWrapper.execute(
					`v8-${mode}`,
					{ language: "v8", code: "const x = 40 + 2; x" },
					undefined,
					undefined,
					h.context,
				);
				expect(h.select).not.toHaveBeenCalled();
				expect(resultText(res)).toContain("42");
			}

			const jsHarness = createHarness(
				{
					"tools.approvalMode": "always-ask",
				},
				async () => "Deny",
			);
			await expect(
				jsHarness.evalWrapper.execute(
					"js-prompts",
					{ language: "js", code: "42" },
					undefined,
					undefined,
					jsHarness.context,
				),
			).rejects.toThrow(/denied|approval/i);
			expect(jsHarness.select).toHaveBeenCalledTimes(1);
		},
	);

	it("still respects explicit user deny and prompt policies on eval", async () => {
		const denyHarness = createHarness({
			"tools.approvalMode": "yolo",
			"tools.approval": { eval: "deny" },
		});
		await expect(
			denyHarness.evalWrapper.execute(
				"v8-deny",
				{ language: "v8", code: "1 + 1" },
				undefined,
				undefined,
				denyHarness.context,
			),
		).rejects.toThrow(/blocked by user policy/i);

		const promptHarness = createHarness(
			{
				"tools.approvalMode": "yolo",
				"tools.approval": { eval: "prompt" },
			},
			async () => "Deny",
		);
		await expect(
			promptHarness.evalWrapper.execute(
				"v8-prompt",
				{ language: "v8", code: "1 + 1" },
				undefined,
				undefined,
				promptHarness.context,
			),
		).rejects.toThrow(/denied|approval/i);
		expect(promptHarness.select).toHaveBeenCalledTimes(1);
	});

	it.skipIf(!hasV8Binary)(
		"enforces normal tool approval on inner tool.write and delegated host read/write calls",
		async () => {
			const denyHarness = createHarness(
				{
					"tools.approvalMode": "always-ask",
				},
				async () => "Deny",
			);

			// Outer eval runs without prompt, inner tool.write triggers approval and fails when denied.
			const deniedWrite = await denyHarness.evalWrapper.execute(
				"v8-inner-deny",
				{
					language: "v8",
					code: 'await tool.write({ path: "host.txt", content: "hi" })',
				},
				undefined,
				undefined,
				denyHarness.context,
			);
			expect(denyHarness.select).toHaveBeenCalledTimes(1);
			expect(deniedWrite.isError).toBe(true);
			expect(fs.existsSync(path.join(cwd, "host.txt"))).toBe(false);

			// Delegated write("escape.txt", ...) also goes through normal write tool approval.
			const deniedHelperWrite = await denyHarness.evalWrapper.execute(
				"v8-helper-deny",
				{
					language: "v8",
					code: 'await write("escape.txt", "nope")',
				},
				undefined,
				undefined,
				denyHarness.context,
			);
			expect(denyHarness.select).toHaveBeenCalledTimes(2);
			expect(deniedHelperWrite.isError).toBe(true);
			expect(fs.existsSync(path.join(cwd, "escape.txt"))).toBe(false);

			// Approving inner write succeeds and writes the host file.
			const approveHarness = createHarness(
				{
					"tools.approvalMode": "always-ask",
				},
				async () => "Approve",
			);
			const approvedWrite = await approveHarness.evalWrapper.execute(
				"v8-inner-approve",
				{
					language: "v8",
					code: 'await tool.write({ path: "host.txt", content: "hello host" })',
				},
				undefined,
				undefined,
				approveHarness.context,
			);
			expect(approveHarness.select).toHaveBeenCalledTimes(1);
			expect(approvedWrite.isError).toBeFalsy();
			expect(fs.readFileSync(path.join(cwd, "host.txt"), "utf-8")).toBe("hello host");
		},
	);

	it.skipIf(!hasV8Binary)(
		"allows direct local:// read/write without prompts while gating host reads under restrictedFolders",
		async () => {
			fs.writeFileSync(path.join(cwd, "secret.txt"), "top-secret");

			const h = createHarness(
				{
					"tools.approvalMode": "always-ask",
					"tools.restrictedFolders": [cwd],
				},
				async () => "Deny",
			);

			const localRes = await h.evalWrapper.execute(
				"v8-local-io",
				{
					language: "v8",
					code: 'await write("local://scratch.txt", "ok"); await read("local://scratch.txt")',
				},
				undefined,
				undefined,
				h.context,
			);
			expect(h.select).not.toHaveBeenCalled();
			expect(localRes.isError).toBeFalsy();
			expect(resultText(localRes)).toContain("ok");
			expect(fs.readFileSync(path.join(artifactsDir, "local", "scratch.txt"), "utf-8")).toBe("ok");

			await h.evalWrapper
				.execute(
					"v8-local-lines",
					{
						language: "v8",
						code: 'await write("local://lines.txt", "a\\nb\\nc\\nd"); await read("local://lines.txt:2-3")',
					},
					undefined,
					undefined,
					h.context,
				)
				.then(res => {
					expect(res.isError).toBeFalsy();
					expect(resultText(res).trim()).toBe("b\nc");
				});
			// Reading a host file delegates to tool.read, which triggers restrictedFolders on cwd.
			const hostRead = await h.evalWrapper.execute(
				"v8-host-read",
				{
					language: "v8",
					code: 'await read("secret.txt")',
				},
				undefined,
				undefined,
				h.context,
			);
			expect(h.select).toHaveBeenCalledTimes(1);
			expect(hostRead.isError).toBe(true);
			expect(resultText(hostRead)).not.toContain("top-secret");
		},
	);

	it.skipIf(!hasV8Binary)(
		"isolates env(), blocks synthetic __* bridges, blocks %load on host paths, and allows %load local://",
		async () => {
			const h = createHarness({ "tools.approvalMode": "always-ask" });

			const isoRes = await h.evalWrapper.execute(
				"v8-isolation",
				{
					language: "v8",
					code: [
						'const before = env("PATH");',
						'env("CUSTOM_KEY", "abc");',
						"const allEnv = env();",
						'let shellErr = "";',
						'try { await tool.__shell__({ command: "id" }); } catch (e) { shellErr = e.message; }',
						"JSON.stringify({ before, allEnv, shellErr, bun: typeof Bun, proc: typeof process, fetch: typeof fetch });",
					].join("\n"),
				},
				undefined,
				undefined,
				h.context,
			);
			expect(isoRes.isError).toBeFalsy();
			const iso = JSON.parse(resultText(isoRes).trim()) as Record<string, unknown>;
			expect(iso.before).toBeUndefined();
			expect(iso.allEnv).toEqual({ CUSTOM_KEY: "abc" });
			expect(String(iso.shellErr)).toContain("Unknown tool in V8 sandbox");
			expect(iso.bun).toBe("undefined");
			expect(iso.proc).toBe("undefined");
			expect(iso.fetch).toBe("undefined");

			// %load on host path is rejected before execution.
			await expect(
				h.evalWrapper.execute(
					"v8-load-host",
					{ language: "v8", code: "%load /etc/hosts" },
					undefined,
					undefined,
					h.context,
				),
			).rejects.toThrow(/safe internal URLs/);

			// %load on local:// succeeds without prompting.
			fs.mkdirSync(path.join(artifactsDir, "local"), { recursive: true });
			fs.writeFileSync(path.join(artifactsDir, "local", "helper.js"), "const loadedVal = 99;\nloadedVal");
			const loadLocal = await h.evalWrapper.execute(
				"v8-load-local",
				{ language: "v8", code: "%load local://helper.js" },
				undefined,
				undefined,
				h.context,
			);
			expect(loadLocal.isError).toBeFalsy();
			expect(resultText(loadLocal)).toContain("99");
		},
	);

	it.skipIf(!hasV8Binary)(
		"persists state across cells, clears on reset, and terminates infinite loops on timeout",
		async () => {
			const h = createHarness({ "tools.approvalMode": "always-ask" });

			const c1 = await h.evalWrapper.execute(
				"v8-p1",
				{ language: "v8", code: "const persistA = 7;" },
				undefined,
				undefined,
				h.context,
			);
			expect(c1.isError).toBeFalsy();

			const c2 = await h.evalWrapper.execute(
				"v8-p2",
				{ language: "v8", code: "persistA * 6" },
				undefined,
				undefined,
				h.context,
			);
			expect(resultText(c2)).toContain("42");

			const c3 = await h.evalWrapper.execute(
				"v8-reset",
				{ language: "v8", reset: true, code: "typeof persistA" },
				undefined,
				undefined,
				h.context,
			);
			expect(resultText(c3)).toContain("undefined");

			// Infinite loop with 1s timeout terminates cleanly without wedging host or isolate.
			const cTimeout = await h.evalWrapper.execute(
				"v8-timeout",
				{ language: "v8", timeout: 1, code: "while (true) {}" },
				undefined,
				undefined,
				h.context,
			);
			expect(cTimeout.isError).toBe(true);
			expect(resultText(cTimeout)).toMatch(/timed out/i);

			const cAfter = await h.evalWrapper.execute(
				"v8-after-timeout",
				{ language: "v8", code: "100 + 23" },
				undefined,
				undefined,
				h.context,
			);
			expect(cAfter.isError).toBeFalsy();
			expect(resultText(cAfter)).toContain("123");
		},
	);

	it.skipIf(!hasV8Binary)(
		"writes directly to out:// and agent:// without prompting or needing the write tool, and handles pre-aborted signals cleanly",
		async () => {
			const h = createHarness({
				"tools.approvalMode": "always-ask",
				"tools.approval": { write: "deny" },
				"tools.restrictedFolders": [cwd],
				"out.enabled": true,
			});
			const outRes = await h.evalWrapper.execute(
				"v8-out-write",
				{
					language: "v8",
					code: 'await write("out://", "reply from v8"); "done"',
				},
				undefined,
				undefined,
				h.context,
			);
			expect(h.select).not.toHaveBeenCalled();
			expect(outRes.isError).toBeFalsy();
			expect(outRes.details?.replies).toEqual(["reply from v8"]);

			// Pre-aborted signal must fail without killing a live persistent isolate.
			await h.evalWrapper.execute(
				"v8-seed",
				{ language: "v8", code: "const kept = 77;" },
				undefined,
				undefined,
				h.context,
			);
			const preAborted = AbortSignal.abort(new Error("already aborted"));
			await expect(
				executeInV8Isolate({
					sessionKey: `v8:${h.toolSession.getEvalSessionId!()}`,
					sessionId: h.toolSession.getEvalSessionId!(),
					ownerId: h.toolSession.getEvalKernelOwnerId!(),
					session: h.toolSession,
					code: "1 + 1",
					filename: "pre-abort.js",
					runState: { signal: preAborted },
				}),
			).rejects.toThrow(/already aborted/i);
			const afterPreAbort = await h.evalWrapper.execute(
				"v8-after-pre-abort",
				{ language: "v8", code: "kept + 3" },
				undefined,
				undefined,
				h.context,
			);
			expect(afterPreAbort.isError).toBeFalsy();
			expect(resultText(afterPreAbort)).toContain("80");
		},
	);
});
