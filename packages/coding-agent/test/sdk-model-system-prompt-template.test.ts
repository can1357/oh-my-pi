import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { Model } from "@oh-my-pi/pi-catalog";
import { resolveDelegationBias } from "@oh-my-pi/pi-catalog/compat/delegation";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { cfgSystemPromptTemplates } from "@oh-my-pi/pi-coding-agent/session/settings";
import { getAgentDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

function bundledOpenAi(id: string): Model {
	const model = getBundledModel("openai", id);
	if (!model) throw new Error(`Expected bundled openai/${id} to exist`);
	return model;
}

/** `prepare` writes the template files and returns the settings overrides the session starts with. */
async function withTemplateSession<T>(
	prepare: (tempDir: TempDir) => Promise<Record<string, unknown>>,
	fn: (session: AgentSession, tempDir: TempDir) => Promise<T>,
): Promise<T> {
	using tempDir = TempDir.createSync("@omp-sdk-model-system-prompt-template-");
	const cwd = tempDir.join("project");
	const authStorage = await AuthStorage.create(":memory:");
	authStorage.keys.setRuntime("openai", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	let session: AgentSession | undefined;
	try {
		const result = await createAgentSession({
			cwd,
			agentDir: tempDir.join("agent"),
			authStorage,
			modelRegistry,
			settings: Settings.isolated(await prepare(tempDir)),
			sessionManager: SessionManager.inMemory(cwd),
			model: bundledOpenAi("gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		session = result.session;
		return await fn(session, tempDir);
	} finally {
		try {
			await session?.dispose();
		} finally {
			authStorage.close();
		}
	}
}

describe("SDK per-model system prompt templates", () => {
	// User-level SYSTEM.md / SYSTEM_TEMPLATE.md come from the global agent dir and would outrank the
	// model template, so a developer's real ~/.omp/agent must not leak in.
	let originalAgentDir: string;
	let agentDir: TempDir;
	beforeEach(() => {
		originalAgentDir = getAgentDir();
		agentDir = TempDir.createSync("@omp-sdk-model-system-prompt-template-agent-");
		setAgentDir(agentDir.path());
	});
	afterEach(() => {
		setAgentDir(originalAgentDir);
		agentDir.removeSync();
	});

	it("swaps the template on a model switch that leaves the hidden-model prompt key unchanged", async () => {
		const mini = bundledOpenAi("gpt-4o-mini");
		const full = bundledOpenAi("gpt-4o");
		// With `includeModelInPrompt: false` a switch rebuilds only on a changed delegation bias or
		// inline-descriptor decision (neither differs here: same bias, both non-Gemini), so only the
		// template change can rebuild the prompt.
		expect(resolveDelegationBias(full)).toBe(resolveDelegationBias(mini));

		await withTemplateSession(
			async tempDir => {
				const templatePath = tempDir.join("mini.md");
				await Bun.write(templatePath, "MINI TEMPLATE");
				return { includeModelInPrompt: false, systemPromptTemplates: { "gpt-4o-mini": templatePath } };
			},
			async session => {
				expect(session.agent.state.systemPrompt[0]).toBe("MINI TEMPLATE");

				await session.setModel(full);
				expect(session.agent.state.systemPrompt[0]).not.toContain("MINI TEMPLATE");

				await session.setModel(mini);
				expect(session.agent.state.systemPrompt[0]).toBe("MINI TEMPLATE");
			},
		);
	});

	it("rebuilds the prompt when systemPromptTemplates changes mid-session", async () => {
		await withTemplateSession(
			async () => ({}),
			async (session, tempDir) => {
				expect(session.agent.state.systemPrompt[0]).not.toContain("EDITED TEMPLATE");

				const templatePath = tempDir.join("edited.md");
				await Bun.write(templatePath, "EDITED TEMPLATE");
				const refresh = session.refreshBaseSystemPrompt.bind(session);
				const rebuilds: Promise<void>[] = [];
				const refreshSpy = spyOn(session, "refreshBaseSystemPrompt").mockImplementation(commitIf => {
					const rebuild = refresh(commitIf);
					rebuilds.push(rebuild);
					return rebuild;
				});
				// Setting listeners fire in registration order, one queued microtask each, and the session's
				// prompt-input listener starts its rebuild before its first await. Once this later-registered
				// probe fires, that listener has already run, so a missing rebuild fails here, not by timeout.
				const delivered = Promise.withResolvers<void>();
				const stopProbe = cfgSystemPromptTemplates.listen(session.settings, () => delivered.resolve());
				try {
					cfgSystemPromptTemplates.override(session.settings, { "gpt-4o-mini": templatePath });
					await delivered.promise;
					expect(rebuilds).toHaveLength(1);
					await rebuilds[0];
				} finally {
					stopProbe();
					refreshSpy.mockRestore();
				}
				expect(session.agent.state.systemPrompt[0]).toBe("EDITED TEMPLATE");
			},
		);
	});
});
