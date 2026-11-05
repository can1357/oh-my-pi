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
import {
	type AssistantErrorPresentation,
	resolveAssistantErrorPresentation,
} from "@oh-my-pi/pi-tui/chat/transcript-render-helpers";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * Who owns a retry saga's pending error entries when something interrupts the saga.
 *
 * An auto-retry leaves one entry per failed attempt in the transcript and marks them when the
 * saga closes: `recovered` (the turn answered in the end) or `superseded` (a terminal error
 * replaced them). Both markers stop the entry rendering as a live error. An abort cancels the
 * retry without closing the saga, so its entries are still pending — and whether the next close
 * may claim them depends entirely on whether the interrupted turn is coming back.
 */

/** A scripted model step; `hold` answers after a delay nothing in these tests waits out. */
type Step = MockResponse | "hold";

const TRANSIENT: MockResponse = { throw: "503 upstream temporarily unavailable" };
const ANSWER: MockResponse = { content: ["done"] };

interface ErrorEntry {
	errorMessage: string | undefined;
	recovery: AssistantMessage["retryRecovery"];
	presentation: AssistantErrorPresentation;
}

interface SagaHarness {
	session: AgentSession;
	/** Resolves when the `hold` step is dispatched: the turn is in flight and not coming back. */
	held: Promise<void>;
	errorEntries(): ErrorEntry[];
	dispose(): Promise<void>;
}

async function createHarness(steps: Step[], overrides: Record<string, unknown> = {}): Promise<SagaHarness> {
	const temp = TempDir.createSync("@pi-retry-saga-");
	const auth = await AuthStorage.create(temp.join("auth.db"));
	auth.keys.setRuntime("anthropic", "test-key");
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected the bundled Anthropic test model to exist");

	const settings = Settings.isolated({
		"retry.enabled": true,
		"retry.maxRetries": 10,
		"retry.baseDelayMs": 1,
		"retry.maxDelayMs": 50,
		"retry.modelFallback": false,
		"compaction.methodOrder": ["soft"],
		"compaction.keepRecentTokens": 1,
		"contextPromotion.enabled": false,
		...overrides,
	});
	settings.setModelRole("default", `${model.provider}/${model.id}`);

	const registry = new ModelRegistry(auth, temp.join("models.yml"), { settings });
	const mock = createMockModel({ id: model.id, provider: model.provider });
	const hold = Promise.withResolvers<void>();
	let dispatched = 0;
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		streamFn: (requestedModel, context, options) => {
			const step = steps[dispatched++];
			if (step === undefined) throw new Error(`Unscripted request ${dispatched}`);
			if (step === "hold") {
				hold.resolve();
				mock.push({ content: ["never delivered"], delayMs: 60_000 });
			} else {
				mock.push(step);
			}
			return mock.stream(requestedModel, context, options);
		},
	});

	const sessionManager = SessionManager.create(temp.path(), temp.path());
	// Keep the production compaction hook boundary without compiling an extension: the summary
	// is what the tests need, not extension discovery.
	const extensionRunner = {
		initialize: () => {},
		onError: () => {},
		hasHandlers: (type: string) => type === "session_before_compact",
		emitBeforeAgentStart: async () => undefined,
		emit: async (event: { type: string; preparation?: { firstKeptEntryId: string; tokensBefore: number } }) => {
			if (event.type !== "session_before_compact" || !event.preparation) return undefined;
			return {
				compaction: {
					summary: "Compacted old history",
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
					details: {},
				},
			};
		},
	};
	const session = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry: registry,
		extensionRunner: extensionRunner as never,
	});

	return {
		session,
		held: hold.promise,
		errorEntries: () =>
			sessionManager.getBranchView().flatMap(entry => {
				if (entry.type !== "message") return [];
				const message = entry.message;
				if (message.role !== "assistant" || message.stopReason !== "error") return [];
				return [
					{
						errorMessage: message.errorMessage,
						recovery: message.retryRecovery,
						presentation: resolveAssistantErrorPresentation(message),
					},
				];
			}),
		dispose: async () => {
			await session.dispose();
			await sessionManager.close();
			auth.close();
			temp.removeSync();
		},
	};
}

describe("retry saga ownership across an interruption", () => {
	let active: SagaHarness | undefined;

	afterEach(async () => {
		const harness = active;
		active = undefined;
		await harness?.dispose();
	});

	/** Primes enough history for a manual compaction to have something to summarize. */
	async function primeContext(harness: SagaHarness): Promise<void> {
		await harness.session.prompt(`Old context: ${"reference text ".repeat(5000)}`);
		await harness.session.waitForIdle();
	}

	it("marks the errors a compaction-interrupted turn retried past once that turn answers", async () => {
		// `/compact` aborts its own turn in order to resume it. The 503 the turn already retried
		// past belongs to that turn, and the continuation's answer is what recovers it: without
		// this the user is left looking at a live error the session has in fact recovered from.
		const harness = await createHarness([ANSWER, TRANSIENT, "hold", ANSWER], {
			"compaction.enabled": true,
			"compaction.autoContinue": true,
		});
		active = harness;
		await primeContext(harness);

		const turn = harness.session.prompt("Continue the work");
		await Promise.race([
			harness.held,
			turn.then(() => {
				throw new Error("The turn ended before the compaction barrier");
			}),
		]);
		await harness.session.compact();
		await turn;
		await harness.session.waitForIdle();

		const errors = harness.errorEntries();
		expect(errors).toHaveLength(1);
		expect(errors[0]?.recovery?.status).toBe("recovered");
		expect(errors[0]?.presentation.kind).toBe("compact-recovered");
	});

	it("leaves them to nobody when the compaction will not resume the turn", async () => {
		// Same abort, opposite decision: `compaction.autoContinue: false` means nothing continues
		// the interrupted turn, so its errors are orphans. The next prompt's success must not
		// claim them — it superseded nothing, and a marker would hide a failure that still stands.
		const harness = await createHarness([ANSWER, TRANSIENT, "hold", ANSWER], {
			"compaction.enabled": true,
			"compaction.autoContinue": false,
		});
		active = harness;
		await primeContext(harness);

		const turn = harness.session.prompt("Continue the work");
		await Promise.race([
			harness.held,
			turn.then(() => {
				throw new Error("The turn ended before the compaction barrier");
			}),
		]);
		await harness.session.compact();
		await turn;
		await harness.session.waitForIdle();

		await harness.session.prompt("A new, unrelated task");
		await harness.session.waitForIdle();

		const errors = harness.errorEntries();
		expect(errors).toHaveLength(1);
		expect(errors[0]?.recovery).toBeUndefined();
		expect(errors[0]?.presentation.kind).toBe("full");
	});

	it("leaves them to nobody when the user interrupts the turn", async () => {
		// The plain abort: Esc, then a new prompt. The same saga state as a compaction's abort —
		// pending entries, a live retry attempt — and the opposite answer, because nothing
		// resumes the interrupted turn.
		const harness = await createHarness([TRANSIENT, "hold", ANSWER], { "compaction.enabled": false });
		active = harness;

		const turn = harness.session.prompt("Interrupted work");
		await Promise.race([
			harness.held,
			turn.then(() => {
				throw new Error("The turn ended before the abort barrier");
			}),
		]);
		await harness.session.abort();
		await turn;
		await harness.session.waitForIdle();

		await harness.session.prompt("A new, unrelated task");
		await harness.session.waitForIdle();

		const errors = harness.errorEntries();
		expect(errors[0]?.errorMessage).toContain("503");
		expect(errors[0]?.recovery).toBeUndefined();
		expect(errors[0]?.presentation.kind).toBe("full");
	});
});
