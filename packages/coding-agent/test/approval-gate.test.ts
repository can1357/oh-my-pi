import { beforeAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runInteractiveApprovalGate } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/approval-gate";
import {
	EXTENSION_HANDLER_TIMEOUT_MS,
	ExtensionRunner,
	testSetExtensionHandlerTimeoutMs,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type {
	Extension,
	ExtensionRuntime,
	ExtensionUIContext,
	ToolApprovalRequestedEvent,
	ToolApprovalResolvedEvent,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
const PROPOSED = "proposed content\n";
const HUMAN = "human content\n";

const writeParamsSchema = type({ path: "string", content: "string" });

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => null,
		enableLsp: false,
		settings: Settings.isolated(),
	} as unknown as ToolSession;
}

async function until(condition: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100 && !condition(); attempt++) {
		await Bun.sleep(2);
	}
	expect(condition()).toBe(true);
}

describe("interactive approval gate", () => {
	let tmpDir: string;
	let session: ToolSession;
	let tool: WriteTool;
	let target: string;

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-approval-gate-"));
		session = createSession(tmpDir);
		tool = new WriteTool(session);
		target = path.join(tmpDir, "f.txt");
		await Bun.write(target, "before\n");
	});

	afterEach(async () => {
		testSetExtensionHandlerTimeoutMs(EXTENSION_HANDLER_TIMEOUT_MS);
		await removeWithRetries(tmpDir);
	});

	interface Harness {
		requested: ToolApprovalRequestedEvent[];
		resolved: ToolApprovalResolvedEvent[];
		uiSignal(): AbortSignal | undefined;
		approveInDialog(): void;
		denyInDialog(): void;
		failDialog(error: unknown): void;
		gate: Promise<void>;
		controller: AbortController;
	}

	async function start(userPolicies: Record<string, unknown> = {}): Promise<Harness> {
		const requested: ToolApprovalRequestedEvent[] = [];
		const resolved: ToolApprovalResolvedEvent[] = [];
		const controller = new AbortController();
		let dialogSignal: AbortSignal | undefined;
		let settleDialog: ((choice: string) => void) | undefined;
		let rejectDialog: ((error: unknown) => void) | undefined;
		const uiContext = {
			select: (_prompt: string, _choices: string[], options?: { signal?: AbortSignal }): Promise<string> => {
				dialogSignal = options?.signal;
				const dialog = Promise.withResolvers<string>();
				settleDialog = dialog.resolve;
				rejectDialog = dialog.reject;
				return dialog.promise;
			},
		};
		const runner = {
			emit: async (event: ToolApprovalRequestedEvent | ToolApprovalResolvedEvent): Promise<unknown> => {
				if (event.type === "tool_approval_requested") requested.push(event);
				if (event.type === "tool_approval_resolved") resolved.push(event);
				return undefined;
			},
			getUIContext: () => uiContext,
		} as unknown as ExtensionRunner;
		const review = await tool.prepareApproval("call", { path: "f.txt", content: PROPOSED });
		if (!review) throw new Error("expected a review for a filesystem write");
		const gatedTool = tool as unknown as AgentTool<typeof writeParamsSchema>;
		const gate = runInteractiveApprovalGate<typeof writeParamsSchema>({
			tool: gatedTool,
			toolCallId: "call",
			effectiveParams: { path: "f.txt", content: PROPOSED },
			approvalMode: "always-ask",
			userPolicies,
			safetyPrompt: "Approve the write?",
			signal: controller.signal,
			runner,
			review,
		});
		await until(() => requested.length > 0);
		return {
			requested,
			resolved,
			uiSignal: () => dialogSignal,
			approveInDialog: () => settleDialog?.("Approve"),
			denyInDialog: () => settleDialog?.("Deny"),
			failDialog: error => rejectDialog?.(error),
			gate,
			controller,
		};
	}

	test("first valid extension response wins: dialog closes, revision executes", async () => {
		const h = await start();
		const ok = await h.requested[0]!.respond!({
			approved: true,
			files: [{ path: "f.txt", content: HUMAN }],
		});
		expect(ok).toBe(true);
		expect(h.uiSignal()?.aborted).toBe(true);
		await h.gate;
		await until(() => h.resolved.length > 0);
		expect(h.resolved[0]).toMatchObject({ approved: true, source: "extension" });
		await tool.execute("call", { path: "f.txt", content: PROPOSED });
		expect(await Bun.file(target).text()).toBe(HUMAN);
	});

	test("TUI answer wins: late extension response resolves false, revision never lands", async () => {
		const h = await start();
		h.approveInDialog();
		await h.gate;
		await until(() => h.resolved.length > 0);
		expect(h.resolved[0]).toMatchObject({ approved: true, source: "user" });
		expect(await h.requested[0]!.respond!({ approved: true, files: [{ path: "f.txt", content: HUMAN }] })).toBe(
			false,
		);
		await tool.execute("call", { path: "f.txt", content: PROPOSED });
		expect(await Bun.file(target).text()).toBe(PROPOSED);
	});

	test("invalid extension response rejects and leaves the dialog open for the TUI", async () => {
		const h = await start();
		await expect(
			h.requested[0]!.respond!({ approved: true, files: [{ path: "nope.txt", content: "x" }] }),
		).rejects.toThrow(/not proposed/i);
		await expect(h.requested[0]!.respond!({ approved: true, files: [{ path: "f.txt" }] } as never)).rejects.toThrow();
		expect(h.uiSignal()?.aborted).toBe(false);
		h.approveInDialog();
		await h.gate;
		await until(() => h.resolved.length > 0);
		expect(h.resolved[0]).toMatchObject({ approved: true, source: "user" });
	});

	test("extension denial settles the gate and drops the prepared revision", async () => {
		const h = await start();
		expect(await h.requested[0]!.respond!({ approved: false })).toBe(true);
		await expect(h.gate).rejects.toThrow(/denied by user/);
		await until(() => h.resolved.length > 0);
		expect(h.resolved[0]).toMatchObject({ approved: false, source: "extension" });
		await tool.execute("call", { path: "f.txt", content: PROPOSED });
		expect(await Bun.file(target).text()).toBe(PROPOSED);
	});

	test("abort settles false, closes the dialog, and notifies once", async () => {
		const h = await start();
		h.controller.abort();
		await expect(h.gate).rejects.toThrow();
		expect(h.uiSignal()?.aborted).toBe(true);
		await until(() => h.resolved.length > 0);
		expect(h.resolved[0]).toMatchObject({ approved: false, source: "abort" });
		expect(h.resolved).toHaveLength(1);
		expect(await h.requested[0]!.respond!({ approved: true })).toBe(false);
	});

	test("a revision denied by per-file policy rejects without closing the dialog", async () => {
		const h = await start({ write: "deny" });
		await expect(
			h.requested[0]!.respond!({ approved: true, files: [{ path: "f.txt", content: HUMAN }] }),
		).rejects.toThrow(/blocked by user policy/);
		expect(h.uiSignal()?.aborted).toBe(false);
		h.controller.abort();
		await expect(h.gate).rejects.toThrow();
		await until(() => h.resolved.length > 0);
		expect(h.resolved).toHaveLength(1);
		expect(h.resolved[0]).toMatchObject({ approved: false, source: "abort" });
	});

	test("a UI selection failure keeps its original error and reports an abort", async () => {
		const h = await start();
		const failure = new Error("approval UI crashed");
		h.failDialog(failure);
		await expect(h.gate).rejects.toBe(failure);
		await until(() => h.resolved.length > 0);
		expect(h.resolved[0]).toMatchObject({
			approved: false,
			source: "abort",
			reason: "Error: approval UI crashed",
		});
	});

	test("resolved is delivered after requested even when an extension responds mid-delivery", async () => {
		const deliveries: string[] = [];
		const uiContext = {
			select: (): Promise<string> => Promise.withResolvers<string>().promise,
		};
		const runner = {
			emit: async (event: ToolApprovalRequestedEvent | ToolApprovalResolvedEvent): Promise<unknown> => {
				if (event.type === "tool_approval_requested") {
					// The first handler answers instantly, mid-delivery; a
					// second extension must still receive the request first.
					await event.respond?.({ approved: true });
					await Bun.sleep(0);
					deliveries.push("requested");
				}
				if (event.type === "tool_approval_resolved") {
					deliveries.push("resolved");
				}
				return undefined;
			},
			getUIContext: () => uiContext,
		} as unknown as ExtensionRunner;
		const review = await tool.prepareApproval("ordering", { path: "f.txt", content: PROPOSED });
		if (!review) throw new Error("expected a review for a filesystem write");
		const gatedTool = tool as unknown as AgentTool<typeof writeParamsSchema>;
		await runInteractiveApprovalGate<typeof writeParamsSchema>({
			tool: gatedTool,
			toolCallId: "ordering",
			effectiveParams: { path: "f.txt", content: PROPOSED },
			approvalMode: "always-ask",
			userPolicies: {},
			safetyPrompt: "Approve the write?",
			runner,
			review,
		});
		await until(() => deliveries.includes("resolved"));
		expect(deliveries).toEqual(["requested", "resolved"]);
		await tool.execute("ordering", { path: "f.txt", content: PROPOSED });
		expect(await Bun.file(target).text()).toBe(PROPOSED);
	});

	test("pre-aborted signal never emits orphan tool_approval_resolved", async () => {
		const events: string[] = [];
		const runner = {
			emit: async (event: ToolApprovalRequestedEvent | ToolApprovalResolvedEvent): Promise<unknown> => {
				events.push(event.type);
				return undefined;
			},
			getUIContext: () => ({
				select: (): Promise<string> => Promise.withResolvers<string>().promise,
			}),
		} as unknown as ExtensionRunner;
		const review = await tool.prepareApproval("pre-aborted", { path: "f.txt", content: PROPOSED });
		if (!review) throw new Error("expected a review for a filesystem write");
		const gatedTool = tool as unknown as AgentTool<typeof writeParamsSchema>;
		const controller = new AbortController();
		controller.abort();
		await expect(
			runInteractiveApprovalGate<typeof writeParamsSchema>({
				tool: gatedTool,
				toolCallId: "pre-aborted",
				effectiveParams: { path: "f.txt", content: PROPOSED },
				approvalMode: "always-ask",
				userPolicies: {},
				safetyPrompt: "Approve the write?",
				signal: controller.signal,
				runner,
				review,
			}),
		).rejects.toThrow();
		await Bun.sleep(10);
		expect(events).toEqual([]);
	});

	test("synchronous UI failure before requested emit never emits orphan tool_approval_resolved", async () => {
		const events: string[] = [];
		const runner = {
			emit: async (event: ToolApprovalRequestedEvent | ToolApprovalResolvedEvent): Promise<unknown> => {
				events.push(event.type);
				return undefined;
			},
			getUIContext: () => ({
				select: (): Promise<string> => {
					throw new Error("UI crashed synchronously");
				},
			}),
		} as unknown as ExtensionRunner;
		const review = await tool.prepareApproval("sync-ui-fail", { path: "f.txt", content: PROPOSED });
		if (!review) throw new Error("expected a review for a filesystem write");
		const gatedTool = tool as unknown as AgentTool<typeof writeParamsSchema>;
		await expect(
			runInteractiveApprovalGate<typeof writeParamsSchema>({
				tool: gatedTool,
				toolCallId: "sync-ui-fail",
				effectiveParams: { path: "f.txt", content: PROPOSED },
				approvalMode: "always-ask",
				userPolicies: {},
				safetyPrompt: "Approve the write?",
				runner,
				review,
			}),
		).rejects.toThrow(/UI crashed synchronously/);
		await Bun.sleep(10);
		expect(events).toEqual([]);
	});

	test("handler capturing respond cannot approve after timing out", async () => {
		testSetExtensionHandlerTimeoutMs(10);
		let capturedRespond: NonNullable<ToolApprovalRequestedEvent["respond"]> | undefined;
		const handlerStarted = Promise.withResolvers<void>();
		const extension: Extension = {
			path: "/test/timeout-extension.ts",
			resolvedPath: "/test/timeout-extension.ts",
			handlers: new Map([
				[
					"tool_approval_requested",
					[
						async (event: unknown) => {
							const approvalEvent = event as ToolApprovalRequestedEvent;
							capturedRespond = approvalEvent.respond;
							handlerStarted.resolve();
							await Promise.withResolvers<void>().promise;
						},
					],
				],
			]),
			tools: new Map(),
			assistantThinkingRenderers: [],
			fileWriteFallbackHandlers: [],
			fileDeleteFallbackHandlers: [],
			messageRenderers: new Map(),
			composerShapes: new Map(),
			commands: new Map(),
			flags: new Map(),
			shortcuts: new Map(),
		};
		let dialogResolve: ((choice: string) => void) | undefined;
		const runner = new ExtensionRunner(
			[extension],
			{ flagValues: new Map(), pendingProviderRegistrations: [] } as unknown as ExtensionRuntime,
			tmpDir,
			{ getCwd: () => tmpDir } as never,
			{} as never,
		);
		runner.initialize(
			{
				sendMessage: () => {},
				sendUserMessage: () => {},
				appendEntry: () => {},
				setLabel: () => {},
				getActiveTools: () => [],
				getAllTools: () => [],
				setActiveTools: async () => {},
				getCommands: () => [],
				setModel: async () => false,
				getThinkingLevel: () => undefined,
				setThinkingLevel: () => {},
				getSessionName: () => undefined,
				setSessionName: async () => {},
			},
			{
				getModel: () => undefined,
				isIdle: () => true,
				abort: () => {},
				hasPendingMessages: () => false,
				shutdown: () => {},
				getContextUsage: () => undefined,
				compact: async () => {},
				getSystemPrompt: () => [],
			},
			undefined,
			{
				select: () => {
					const dialog = Promise.withResolvers<string>();
					dialogResolve = dialog.resolve;
					return dialog.promise;
				},
				confirm: async () => false,
				input: async () => undefined,
				notify: () => {},
				onTerminalInput: () => () => {},
				setFooter: () => {},
			} as unknown as ExtensionUIContext,
		);
		const review = await tool.prepareApproval("timeout-call", { path: "f.txt", content: PROPOSED });
		if (!review) throw new Error("expected a review for a filesystem write");
		const gatedTool = tool as unknown as AgentTool<typeof writeParamsSchema>;
		const gate = runInteractiveApprovalGate<typeof writeParamsSchema>({
			tool: gatedTool,
			toolCallId: "timeout-call",
			effectiveParams: { path: "f.txt", content: PROPOSED },
			approvalMode: "always-ask",
			userPolicies: {},
			safetyPrompt: "Approve the write?",
			runner,
			review,
		});
		await handlerStarted.promise;
		await until(() => capturedRespond !== undefined);
		await Bun.sleep(25);
		if (!capturedRespond) throw new Error("respond was not captured");
		const lateResult = await capturedRespond({ approved: true });
		expect(lateResult).toBe(false);
		dialogResolve?.("Approve");
		await gate;
		await tool.execute("timeout-call", { path: "f.txt", content: PROPOSED });
		expect(await Bun.file(target).text()).toBe(PROPOSED);
	});
});
