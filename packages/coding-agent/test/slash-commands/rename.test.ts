import { afterEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { DEFAULT_TINY_TITLE_LOCAL_MODEL_KEY } from "@oh-my-pi/pi-coding-agent/tiny/models";
import { tinyTitleClient } from "@oh-my-pi/pi-coding-agent/tiny/title-client";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

let session: AgentSession | undefined;
let authStorage: AuthStorage | undefined;

function createRuntime(mode: "TUI" | "headless", topic: string | null = "Repair cache invalidation after writes") {
	authStorage = createInMemoryAuthStorage();
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"providers.tinyModel": DEFAULT_TINY_TITLE_LOCAL_MODEL_KEY,
	});
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
	const agent = new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } });
	const sessionManager = SessionManager.inMemory();
	session = new AgentSession({ agent, sessionManager, settings, modelRegistry: new ModelRegistry(authStorage) });
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
	const ctx = {
		session,
		sessionManager,
		settings,
		editor: { setText: () => {}, addToHistory: () => {} },
		showStatus: () => {},
		showError: () => {},
	} as unknown as InteractiveModeContext;
	const controller = new CommandController(ctx);
	ctx.handleRenameCommand = title => controller.handleRenameCommand(title);
	return {
		session,
		sessionManager,
		runtime,
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

for (const mode of ["TUI", "headless"] as const) {
	describe(`/rename (${mode})`, () => {
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

		it("does not rename a replacement session when an earlier generation completes", async () => {
			const { session, sessionManager, execute } = createRuntime(mode);
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
			session.maybeStartTitleGeneration("Repair cache invalidation after writes");
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
