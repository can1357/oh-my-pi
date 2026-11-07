import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { reset as resetCapabilities } from "@oh-my-pi/pi-coding-agent/capability";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { buildSessionOptions } from "@oh-my-pi/pi-coding-agent/main";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { createAgentSession, type CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { handleSystemPromptCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/system-prompt";
import { TempDir } from "@oh-my-pi/pi-utils";

interface Workspace {
	cwd: string;
	agentDir: string;
	local: (filename: string) => string;
	global: (filename: string) => string;
	create: (options?: Partial<CreateAgentSessionOptions>, cliArgs?: string[]) => Promise<AgentSession>;
	context: (session: AgentSession, edited: string | undefined) => InteractiveModeContext;
}

async function withWorkspace(fn: (workspace: Workspace) => Promise<void>): Promise<void> {
	using temp = TempDir.createSync("@omp-system-prompt-editor-");
	const cwd = temp.join("workspace");
	const agentDir = temp.join("profile", "agent");
	await fs.mkdir(cwd, { recursive: true });
	const settings = await Settings.loadIsolated({ cwd, agentDir, inMemory: true });
	const authStorage = await AuthStorage.create(":memory:");
	const modelRegistry = new ModelRegistry(authStorage, temp.join("models.yml"));
	const sessions: AgentSession[] = [];
	const create = async (overrides: Partial<CreateAgentSessionOptions> = {}, cliArgs?: string[]) => {
		resetCapabilities();
		const cliOptions =
			cliArgs === undefined
				? {}
				: await buildSessionOptions(
						parseArgs(["--cwd", cwd, ...cliArgs]),
						[],
						SessionManager.inMemory(cwd),
						modelRegistry,
						settings,
					);
		const { session } = await createAgentSession({
			...cliOptions,
			cwd,
			agentDir,
			settings,
			authStorage,
			modelRegistry,
			sessionManager: SessionManager.inMemory(cwd),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			...overrides,
		});
		sessions.push(session);
		return session;
	};
	try {
		await fn({
			cwd,
			agentDir,
			local: filename => path.join(cwd, ".omp", filename),
			global: filename => path.join(agentDir, filename),
			create,
			context: (session, edited) =>
				({
					session,
					sessionManager: session.sessionManager,
					settings,
					showHookEditor: vi.fn(async () => edited),
					showHookSelector: vi.fn(async () => "Local workspace"),
					showStatus: vi.fn(),
					showWarning: vi.fn(),
					showError: vi.fn(),
				}) as unknown as InteractiveModeContext,
		});
	} finally {
		for (const session of sessions) await session.dispose();
		authStorage.close();
		resetCapabilities();
	}
}

describe("scoped system prompt editing", () => {
	it("keeps CLI-discovered prompt source live after editing and across new sessions", async () => {
		await withWorkspace(async w => {
			await Bun.write(w.local("SYSTEM_TEMPLATE.md"), "Original CLI base for {{model}}");
			const session = await w.create({}, []);
			expect(session.systemPrompt[0]).toBe("Original CLI base for openai/gpt-4o-mini");
			await handleSystemPromptCommand("local", w.context(session, "Edited CLI base for {{model}}"));
			expect(session.systemPrompt[0]).toBe("Edited CLI base for openai/gpt-4o-mini");
			expect((await w.create({}, [])).systemPrompt[0]).toBe(session.systemPrompt[0]);
		});
	});

	it("inherits literal source without interpreting Handlebars and preserves the global file", async () => {
		await withWorkspace(async w => {
			const original = "Keep {{cwd}} literal";
			await Bun.write(w.global("SYSTEM.md"), original);
			const session = await w.create();
			const ctx = w.context(session, `${original}\nLocal instruction`);
			await handleSystemPromptCommand("local", ctx);
			expect(ctx.showHookEditor).toHaveBeenCalledWith(expect.any(String), original);
			expect(await Bun.file(w.local("SYSTEM.md")).text()).toBe(`${original}\nLocal instruction`);
			expect(await Bun.file(w.local("SYSTEM_TEMPLATE.md")).exists()).toBe(false);
			expect(await Bun.file(w.global("SYSTEM.md")).text()).toBe(original);
			expect(session.systemPrompt.join("\n")).toContain("Keep {{cwd}} literal");
			expect(session.systemPrompt.join("\n")).toContain("Local instruction");
		});
	});

	it("edits bundled raw source and applies saved template to current and future sessions", async () => {
		await withWorkspace(async w => {
			const session = await w.create();
			const ctx = w.context(session, "Saved base for {{model}}");
			ctx.showHookEditor = vi.fn(async (_title, prefill) => {
				expect(prefill).toContain("{{");
				expect(prefill).not.toContain(w.cwd);
				return "Saved base for {{model}}";
			});
			await handleSystemPromptCommand("edit local", ctx);
			expect(await Bun.file(w.local("SYSTEM_TEMPLATE.md")).text()).toBe("Saved base for {{model}}");
			expect(session.systemPrompt[0]).toContain("Saved base for openai/gpt-4o-mini");
			expect((await w.create()).systemPrompt[0]).toBe(session.systemPrompt[0]);
			expect(session.systemPrompt.join("\n")).toContain("<project-context>");
		});
	});

	it("saves an empty local base distinctly from reset and never removes append instructions", async () => {
		await withWorkspace(async w => {
			await Bun.write(w.global("SYSTEM_TEMPLATE.md"), "Inherited global base");
			await Bun.write(w.local("APPEND_SYSTEM.md"), "Retained append");
			const session = await w.create();
			await handleSystemPromptCommand("edit local", w.context(session, ""));
			expect(await Bun.file(w.local("SYSTEM_TEMPLATE.md")).text()).toBe("");
			expect(session.systemPrompt[0]).toBe("");
			expect(session.systemPrompt.join("\n")).toContain("Retained append");
			expect((await w.create()).systemPrompt[0]).toBe("");
			await handleSystemPromptCommand("reset local", w.context(session, undefined));
			expect(await Bun.file(w.local("SYSTEM_TEMPLATE.md")).exists()).toBe(false);
			expect(session.systemPrompt[0]).toBe("Inherited global base");
			expect(await Bun.file(w.local("APPEND_SYSTEM.md")).text()).toBe("Retained append");
		});
	});

	it("uses session-profile global append, while an empty local append masks inheritance", async () => {
		await withWorkspace(async w => {
			const session = await w.create();
			await handleSystemPromptCommand("append global", w.context(session, "Profile append {{literal}}"));
			expect(await Bun.file(w.global("APPEND_SYSTEM.md")).text()).toBe("Profile append {{literal}}");
			expect(session.systemPrompt.join("\n")).toContain("Profile append {{literal}}");
			await handleSystemPromptCommand("append local", w.context(session, ""));
			expect(await Bun.file(w.local("APPEND_SYSTEM.md")).text()).toBe("");
			expect(session.systemPrompt.join("\n")).not.toContain("Profile append");
			expect((await w.create()).systemPrompt.join("\n")).not.toContain("Profile append");
		});
	});

	it("does not overwrite saved source or active instructions after cancel or malformed input", async () => {
		await withWorkspace(async w => {
			await Bun.write(w.local("SYSTEM_TEMPLATE.md"), "Original base");
			const session = await w.create();
			await handleSystemPromptCommand("local", w.context(session, undefined));
			const ctx = w.context(session, "{{#if model}}");
			await handleSystemPromptCommand("local", ctx);
			expect(ctx.showError).toHaveBeenCalledTimes(1);
			expect(await Bun.file(w.local("SYSTEM_TEMPLATE.md")).text()).toBe("Original base");
			expect(session.systemPrompt[0]).toBe("Original base");
		});
	});

	it("preserves explicit SDK base and append ownership when saving lower-priority files", async () => {
		await withWorkspace(async w => {
			const session = await w.create({
				systemPromptTemplate: "Explicit base",
				appendSystemPrompt: "Explicit append",
			});
			await handleSystemPromptCommand("edit local", w.context(session, "Saved lower base"));
			await handleSystemPromptCommand("append local", w.context(session, "Saved lower append"));
			expect(session.systemPrompt[0]).toBe("Explicit base");
			expect(session.systemPrompt.join("\n")).toContain("Explicit append");
			expect(session.systemPrompt.join("\n")).not.toContain("Saved lower");
			const future = await w.create();
			expect(future.systemPrompt[0]).toBe("Saved lower base");
			expect(future.systemPrompt.join("\n")).toContain("Saved lower append");
		});
	});

	it("refuses edits started while streaming and saves overtaken by a stream", async () => {
		await withWorkspace(async w => {
			const session = await w.create();
			let streaming = true;
			Object.defineProperty(session, "isStreaming", { configurable: true, get: () => streaming });
			const ctx = w.context(session, "Do not save");
			try {
				await handleSystemPromptCommand("local", ctx);
				expect(ctx.showHookEditor).not.toHaveBeenCalled();
				streaming = false;
				ctx.showHookEditor = vi.fn(async () => {
					streaming = true;
					return "Do not save";
				});
				await handleSystemPromptCommand("local", ctx);
				expect(await Bun.file(w.local("SYSTEM_TEMPLATE.md")).exists()).toBe(false);
			} finally {
				Reflect.deleteProperty(session, "isStreaming");
			}
		});
	});

	it("reports persistence separately when refreshing the active session fails", async () => {
		await withWorkspace(async w => {
			const session = await w.create();
			const refresh = vi
				.spyOn(session, "refreshBaseSystemPrompt")
				.mockRejectedValue(new Error("refresh unavailable"));
			const ctx = w.context(session, "Saved instructions");
			try {
				await handleSystemPromptCommand("local", ctx);
				expect(await Bun.file(w.local("SYSTEM_TEMPLATE.md")).text()).toBe("Saved instructions");
				expect(ctx.showError).toHaveBeenCalledWith(expect.stringContaining(w.local("SYSTEM_TEMPLATE.md")));
				expect(ctx.showError).toHaveBeenCalledWith(expect.stringContaining("refresh unavailable"));
			} finally {
				refresh.mockRestore();
			}
			expect((await w.create()).systemPrompt[0]).toBe("Saved instructions");
		});
	});
});
