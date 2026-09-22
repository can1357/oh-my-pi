/**
 * Contract: a message typed while the provider is still thinking — the request
 * is open but has streamed nothing — is never silently parked.
 *
 *  1. The session acknowledges the queue immediately with a `notice` event
 *     (rendered as a status line in interactive mode).
 *  2. The agent loop cancels the output-less request, folds the steer in and
 *     re-issues the model call, so the user's correction reaches the model that
 *     turn instead of after it.
 *  3. Because nothing streamed, no `stopReason: "aborted"` assistant message is
 *     persisted: the transcript shows one answer, not an aborted stub plus a
 *     retry.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

describe("AgentSession steering during the provider wait", () => {
	let tempDir: string;
	let fixtureDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession;

	beforeAll(async () => {
		fixtureDir = path.join(os.tmpdir(), `pi-steer-wait-fixture-${Snowflake.next()}`);
		fs.mkdirSync(fixtureDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(fixtureDir, "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(fixtureDir, "models.yml"));
	});

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-steer-wait-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		await session?.dispose();
		removeSyncWithRetries(tempDir);
	});

	afterAll(() => {
		authStorage.close();
		removeSyncWithRetries(fixtureDir);
	});

	async function createSession(responses: MockResponse[]): Promise<{ session: AgentSession; mock: MockModel }> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ responses });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
		return { session, mock };
	}

	/** Resolves once the run has started and the first request is in flight. */
	function firstRequestInFlight(target: AgentSession, mock: MockModel): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		const unsubscribe = target.subscribe(event => {
			if (event.type !== "message_end" || event.message.role !== "user") return;
			if (mock.calls.length === 0) return;
			unsubscribe();
			resolve();
		});
		return promise;
	}

	it("notices the queue and re-issues the output-less request with the steer", async () => {
		// The first response never streams anything before the steer lands: a
		// provider still thinking, or retrying its own request with backoff.
		const { session, mock } = await createSession([
			{ content: ["stale answer"], delayMs: 10_000 },
			{ content: ["answer with the correction"] },
		]);

		const notices: string[] = [];
		session.subscribe(event => {
			if (event.type === "notice") notices.push(event.message);
		});

		const inFlight = firstRequestInFlight(session, mock);
		const run = session.prompt("hello");
		await inFlight;

		await session.steer("actually, do X instead");
		await run;
		await session.waitForIdle();

		expect(notices).toContain("Queued — will apply after the current response");
		// Two calls: the cancelled one and its replacement, which carries the steer.
		expect(mock.calls.length).toBe(2);
		expect(
			mock.calls[1]?.context.messages.some(
				message =>
					message.role === "user" &&
					(typeof message.content === "string"
						? message.content
						: message.content.map(part => (part.type === "text" ? part.text : "")).join("")
					).includes("actually, do X instead"),
			),
		).toBe(true);

		// One committed turn, and it is the answer — not an aborted stub plus a retry.
		const assistants = session.agent.state.messages.filter(message => message.role === "assistant");
		expect(assistants.length).toBe(1);
		expect(assistants[0]?.stopReason).not.toBe("aborted");
		expect(session.agent.hasQueuedMessages()).toBe(false);
	});
});
