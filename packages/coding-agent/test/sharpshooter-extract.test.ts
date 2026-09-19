import { afterEach, describe, expect, it, vi } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { MemoryBackendStartReason } from "@oh-my-pi/pi-coding-agent/memory-backend/types";
import { startSharpshooterLeg } from "@oh-my-pi/pi-coding-agent/memory-backend/with-sharpshooter";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { releaseSharpshooterSession } from "@oh-my-pi/pi-coding-agent/sharpshooter/backend";
import {
	buildSharpshooterEnvelope,
	flushSharpshooterExtraction,
	maybeStartSharpshooterExtraction,
} from "@oh-my-pi/pi-coding-agent/sharpshooter/extract";
import { writeSharpshooterState } from "@oh-my-pi/pi-coding-agent/sharpshooter/paths";
import { listSharpshooterDeltas } from "@oh-my-pi/pi-coding-agent/sharpshooter/queue";
import { TempDir } from "@oh-my-pi/pi-utils";

function message(role: "user" | "assistant", content: unknown): AgentMessage {
	return { role, content, timestamp: Date.now() } as unknown as AgentMessage;
}

function assistantResponse(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-haiku-4-5",
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

/** The session, settings and model registry a Sharpshooter extraction runs against. */
interface ExtractionDeps {
	session: AgentSession;
	settings: Settings;
	modelRegistry: ModelRegistry;
}

function extractionDependencies(
	cwd: string,
	messages: AgentMessage[],
	sessionId = "session-extract",
	getCwd: () => string = () => cwd,
): ExtractionDeps {
	const model = getBundledModel("anthropic", "claude-haiku-4-5");
	if (!model) throw new Error("Expected bundled Claude Haiku model");
	const settings = {
		get(key: string) {
			if (key === "sharpshooter.model") return `${model.provider}/${model.id}`;
			return undefined;
		},
		getModelRole() {
			return undefined;
		},
		getCwd() {
			return cwd;
		},
		getStorage() {
			return undefined;
		},
	} as unknown as Settings;
	const modelRegistry = {
		getAll: () => [model],
		getAvailable: () => [model],
		resolver: () => async () => "test-key",
	} as unknown as ModelRegistry;
	const session = {
		isDisposed: false,
		messages,
		sessionId,
		sessionManager: { getCwd },
		subscribe: () => () => {},
	} as unknown as AgentSession;
	return { modelRegistry, session, settings };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, message: string): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (await predicate()) return;
	}
	if (!(await predicate())) throw new Error(message);
}

/**
 * Install a session's paired Sharpshooter leg the way a live toggle does. The
 * install is what fires the catch-up, so the tests that exercise it have to go
 * through the paired entry point rather than calling the extractor directly.
 * `reason` is the live distinction: `"start"` catches up on a transcript that
 * already ends in a user prompt, `"rebind"` (every cwd-move path) does not.
 */
function installPairedSharpshooter(
	deps: ExtractionDeps,
	agentDir: string,
	reason: MemoryBackendStartReason = "start",
): void {
	startSharpshooterLeg(
		{
			session: deps.session,
			settings: deps.settings,
			modelRegistry: deps.modelRegistry,
			agentDir,
			taskDepth: 0,
			reason,
		},
		"mnemopi",
	);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("buildSharpshooterEnvelope", () => {
	it("selects visible referent context, strips fenced code, and enforces caps", () => {
		const previousHuman = `nearest user \`\`\`ts\nconst secret = true;\n\`\`\` ${"p".repeat(500)}`;
		const assistantText = `nearest assistant \`\`\`sh\necho secret\n\`\`\` ${"a".repeat(900)}`;
		const messages = [
			message("user", [{ type: "text", text: "older user" }]),
			message("assistant", [{ type: "text", text: "older assistant" }]),
			message("user", [{ type: "text", text: previousHuman }]),
			message("assistant", [
				{ type: "thinking", thinking: "private chain of thought" },
				{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "hidden" } },
				{ type: "text", text: assistantText },
			]),
			message("user", [{ type: "text", text: "Keep the cyan status indicator exactly as designed." }]),
		];

		const envelope = buildSharpshooterEnvelope(messages);

		expect(envelope?.prompt).toBe("Keep the cyan status indicator exactly as designed.");
		expect(envelope?.previousHuman).toHaveLength(400);
		expect(envelope?.previousHuman).toStartWith("nearest user [code omitted]");
		expect(envelope?.previousHuman).not.toContain("const secret");
		expect(envelope?.assistantContext).toHaveLength(800);
		expect(envelope?.assistantContext).toStartWith("nearest assistant [code omitted]");
		expect(envelope?.assistantContext).not.toContain("private chain of thought");
		expect(envelope?.assistantContext).not.toContain("hidden");
	});

	it("returns no referent fields when none are available and undefined without a user prompt", () => {
		expect(
			buildSharpshooterEnvelope([
				message("user", [{ type: "text", text: "This prompt has no prior conversation." }]),
			]),
		).toEqual({ prompt: "This prompt has no prior conversation." });
		expect(
			buildSharpshooterEnvelope([message("assistant", [{ type: "text", text: "No user yet" }])]),
		).toBeUndefined();
	});
});

describe("maybeStartSharpshooterExtraction", () => {
	it("allows only one in-flight extraction for a session", async () => {
		const cwd = path.join(os.tmpdir(), "sharpshooter-in-flight-project");
		const deps = extractionDependencies(cwd, [
			message("user", [{ type: "text", text: "Keep this product behavior stable across every release." }]),
		]);
		const pending = Promise.withResolvers<AssistantMessage>();
		const completion = vi.spyOn(ai, "completeSimple").mockImplementation(() => pending.promise);

		maybeStartSharpshooterExtraction({
			agentDir: path.join(os.tmpdir(), "sharpshooter-in-flight-agent"),
			modelRegistry: deps.modelRegistry,
			session: deps.session,
			settings: deps.settings,
		});
		await waitFor(() => completion.mock.calls.length === 1, "first completion was not called");
		maybeStartSharpshooterExtraction({
			agentDir: path.join(os.tmpdir(), "sharpshooter-in-flight-agent"),
			modelRegistry: deps.modelRegistry,
			session: deps.session,
			settings: deps.settings,
		});

		expect(completion).toHaveBeenCalledTimes(1);
		pending.resolve(assistantResponse([{ type: "text", text: "No tool call." }]));
		await pending.promise;
		await Promise.resolve();
		await Promise.resolve();
	});

	it("extracts a prompt dropped while the slot was busy once the slot clears", async () => {
		using temp = TempDir.createSync("@sharpshooter-stash-");
		const root = temp.path();
		const cwd = path.join(root, "project");
		const agentDir = path.join(root, "agent");
		const messages = [
			message("user", [{ type: "text", text: "Keep this product behavior stable across every release." }]),
		];
		let currentCwd = cwd;
		const deps = extractionDependencies(cwd, messages, "session-extract", () => currentCwd);

		const pendingFirst = Promise.withResolvers<AssistantMessage>();
		const completion = vi.spyOn(ai, "completeSimple").mockImplementation(() => pendingFirst.promise);

		maybeStartSharpshooterExtraction({
			agentDir,
			modelRegistry: deps.modelRegistry,
			session: deps.session,
			settings: deps.settings,
		});
		await waitFor(() => completion.mock.calls.length === 1, "first completion was not called");

		// The destination prompt arrives while the source extraction still
		// holds the slot (the /move mid-flight case). Pre-fix it was dropped
		// outright and never extracted.
		const movedPrompt = "Record that the destination project ships on Tuesdays only.";
		const movedMessage = message("user", [{ type: "text", text: movedPrompt }]);
		messages.push(movedMessage);
		currentCwd = path.join(root, "destination");
		maybeStartSharpshooterExtraction({
			agentDir,
			message: movedMessage,
			modelRegistry: deps.modelRegistry,
			session: deps.session,
			settings: deps.settings,
		});
		expect(completion).toHaveBeenCalledTimes(1);

		// A second prompt drops after the move; the queue must retry both,
		// in drop order, instead of the newest overwriting the oldest.
		const thirdPrompt = "Note that the destination project flags flaky checkout tests.";
		const thirdMessage = message("user", [{ type: "text", text: thirdPrompt }]);
		messages.push(thirdMessage);
		maybeStartSharpshooterExtraction({
			agentDir,
			message: thirdMessage,
			modelRegistry: deps.modelRegistry,
			session: deps.session,
			settings: deps.settings,
		});
		expect(completion).toHaveBeenCalledTimes(1);

		// The source extraction clears the slot; stashed prompts must
		// extract in order.
		const pendingSecond = Promise.withResolvers<AssistantMessage>();
		const pendingThird = Promise.withResolvers<AssistantMessage>();
		const responses = [pendingFirst.promise, pendingSecond.promise, pendingThird.promise];
		let served = 0;
		completion.mockImplementation(() => responses[Math.min(served++, responses.length - 1)]);
		pendingFirst.resolve(assistantResponse([{ type: "text", text: "No tool call." }]));
		await waitFor(() => completion.mock.calls.length === 3, "stashed prompts were not extracted");
		expect(JSON.stringify(completion.mock.calls[1])).toContain(movedPrompt);
		expect(JSON.stringify(completion.mock.calls[2])).toContain(thirdPrompt);

		pendingSecond.resolve(assistantResponse([{ type: "text", text: "No tool call." }]));
		await pendingSecond.promise;
		pendingThird.resolve(assistantResponse([{ type: "text", text: "No tool call." }]));
		await pendingThird.promise;
	});

	it("files a stashed prompt's deltas to the project it was queued in, even if /move lands before the slot clears", async () => {
		using temp = TempDir.createSync("@sharpshooter-stash-move-");
		const source = path.join(temp.path(), "source");
		const destination = path.join(temp.path(), "destination");
		const agentDir = path.join(temp.path(), "agent");
		const stashedPrompt = "Keep the cyan status indicator on the source dashboard.";
		const messages = [
			message("user", [{ type: "text", text: "Keep this product behavior stable across every release." }]),
		];
		// The session's directory is live: a `/move` that lands after the drop but
		// before the slot clears must not move the stashed prompt's bank with it.
		let live = source;
		const deps = extractionDependencies(source, messages, "session-extract", () => live);

		const pendingFirst = Promise.withResolvers<AssistantMessage>();
		const pendingStashed = Promise.withResolvers<AssistantMessage>();
		const responses = [pendingFirst.promise, pendingStashed.promise];
		let served = 0;
		const completion = vi.spyOn(ai, "completeSimple").mockImplementation(() => responses[Math.min(served++, 1)]);

		maybeStartSharpshooterExtraction({
			agentDir,
			modelRegistry: deps.modelRegistry,
			session: deps.session,
			settings: deps.settings,
		});
		await waitFor(() => completion.mock.calls.length === 1, "first completion was not called");

		const stashedMessage = message("user", [{ type: "text", text: stashedPrompt }]);
		messages.push(stashedMessage);
		maybeStartSharpshooterExtraction({
			agentDir,
			message: stashedMessage,
			modelRegistry: deps.modelRegistry,
			session: deps.session,
			settings: deps.settings,
		});
		expect(completion).toHaveBeenCalledTimes(1);

		// The move lands while the slot is still held, so the retry has to file the
		// prompt in the project it was dropped in rather than the live one.
		live = destination;
		pendingFirst.resolve(assistantResponse([{ type: "text", text: "No tool call." }]));
		await waitFor(() => completion.mock.calls.length === 2, "stashed prompt was not extracted");
		expect(JSON.stringify(completion.mock.calls[1])).toContain(stashedPrompt);

		pendingStashed.resolve(
			assistantResponse([
				{
					type: "toolCall",
					id: "call-record",
					name: "record_deltas",
					arguments: {
						deltas: [
							{
								kind: "style_decision",
								statement: "Status indicator stays cyan on the source dashboard.",
								source: "explicit_user",
								evidence: "cyan status indicator",
								friction: { corrective: false, regression: false, subtle: false },
							},
						],
					},
				},
			]),
		);
		await waitFor(
			async () => (await listSharpshooterDeltas(agentDir, source)).length === 1,
			"stashed prompt's delta was not queued to the project it was dropped in",
		);
		// A decision the destination project never earned.
		expect(await listSharpshooterDeltas(agentDir, destination)).toHaveLength(0);
	});

	it("drops a stashed prompt when the session's Sharpshooter resources are released before the slot clears", async () => {
		using temp = TempDir.createSync("@sharpshooter-stash-release-");
		const cwd = path.join(temp.path(), "project");
		const agentDir = path.join(temp.path(), "agent");
		const messages = [
			message("user", [{ type: "text", text: "Keep this product behavior stable across every release." }]),
		];
		const deps = extractionDependencies(cwd, messages);

		const pendingFirst = Promise.withResolvers<AssistantMessage>();
		// A retry consumes this second response and writes the delta, so the red
		// half fails on both the call count and the bank it landed in.
		const retryResponse = Promise.resolve(
			assistantResponse([
				{
					type: "toolCall",
					id: "call-record",
					name: "record_deltas",
					arguments: {
						deltas: [
							{
								kind: "product_decision",
								statement: "This project ships on Tuesdays only.",
								source: "explicit_user",
								evidence: "ships on Tuesdays",
								friction: { corrective: false, regression: false, subtle: false },
							},
						],
					},
				},
			]),
		);
		const responses = [pendingFirst.promise, retryResponse];
		let served = 0;
		const completion = vi.spyOn(ai, "completeSimple").mockImplementation(() => responses[Math.min(served++, 1)]);

		maybeStartSharpshooterExtraction({
			agentDir,
			modelRegistry: deps.modelRegistry,
			session: deps.session,
			settings: deps.settings,
		});
		await waitFor(() => completion.mock.calls.length === 1, "first completion was not called");

		const droppedPrompt = "Record that this project ships on Tuesdays only.";
		const droppedMessage = message("user", [{ type: "text", text: droppedPrompt }]);
		messages.push(droppedMessage);
		maybeStartSharpshooterExtraction({
			agentDir,
			message: droppedMessage,
			modelRegistry: deps.modelRegistry,
			session: deps.session,
			settings: deps.settings,
		});
		expect(completion).toHaveBeenCalledTimes(1);

		// Pairing is released while the source extraction still holds the slot,
		// which is the state a `/move` into an unpaired project leaves behind.
		releaseSharpshooterSession(deps.session);

		pendingFirst.resolve(assistantResponse([{ type: "text", text: "No tool call." }]));
		// Await the real settle signals rather than a guessed delay. The first
		// flush returns once the held slot's `finally` has run, which is where a
		// retry starts (synchronously, and it rebinds the slot before returning);
		// the second covers that retry's own extraction. The bounds only keep a
		// breakage from hanging the suite.
		await flushSharpshooterExtraction(deps.session, 500);
		await flushSharpshooterExtraction(deps.session, 500);

		expect(completion).toHaveBeenCalledTimes(1);
		expect(await listSharpshooterDeltas(agentDir, cwd)).toEqual([]);
	});

	it("carries queued prompts across a paired rebind of the same session", async () => {
		using temp = TempDir.createSync("@sharpshooter-carry-rebind-");
		const source = path.join(temp.path(), "source");
		const destination = path.join(temp.path(), "destination");
		const agentDir = path.join(temp.path(), "agent");
		const carriedPrompt = "Keep the cyan status indicator on the source dashboard.";
		const messages = [
			message("user", [{ type: "text", text: "Keep this product behavior stable across every release." }]),
		];
		// The session's directory is live, so the drop below captures the source
		// project and the rebind that follows moves the session off it.
		let live = source;
		const deps = extractionDependencies(source, messages, "session-extract", () => live);
		// The rebind starts a scheduler on the source bank whose immediate tick
		// would otherwise consolidate the delta this test asserts on.
		await writeSharpshooterState(agentDir, source, { v: 1, lastConsolidatedAt: Date.now() });

		const pendingFirst = Promise.withResolvers<AssistantMessage>();
		const pendingCarried = Promise.withResolvers<AssistantMessage>();
		const responses = [pendingFirst.promise, pendingCarried.promise];
		let served = 0;
		const completion = vi.spyOn(ai, "completeSimple").mockImplementation(() => responses[Math.min(served++, 1)]);

		maybeStartSharpshooterExtraction({
			agentDir,
			modelRegistry: deps.modelRegistry,
			session: deps.session,
			settings: deps.settings,
		});
		await waitFor(() => completion.mock.calls.length === 1, "first completion was not called");

		// The prompt the rebind has to preserve arrives while the source
		// extraction still holds the slot, so it only ever reaches the queue.
		const carriedMessage = message("user", [{ type: "text", text: carriedPrompt }]);
		messages.push(carriedMessage);
		maybeStartSharpshooterExtraction({
			agentDir,
			message: carriedMessage,
			modelRegistry: deps.modelRegistry,
			session: deps.session,
			settings: deps.settings,
		});
		expect(completion).toHaveBeenCalledTimes(1);

		// The rebind lands with the slot still held and the queue non-empty, and
		// pairing stays on, so the new leg suppresses the catch-up and the queue
		// is the only thing that can carry the prompt.
		live = destination;
		installPairedSharpshooter(deps, agentDir, "rebind");

		pendingFirst.resolve(assistantResponse([{ type: "text", text: "No tool call." }]));
		await waitFor(() => completion.mock.calls.length === 2, "the carried prompt was not extracted");
		expect(JSON.stringify(completion.mock.calls[1])).toContain(carriedPrompt);

		pendingCarried.resolve(
			assistantResponse([
				{
					type: "toolCall",
					id: "call-record",
					name: "record_deltas",
					arguments: {
						deltas: [
							{
								kind: "style_decision",
								statement: "Status indicator stays cyan on the source dashboard.",
								source: "explicit_user",
								evidence: "cyan status indicator",
								friction: { corrective: false, regression: false, subtle: false },
							},
						],
					},
				},
			]),
		);
		await waitFor(
			async () => (await listSharpshooterDeltas(agentDir, source)).length === 1,
			"the carried prompt's delta was not queued to the project it was dropped in",
		);
		expect(await listSharpshooterDeltas(agentDir, destination)).toHaveLength(0);
	});

	it("still drops queued prompts when pairing is disabled", async () => {
		using temp = TempDir.createSync("@sharpshooter-carry-disabled-");
		const cwd = path.join(temp.path(), "project");
		const agentDir = path.join(temp.path(), "agent");
		const droppedPrompt = "Record that this project ships on Tuesdays only.";
		const messages: AgentMessage[] = [];
		const deps = extractionDependencies(cwd, messages);
		// The install starts a scheduler whose immediate tick would otherwise
		// consolidate the queue this test asserts on.
		await writeSharpshooterState(agentDir, cwd, { v: 1, lastConsolidatedAt: Date.now() });

		// Pairing is on with resources of its own, so the release below is the
		// resource-holding branch rather than a session that never paired.
		installPairedSharpshooter(deps, agentDir);

		const pendingFirst = Promise.withResolvers<AssistantMessage>();
		// A preserved prompt would consume this second response and write its
		// delta, so over-preserving fails on both the call count and the bank.
		const retryResponse = Promise.resolve(
			assistantResponse([
				{
					type: "toolCall",
					id: "call-record",
					name: "record_deltas",
					arguments: {
						deltas: [
							{
								kind: "product_decision",
								statement: "This project ships on Tuesdays only.",
								source: "explicit_user",
								evidence: "ships on Tuesdays",
								friction: { corrective: false, regression: false, subtle: false },
							},
						],
					},
				},
			]),
		);
		const responses = [pendingFirst.promise, retryResponse];
		let served = 0;
		const completion = vi.spyOn(ai, "completeSimple").mockImplementation(() => responses[Math.min(served++, 1)]);

		const sourceMessage = message("user", [
			{ type: "text", text: "Keep this product behavior stable across every release." },
		]);
		messages.push(sourceMessage);
		maybeStartSharpshooterExtraction({
			agentDir,
			message: sourceMessage,
			modelRegistry: deps.modelRegistry,
			session: deps.session,
			settings: deps.settings,
		});
		await waitFor(() => completion.mock.calls.length === 1, "first completion was not called");

		const droppedMessage = message("user", [{ type: "text", text: droppedPrompt }]);
		messages.push(droppedMessage);
		maybeStartSharpshooterExtraction({
			agentDir,
			message: droppedMessage,
			modelRegistry: deps.modelRegistry,
			session: deps.session,
			settings: deps.settings,
		});
		expect(completion).toHaveBeenCalledTimes(1);

		// Pairing turns off with the slot still held and the queue non-empty:
		// there is no leg to hand the queue to, so it has to be dropped.
		releaseSharpshooterSession(deps.session);

		pendingFirst.resolve(assistantResponse([{ type: "text", text: "No tool call." }]));
		await flushSharpshooterExtraction(deps.session, 500);
		await flushSharpshooterExtraction(deps.session, 500);

		expect(completion).toHaveBeenCalledTimes(1);
		expect(await listSharpshooterDeltas(agentDir, cwd)).toEqual([]);
	});

	it("queues only deltas whose evidence is a verbatim prompt substring", async () => {
		using temp = TempDir.createSync("@sharpshooter-extract-");
		const root = temp.path();
		const cwd = path.join(root, "project");
		const agentDir = path.join(root, "agent");
		const currentPrompt = "Keep the cyan status indicator and never replace it with magenta.";
		const deps = extractionDependencies(cwd, [message("user", [{ type: "text", text: currentPrompt }])]);
		vi.spyOn(ai, "completeSimple").mockResolvedValue(
			assistantResponse([
				{
					type: "toolCall",
					id: "call-record",
					name: "record_deltas",
					arguments: {
						deltas: [
							{
								kind: "style_decision",
								statement: "Status indicator uses cyan rather than magenta.",
								rejectedAlternative: "Magenta status indicator",
								rationale: "The cyan treatment is intentional.",
								source: "explicit_user",
								evidence: "cyan status indicator",
								friction: { corrective: true, regression: false, subtle: true },
							},
							{
								kind: "product_decision",
								statement: "The status indicator is always green.",
								source: "explicit_user",
								evidence: "always green",
								friction: { corrective: false, regression: false, subtle: false },
							},
						],
					},
				},
			]),
		);

		maybeStartSharpshooterExtraction({
			agentDir,
			modelRegistry: deps.modelRegistry,
			session: deps.session,
			settings: deps.settings,
		});
		await waitFor(async () => (await listSharpshooterDeltas(agentDir, cwd)).length === 1, "delta was not queued");

		const groups = await listSharpshooterDeltas(agentDir, cwd);
		expect(groups).toHaveLength(1);
		expect(groups[0]?.deltas).toHaveLength(1);
		expect(groups[0]?.deltas[0]?.delta).toEqual({
			v: 1,
			kind: "style_decision",
			statement: "Status indicator uses cyan rather than magenta.",
			rejectedAlternative: "Magenta status indicator",
			rationale: "The cyan treatment is intentional.",
			source: "explicit_user",
			evidence: "cyan status indicator",
			friction: { corrective: true, regression: false, subtle: true },
			sessionId: "session-extract",
			ts: expect.any(Number),
		});
	});

	it("queues a delta to the project whose prompt produced it, even if /move lands mid-extraction", async () => {
		using temp = TempDir.createSync("@sharpshooter-extract-move-");
		{
			const root = temp.path();
			const source = path.join(root, "source");
			const destination = path.join(root, "destination");
			const agentDir = path.join(root, "agent");
			const currentPrompt = "Keep the cyan status indicator and never replace it with magenta.";
			const deps = extractionDependencies(source, [message("user", [{ type: "text", text: currentPrompt }])]);
			// The session's directory is live, so a `/move` while the model call is
			// outstanding changes it under the extraction that is already running.
			let live = source;
			(deps.session as unknown as { sessionManager: { getCwd: () => string } }).sessionManager = {
				getCwd: () => live,
			};
			vi.spyOn(ai, "completeSimple").mockImplementation(async () => {
				live = destination;
				return assistantResponse([
					{
						type: "toolCall",
						id: "call-record",
						name: "record_deltas",
						arguments: {
							deltas: [
								{
									kind: "style_decision",
									statement: "Status indicator uses cyan rather than magenta.",
									source: "explicit_user",
									evidence: "cyan status indicator",
									friction: { corrective: true, regression: false, subtle: true },
								},
							],
						},
					},
				]);
			});

			maybeStartSharpshooterExtraction({
				agentDir,
				modelRegistry: deps.modelRegistry,
				session: deps.session,
				settings: deps.settings,
			});
			await waitFor(
				async () => (await listSharpshooterDeltas(agentDir, source)).length === 1,
				"delta was not queued to the source project",
			);

			// The decision was earned in the source project and is not a decision
			// about the destination.
			expect(await listSharpshooterDeltas(agentDir, destination)).toHaveLength(0);
		}
	});

	it("ignores a non-tool text response without writing queue files", async () => {
		using temp = TempDir.createSync("@sharpshooter-extract-text-");
		const root = temp.path();
		const cwd = path.join(root, "project");
		const agentDir = path.join(root, "agent");
		const deps = extractionDependencies(cwd, [
			message("user", [{ type: "text", text: "Preserve this product behavior exactly as it is." }]),
		]);
		const completion = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValue(assistantResponse([{ type: "text", text: "No tool call." }]));

		expect(() =>
			maybeStartSharpshooterExtraction({
				agentDir,
				modelRegistry: deps.modelRegistry,
				session: deps.session,
				settings: deps.settings,
			}),
		).not.toThrow();
		await waitFor(() => completion.mock.calls.length === 1, "completion was not called");
		await Promise.resolve();
		await Promise.resolve();

		expect(await listSharpshooterDeltas(agentDir, cwd)).toEqual([]);
	});

	it("pins the catch-up snapshot so a newer steering prompt cannot be extracted in its place", async () => {
		using temp = TempDir.createSync("@sharpshooter-catchup-pin-");
		const cwd = path.join(temp.path(), "project");
		const agentDir = path.join(temp.path(), "agent");
		const catchUpPrompt = "Keep the cyan status indicator exactly as designed on the source dashboard.";
		const steeringPrompt = "Never replace the cyan status indicator with magenta on the source dashboard.";
		const messages = [message("user", [{ type: "text", text: catchUpPrompt }])];
		const deps = extractionDependencies(cwd, messages);
		// The install starts a scheduler whose immediate tick would otherwise
		// consolidate the queue this test asserts on.
		await writeSharpshooterState(agentDir, cwd, { v: 1, lastConsolidatedAt: Date.now() });

		const pendingFirst = Promise.withResolvers<AssistantMessage>();
		const pendingCatchUp = Promise.withResolvers<AssistantMessage>();
		const responses = [pendingFirst.promise, pendingCatchUp.promise];
		let served = 0;
		const completion = vi.spyOn(ai, "completeSimple").mockImplementation(() => responses[Math.min(served++, 1)]);

		// The transcript's prompt is already extracting when the install runs, so
		// the catch-up it fires lands in the queue instead of the model.
		maybeStartSharpshooterExtraction({
			agentDir,
			modelRegistry: deps.modelRegistry,
			session: deps.session,
			settings: deps.settings,
		});
		await waitFor(() => completion.mock.calls.length === 1, "first completion was not called");
		installPairedSharpshooter(deps, agentDir);

		// A steering prompt lands while the catch-up waits for the slot. The drain
		// has to extract the prompt the install named, not whatever the transcript
		// ends with by then.
		messages.push(message("user", [{ type: "text", text: steeringPrompt }]));
		pendingFirst.resolve(assistantResponse([{ type: "text", text: "No tool call." }]));
		await waitFor(() => completion.mock.calls.length === 2, "the queued catch-up was not extracted");
		const catchUpCall = JSON.stringify(completion.mock.calls[1]);
		expect(catchUpCall).toContain(catchUpPrompt);
		expect(catchUpCall).not.toContain(steeringPrompt);

		pendingCatchUp.resolve(
			assistantResponse([
				{
					type: "toolCall",
					id: "call-record",
					name: "record_deltas",
					arguments: {
						deltas: [
							{
								kind: "style_decision",
								statement: "Status indicator stays cyan on the source dashboard.",
								source: "explicit_user",
								evidence: "cyan status indicator",
								friction: { corrective: false, regression: false, subtle: false },
							},
						],
					},
				},
			]),
		);
		await waitFor(
			async () => (await listSharpshooterDeltas(agentDir, cwd)).length === 1,
			"the catch-up's delta was not queued",
		);

		// One call for the prompt in flight and one for its pinned catch-up. The
		// steering prompt was never sent to the model, so it queued no deltas.
		expect(completion).toHaveBeenCalledTimes(2);
		const groups = await listSharpshooterDeltas(agentDir, cwd);
		expect(groups.flatMap(group => group.deltas.map(item => item.delta.statement))).toEqual([
			"Status indicator stays cyan on the source dashboard.",
		]);
	});

	it("skips a catch-up whose snapshot is already the in-flight target", async () => {
		using temp = TempDir.createSync("@sharpshooter-catchup-dedupe-");
		const cwd = path.join(temp.path(), "project");
		const agentDir = path.join(temp.path(), "agent");
		const promptMessage = message("user", [
			{ type: "text", text: "Keep the cyan status indicator exactly as designed on the source dashboard." },
		]);
		const deps = extractionDependencies(cwd, [promptMessage]);
		// The install starts a scheduler whose immediate tick would otherwise
		// consolidate the queue this test asserts on.
		await writeSharpshooterState(agentDir, cwd, { v: 1, lastConsolidatedAt: Date.now() });

		const pendingFirst = Promise.withResolvers<AssistantMessage>();
		const completion = vi.spyOn(ai, "completeSimple").mockImplementation(() => pendingFirst.promise);

		// message_start fired for this prompt, so the in-flight run owns it.
		maybeStartSharpshooterExtraction({
			agentDir,
			message: promptMessage,
			modelRegistry: deps.modelRegistry,
			session: deps.session,
			settings: deps.settings,
		});
		await waitFor(() => completion.mock.calls.length === 1, "first completion was not called");

		// The install's catch-up names the same prompt the slot is extracting, so
		// it is the same extraction and must not be queued for a second run.
		installPairedSharpshooter(deps, agentDir);

		pendingFirst.resolve(assistantResponse([{ type: "text", text: "No tool call." }]));
		// Settle the held slot, then any retry it starts, rather than guessing a
		// delay: the first flush returns once the `finally` that drains has run.
		await flushSharpshooterExtraction(deps.session, 500);
		await flushSharpshooterExtraction(deps.session, 500);

		expect(completion).toHaveBeenCalledTimes(1);
		expect(await listSharpshooterDeltas(agentDir, cwd)).toEqual([]);
	});

	it("skips catch-up for a prompt whose extraction already settled", async () => {
		using temp = TempDir.createSync("@sharpshooter-catchup-settled-");
		const cwd = path.join(temp.path(), "project");
		const agentDir = path.join(temp.path(), "agent");
		const promptMessage = message("user", [
			{ type: "text", text: "Keep the cyan status indicator exactly as designed on the source dashboard." },
		]);
		const deps = extractionDependencies(cwd, [promptMessage]);
		// The install starts a scheduler whose immediate tick would otherwise
		// consolidate the queue this test asserts on.
		await writeSharpshooterState(agentDir, cwd, { v: 1, lastConsolidatedAt: Date.now() });

		const completion = vi.spyOn(ai, "completeSimple").mockResolvedValue(
			assistantResponse([
				{
					type: "toolCall",
					id: "call-record",
					name: "record_deltas",
					arguments: {
						deltas: [
							{
								kind: "style_decision",
								statement: "Status indicator stays cyan on the source dashboard.",
								source: "explicit_user",
								evidence: "cyan status indicator",
								friction: { corrective: false, regression: false, subtle: false },
							},
						],
					},
				},
			]),
		);

		// message_start fired for this prompt, so it took the slot and enrolled.
		maybeStartSharpshooterExtraction({
			agentDir,
			message: promptMessage,
			modelRegistry: deps.modelRegistry,
			session: deps.session,
			settings: deps.settings,
		});
		await waitFor(
			async () => (await listSharpshooterDeltas(agentDir, cwd)).length === 1,
			"the prompt's delta was not queued",
		);
		// The run has settled by the time the flush returns: its `finally` clears
		// the slot before the promise resolves, so nothing is extracting now and
		// the rest of this test cannot pass on the in-flight guard.
		await flushSharpshooterExtraction(deps.session, 500);

		// A live restart re-fires the catch-up with the same prompt still last in
		// the transcript. Enrollment is the only thing left that can skip it.
		installPairedSharpshooter(deps, agentDir);

		// Settle the slot, then any run the catch-up started, rather than guessing
		// a delay: the first flush returns once the `finally` that drains has run.
		await flushSharpshooterExtraction(deps.session, 500);
		await flushSharpshooterExtraction(deps.session, 500);

		expect(completion).toHaveBeenCalledTimes(1);
		const groups = await listSharpshooterDeltas(agentDir, cwd);
		expect(groups.flatMap(group => group.deltas.map(item => item.delta.statement))).toEqual([
			"Status indicator stays cyan on the source dashboard.",
		]);
	});
});
