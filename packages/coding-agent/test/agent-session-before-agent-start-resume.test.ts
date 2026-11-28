import { afterEach, describe, expect, it } from "bun:test";
import type { Api, Context, Model, ModelSpec } from "@oh-my-pi/pi-ai";
import { clearCustomApis, registerCustomApi } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession, type ExtensionFactory } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

// Contract: a system prompt `before_agent_start` returns governs every later request while its base is unchanged,
// whether the turn ran the hook or not. A turn an agent starts (a card handed to an idle session) does not run it,
// and a session resumed with `--continue` rebuilds its base prompt alone; when either dropped the block, the
// provider's cached prefix ended at the system prompt and every request re-sent the whole conversation uncached.

const GUIDELINES = "Use `probe` for code questions.";

/** Appends a system block unless the prompt already holds it, as a tool's guidance plugin does. */
const addsGuidelines: ExtensionFactory = pi => {
	pi.on("before_agent_start", event =>
		event.systemPrompt.includes(GUIDELINES) ? undefined : { systemPrompt: [...event.systemPrompt, GUIDELINES] },
	);
};

const FIXED_PROMPT = "You answer from the project's own documentation.";

/** Replaces the system prompt with one that does not depend on the base. */
const replacesPrompt: ExtensionFactory = pi => {
	pi.on("before_agent_start", () => ({ systemPrompt: [FIXED_PROMPT] }));
};

/** A request as the provider reads it, one item per system block, then one per message. */
function wire(context: Context): string[] {
	return [
		...(context.systemPrompt ?? []).map(block => JSON.stringify(["system", block])),
		...context.messages.map(message => JSON.stringify([message.role, message.content])),
	];
}

describe("before_agent_start system prompt across turn kinds", () => {
	const sessions: Array<{ dispose(): Promise<void> }> = [];

	afterEach(async () => {
		clearCustomApis();
		for (const session of sessions.splice(0)) {
			await session.dispose();
		}
	});

	/**
	 * A provider that records each request, and `open`, which builds a session over a transcript as each process
	 * does, with `extension` and, when given, a base prompt read at every rebuild. A subagent session makes no side
	 * requests.
	 */
	async function harness(tempDir: TempDir, api: string) {
		const requests: string[][] = [];
		registerCustomApi(api, (_model, context) => {
			requests.push(wire(context));
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "done", reason: "stop", message: createAssistantMessage("ok") });
			});
			return stream;
		});
		const model = buildModel({
			id: api,
			name: "Before agent start resume",
			api,
			provider: "managed-primary",
			baseUrl: "https://api.example.com/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		} as ModelSpec<Api>) as Model<Api>;
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.keys.setRuntime(model.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const open = (sessionManager: SessionManager, extension: ExtensionFactory, base?: () => string) =>
			createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				sessionManager,
				authStorage,
				modelRegistry,
				settings: Settings.isolated({ "compaction.enabled": false }),
				model,
				...(base && { systemPrompt: () => [base()] }),
				disableExtensionDiscovery: true,
				extensions: [extension],
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
				taskDepth: 1,
				agentId: "SubAgent",
			});
		return { requests, authStorage, open, sessionDir: tempDir.join("sessions") };
	}

	/** Hands the idle session a card, as a peer's message reaches it, and waits for the turn it starts. */
	async function deliverCard(session: AgentSession): Promise<void> {
		await session.sendCustomMessage(
			{ customType: "card", content: "A card for you.", display: true, attribution: "agent" },
			{ deliverAs: "aside", triggerTurn: true },
		);
		await session.waitForIdle();
	}

	function expectAppendOnly(requests: string[][]): void {
		for (let index = 1; index < requests.length; index++) {
			const previous = requests[index - 1]!;
			expect(requests[index]!.slice(0, previous.length)).toEqual(previous);
		}
	}

	it("keeps each request a prefix of the next across --continue and an agent-started turn", async () => {
		using tempDir = TempDir.createSync("@pi-before-agent-start-resume-");
		const { requests, authStorage, open, sessionDir } = await harness(tempDir, "test-before-agent-start-resume");
		try {
			const { session: first } = await open(SessionManager.create(tempDir.path(), sessionDir), addsGuidelines);
			const sessionFile = first.sessionManager.getSessionFile();
			await first.prompt("first");
			await first.waitForIdle();
			await first.dispose();

			const continued = await SessionManager.continueRecent(tempDir.path(), sessionDir);
			expect(continued.getSessionFile()).toBe(sessionFile);
			const { session: resumed } = await open(continued, addsGuidelines);
			sessions.push(resumed);
			await deliverCard(resumed);
			await resumed.prompt("second");
			await resumed.waitForIdle();

			expect(requests).toHaveLength(3);
			expect(requests[0]).toContain(JSON.stringify(["system", GUIDELINES]));
			expectAppendOnly(requests);
		} finally {
			authStorage.close();
		}
	});

	it("restores a hook prompt sent again on a changed base after --continue", async () => {
		using tempDir = TempDir.createSync("@pi-before-agent-start-rebased-");
		const { requests, authStorage, open, sessionDir } = await harness(tempDir, "test-before-agent-start-rebased");
		let base = "First base.";
		try {
			const { session: first } = await open(
				SessionManager.create(tempDir.path(), sessionDir),
				replacesPrompt,
				() => base,
			);
			await first.prompt("first");
			await first.waitForIdle();
			// The base changes between turns; the next user turn's hook returns the same prompt on it.
			base = "Second base.";
			await first.refreshBaseSystemPrompt();
			await first.prompt("second");
			await first.waitForIdle();
			await first.dispose();

			const { session: resumed } = await open(
				await SessionManager.continueRecent(tempDir.path(), sessionDir),
				replacesPrompt,
				() => base,
			);
			sessions.push(resumed);
			await deliverCard(resumed);

			expect(requests).toHaveLength(3);
			expect(requests[2]).toContain(JSON.stringify(["system", FIXED_PROMPT]));
			expectAppendOnly(requests);
		} finally {
			authStorage.close();
		}
	});
});
