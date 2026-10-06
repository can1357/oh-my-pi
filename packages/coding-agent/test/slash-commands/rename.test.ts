import { afterEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { CliUsageError } from "@oh-my-pi/pi-coding-agent/cli/usage-error";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionActions, ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import type { MessagingService } from "@oh-my-pi/pi-coding-agent/messaging/service";
import { RESERVED_SESSION_NAME_ERROR } from "@oh-my-pi/pi-coding-agent/messaging/names";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { ExtensionUiController } from "@oh-my-pi/pi-coding-agent/modes/controllers/extension-ui-controller";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { MemorySessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { DEFAULT_TINY_TITLE_LOCAL_MODEL_KEY } from "@oh-my-pi/pi-coding-agent/tiny/models";
import { tinyTitleClient } from "@oh-my-pi/pi-coding-agent/tiny/title-client";
import { cfgTitleIcons } from "@oh-my-pi/pi-coding-agent/utils/title-settings";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { createInteractiveModeContext } from "../helpers/interactive-mode-context";

let session: AgentSession | undefined;
let authStorage: AuthStorage | undefined;

function createRuntime(
	mode: "TUI" | "headless",
	topic: string | null = "Repair cache invalidation after writes",
	sessionManager = SessionManager.inMemory(),
) {
	authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("anthropic", "test-key");
	// Plain titles keep the rename lifecycle tests to one title request; the card tests opt in.
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"title.icons": "boring",
		modelRoles: { tiny: `local/${DEFAULT_TINY_TITLE_LOCAL_MODEL_KEY}` },
	});
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		streamFn: createMockModel({ handler: { content: ["Looking at the cache."] } }).stream,
	});
	session = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry: new ModelRegistry(authStorage),
		autoTitle: true,
	});
	if (topic !== null) {
		const message = { role: "user" as const, content: topic, timestamp: 1 };
		agent.appendMessage(message);
		sessionManager.appendMessage(message);
	}
	const runtime: SlashCommandRuntime = {
		session,
		sessionManager,
		settings,
		cwd: sessionManager.getCwd(),
		output: () => {},
		refreshCommands: () => {},
		reloadPlugins: async () => {},
	};
	const ctx = createInteractiveModeContext({
		session,
		sessionManager,
		settings,
		editor: { setText: () => {}, addToHistory: () => {} },
		showStatus: () => {},
		showError: () => {},
	});
	const controller = new CommandController(ctx);
	ctx.handleRenameCommand = title => controller.handleRenameCommand(title);
	return {
		session,
		sessionManager,
		runtime,
		ctx,
		execute: (text: string) =>
			mode === "TUI" ? executeBuiltinSlashCommand(text, { ctx }) : executeAcpBuiltinSlashCommand(text, runtime),
	};
}

function deferTitle() {
	const started = Promise.withResolvers<void>();
	const response = Promise.withResolvers<string | null>();
	const generate = vi.spyOn(tinyTitleClient, "generate").mockImplementation(() => {
		started.resolve();
		return response.promise;
	});
	return { started, response, generate };
}

afterEach(async () => {
	try {
		await session?.dispose();
	} finally {
		authStorage?.close();
		vi.restoreAllMocks();
		session = undefined;
		authStorage = undefined;
	}
});

it("rejects normalized reserved explicit names without mutating the session", async () => {
	const { session, sessionManager } = createRuntime("headless");
	await sessionManager.setSessionName("previous", "user");
	const header = structuredClone(sessionManager.getHeader());
	const entries = sessionManager.getEntries();
	const revision = sessionManager.titleRevision;
	const renamed = vi.fn();
	sessionManager.onSessionNameChanged(renamed);
	for (const name of [" all ", "\u0000all\u0007", " @extension "]) {
		await expect(session.setSessionName(name, "user")).rejects.toThrow(RESERVED_SESSION_NAME_ERROR);
		expect(session.sessionName).toBe("previous");
		expect(sessionManager.titleRevision).toBe(revision);
		expect(sessionManager.getHeader()).toEqual(header);
		expect(sessionManager.getEntries()).toEqual(entries);
	}
	expect(renamed).not.toHaveBeenCalled();
});

it("rejects reserved renames through headless and interactive extension actions", async () => {
	const { session, sessionManager, ctx } = createRuntime("headless");
	await sessionManager.setSessionName("previous", "user");
	let actions: ExtensionActions | undefined;
	Object.defineProperty(session, "extensionRunner", {
		configurable: true,
		value: {
			initialize: (bound: ExtensionActions) => {
				actions = bound;
			},
			onError: () => {},
			emit: async () => {},
			getComposerShapes: () => [],
		},
	});
	await initializeExtensions(session, { reportSendError: () => {}, reportRuntimeError: () => {} });
	if (!actions) throw new Error("expected initialized extension actions");
	await expect(actions.setSessionName("all")).rejects.toThrow(RESERVED_SESSION_NAME_ERROR);
	ctx.syncComposerShape = () => {};
	new ExtensionUiController(ctx).initializeHookRunner({} as ExtensionUIContext, true);
	await expect(actions.setSessionName("all")).rejects.toThrow(RESERVED_SESSION_NAME_ERROR);
	expect(sessionManager.getSessionName()).toBe("previous");
});

it("preserves a legacy reserved user title when branching before the root message with messaging off", async () => {
	const manager = SessionManager.inMemory();
	const rootId = manager.appendMessage({ role: "user", content: "Edit this root prompt", timestamp: 1 });
	const legacy = manager.captureState();
	manager.restoreState({
		...legacy,
		sessionName: "all",
		titleSource: "user",
		header: { ...legacy.header, title: "all", titleSource: "user" },
	});
	const { session } = createRuntime("headless", null, manager);
	const previousId = session.sessionId;
	expect(session.messaging).toBeUndefined();
	const result = await session.branch(rootId);
	expect(result).toMatchObject({ cancelled: false, selectedText: "Edit this root prompt" });
	expect(session.sessionId).not.toBe(previousId);
	expect(session.sessionName).toBe("all");
	expect(manager.titleSource).toBe("user");
	expect(session.messages).toEqual([]);
});

it("cancels title inference without applying or announcing a late rename", async () => {
	const { session, sessionManager, runtime, execute } = createRuntime("headless");
	await sessionManager.setSessionName("Keep this title", "user");
	const controller = new AbortController();
	runtime.signal = controller.signal;
	const output = vi.spyOn(runtime, "output");
	const { started, response, generate } = deferTitle();
	const pending = execute("/rename");
	try {
		await Promise.race([started.promise, pending]);
		controller.abort();
		expect(generate.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
		response.resolve("Late cancelled title");
		await pending;
		expect(session.sessionName).toBe("Keep this title");
		expect(output).not.toHaveBeenCalled();
	} finally {
		response.resolve(null);
		await pending;
	}
});

for (const mode of ["TUI", "headless"] as const) {
	describe(`/rename (${mode})`, () => {
		it("refuses reserved @ names without changing the stored name", async () => {
			const { session, sessionManager, runtime, ctx, execute } = createRuntime(mode);
			await sessionManager.setSessionName("Keep this name", "user");
			const entries = sessionManager.getEntries();
			const output = mode === "TUI" ? vi.spyOn(ctx, "showError") : vi.spyOn(runtime, "output");

			await execute("/rename @x");

			expect(output).toHaveBeenCalledWith(RESERVED_SESSION_NAME_ERROR);
			expect(session.sessionName).toBe("Keep this name");
			expect(sessionManager.getEntries()).toEqual(entries);
		});

		it("claims a free collision variant and reports the stored address rather than the requested name", async () => {
			const { session, sessionManager, runtime, ctx, execute } = createRuntime(mode);
			const messaging = {
				listSessions: async () => [{ name: "release notes" }],
			} as unknown as MessagingService;
			Object.defineProperty(session, "messaging", { value: messaging, configurable: true });
			vi.spyOn(Math, "random").mockReturnValue(0);
			const output = mode === "TUI" ? vi.spyOn(ctx, "showStatus") : vi.spyOn(runtime, "output");
			await execute("/rename release notes");
			const stored = sessionManager.getSessionName()!;
			expect(stored).toMatch(/^release notes-[a-z]+-[a-z]+$/);
			expect(output.mock.calls[0]?.[0]).toContain(stored);
			expect(output.mock.calls[0]?.[0]).toContain(' ("release notes" is used by another session)');
		});

		it("replaces a manual title from conversation context and protects the result from automatic titles", async () => {
			const { session, sessionManager, execute } = createRuntime(mode);
			await sessionManager.setSessionName("Old manually chosen title", "user");
			const generate = vi.spyOn(tinyTitleClient, "generate").mockResolvedValue("Cache invalidation repair");

			await execute("/rename   ");

			expect(session.sessionName).toBe("Cache invalidation repair");
			expect(generate).toHaveBeenCalledTimes(1);
			const context = generate.mock.calls[0]?.[1];
			expect(context).toContain("Repair cache invalidation after writes");
			await sessionManager.setSessionName("Later automatic title", "auto");
			expect(session.sessionName).toBe("Cache invalidation repair");
		});

		it("keeps the current title's card on a generated title without asking for a new one", async () => {
			const { session, sessionManager, runtime, execute } = createRuntime(mode);
			cfgTitleIcons.override(runtime.settings, "emoji");
			await sessionManager.setSessionName("🧪 CACHE: Fix cache writes", "auto");
			const generate = vi.spyOn(tinyTitleClient, "generate").mockResolvedValue("Cache invalidation repair");

			await execute("/rename");

			expect(session.sessionName).toBe("🧪 CACHE: Cache invalidation repair");
			expect(generate).toHaveBeenCalledTimes(1);
		});

		it("heads a typed or generated title without a card with one the title model names", async () => {
			const { session, runtime, execute } = createRuntime(mode);
			cfgTitleIcons.override(runtime.settings, "emoji");
			const generate = vi
				.spyOn(tinyTitleClient, "generate")
				.mockImplementation(async (_model, _message, options) =>
					options && "systemPrompt" in options ? "🗄 CACHE" : "Cache invalidation repair",
				);

			await execute("/rename");
			expect(session.sessionName).toBe("🗄️ CACHE: Cache invalidation repair");

			await execute("/rename Cache ownership");
			expect(session.sessionName).toBe("🗄️ CACHE: Cache ownership");
			expect(generate.mock.calls.at(-1)?.[1]).toBe("Cache ownership");

			await execute("/rename 🐳 DOCKER: Docker builds");
			expect(session.sessionName).toBe("🐳 DOCKER: Docker builds");
			expect(generate).toHaveBeenCalledTimes(3);
		});

		it("applies a typed title without its card when an interrupt cancels the card", async () => {
			const { session, runtime, execute } = createRuntime(mode);
			cfgTitleIcons.override(runtime.settings, "emoji");
			const { started, response } = deferTitle();
			const pending = execute("/rename Cache ownership");
			try {
				await Promise.race([started.promise, pending]);
				await session.abort();
				response.resolve("🗄 CACHE");
				await pending;
				expect(session.sessionName).toBe("Cache ownership");
			} finally {
				response.resolve(null);
				await pending;
			}
		});

		it("persists an explicit title without asking the model", async () => {
			const { session, execute } = createRuntime(mode);
			const generate = vi.spyOn(tinyTitleClient, "generate").mockResolvedValue("Unrequested generated title");

			await execute("/rename   Cache ownership   ");

			expect(session.sessionName).toBe("Cache ownership");
			expect(generate).not.toHaveBeenCalled();
		});

		it("keeps the previous title without inference when there is no conversation", async () => {
			const { session, sessionManager, execute } = createRuntime(mode, null);
			await sessionManager.setSessionName("Keep this title", "user");
			const entries = sessionManager.getEntries();
			const generate = vi.spyOn(tinyTitleClient, "generate").mockResolvedValue("Invented topic");

			await execute("/rename");

			expect(session.sessionName).toBe("Keep this title");
			expect(sessionManager.getEntries()).toEqual(entries);
			expect(generate).not.toHaveBeenCalled();
		});

		it.each(["empty", "low-signal"] as const)(
			"keeps a pending rename when another request has %s context",
			async context => {
				const { session, execute } = createRuntime(mode);
				const messages = session.messages;
				const { started, response, generate } = deferTitle();
				const pending = execute("/rename");
				try {
					await Promise.race([started.promise, pending]);
					session.agent.replaceMessages(
						context === "empty" ? [] : [{ role: "user", content: "hello", timestamp: 2 }],
					);
					generate.mockResolvedValueOnce(null);
					await execute("/rename");
					expect(generate).toHaveBeenCalledTimes(1);

					session.agent.replaceMessages(messages);
					response.resolve("Cache invalidation repair");
					await pending;
					expect(session.sessionName).toBe("Cache invalidation repair");
				} finally {
					session.agent.replaceMessages(messages);
					response.resolve(null);
					await pending;
				}
			},
		);

		for (const outcome of ["no title", "failure"] as const) {
			it(`preserves the previous title when generation returns ${outcome}`, async () => {
				const { session, sessionManager, execute } = createRuntime(mode);
				await sessionManager.setSessionName("Keep this title", "user");
				const entries = sessionManager.getEntries();
				const generate = vi.spyOn(tinyTitleClient, "generate");
				if (outcome === "failure") generate.mockRejectedValue(new Error("Title model unavailable"));
				else generate.mockResolvedValue(null);

				await execute("/rename");

				expect(generate).toHaveBeenCalledTimes(1);
				expect(session.sessionName).toBe("Keep this title");
				expect(sessionManager.getEntries()).toEqual(entries);
			});
		}

		it.each(["abort", "switch", "rename"] as const)(
			"suppresses completion when %s occurs during title persistence",
			async interruption => {
				const { session, sessionManager, execute, ctx, runtime } = createRuntime(mode);
				const output = mode === "TUI" ? vi.spyOn(ctx, "showStatus") : vi.spyOn(runtime, "output");
				const notify = vi.fn();
				runtime.notifyTitleChanged = notify;
				vi.spyOn(tinyTitleClient, "generate").mockResolvedValue("Generated title");
				const started = Promise.withResolvers<void>();
				const persisted = Promise.withResolvers<void>();
				const store = sessionManager.setSessionName.bind(sessionManager);
				vi.spyOn(sessionManager, "setSessionName").mockImplementationOnce(async (...args) => {
					const result = await store(...args);
					started.resolve();
					await persisted.promise;
					return result;
				});
				const pending = execute("/rename");
				try {
					await Promise.race([started.promise, pending]);
					if (interruption === "abort") await session.abort();
					else if (interruption === "switch") await session.newSession();
					else await store("Generated title", "user");
					const currentTitle = session.sessionName;
					persisted.resolve();
					await pending;
					expect(session.sessionName).toBe(currentTitle);
					expect(output).not.toHaveBeenCalled();
					expect(notify).not.toHaveBeenCalled();
				} finally {
					persisted.resolve();
					await pending;
				}
			},
		);

		it("does not rename a replacement session when an earlier generation completes", async () => {
			const { session, sessionManager, execute, ctx, runtime } = createRuntime(mode);
			const output = mode === "TUI" ? vi.spyOn(ctx, "showStatus") : vi.spyOn(runtime, "output");
			const { started, response, generate } = deferTitle();
			const pending = execute("/rename");
			try {
				// Also settles on the old usage-only path, so a regression fails instead of hanging.
				await Promise.race([started.promise, pending]);
				expect(generate).toHaveBeenCalledTimes(1);
				const previousSessionId = sessionManager.getSessionId();
				expect(await session.newSession()).toBe(true);
				expect(sessionManager.getSessionId()).not.toBe(previousSessionId);
				const entries = sessionManager.getEntries();

				response.resolve("Old conversation topic");
				await pending;

				expect(session.sessionName).toBeUndefined();
				expect(sessionManager.getEntries()).toEqual(entries);
				expect(output).not.toHaveBeenCalled();
			} finally {
				response.resolve(null);
				await pending;
			}
		});

		it("discards a pending rename after switching away and back to the same session", async () => {
			const storage = new MemorySessionStorage();
			const source = SessionManager.create("/tmp/rename-switch", "/sessions", storage);
			const { session, sessionManager, execute, ctx, runtime } = createRuntime(mode, undefined, source);
			const output = mode === "TUI" ? vi.spyOn(ctx, "showStatus") : vi.spyOn(runtime, "output");
			await source.ensureOnDisk();
			await source.flush();
			const sourceFile = source.getSessionFile()!;
			const other = SessionManager.create("/tmp/rename-switch", "/sessions", storage);
			await other.ensureOnDisk();
			const otherFile = other.getSessionFile()!;
			await other.close();
			const { started, response } = deferTitle();
			const pending = execute("/rename");
			try {
				await Promise.race([started.promise, pending]);
				expect(await session.switchSession(otherFile)).toBe(true);
				expect(await session.switchSession(sourceFile)).toBe(true);
				const entries = sessionManager.getEntries();
				response.resolve("Stale title from before switching");
				await pending;
				expect(session.sessionName).toBeUndefined();
				expect(sessionManager.getEntries()).toEqual(entries);
				expect(output).not.toHaveBeenCalled();
			} finally {
				response.resolve(null);
				await pending;
			}
		});

		it("preserves a newer explicit rename even when it repeats the same title", async () => {
			const { session, sessionManager, execute } = createRuntime(mode);
			await sessionManager.setSessionName("My chosen title", "user");
			const { started, response, generate } = deferTitle();
			const pending = execute("/rename");
			try {
				await Promise.race([started.promise, pending]);
				expect(generate).toHaveBeenCalledTimes(1);
				await execute("/rename My chosen title");
				const entries = sessionManager.getEntries();

				response.resolve("Stale generated title");
				await pending;

				expect(session.sessionName).toBe("My chosen title");
				expect(sessionManager.getEntries()).toEqual(entries);
			} finally {
				response.resolve(null);
				await pending;
			}
		});
	});
}
it("suppresses confirmation when the prompt is cancelled during title notification", async () => {
	const { runtime, execute } = createRuntime("headless");
	const controller = new AbortController();
	runtime.signal = controller.signal;
	const output = vi.spyOn(runtime, "output");
	const started = Promise.withResolvers<void>();
	const notified = Promise.withResolvers<void>();
	runtime.notifyTitleChanged = () => {
		started.resolve();
		return notified.promise;
	};
	vi.spyOn(tinyTitleClient, "generate").mockResolvedValue("Generated title");
	const pending = execute("/rename");
	try {
		await Promise.race([started.promise, pending]);
		controller.abort();
		notified.resolve();
		await pending;
		expect(output).not.toHaveBeenCalled();
	} finally {
		notified.resolve();
		await pending;
	}
});

it("releases the RPC command while title inference runs in the background and preserves a newer rename", async () => {
	const { session, sessionManager, runtime } = createRuntime("headless");
	const { started, response } = deferTitle();
	let backgroundTask: Promise<void> | undefined;
	runtime.runCommandInBackground = task => {
		backgroundTask = task();
	};
	const dispatched = executeAcpBuiltinSlashCommand("/rename", runtime);
	try {
		await Promise.race([started.promise, dispatched]);
		expect(backgroundTask).toBeDefined();
		// The deferred inference is unresolved: the RPC command must already return.
		expect(await dispatched).toMatchObject({ consumed: true });
		await started.promise;
		await executeAcpBuiltinSlashCommand("/rename My newer RPC title", runtime);
		const entries = sessionManager.getEntries();

		response.resolve("Stale generated title");
		await backgroundTask;

		expect(session.sessionName).toBe("My newer RPC title");
		expect(sessionManager.getEntries()).toEqual(entries);
	} finally {
		response.resolve(null);
		await dispatched;
		await backgroundTask;
	}
});

it("aborts a background RPC rename silently and allows a later rename", async () => {
	const { session, runtime } = createRuntime("headless");
	const { started, response, generate } = deferTitle();
	const output = vi.spyOn(runtime, "output");
	let backgroundTask: Promise<void> | undefined;
	runtime.runCommandInBackground = task => {
		backgroundTask = task();
	};
	try {
		await executeAcpBuiltinSlashCommand("/rename", runtime);
		await started.promise;
		await session.abort();
		expect(generate.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
		response.resolve("Cancelled RPC title");
		await backgroundTask;
		expect(session.sessionName).toBeUndefined();
		expect(output).not.toHaveBeenCalled();

		generate.mockResolvedValue("Fresh RPC title");
		await executeAcpBuiltinSlashCommand("/rename", runtime);
		await backgroundTask;
		expect(session.sessionName).toBe("Fresh RPC title");
	} finally {
		response.resolve(null);
		await backgroundTask;
	}
});

it.each([true, false])("keeps the latest RPC rename request when older finishes first: %s", async olderFirst => {
	const { session, sessionManager, runtime } = createRuntime("headless");
	await sessionManager.setSessionName("Original title", "user");
	const responses = [Promise.withResolvers<string | null>(), Promise.withResolvers<string | null>()];
	const generate = vi
		.spyOn(tinyTitleClient, "generate")
		.mockImplementationOnce(() => responses[0].promise)
		.mockImplementationOnce(() => responses[1].promise);
	const pending: Promise<void>[] = [];
	runtime.runCommandInBackground = task => {
		pending.push(task());
	};
	try {
		await executeAcpBuiltinSlashCommand("/rename", runtime);
		await executeAcpBuiltinSlashCommand("/rename", runtime);
		expect(generate).toHaveBeenCalledTimes(2);
		const first = olderFirst ? 0 : 1;
		const titles = ["Stale generated title", "Latest generated title"];
		responses[first].resolve(titles[first]);
		await pending[first];
		expect(session.sessionName).toBe(olderFirst ? "Original title" : titles[1]);
		responses[1 - first].resolve(titles[1 - first]);
		await pending[1 - first];
		expect(session.sessionName).toBe(titles[1]);
	} finally {
		for (const response of responses) response.resolve(null);
		await Promise.all(pending);
	}
});

it.each(["TUI", "headless"] as const)(
	"keeps a manual %s rename after an older automatic title completes",
	async mode => {
		const { session, sessionManager, execute } = createRuntime(mode);
		const previousNoTitle = Bun.env.PI_NO_TITLE;
		delete Bun.env.PI_NO_TITLE;
		const automatic = Promise.withResolvers<string | null>();
		const manual = Promise.withResolvers<string | null>();
		const applied = Promise.withResolvers<void>();
		const unsubscribe = sessionManager.onSessionNameChanged(() => applied.resolve());
		const generate = vi
			.spyOn(tinyTitleClient, "generate")
			.mockImplementationOnce(() => automatic.promise)
			.mockImplementationOnce(() => manual.promise);
		let pending: Promise<unknown> | undefined;
		try {
			// A TITLE_SYSTEM.md override keeps the automatic title on the title model
			// (no reply fork), so both titles race through `generate`.
			session.setTitleSystemPrompt("Name the session in 3-6 words.");
			await session.prompt("Repair cache invalidation after writes");
			pending = execute("/rename");
			expect(generate).toHaveBeenCalledTimes(2);
			automatic.resolve("Initial automatic title");
			await applied.promise;
			manual.resolve("Requested manual title");
			await pending;
			expect(session.sessionName).toBe("Requested manual title");
			await sessionManager.setSessionName("Later automatic title", "auto");
			expect(session.sessionName).toBe("Requested manual title");
		} finally {
			automatic.resolve(null);
			manual.resolve(null);
			await pending;
			unsubscribe();
			if (previousNoTitle === undefined) delete Bun.env.PI_NO_TITLE;
			else Bun.env.PI_NO_TITLE = previousNoTitle;
		}
	},
);

it.each(["@x", " @x ", "all", " all "])("rejects --name %s as a CLI usage error", async name => {
	const args = ["--name", name];
	const result = runRootCommand(parseArgs(args), args);
	await expect(result).rejects.toBeInstanceOf(CliUsageError);
	await expect(result).rejects.toThrow(RESERVED_SESSION_NAME_ERROR);
});
