import { afterEach, describe, expect, it } from "bun:test";
import type { Api, Context, Model, ModelSpec } from "@oh-my-pi/pi-ai";
import { clearCustomApis, registerCustomApi } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession, type ExtensionFactory } from "@oh-my-pi/pi-coding-agent/sdk";
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

	it("keeps each request a prefix of the next across --continue and an agent-started turn", async () => {
		using tempDir = TempDir.createSync("@pi-before-agent-start-resume-");
		const api = "test-before-agent-start-resume";
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
			id: "before-agent-start-resume",
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
		const sessionDir = tempDir.join("sessions");
		// Each process builds a new session over the transcript; a subagent session makes no side requests.
		const open = (sessionManager: SessionManager) =>
			createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				sessionManager,
				authStorage,
				modelRegistry,
				settings: Settings.isolated({ "compaction.enabled": false }),
				model,
				disableExtensionDiscovery: true,
				extensions: [addsGuidelines],
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

		try {
			const { session: first } = await open(SessionManager.create(tempDir.path(), sessionDir));
			const sessionFile = first.sessionManager.getSessionFile();
			await first.prompt("first");
			await first.waitForIdle();
			await first.dispose();

			const continued = await SessionManager.continueRecent(tempDir.path(), sessionDir);
			expect(continued.getSessionFile()).toBe(sessionFile);
			const { session: resumed } = await open(continued);
			sessions.push(resumed);
			await resumed.sendCustomMessage(
				{ customType: "card", content: "A card for you.", display: true, attribution: "agent" },
				{ deliverAs: "aside", triggerTurn: true },
			);
			await resumed.waitForIdle();
			await resumed.prompt("second");
			await resumed.waitForIdle();

			expect(requests).toHaveLength(3);
			expect(requests[0]).toContain(JSON.stringify(["system", GUIDELINES]));
			for (let index = 1; index < requests.length; index++) {
				const previous = requests[index - 1]!;
				expect(requests[index]!.slice(0, previous.length)).toEqual(previous);
			}
		} finally {
			authStorage.close();
		}
	});
});
