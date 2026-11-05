import { afterEach, describe, expect, it } from "bun:test";
import { Agent, filterProviderReplayMessages } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Message } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * Where a provider refusal ends the turn, and which refusals deserve that.
 *
 * Both `cyber_policy` and `reasoning_extraction` are categories the classifier's verdict is
 * unstable for, so each earns the bounded same-model allowance `retry.refusalRetries` and the
 * turn continues when a resend clears. Neither ever rotates credentials. A classifier refusal
 * carrying any other category is never resent on the same model and walks `retry.fallbackChains`
 * only.
 *
 * These tests measure what the product does rather than what the code reads like, because this
 * area has repeatedly turned out to behave differently from how it reads.
 */

const REASONING_EXTRACTION_MESSAGE =
	"This request was blocked as it seems to violate Anthropic's Terms of Service restrictions on reverse engineering or duplicating model outputs";

function refusal(category: string, message: string): MockResponse {
	return {
		content: [],
		stopReason: "error",
		errorMessage: message,
		stopDetails: { type: "refusal", category, explanation: message },
	};
}

interface RoutingHarness {
	session: AgentSession;
	/** One entry per model call the session made, in order. */
	calls(): number;
	messages(): AssistantMessage[];
	entries(): string[];
	dispose(): Promise<void>;
}

async function createHarness(steps: MockResponse[], overrides: Record<string, unknown> = {}): Promise<RoutingHarness> {
	const temp = TempDir.createSync("@pi-refusal-routing-");
	const auth = await AuthStorage.create(temp.join("auth.db"));
	auth.keys.setRuntime("anthropic", "test-key");
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected the bundled Anthropic test model to exist");

	const settings = Settings.isolated({
		"retry.enabled": true,
		"retry.maxRetries": 4,
		"retry.baseDelayMs": 1,
		"retry.maxDelayMs": 50,
		"retry.modelFallback": false,
		"compaction.enabled": false,
		"contextPromotion.enabled": false,
		...overrides,
	});
	settings.setModelRole("default", `${model.provider}/${model.id}`);

	const registry = new ModelRegistry(auth, temp.join("models.yml"), { settings });
	const mock = createMockModel({ id: model.id, provider: model.provider });
	let dispatched = 0;
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		streamFn: (requestedModel, context, options) => {
			const step = steps[Math.min(dispatched, steps.length - 1)];
			dispatched++;
			mock.push(step);
			return mock.stream(requestedModel, context, options);
		},
	});

	const sessionManager = SessionManager.create(temp.path(), temp.path());
	const session = new AgentSession({ agent, sessionManager, settings, modelRegistry: registry });

	return {
		session,
		calls: () => dispatched,
		messages: () =>
			sessionManager.getBranchView().flatMap(entry => {
				if (entry.type !== "message") return [];
				return entry.message.role === "assistant" ? [entry.message] : [];
			}),
		entries: () =>
			sessionManager
				.getBranchView()
				.map(entry =>
					entry.type === "message"
						? `message/${entry.message.role}/${(entry.message as { stopReason?: string }).stopReason ?? "-"}`
						: entry.type,
				),
		dispose: async () => {
			await session.dispose();
			await sessionManager.close();
			auth.close();
			temp.removeSync();
		},
	};
}

describe("which refusals the session resends, and whether the turn continues", () => {
	let active: RoutingHarness | undefined;

	afterEach(async () => {
		const harness = active;
		active = undefined;
		await harness?.dispose();
	});

	// Both categories are probabilistic classifier verdicts that a cold call can clear, so both
	// earn the bounded same-model allowance and the turn must survive them. `reasoning_extraction`
	// is the one that matters most: it is a false flag on legitimate reasoning replay, and ending
	// the turn on it strands work the next call would have completed.
	it.each([
		{ category: "reasoning_extraction", message: REASONING_EXTRACTION_MESSAGE },
		{ category: "cyber_policy", message: "declined" },
	])("resends a $category refusal and the turn completes", async ({ category, message }) => {
		const harness = await createHarness([refusal(category, message), { content: ["recovered"] }], {
			"retry.refusalRetries": 3,
		});
		active = harness;

		await harness.session.prompt("A request the provider declines");
		await harness.session.waitForIdle();

		expect(harness.calls()).toBe(2);
		const assistant = harness.messages();
		expect(assistant).toHaveLength(2);
		expect(assistant[0]?.stopDetails).toEqual({ type: "refusal", category, explanation: message });
		expect(assistant.at(-1)?.stopReason).toBe("stop");
		expect(assistant.at(-1)?.content.some(block => block.type === "text" && block.text === "recovered")).toBe(true);
	});

	// The red control for the row above: the allowance is what resends, so setting it to zero must
	// end the turn. Without this the assertions above would pass against a session that resent for
	// some other reason.
	it.each([{ category: "reasoning_extraction" }, { category: "cyber_policy" }])(
		"makes one call and ends the turn on a $category refusal when the allowance is zero",
		async ({ category }) => {
			const harness = await createHarness([refusal(category, "declined"), { content: ["recovered"] }], {
				"retry.refusalRetries": 0,
			});
			active = harness;

			await harness.session.prompt("A request the provider declines");
			await harness.session.waitForIdle();

			expect(harness.calls()).toBe(1);
			// And the user must still SEE the refusal: a turn that ends with nothing but the
			// user's own message in the branch — no error, no reason — is what makes a refusal
			// look like the session stopping for no reason.
			expect(harness.entries()).toEqual(["message/user/-", "message/assistant/error"]);
			const refused = harness.messages().at(-1);
			expect(refused?.stopDetails).toEqual({ type: "refusal", category, explanation: "declined" });
		},
	);
});

/**
 * Reload safety for the turn a refusal ends.
 *
 * That turn is persisted into the session JSONL so a resumed session still shows why it stopped.
 * Persisting it is only safe because replay drops it again, and three independent guards do:
 * `buildSessionContext` skips the empty errored turn, then sweeps every error/abort assistant
 * turn out of the rebuilt context, and `filterProviderReplayMessages` drops API-level refusals
 * from the wire. This test is the one that notices if all of them stop covering this case — it
 * measures the wire, so it does not care which of them is doing the work.
 *
 * The failure this guards: resume a session whose last turn was refused, and the very first
 * request of the new process carries the refusal, so the provider refuses again, forever.
 */
describe("a refusal persisted in the session file never returns to the provider on reload", () => {
	/** One process: open the file, prompt once, return after everything is flushed and closed. */
	async function runProcess(options: {
		manager: SessionManager;
		settings: Settings;
		registry: ModelRegistry;
		steps: MockResponse[];
		prompt: string;
		requests: Message[][];
	}): Promise<void> {
		const { manager, settings, registry, steps, prompt, requests } = options;
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected the bundled Anthropic test model to exist");
		const mock = createMockModel({ id: model.id, provider: model.provider });
		let dispatched = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				// The resume path: history comes from the persisted entries, not from a live object.
				messages: manager.buildSessionContext().messages,
			},
			// The production composition from `createAgentSession` (`convertToLlmFinal` in sdk.ts).
			convertToLlm: messages => filterProviderReplayMessages(convertToLlm(messages)),
			streamFn: (requestedModel, context, streamOptions) => {
				// What the provider is handed, captured at the transport boundary.
				requests.push(structuredClone(context.messages));
				const step = steps[Math.min(dispatched, steps.length - 1)];
				dispatched++;
				mock.push(step);
				return mock.stream(requestedModel, context, streamOptions);
			},
		});
		const session = new AgentSession({ agent, sessionManager: manager, settings, modelRegistry: registry });
		try {
			await session.prompt(prompt);
			await session.waitForIdle();
			await manager.flush();
		} finally {
			await session.dispose();
			await manager.close();
		}
	}

	// Two different routes to a persisted refusal, both driven by this row's `retry.refusalRetries`:
	// `reasoning_extraction` at `1` spends its allowance and persists the last of two refusals,
	// `cyber_policy` at `0` persists the first. Both leave the same poison on disk, so both must be
	// dropped on reload.
	it.each([
		{
			category: "reasoning_extraction",
			explanation: REASONING_EXTRACTION_MESSAGE,
			refusalRetries: 1,
			refusalsBeforeGivingUp: 2,
		},
		{
			category: "cyber_policy",
			explanation: "Blocked by the account's cyber policy",
			refusalRetries: 0,
			refusalsBeforeGivingUp: 1,
		},
	])(
		"drops a persisted $category refusal from the resumed request",
		async ({ category, explanation, refusalRetries, refusalsBeforeGivingUp }) => {
			const refusedPrompt = "Walk me through the whole chain";
			const temp = TempDir.createSync("@pi-refusal-reload-");
			const auth = await AuthStorage.create(temp.join("auth.db"));
			try {
				auth.keys.setRuntime("anthropic", "test-key");
				const model = getBundledModel("anthropic", "claude-sonnet-4-5");
				if (!model) throw new Error("Expected the bundled Anthropic test model to exist");
				const settings = Settings.isolated({
					"retry.enabled": true,
					"retry.maxRetries": 4,
					"retry.baseDelayMs": 1,
					"retry.maxDelayMs": 50,
					"retry.modelFallback": false,
					"retry.refusalRetries": refusalRetries,
					"compaction.enabled": false,
					"contextPromotion.enabled": false,
				});
				settings.setModelRole("default", `${model.provider}/${model.id}`);
				const registry = new ModelRegistry(auth, temp.join("models.yml"), { settings });
				const sessionDir = temp.join("sessions");
				const requests: Message[][] = [];

				// First process: the provider refuses until the turn ends, and the turn is persisted.
				const first = SessionManager.create(temp.path(), sessionDir);
				const sessionFile = first.getSessionFile();
				if (!sessionFile) throw new Error("Expected a persisted session file");
				await runProcess({
					manager: first,
					settings,
					registry,
					steps: Array.from({ length: refusalsBeforeGivingUp }, () => refusal(category, explanation)),
					prompt: refusedPrompt,
					requests,
				});
				expect(requests).toHaveLength(refusalsBeforeGivingUp);

				// The refusal is really on disk. Without this the reload assertions below could pass
				// simply because nothing was ever written.
				const persisted = Bun.JSONL.parse(await Bun.file(sessionFile).text()) as Array<{
					type: string;
					message?: AssistantMessage;
				}>;
				const persistedAssistants = persisted.flatMap(entry =>
					entry.type === "message" && entry.message?.role === "assistant" ? [entry.message] : [],
				);
				// Every refused attempt is written out, the last one being the turn's terminal refusal.
				expect(persistedAssistants).toHaveLength(refusalsBeforeGivingUp);
				expect(persistedAssistants.map(message => message.stopReason)).toEqual(
					persistedAssistants.map(() => "error"),
				);
				expect(persistedAssistants.at(-1)?.stopDetails).toEqual({ type: "refusal", category, explanation });

				// Second process: resume from that file and send one more prompt.
				const resumePrompt = "Never mind, say hello";
				await runProcess({
					manager: await SessionManager.open(sessionFile, sessionDir),
					settings,
					registry,
					steps: [{ content: ["recovered"] }],
					prompt: resumePrompt,
					requests,
				});

				// Exactly one more request, and it is the resumed one: without this the assertions
				// below could all be satisfied by a request the FIRST process sent.
				expect(requests).toHaveLength(refusalsBeforeGivingUp + 1);
				const resumed = requests[refusalsBeforeGivingUp];
				if (!resumed) throw new Error("Expected the resumed process to send a request");
				const wire = JSON.stringify(resumed);
				expect(wire).toContain(resumePrompt);
				// The session really did resume: the earlier user turn is on the wire...
				expect(wire).toContain(refusedPrompt);
				// ...but the refusal that followed it is not, in any shape.
				expect(resumed.filter(message => message.role === "assistant")).toEqual([]);
				expect(wire).not.toContain(explanation);
				expect(wire).not.toContain(category);
			} finally {
				auth.close();
				temp.removeSync();
			}
		},
	);
});
