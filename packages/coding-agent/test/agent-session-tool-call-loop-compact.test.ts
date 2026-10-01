import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockHandler, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { toolLoopRung } from "@oh-my-pi/pi-coding-agent/session/stream-guards";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";

const noopSchema = type({});
const noopTool: AgentTool<typeof noopSchema, undefined> = {
	name: "noop",
	label: "No-op",
	description: "Continue the scripted tool loop",
	parameters: noopSchema,
	async execute() {
		return { content: [{ type: "text", text: "continued" }], details: undefined };
	},
};

/** One repeated noop tool call. Arguments are what the loop guard hashes. */
function repeatTurn(id: string, argumentsValue: Record<string, unknown> = {}): MockResponse {
	return { content: [{ type: "toolCall", id, name: "noop", arguments: argumentsValue }], usage: { input: 190_000 } };
}

describe("toolLoopRung", () => {
	it("ladders steer, compact, abort for a positive compactAfter", () => {
		expect(toolLoopRung(1, 2, 1, false)).toBe("steer");
		expect(toolLoopRung(2, 2, 1, false)).toBe("steer");
		expect(toolLoopRung(2, 2, 1, true)).toBe("steer");
		expect(toolLoopRung(3, 2, 1, false)).toBe("compact");
		expect(toolLoopRung(3, 2, 1, true)).toBe("steer");
		expect(toolLoopRung(4, 2, 1, true)).toBe("abort");
		expect(toolLoopRung(4, 2, 1, false)).toBe("steer");
		expect(toolLoopRung(5, 2, 1, true)).toBe("abort");
	});

	it("steers for every count when compactAfter is off", () => {
		for (let count = 2; count <= 9; count++) {
			expect(toolLoopRung(count, 2, 0, false)).toBe("steer");
			expect(toolLoopRung(count, 2, 0, true)).toBe("steer");
		}
	});

	it("normalizes fractional and non-positive bounds the way the detector does", () => {
		// 1.5 truncates to 1, so the compact rung stays reachable instead of the
		// ladder silently becoming steer-forever.
		expect(toolLoopRung(3, 2, 1.5, false)).toBe("compact");
		expect(toolLoopRung(4, 2, 1.5, true)).toBe("abort");
		// threshold 0 is clamped to 1 by the detector, so the rungs line up with
		// the counts it reports.
		expect(toolLoopRung(2, 0, 1, false)).toBe("compact");
		expect(toolLoopRung(3, 0, 1, true)).toBe("abort");
	});
});

describe("AgentSession tool-call loop compaction", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	afterEach(async () => {
		await session?.dispose();
		authStorage?.close();
		await tempDir?.remove();
		vi.restoreAllMocks();
	});

	async function createSession(options: {
		responses: MockHandler[];
		compactAfter: number;
		compactionEnabled?: boolean;
		midTurnEnabled?: boolean;
		threshold?: number;
	}): Promise<{ notices: string[]; noticeSources: string[]; compactionStarts: number[] }> {
		tempDir = TempDir.createSync("@pi-tool-call-loop-compact-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.keys.setRuntime("mock", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const mock = createMockModel({
			responses: options.responses,
			contextWindow: 200_000,
		});
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([mock]);

		const sessionManager = SessionManager.inMemory(tempDir.path());
		const extensionsDir = path.join(getProjectAgentDir(tempDir.path()), "extensions");
		fs.mkdirSync(extensionsDir, { recursive: true });
		const extensionPath = path.join(extensionsDir, "compaction-short-circuit.ts");
		fs.writeFileSync(
			extensionPath,
			[
				"export default function(pi) {",
				'\tpi.on("session_before_compact", async (event) => ({',
				"\t\tcompaction: {",
				'\t\t\tsummary: "compacted",',
				"\t\t\tshortSummary: undefined,",
				"\t\t\tfirstKeptEntryId: event.preparation.firstKeptEntryId,",
				"\t\t\ttokensBefore: event.preparation.tokensBefore,",
				"\t\t\tdetails: {},",
				"\t\t},",
				"\t}));",
				"}",
			].join("\n"),
		);
		const loaded = await loadExtensions([extensionPath], tempDir.path());
		const extensionRunner = new ExtensionRunner(
			loaded.extensions,
			loaded.runtime,
			tempDir.path(),
			sessionManager,
			modelRegistry,
		);

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock, systemPrompt: ["Test"], tools: [noopTool], messages: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const settings = Settings.isolated({
			"model.toolCallLoopGuard.enabled": true,
			"model.toolCallLoopGuard.threshold": options.threshold ?? 2,
			"model.toolCallLoopGuard.compactAfter": options.compactAfter,
			"compaction.enabled": options.compactionEnabled ?? true,
			"compaction.methodOrder": ["soft"],
			"compaction.thresholdTokens": 10_000_000,
			"compaction.midTurnEnabled": options.midTurnEnabled ?? true,
			"compaction.autoContinue": false,
			"retry.enabled": false,
			"todo.enabled": false,
		});
		settings.setModelRole("default", `${mock.provider}/${mock.id}`);
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			toolRegistry: new Map([[noopTool.name, noopTool]]),
			extensionRunner,
		});

		const notices: string[] = [];
		const noticeSources: string[] = [];
		const compactionStarts: number[] = [];
		session.subscribe(event => {
			if (event.type === "notice") {
				notices.push(event.message);
				if (event.source) noticeSources.push(event.source);
			} else if (event.type === "auto_compaction_start") compactionStarts.push(1);
		});
		return { notices, noticeSources, compactionStarts };
	}

	function redirectEntries(): number[] {
		const branch = session!.sessionManager.getBranch();
		const indices: number[] = [];
		branch.forEach((entry, index) => {
			if (entry.type === "custom_message" && entry.customType === "tool-call-loop-redirect") indices.push(index);
		});
		return indices;
	}

	it("compacts once, then aborts when the tool call keeps repeating", async () => {
		const state = await createSession({
			compactAfter: 1,
			responses: [
				{ content: ["warming up"] },
				repeatTurn("noop-1"),
				repeatTurn("noop-2"),
				repeatTurn("noop-3"),
				repeatTurn("noop-4"),
				repeatTurn("noop-5"),
				repeatTurn("noop-6"),
				{ content: ["done"] },
			],
		});

		await session!.prompt("Warm up");
		await session!.waitForIdle();
		await session!.prompt("Loop forever");
		await session!.waitForIdle();

		expect(state.compactionStarts).toHaveLength(1);
		expect(state.notices.filter(message => message.includes("even after compacting context"))).toHaveLength(1);
		expect(state.noticeSources).toContain("loop-guard");

		const branch = session!.sessionManager.getBranch();
		const compactionIndex = branch.findIndex(entry => entry.type === "compaction");
		expect(compactionIndex).toBeGreaterThanOrEqual(0);
		const redirectAfterCompaction = branch.some(
			(entry, index) =>
				index > compactionIndex &&
				entry.type === "custom_message" &&
				entry.customType === "tool-call-loop-redirect",
		);
		expect(redirectAfterCompaction).toBe(true);

		// Abort at count 4 = threshold + 2 * compactAfter, so the fifth repeated
		// model call never runs.
		const noopCalls = branch.filter(
			entry =>
				entry.type === "message" &&
				entry.message.role === "assistant" &&
				entry.message.content.some(block => block.type === "toolCall"),
		);
		expect(noopCalls).toHaveLength(4);
	});

	it("never compacts and never aborts when compactAfter is off", async () => {
		const state = await createSession({
			compactAfter: 0,
			responses: [
				{ content: ["warming up"] },
				repeatTurn("noop-1"),
				repeatTurn("noop-2"),
				repeatTurn("noop-3"),
				repeatTurn("noop-4"),
				repeatTurn("noop-5"),
				repeatTurn("noop-6"),
				{ content: ["stopped"] },
			],
		});

		await session!.prompt("Warm up");
		await session!.waitForIdle();
		await session!.prompt("Loop forever");
		await session!.waitForIdle();

		expect(state.compactionStarts).toHaveLength(0);
		expect(state.notices.filter(message => message.includes("even after compacting context"))).toHaveLength(0);
		expect(redirectEntries().length).toBeGreaterThan(0);
		const last = session!.agent.state.messages.at(-1);
		expect(last?.role === "assistant" && last.content.some(block => block.type === "text")).toBe(true);
	});

	it("compacts once per episode for two different argument sets", async () => {
		const state = await createSession({
			compactAfter: 1,
			responses: [
				{ content: ["warming up"] },
				repeatTurn("a-1", { a: 1 }),
				repeatTurn("a-2", { a: 1 }),
				repeatTurn("a-3", { a: 1 }),
				repeatTurn("b-1", { b: 2 }),
				repeatTurn("b-2", { b: 2 }),
				repeatTurn("b-3", { b: 2 }),
				{ content: ["done"] },
			],
		});

		await session!.prompt("Warm up");
		await session!.waitForIdle();
		await session!.prompt("Loop with two shapes");
		await session!.waitForIdle();

		expect(state.compactionStarts).toHaveLength(2);
		expect(state.notices.filter(message => message.includes("even after compacting context"))).toHaveLength(0);
	});

	it("compacts once per episode when the threshold is 1", async () => {
		// Regression: at threshold 1 the detector reports a detection on the first
		// turn of every run, so the episode flag cannot rely on the null path to
		// clear. Two identical-turn episodes must each compact once.
		const state = await createSession({
			compactAfter: 1,
			threshold: 1,
			responses: [
				{ content: ["warming up"] },
				repeatTurn("a-1", { a: 1 }),
				repeatTurn("a-2", { a: 1 }),
				repeatTurn("b-1", { b: 2 }),
				repeatTurn("b-2", { b: 2 }),
				{ content: ["done"] },
			],
		});

		await session!.prompt("Warm up");
		await session!.waitForIdle();
		await session!.prompt("Two short episodes");
		await session!.waitForIdle();

		expect(state.compactionStarts).toHaveLength(2);
		expect(state.notices.filter(message => message.includes("even after compacting context"))).toHaveLength(0);
	});

	it("does not compact when mid-turn compaction is disabled", async () => {
		const state = await createSession({
			compactAfter: 1,
			midTurnEnabled: false,
			responses: [
				{ content: ["warming up"] },
				repeatTurn("noop-1"),
				repeatTurn("noop-2"),
				repeatTurn("noop-3"),
				repeatTurn("noop-4"),
				{ content: ["stopped"] },
			],
		});

		await session!.prompt("Warm up");
		await session!.waitForIdle();
		await session!.prompt("Loop forever");
		await session!.waitForIdle();

		expect(state.compactionStarts).toHaveLength(0);
		const last = session!.agent.state.messages.at(-1);
		expect(last?.role === "assistant" && last.content.some(block => block.type === "text")).toBe(true);
	});

	it("keeps steering without aborting when compaction is disabled", async () => {
		const state = await createSession({
			compactAfter: 1,
			compactionEnabled: false,
			responses: [
				{ content: ["warming up"] },
				repeatTurn("noop-1"),
				repeatTurn("noop-2"),
				repeatTurn("noop-3"),
				repeatTurn("noop-4"),
				repeatTurn("noop-5"),
				{ content: ["stopped"] },
			],
		});

		await session!.prompt("Warm up");
		await session!.waitForIdle();
		await session!.prompt("Loop forever");
		await session!.waitForIdle();

		expect(state.compactionStarts).toHaveLength(0);
		expect(state.notices.filter(message => message.includes("even after compacting context"))).toHaveLength(0);
		const last = session!.agent.state.messages.at(-1);
		expect(last?.role === "assistant" && last.content.some(block => block.type === "text")).toBe(true);
	});
});
