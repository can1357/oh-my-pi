import { afterAll, describe, expect, it } from "bun:test";
import type { Api, Model, ModelSpec } from "@oh-my-pi/pi-ai";
import { clearCustomApis, registerCustomApi } from "@oh-my-pi/pi-ai";
import { redactSensitiveCredentials } from "@oh-my-pi/pi-ai/providers/transform-messages";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { bindEffects } from "@oh-my-pi/pi-coding-agent/config/registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAcpSessionFactory } from "@oh-my-pi/pi-coding-agent/main";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage, createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const authStorage = createInMemoryAuthStorage();
const modelRegistry = new ModelRegistry(authStorage);
const GITHUB_TOKEN = "ghp_AbCd1234EfGh5678IjKl9012MnOp3456QrSt";
const API = "test-acp-session-redaction";
const model = buildModel({
	id: "acp-session-redaction",
	name: "ACP session redaction",
	api: API,
	provider: "managed-primary",
	baseUrl: "http://127.0.0.1:8080/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32_768,
	maxTokens: 1024,
} as ModelSpec<Api>) as Model<Api>;
authStorage.keys.setRuntime(model.provider, "test-key");

afterAll(() => {
	clearCustomApis();
	authStorage.close();
});

// An ACP client keeps several `session/new` sessions alive at once, each possibly for a
// different workspace. Each session's outbound requests must be credential-redacted per its
// own project's `secrets.enabled`, whichever session currently holds process-wide effects.
describe("concurrent ACP sessions", () => {
	it("redact each session's requests per its own project's secrets.enabled", async () => {
		using launchDir = TempDir.createSync("@pi-acp-effects-launch-");
		using projectDir = TempDir.createSync("@pi-acp-effects-project-");
		await Bun.write(projectDir.join(".omp/config.yml"), "secrets:\n  enabled: true\n");
		// What the provider's credential-redaction pass does to a token in each request it builds.
		const requests: Array<{ context: string; credential: string }> = [];
		registerCustomApi(API, (_model, context) => {
			requests.push({
				context: JSON.stringify(context.messages),
				credential: redactSensitiveCredentials(GITHUB_TOKEN),
			});
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistantMessage("ok");
				stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		});
		const credentialSentBy = (marker: string) =>
			requests.find(request => request.context.includes(marker))?.credential;
		const launchSettings = await Settings.loadIsolated({
			cwd: launchDir.path(),
			agentDir: launchDir.join("agent"),
		});
		// `omp acp` binds its launch settings the way `Settings.init` does.
		const releaseLaunch = bindEffects(launchSettings);
		const factory = createAcpSessionFactory({
			baseOptions: {
				agentDir: launchDir.join("agent"),
				model,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				rules: [],
				enableLsp: false,
				skipPythonPreflight: true,
			},
			settings: launchSettings,
			sessionDir: launchDir.join("sessions"),
			authStorage,
			modelRegistry,
			parsedArgs: {},
			rawArgs: [],
			createSession: createAgentSession,
		});
		const sessions: AgentSession[] = [];
		try {
			const redacting = (await factory(projectDir.path())).session;
			sessions.push(redacting);
			const plain = (await factory(launchDir.path())).session;
			sessions.push(plain);

			// The launch-cwd session opened last and holds process-wide effects…
			expect(redactSensitiveCredentials(GITHUB_TOKEN)).toBe(GITHUB_TOKEN);
			// …yet the project session's requests stay redacted, and its own stay as configured.
			await redacting.sendUserMessage("from the secrets project");
			await plain.sendUserMessage("from the launch cwd");
			expect(credentialSentBy("from the secrets project")).toBe("[github_token_redacted]");
			expect(credentialSentBy("from the launch cwd")).toBe(GITHUB_TOKEN);

			// Process-wide effects follow the remaining session's project, then the launch settings.
			await plain.dispose();
			expect(redactSensitiveCredentials(GITHUB_TOKEN)).toBe("[github_token_redacted]");
			await redacting.dispose();
			expect(redactSensitiveCredentials(GITHUB_TOKEN)).toBe(GITHUB_TOKEN);
		} finally {
			for (const session of sessions.reverse()) {
				if (!session.isDisposed) await session.dispose();
			}
			releaseLaunch();
			launchSettings.cancelPendingSaves();
			// The persisted instance opened agent storage under the temp dir removed below.
			AgentStorage.close();
		}
	});
});
