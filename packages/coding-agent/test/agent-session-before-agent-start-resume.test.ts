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

// Contract: with `extensionHandlers.keepSystemPromptOverride` on, a system prompt `before_agent_start` returns governs
// every later request while its base is unchanged, whether the turn ran the hook or not. A turn an agent starts (a
// card handed to an idle session) does not run it, and a session resumed with `--continue` rebuilds its base prompt
// alone; when either dropped the block, the provider's cached prefix ended at the system prompt and every request
// re-sent the whole conversation uncached. With the setting off (the default), the hook prompt governs only its turn.

const KEEP = { "extensionHandlers.keepSystemPromptOverride": true };

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

/** Returns a new prompt on each turn: `Policy 1.`, `Policy 2.`, … */
const numbersPolicies: ExtensionFactory = pi => {
	let turn = 0;
	pi.on("before_agent_start", () => ({ systemPrompt: [`Policy ${++turn}.`] }));
};

/** Keeps one array, adds a block to it on each turn and returns that same array. */
const editsItsOwnArray: ExtensionFactory = pi => {
	const blocks: string[] = [];
	pi.on("before_agent_start", () => {
		blocks.push(`Policy for turn ${blocks.length + 1}.`);
		return { systemPrompt: blocks };
	});
};

/** A request as the provider reads it, one item per system block, then one per message. */
function wire(context: Context): string[] {
	return [
		...(context.systemPrompt ?? []).map(block => JSON.stringify(["system", block])),
		...context.messages.map(message => JSON.stringify([message.role, message.content])),
	];
}

const systemBlock = (text: string): string => JSON.stringify(["system", text]);

/** The system blocks of a recorded request. */
const systemOf = (request: string[]): string[] => request.filter(item => item.startsWith('["system",'));

function expectAppendOnly(requests: string[][]): void {
	for (let index = 1; index < requests.length; index++) {
		const previous = requests[index - 1]!;
		expect(requests[index]!.slice(0, previous.length)).toEqual(previous);
	}
}

/** The prompts the session holds `system-prompt-override` records of, oldest first. */
function overrideRecords(session: AgentSession): Array<{ base: unknown; prompt: unknown }> {
	return session.sessionManager
		.getEntries()
		.flatMap(entry =>
			entry.type === "custom" && entry.customType === "system-prompt-override"
				? [entry.data as { base: unknown; prompt: unknown }]
				: [],
		);
}

describe("before_agent_start system prompt across turn kinds", () => {
	/** Everything a test opened, released after it in reverse order: sessions, then auth stores and directories. */
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		clearCustomApis();
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	});

	/**
	 * A provider that records each request, and `open`, which builds a session over a transcript as each process
	 * does, with `extension`, `settings` and, when given, a base prompt read at every rebuild. Every session it opens
	 * is disposed after the test, whatever the test did with it. A subagent session makes no side requests.
	 */
	async function harness(api: string) {
		const tempDir = TempDir.createSync(`@pi-${api}-`);
		cleanups.push(() => tempDir.removeSync());
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
		cleanups.push(() => authStorage.close());
		authStorage.keys.setRuntime(model.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const sessionDir = tempDir.join("sessions");
		const open = async (
			sessionManager: SessionManager,
			extension: ExtensionFactory,
			options: { settings?: Record<string, unknown>; base?: () => string } = {},
		): Promise<AgentSession> => {
			const { base } = options;
			const { session } = await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				sessionManager,
				authStorage,
				modelRegistry,
				settings: Settings.isolated({ "compaction.enabled": false, ...options.settings }),
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
			cleanups.push(() => session.dispose());
			return session;
		};
		return {
			requests,
			open,
			create: () => SessionManager.create(tempDir.path(), sessionDir),
			continueRecent: () => SessionManager.continueRecent(tempDir.path(), sessionDir),
		};
	}

	/** Hands the idle session a card, as a peer's message reaches it, and waits for the turn it starts. */
	async function deliverCard(session: AgentSession): Promise<void> {
		await session.sendCustomMessage(
			{ customType: "card", content: "A card for you.", display: true, attribution: "agent" },
			{ deliverAs: "aside", triggerTurn: true },
		);
		await session.waitForIdle();
	}

	async function userTurn(session: AgentSession, text: string): Promise<void> {
		await session.prompt(text);
		await session.waitForIdle();
	}

	it("keeps each request a prefix of the next across --continue and an agent-started turn", async () => {
		const { requests, open, create, continueRecent } = await harness("test-before-agent-start-resume");
		const first = await open(create(), addsGuidelines, { settings: KEEP });
		const sessionFile = first.sessionManager.getSessionFile();
		await userTurn(first, "first");
		await first.dispose();

		const continued = await continueRecent();
		expect(continued.getSessionFile()).toBe(sessionFile);
		const resumed = await open(continued, addsGuidelines, { settings: KEEP });
		await deliverCard(resumed);
		await userTurn(resumed, "second");

		expect(requests).toHaveLength(3);
		expect(requests[0]).toContain(systemBlock(GUIDELINES));
		expectAppendOnly(requests);
	});

	it("drops the hook prompt after its turn and records no override with the setting off", async () => {
		const { requests, open, create, continueRecent } = await harness("test-before-agent-start-off");
		const first = await open(create(), addsGuidelines);
		await userTurn(first, "first");
		await first.dispose();

		const resumed = await open(await continueRecent(), addsGuidelines);
		await deliverCard(resumed);
		await userTurn(resumed, "second");

		expect(requests).toHaveLength(3);
		expect(requests[0]).toContain(systemBlock(GUIDELINES));
		// The card's turn runs no hook, and the resumed process sends its base alone.
		expect(requests[1]).not.toContain(systemBlock(GUIDELINES));
		expect(requests[2]).toContain(systemBlock(GUIDELINES));
		expect(overrideRecords(resumed)).toEqual([]);
	});

	it("restores a hook prompt sent again on a changed base after --continue", async () => {
		const { requests, open, create, continueRecent } = await harness("test-before-agent-start-rebased");
		let base = "First base.";
		const options = { settings: KEEP, base: () => base };
		const first = await open(create(), replacesPrompt, options);
		await userTurn(first, "first");
		// The base changes between turns; the next user turn's hook returns the same prompt on it.
		base = "Second base.";
		await first.refreshBaseSystemPrompt();
		await userTurn(first, "second");
		await first.dispose();

		const resumed = await open(await continueRecent(), replacesPrompt, options);
		await deliverCard(resumed);

		expect(requests).toHaveLength(3);
		expect(requests[2]).toContain(systemBlock(FIXED_PROMPT));
		expectAppendOnly(requests);
	});

	it("sends the bare base after a base change no hook has seen, then records the next hook prompt on it", async () => {
		const { requests, open, create, continueRecent } = await harness("test-before-agent-start-unseen-base");
		let base = "First base.";
		const options = { settings: KEEP, base: () => base };
		const first = await open(create(), addsGuidelines, options);
		await userTurn(first, "first");
		await first.dispose();

		base = "Second base.";
		const resumed = await open(await continueRecent(), addsGuidelines, options);
		await deliverCard(resumed);
		await userTurn(resumed, "second");

		expect(requests).toHaveLength(3);
		expect(systemOf(requests[1]!)).toEqual([systemBlock("Second base.")]);
		expect(systemOf(requests[2]!)).toEqual([systemBlock("Second base."), systemBlock(GUIDELINES)]);
		const records = overrideRecords(resumed);
		expect(records.map(record => record.prompt)).toEqual([
			["First base.", GUIDELINES],
			["Second base.", GUIDELINES],
		]);
		expect(records[1]!.base).not.toEqual(records[0]!.base);
	});

	it("records the blocks a handler edits in its own array", async () => {
		const { requests, open, create, continueRecent } = await harness("test-before-agent-start-edited-array");
		const first = await open(create(), editsItsOwnArray, { settings: KEEP });
		await userTurn(first, "first");
		await userTurn(first, "second");
		await first.dispose();

		const resumed = await open(await continueRecent(), editsItsOwnArray, { settings: KEEP });
		await deliverCard(resumed);

		expect(requests).toHaveLength(3);
		expect(systemOf(requests[1]!)).toEqual([systemBlock("Policy for turn 1."), systemBlock("Policy for turn 2.")]);
		expectAppendOnly(requests.slice(1));
	});

	it("sends the hook prompt of the branch /tree moved to on a turn that runs no hook", async () => {
		const { requests, open, create } = await harness("test-before-agent-start-tree");
		const session = await open(create(), numbersPolicies, { settings: KEEP });
		await userTurn(session, "first");
		const firstReply = session.sessionManager
			.getEntries()
			.find(entry => entry.type === "message" && entry.message.role === "assistant");
		if (!firstReply) throw new Error("the first turn persisted no reply");
		await userTurn(session, "second");

		await session.navigateTree(firstReply.id);
		await deliverCard(session);

		expect(requests).toHaveLength(3);
		expect(systemOf(requests[1]!)).toEqual([systemBlock("Policy 2.")]);
		expect(systemOf(requests[2]!)).toEqual([systemBlock("Policy 1.")]);
		expectAppendOnly([requests[0]!, requests[2]!]);
	});
});
