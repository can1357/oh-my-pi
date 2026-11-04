import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
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
		return { session, provider, context: captured.context, cwd: dir.path() };
	}

	async function addCommand(cwd: string) {
		const command = path.join(cwd, ".omp", "commands", "reload-check.md");
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
