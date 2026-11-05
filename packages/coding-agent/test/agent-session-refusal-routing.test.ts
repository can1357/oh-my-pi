import { afterEach, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * Where a provider refusal ends the turn, and which refusals deserve that.
 *
 * The two categories want opposite handling. A `cyber_policy` refusal is a real account-policy
 * block: every sibling credential sees the same content, so resending wastes calls and the turn
 * should end. A `reasoning_extraction` refusal is a false flag on legitimate reasoning replay that
 * a fresh call almost always clears, so the session must retry and keep going.
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
			// And the user must still SEE the refusal. An ended turn used to leave the branch
			// holding nothing but the user's own message — no error, no reason, nothing — which
			// is what makes a refusal look like the session stopping for no reason.
			expect(harness.entries()).toEqual(["message/user/-", "message/assistant/error"]);
			const refused = harness.messages().at(-1);
			expect(refused?.stopDetails).toEqual({ type: "refusal", category, explanation: "declined" });
		},
	);
});
