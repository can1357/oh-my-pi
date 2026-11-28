import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTool, AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgEvalV8, cfgEvalV8MaxHeapMb } from "@oh-my-pi/pi-coding-agent/eval/settings";
import { isDirectWritableV8Url } from "@oh-my-pi/pi-coding-agent/eval/v8/url-policy";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
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
	let schemeCounter = 0;

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
					sessionKey: `v8:${h.toolSession.getEvalSessionId!()!}`,
					sessionId: h.toolSession.getEvalSessionId!()!,
					ownerId: h.toolSession.getEvalKernelOwnerId!() ?? undefined,
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

	it.skipIf(!hasV8Binary)(
		"rejects TS/Bun macro imports before transpilation, blocks WebAssembly and oversized ArrayBuffers, awaits trailing promises/early returns, and rejects nested v8 eval",
		async () => {
			const h = createHarness(
				{
					"tools.approvalMode": "always-ask",
					"tools.restrictedFolders": [cwd],
					"eval.v8": true,
					"eval.v8MaxHeapMb": 32,
				},
				async () => "Deny",
			);
			expect(cfgEvalV8.get(h.toolSession.settings)).toBe(true);
			expect(cfgEvalV8MaxHeapMb.get(h.toolSession.settings)).toBe(32);
			// Macro import (including TS-annotated and nested block forms) must be rejected before Bun.Transpiler runs.
			const macroMarker = path.join(cwd, "macro-ran.txt");
			for (const macroCode of [
				`const m: string = ${JSON.stringify(macroMarker)};\nimport { writeFileSync } from "node:fs" with { type: "macro" };\nwriteFileSync(m, "pwned");`,
				`const m: string = ${JSON.stringify(macroMarker)};\n{\nimport { writeFileSync } from "node:fs" with { type: "macro" };\nwriteFileSync(m, "pwned");\n}`,
				'import fsMod = require("node:fs");\nfsMod;',
				'type Mod = typeof import("node:fs");\nconst x: number = 1;\nx;',
			]) {
				const macroRes = await h.evalWrapper.execute(
					"v8-macro",
					{ language: "v8", code: macroCode },
					undefined,
					undefined,
					h.context,
				);
				expect(macroRes.isError).toBe(true);
				expect(resultText(macroRes)).toContain("Module import/export syntax is not supported");
				expect(fs.existsSync(macroMarker)).toBe(false);
			}
			// Early return in async cell and trailing Promise expression both surface values.
			const earlyAsync = await h.evalWrapper.execute(
				"v8-early-async",
				{ language: "v8", code: "await Promise.resolve(1);\nreturn 77;\n99;" },
				undefined,
				undefined,
				h.context,
			);
			expect(earlyAsync.isError).toBeFalsy();
			expect(resultText(earlyAsync)).toContain("77");

			const trailingPromise = await h.evalWrapper.execute(
				"v8-trailing-promise",
				{ language: "v8", code: "Promise.resolve(88)" },
				undefined,
				undefined,
				h.context,
			);
			expect(trailingPromise.isError).toBeFalsy();
			expect(resultText(trailingPromise)).toContain("88");

			// WebAssembly is disabled.
			const wasmCheck = await h.evalWrapper.execute(
				"v8-wasm",
				{ language: "v8", code: "typeof WebAssembly" },
				undefined,
				undefined,
				h.context,
			);
			expect(wasmCheck.isError).toBeFalsy();
			expect(resultText(wasmCheck).trim()).toBe("undefined");

			// Oversized ArrayBuffer allocation hits the 32 MiB limit cleanly and the isolate recovers on the next cell.
			const abOom = await h.evalWrapper.execute(
				"v8-ab-oom",
				{ language: "v8", code: "new ArrayBuffer(128 * 1024 * 1024)" },
				undefined,
				undefined,
				h.context,
			);
			expect(abOom.isError).toBe(true);
			expect(resultText(abOom)).toMatch(/heap limit|allocation failed/i);

			const postOom = await h.evalWrapper.execute(
				"v8-post-oom",
				{ language: "v8", code: "6 * 7" },
				undefined,
				undefined,
				h.context,
			);
			expect(postOom.isError).toBeFalsy();
			expect(resultText(postOom)).toContain("42");

			// Privileged / non-allowlisted schemes delegate to tool.read rather than bypassing approval:
			// ssh:// has readTier "exec" (prompts under always-ask), and git:// prompts under always-ask-cached.
			const sshRead = await h.evalWrapper.execute(
				"v8-ssh-read",
				{ language: "v8", code: 'await read("ssh://host/etc/passwd")' },
				undefined,
				undefined,
				h.context,
			);
			expect(h.select).toHaveBeenCalledTimes(1);
			expect(sshRead.isError).toBe(true);

			const cachedHarness = createHarness({ "tools.approvalMode": "always-ask-cached" }, async () => "Deny");
			const gitRead = await cachedHarness.evalWrapper.execute(
				"v8-git-read",
				{ language: "v8", code: 'await read("git://status")' },
				undefined,
				undefined,
				cachedHarness.context,
			);
			expect(cachedHarness.select).toHaveBeenCalledTimes(1);
			expect(gitRead.isError).toBe(true);

			// Re-entrant tool.eval({ language: "v8" }) on the same session rejects immediately instead of deadlocking.
			const nestedEval = await h.evalWrapper.execute(
				"v8-nested",
				{
					language: "v8",
					code: 'const r = await tool.eval({ language: "v8", code: "1+1" }); if (r?.hasError) throw new Error(r.text); r',
				},
				undefined,
				undefined,
				h.context,
			);
			expect(nestedEval.isError).toBe(true);
			expect(resultText(nestedEval)).toContain("Nested language: 'v8' calls");
		},
	);

	it.skipIf(!hasV8Binary)(
		"blocks resizable/growable ArrayBuffers, strips guest image URL metadata, rejects malformed views, settles dangling promises, rejects non-file %load, enforces write-tier boundary, and aborts queued cells deterministically",
		async () => {
			const h = createHarness({
				"tools.approvalMode": "always-ask",
				"eval.v8": true,
				"eval.v8MaxHeapMb": 32,
			});

			// Resizable ArrayBuffer, constructor bypass, and SharedArrayBuffer options are all blocked.
			const rabRes = await h.evalWrapper.execute(
				"v8-rab",
				{
					language: "v8",
					code: [
						"const errs = [];",
						"let leakedCtor = null;",
						"const origReflectConstruct = Reflect.construct;",
						"Reflect.construct = function (target, args, newTarget) { leakedCtor = target; return origReflectConstruct(target, args, newTarget); };",
						"try { new ArrayBuffer(0, { maxByteLength: 1 << 30 }); } catch (e) { errs.push(e.name); }",
						"try { new ((new Uint8Array(1)).buffer.constructor)(0, { maxByteLength: 1 << 30 }); } catch (e) { errs.push(e.name); }",
						"try { new SharedArrayBuffer(0, { maxByteLength: 1 << 30 }); } catch (e) { errs.push(e.name); }",
						"new ArrayBuffer(8);",
						"Reflect.construct = origReflectConstruct;",
						"JSON.stringify({ errs, leakedNativeCtor: leakedCtor !== ArrayBuffer && leakedCtor !== null, resize: typeof ArrayBuffer.prototype.resize, grow: typeof SharedArrayBuffer.prototype.grow });",
					].join("\n"),
				},
				undefined,
				undefined,
				h.context,
			);
			expect(rabRes.isError).toBeFalsy();
			const rab = JSON.parse(resultText(rabRes).trim()) as {
				errs: string[];
				leakedNativeCtor: boolean;
				resize: string;
				grow: string;
			};
			expect(rab.errs).toEqual(["RangeError", "RangeError", "RangeError"]);
			expect(rab.leakedNativeCtor).toBe(false);
			expect(rab.resize).toBe("undefined");
			expect(rab.grow).toBe("undefined");
			// Guest image url/providerFile/detail spoofing is stripped and malformed view payloads are dropped.
			const png1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
			// Valid 256x256 PNG IHDR header with truncated payload (would hit metadata-only fast path if decode isn't verified).
			const truncated256Png = Buffer.concat([
				Buffer.from([
					0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00,
					0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x08, 0x06, 0x00, 0x00, 0x00, 0x5c, 0x72, 0xa8, 0x66,
				]),
				Buffer.from("corrupt-idat-tail"),
			]).toString("base64");
			const imgRes = await h.evalWrapper.execute(
				"v8-img-spoof",
				{
					language: "v8",
					code: [
						"Object.prototype.toJSON = function () {",
						'  if (this && this.type === "image") {',
						'    return { type: "image", data: this.data, mimeType: this.mimeType, detail: "original", url: "https://attacker.example/leak", providerFile: { provider: "openai", id: "file-1" } };',
						"  }",
						'  if (this && this.type === "view" && typeof this.text === "string" && this.text.includes("fallback-text")) {',
						'    return { type: "view", text: this.text, view: { kind: "table" } };',
						"  }",
						"  return this;",
						"};",
						"try {",
						`  print({ type: "image", data: ${JSON.stringify(png1x1)}, mimeType: "image/png" });`,
						`  print({ type: "image", data: ${JSON.stringify(truncated256Png)}, mimeType: "image/png" });`,
						'  print({ type: "image", data: "bm90LWFuLWltYWdl", mimeType: "image/png" });',
						'  print(JSON.stringify({ okView: "valid", pad: "x".repeat(90) }));',
						'  print(JSON.stringify({ badView: "fallback-text", pad: "y".repeat(90) }));',
						"} finally {",
						"  delete Object.prototype.toJSON;",
						"}",
						'"ok"',
					].join("\n"),
				},
				undefined,
				undefined,
				h.context,
			);
			expect(imgRes.isError).toBeFalsy();
			const images = imgRes.content.filter(b => b.type === "image");
			expect(images).toHaveLength(1);
			expect(images[0]).not.toHaveProperty("url");
			expect(images[0]).not.toHaveProperty("providerFile");
			expect(images[0]).not.toHaveProperty("detail");
			expect(imgRes.details?.cells?.[0]?.views).toHaveLength(1);
			expect(resultText(imgRes)).toContain("fallback-text");
			// Un-awaited host promise stored in persistent state is rejected when cell finishes.
			const seedDangling = await h.evalWrapper.execute(
				"v8-dangling-seed",
				{
					language: "v8",
					code: 'globalThis.dangling = read("local://does-not-exist.txt"); globalThis.danglingFallback = globalThis.dangling.catch(() => read("local://fallback.txt")); "seeded"',
				},
				undefined,
				undefined,
				h.context,
			);
			expect(seedDangling.isError).toBeFalsy();
			const checkDangling = await h.evalWrapper.execute(
				"v8-dangling-check",
				{
					language: "v8",
					code: 'let msg = ""; let fbMsg = ""; try { await globalThis.dangling; } catch (e) { msg = e.message; } try { await globalThis.danglingFallback; } catch (e) { fbMsg = e.message; } JSON.stringify({ msg, fbMsg })',
				},
				undefined,
				undefined,
				h.context,
			);
			expect(checkDangling.isError).toBeFalsy();
			const danglingOut = JSON.parse(resultText(checkDangling).trim()) as { msg: string; fbMsg: string };
			expect(danglingOut.msg).toContain("V8 cell finished before host call settled");
			expect(danglingOut.fbMsg).toContain("outside active V8 run");
			// %load rejects virtual resources like history:// in V8 sandbox.
			await expect(
				h.evalWrapper.execute(
					"v8-load-history",
					{ language: "v8", code: "%load history://current" },
					undefined,
					undefined,
					h.context,
				),
			).rejects.toThrow(/%load|safe internal URLs/i);

			// isDirectWritableV8Url requires tier === "read" even when policy === "allow".
			const router = InternalUrlRouter.instance();
			const testScheme = `v8testwrite${++schemeCounter}`;
			router.register({
				scheme: testScheme,
				spec: {
					backing: "device",
					selectors: "none",
					immutable: false,
					write: {
						via: "handler",
						payload: "text",
						scope: "coordination",
						tier: () => ({ tier: "write", policy: "allow" }),
					},
				},
				resolve: async () => ({
					url: `${testScheme}://x`,
					content: "",
					contentType: "text/plain",
					size: 0,
					notes: [],
				}),
				write: async () => undefined,
			});
			try {
				expect(isDirectWritableV8Url(`${testScheme}://x`, "hi", h.toolSession).allowed).toBe(false);
			} finally {
				router.unregister(testScheme);
			}

			// Queued cell aborting while predecessor holds the isolate fails immediately without unblocking cell #3 ahead of #1.
			const c1Started = Promise.withResolvers<void>();
			const c1Gate = Promise.withResolvers<void>();
			const queueOrder: string[] = [];
			const queueHarnessSession: ToolSession = {
				...h.toolSession,
				getToolByName: name =>
					name === "gate"
						? ({
								name: "gate",
								label: "Gate",
								description: "Gate",
								parameters: {} as AgentTool["parameters"],
								execute: async () => {
									c1Started.resolve();
									await c1Gate.promise;
									return { content: [{ type: "text", text: "released" }] };
								},
							} as unknown as AgentTool)
						: h.toolSession.getToolByName?.(name),
				getToolForEvalBridge: name => queueHarnessSession.getToolByName?.(name),
			};
			const sessionId = queueHarnessSession.getEvalSessionId!()!;
			const sessionKey = `v8:${sessionId}`;
			const c1 = executeInV8Isolate({
				sessionKey,
				sessionId,
				ownerId: queueHarnessSession.getEvalKernelOwnerId!() ?? undefined,
				session: queueHarnessSession,
				code: '(async () => { await tool.gate({}); globalThis.qOrder = ["c1"]; })()',
				filename: "c1.js",
				asyncWrapped: true,
				runState: {},
			}).then(() => queueOrder.push("c1"));
			await c1Started.promise;
			const c2Ctrl = new AbortController();
			const c2 = executeInV8Isolate({
				sessionKey,
				sessionId,
				ownerId: queueHarnessSession.getEvalKernelOwnerId!() ?? undefined,
				session: queueHarnessSession,
				code: 'globalThis.qOrder.push("c2");',
				filename: "c2.js",
				runState: { signal: c2Ctrl.signal },
			});
			const c3 = executeInV8Isolate({
				sessionKey,
				sessionId,
				ownerId: queueHarnessSession.getEvalKernelOwnerId!() ?? undefined,
				session: queueHarnessSession,
				code: 'globalThis.qOrder.push("c3");',
				filename: "c3.js",
				runState: {},
			}).then(() => queueOrder.push("c3"));
			c2Ctrl.abort(new Error("queued cancel"));
			await expect(c2).rejects.toThrow(/queued cancel/i);
			expect(queueOrder).toEqual([]);
			c1Gate.resolve();
			await Promise.all([c1, c3]);
			expect(queueOrder).toEqual(["c1", "c3"]);

			// Per-run bridge concurrency cap rejects excess calls cleanly without blocking admitted calls.
			const floodGate = Promise.withResolvers<void>();
			const floodSession: ToolSession = {
				...queueHarnessSession,
				getToolByName: name =>
					name === "flood"
						? ({
								name: "flood",
								label: "Flood",
								description: "Flood",
								parameters: {} as AgentTool["parameters"],
								execute: async () => {
									await floodGate.promise;
									return { content: [{ type: "text", text: "admitted" }] };
								},
							} as unknown as AgentTool)
						: queueHarnessSession.getToolByName?.(name),
				getToolForEvalBridge: name => floodSession.getToolByName?.(name),
			};
			await executeInV8Isolate({
				sessionKey,
				sessionId,
				ownerId: floodSession.getEvalKernelOwnerId!() ?? undefined,
				session: floodSession,
				code: `(async () => {
					const ps = Array.from({ length: 35 }, () => tool.flood({}).then(() => "ok", e => e.message));
					Promise.any(ps).then(() => print("flood-rejected"));
					globalThis.floodResults = await Promise.all(ps);
				})()`,
				filename: "flood.js",
				asyncWrapped: true,
				runState: {
					onText: chunk => {
						if (chunk.includes("flood-rejected")) floodGate.resolve();
					},
				},
			});
			const floodVerify = await h.evalWrapper.execute(
				"v8-flood-verify",
				{ language: "v8", code: "JSON.stringify(globalThis.floodResults)" },
				undefined,
				undefined,
				h.context,
			);
			expect(floodVerify.isError).toBeFalsy();
			const floodResults = JSON.parse(resultText(floodVerify).trim()) as string[];
			expect(floodResults.filter(r => r === "ok")).toHaveLength(32);
			expect(floodResults.filter(r => r.includes("Too many concurrent V8 bridge calls"))).toHaveLength(3);
		},
	);
});
