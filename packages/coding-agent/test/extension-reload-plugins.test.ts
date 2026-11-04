import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { getProjectDir, setProjectDir, TempDir, withTimeout } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

describe("ctx.reloadPlugins", () => {
	let registry: ModelRegistry;
	const originalProjectDir = getProjectDir();
	const cleanups: Array<() => Promise<void> | void> = [];

	beforeAll(() => {
		initTheme();
		registry = new ModelRegistry(createInMemoryAuthStorage());
		registry.authStorage.keys.setRuntime("openai", "test-key");
	});
	beforeEach(() => {
		resetSettingsForTest();
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockReturnValue(process.stdin);
		if (typeof process.stdin.setRawMode === "function") {
			vi.spyOn(process.stdin, "setRawMode").mockReturnValue(process.stdin);
		}
	});
	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		vi.restoreAllMocks();
		setProjectDir(originalProjectDir);
		resetSettingsForTest();
	});
	afterAll(() => registry.authStorage.close());

	async function tui(install?: (api: ExtensionAPI) => void) {
		const dir = TempDir.createSync("omp-extension-reload-");
		cleanups.push(() => dir.removeSync());
		setProjectDir(dir.path());
		await Settings.init({ inMemory: true, cwd: dir.path() });
		const captured: { context?: ExtensionContext } = {};
		const { session } = await createAgentSession({
			cwd: dir.path(),
			agentDir: path.join(dir.path(), "agent"),
			modelRegistry: registry,
			model: getBundledModel("openai", "gpt-4o-mini"),
			sessionManager: SessionManager.create(dir.path(), dir.path()),
			settings: Settings.isolated({ "compaction.enabled": false, "update.auto": false }),
			disableExtensionDiscovery: true,
			extensions: [
				pi => {
					pi.on("session_start", (_event, context) => {
						captured.context = context;
					});
					install?.(pi);
				},
			],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			rules: [],
			enableMCP: false,
			enableLsp: false,
			cacheWarming: false,
			workspaceTree: { rootPath: dir.path(), rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		});
		cleanups.push(() => session.dispose());
		const provider = createMockModel({ handler: () => ({ content: ["done"] }) });
		session.agent.streamFn = provider.stream;
		const mode = new InteractiveMode(session, "test");
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
		cleanups.push(() => mode.stop());
		await mode.init();
		if (!captured.context) throw new Error("Extension did not receive its TUI context");
		return { session, provider, context: captured.context, cwd: dir.path(), mode };
	}

	async function addCommand(cwd: string, name = "reload-check") {
		const command = path.join(cwd, ".omp", "commands", `${name}.md`);
		await fs.mkdir(path.dirname(command), { recursive: true });
		await Bun.write(command, "---\ndescription: Discovered after plugin reload\n---\nReview the changed files.\n");
	}

	it("discovers a newly installed command without submitting or replacing the editor draft", async () => {
		const { session, context, provider, cwd } = await tui();
		context.ui.setEditorText("keep this unsent draft");
		await addCommand(cwd);
		expect(session.slashCommands.some(command => command.name === "reload-check")).toBe(false);

		await context.reloadPlugins();

		expect(session.slashCommands).toContainEqual(
			expect.objectContaining({
				name: "reload-check",
				description: "Discovered after plugin reload",
				content: expect.stringContaining("Review the changed files."),
			}),
		);
		expect(context.ui.getEditorText()).toBe("keep this unsent draft");
		expect(provider.calls).toEqual([]);
	});

	it.each([
		["API", "API"],
		["/reload-plugins", "API"],
	] as const)(
		"rejects overlapping %s then %s reloads until the first finishes",
		async (firstConsumer, secondConsumer) => {
			const { session, context, provider, cwd, mode } = await tui();
			const draft = "keep this unsent draft during overlapping reloads";
			context.ui.setEditorText(draft);
			await addCommand(cwd);
			const status = vi.spyOn(mode, "showStatus");
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const refreshSkills = session.refreshSkills.bind(session);
			vi.spyOn(session, "refreshSkills").mockImplementationOnce(async () => {
				entered.resolve();
				await release.promise;
				await refreshSkills();
			});
			const reload = (consumer: "API" | "/reload-plugins") =>
				consumer === "API"
					? context.reloadPlugins()
					: executeBuiltinSlashCommand("/reload-plugins", { ctx: mode, draftDetached: true });
			const first = reload(firstConsumer);
			try {
				await withTimeout(entered.promise, 2_000, "First reload did not reach skill discovery");
				expect(session.slashCommands.some(command => command.name === "reload-check")).toBe(false);
				expect(context.ui.getEditorText()).toBe(draft);
				expect(status).not.toHaveBeenCalled();

				const rejection = await withTimeout(
					reload(secondConsumer).then(
						() => undefined,
						(error: unknown) => error,
					),
					2_000,
					"Overlapping reload did not reject while the first was blocked",
				);
				expect(rejection).toBeInstanceOf(Error);
				expect(session.slashCommands.some(command => command.name === "reload-check")).toBe(false);
				expect(context.ui.getEditorText()).toBe(draft);
				expect(status).not.toHaveBeenCalled();
				expect(provider.calls).toEqual([]);
			} finally {
				release.resolve();
				await first;
			}

			expect(session.slashCommands).toContainEqual(
				expect.objectContaining({
					name: "reload-check",
					description: "Discovered after plugin reload",
					content: expect.stringContaining("Review the changed files."),
				}),
			);
			expect(context.ui.getEditorText()).toBe(draft);
			expect(status).toHaveBeenCalledWith("Plugins reloaded.");
			status.mockClear();
			await addCommand(cwd, "reload-after-overlap");
			await reload(secondConsumer);
			expect(session.slashCommands).toContainEqual(
				expect.objectContaining({
					name: "reload-after-overlap",
					content: expect.stringContaining("Review the changed files."),
				}),
			);
			expect(context.ui.getEditorText()).toBe(draft);
			expect(status).toHaveBeenCalledWith("Plugins reloaded.");
			expect(provider.calls).toEqual([]);
		},
	);

	it("reports an overlapping Enter command without rejecting the submit callback or losing a newer draft", async () => {
		const { session, context, provider, cwd, mode } = await tui();
		const submit = mode.editor.onSubmit;
		if (!submit) throw new Error("Expected the initialized editor's submit callback");
		await addCommand(cwd);
		const status = vi.spyOn(mode, "showStatus");
		const error = vi.spyOn(mode, "showError");
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const refreshSkills = session.refreshSkills.bind(session);
		vi.spyOn(session, "refreshSkills").mockImplementationOnce(async () => {
			entered.resolve();
			await release.promise;
			await refreshSkills();
		});
		const first = context.reloadPlugins();
		const draft = "new draft typed after submitting the overlapping command";
		try {
			await withTimeout(entered.promise, 2_000, "First reload did not reach skill discovery");
			const submission = Promise.resolve(submit("/reload-plugins"));
			context.ui.setEditorText(draft);
			await withTimeout(submission, 2_000, "Overlapping Enter command did not finish");
			expect(error).toHaveBeenCalledTimes(1);
			expect(status).not.toHaveBeenCalled();
			expect(session.slashCommands.some(command => command.name === "reload-check")).toBe(false);
			expect(context.ui.getEditorText()).toBe(draft);
			await expect(context.reloadPlugins()).rejects.toBeInstanceOf(Error);
			expect(provider.calls).toEqual([]);
		} finally {
			release.resolve();
			await first;
		}
		expect(session.slashCommands).toContainEqual(
			expect.objectContaining({
				name: "reload-check",
				content: expect.stringContaining("Review the changed files."),
			}),
		);
		expect(context.ui.getEditorText()).toBe(draft);
		expect(status).toHaveBeenCalledWith("Plugins reloaded.");
		expect(provider.calls).toEqual([]);
	});

	it("propagates a workflow refresh failure without success or draft changes and releases the reload guard", async () => {
		const { session, context, provider, cwd, mode } = await tui();
		const draft = "keep this unsent draft after a failed reload";
		context.ui.setEditorText(draft);
		await addCommand(cwd);
		const status = vi.spyOn(mode, "showStatus");
		const failure = new Error("Skill discovery failed deterministically");
		const refreshSkills = vi.spyOn(session, "refreshSkills").mockRejectedValueOnce(failure);

		await expect(context.reloadPlugins()).rejects.toBe(failure);

		expect(session.slashCommands.some(command => command.name === "reload-check")).toBe(false);
		expect(context.ui.getEditorText()).toBe(draft);
		expect(status).not.toHaveBeenCalled();
		expect(provider.calls).toEqual([]);
		refreshSkills.mockRestore();
		await addCommand(cwd, "reload-after-failure");
		await context.reloadPlugins();

		for (const name of ["reload-check", "reload-after-failure"]) {
			expect(session.slashCommands).toContainEqual(
				expect.objectContaining({
					name,
					description: "Discovered after plugin reload",
					content: expect.stringContaining("Review the changed files."),
				}),
			);
		}
		expect(context.ui.getEditorText()).toBe(draft);
		expect(status).toHaveBeenCalledWith("Plugins reloaded.");
		expect(provider.calls).toEqual([]);
	});

	it("restores a failed Ctrl+Enter reload beside a newer draft and its image", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const { session, context, provider, cwd, mode } = await tui(pi => {
			pi.on("input", async () => {
				entered.resolve();
				await release.promise;
			});
		});
		await addCommand(cwd);
		const failure = new Error("Skill refresh failed during a follow-up reload");
		const refreshSkills = vi.spyOn(session, "refreshSkills").mockRejectedValueOnce(failure);
		const status = vi.spyOn(mode, "showStatus");
		const error = vi.spyOn(mode, "showError");
		context.ui.setEditorText("/reload-plugins");
		const followUp = new InputController(mode).handleFollowUp();
		const image: ImageContent = { type: "image", mimeType: "image/png", data: "d29ybGQ=" };
		try {
			await withTimeout(entered.promise, 2_000, "Follow-up did not reach its input hook");
			mode.editor.setCollapsedText("newer draft [Image #1]");
			mode.editor.pendingImages = [image];
			mode.editor.pendingImageLinks = ["attachment://1"];
			mode.editor.imageLinks = ["attachment://1"];
		} finally {
			release.resolve();
			await followUp;
		}
		const restored = mode.editor.getExpandedText();
		expect(restored).toMatch(/^\/reload-plugins\s+newer draft \[Image #1\]$/);
		expect(mode.editor.pendingImages).toEqual([image]);
		expect(mode.editor.pendingImageLinks).toEqual(["attachment://1"]);
		expect(error.mock.calls).toEqual([[failure.message]]);
		expect(status).not.toHaveBeenCalled();
		expect(session.slashCommands.some(command => command.name === "reload-check")).toBe(false);
		expect(provider.calls).toEqual([]);
		refreshSkills.mockRestore();
		await context.reloadPlugins();
		expect(session.slashCommands).toContainEqual(
			expect.objectContaining({
				name: "reload-check",
				content: expect.stringContaining("Review the changed files."),
			}),
		);
		expect(mode.editor.getExpandedText()).toBe(restored);
		expect(mode.editor.pendingImages).toEqual([image]);
		expect(status).toHaveBeenCalledWith("Plugins reloaded.");
		expect(provider.calls).toEqual([]);
	});

	it("leaves the running turn and command catalog untouched, then reloads once idle", async () => {
		const { session, provider, context, cwd } = await tui();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		provider.fallback = async () => {
			started.resolve();
			await release.promise;
			return { content: ["released"] };
		};
		await addCommand(cwd);
		const turn = session.prompt("hold this turn");
		try {
			await withTimeout(started.promise, 2_000, "Model turn did not start");
			await expect(context.reloadPlugins()).rejects.toBeInstanceOf(Error);
			expect(session.isStreaming).toBe(true);
			expect(session.slashCommands.some(command => command.name === "reload-check")).toBe(false);
		} finally {
			release.resolve();
			await turn;
		}
		await session.waitForIdle();
		await context.reloadPlugins();
		expect(session.slashCommands.some(command => command.name === "reload-check")).toBe(true);
	});

	it("keeps advisor tool hooks from reloading the host TUI's command catalog", async () => {
		let callerKind: string | undefined;
		let failure: unknown;
		const { session, cwd } = await tui(pi => {
			pi.on("tool_call", async (_event, ctx) => {
				callerKind = ctx.agent.kind;
				try {
					await ctx.reloadPlugins();
				} catch (error) {
					failure = error;
				}
			});
		});
		await addCommand(cwd);
		const runner = session.extensionRunner;
		if (!runner) throw new Error("Expected the shared extension runner");

		await runner.emitToolCall(
			{
				type: "tool_call",
				toolName: "read",
				toolCallId: "advisor-reload-18034",
				input: { path: path.join(cwd, "README.md") },
			},
			undefined,
			{ kind: "sub", id: "advisor", name: "advisor", depth: 0, parentId: session.sessionId },
		);

		expect(callerKind).toBe("sub");
		expect(failure).toBeInstanceOf(Error);
		expect(session.slashCommands.some(command => command.name === "reload-check")).toBe(false);
	});

	it("lets an idle main-agent extension command reload without a model turn", async () => {
		let admittedAtReload = false;
		const owner: { session?: { readonly hasAdmittedSubmission: boolean } } = {};
		const { session, provider, cwd } = await tui(pi => {
			pi.registerCommand("refresh-local-18034", {
				handler: async (_args, ctx) => {
					admittedAtReload = owner.session?.hasAdmittedSubmission === true;
					await ctx.reloadPlugins();
				},
			});
		});
		owner.session = session;
		await addCommand(cwd);

		await session.prompt("/refresh-local-18034");

		expect(admittedAtReload).toBe(true);
		expect(session.slashCommands.some(command => command.name === "reload-check")).toBe(true);
		expect(provider.calls).toEqual([]);
	});

	it("revokes a saved TUI context's reload capability when rebound to a headless host", async () => {
		const { session, context, cwd, provider } = await tui();
		await addCommand(cwd);
		await initializeExtensions(session, {
			mode: "rpc",
			reportSendError: (_action, error) => {
				throw error;
			},
			reportRuntimeError: error => {
				throw new Error(error.error);
			},
		});

		await expect(context.reloadPlugins()).rejects.toBeInstanceOf(Error);
		expect(session.slashCommands.some(command => command.name === "reload-check")).toBe(false);
		expect(provider.calls).toEqual([]);
	});
});
