import { afterEach, describe, expect, it, vi } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
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
	overrides: Record<string, unknown> = {},
): ExtractionDeps {
	const model = getBundledModel("anthropic", "claude-haiku-4-5");
	if (!model) throw new Error("Expected bundled Claude Haiku model");
	const settings = Settings.isolated({ "sharpshooter.model": `${model.provider}/${model.id}`, ...overrides });
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
