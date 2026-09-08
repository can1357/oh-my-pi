import { beforeAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runInteractiveApprovalGate } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/approval-gate";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type {
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
		await removeWithRetries(tmpDir);
	});

	interface Harness {
		requested: ToolApprovalRequestedEvent[];
		resolved: ToolApprovalResolvedEvent[];
		uiSignal(): AbortSignal | undefined;
		approveInDialog(): void;
		denyInDialog(): void;
		gate: Promise<void>;
		controller: AbortController;
	}

	async function start(userPolicies: Record<string, unknown> = {}): Promise<Harness> {
		const requested: ToolApprovalRequestedEvent[] = [];
		const resolved: ToolApprovalResolvedEvent[] = [];
		const controller = new AbortController();
		let dialogSignal: AbortSignal | undefined;
		let settleDialog: ((choice: string) => void) | undefined;
		const uiContext = {
			select: (_prompt: string, _choices: string[], options?: { signal?: AbortSignal }): Promise<string> => {
				dialogSignal = options?.signal;
				return new Promise<string>(resolve => {
					settleDialog = resolve;
				});
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
});
