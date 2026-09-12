import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { SessionSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/session-selector";
import { BtwController } from "@oh-my-pi/pi-coding-agent/modes/controllers/btw-controller";
import { ExtensionUiController } from "@oh-my-pi/pi-coding-agent/modes/controllers/extension-ui-controller";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { BtwHistoryStore } from "@oh-my-pi/pi-coding-agent/session/btw-history";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

function answer(text: string) {
	const assistantMessage: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		timestamp: Date.now(),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	return { replyText: text, assistantMessage };
}

interface SideTurn {
	signal?: AbortSignal;
	resolve: (result: { replyText: string; assistantMessage: AssistantMessage }) => void;
}

describe("BTW session boundaries", () => {
	let directory: TempDir;
	let auth: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let manager: SessionManager;
	let btw: BtwController;
	let sourceFile: string;
	let sourceId: string;
	let recordPath: string;
	let originalRecord: string;
	let turns: SideTurn[];
	let extensionRunner: ExtensionRunner;

	beforeAll(() => initTheme());
	beforeEach(async () => {
		resetSettingsForTest();
		directory = TempDir.createSync("@omp-btw-session-lifecycle-");
		await Settings.init({ inMemory: true, cwd: directory.path() });
		auth = await AuthStorage.create(path.join(directory.path(), "auth.db"));
		const registry = new ModelRegistry(auth);
		const model = registry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model");
		manager = SessionManager.create(directory.path(), directory.path());
		manager.appendMessage({ role: "user", content: "Source session", timestamp: Date.now() });
		await manager.ensureOnDisk();
		extensionRunner = new ExtensionRunner([], new ExtensionRuntime(), directory.path(), manager, registry);
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: manager,
			settings: Settings.isolated(),
			modelRegistry: registry,
			extensionRunner,
			rebuildSystemPrompt: async () => ({ systemPrompt: ["Test"] }),
		});
		mode = new InteractiveMode(session, "test");
		mode.ui.requestRender = vi.fn();
		mode.ui.requestComponentRender = vi.fn();
		mode.ui.setFocus = vi.fn();
		vi.spyOn(mode.ui, "showOverlay").mockImplementation(() => ({
			hide: vi.fn(),
			setHidden: vi.fn(),
			isHidden: () => false,
		}));
		vi.spyOn(mode, "renderInitialMessages").mockResolvedValue(undefined);
		vi.spyOn(mode, "reloadTodos").mockResolvedValue(undefined);
		vi.spyOn(mode, "showHookConfirm").mockResolvedValue(true);
		vi.spyOn(mode, "showStatus").mockImplementation(() => {});
		vi.spyOn(mode, "showError").mockImplementation(() => {});
		turns = [];
		vi.spyOn(session, "runEphemeralTurn").mockImplementation(args => {
			const pending = Promise.withResolvers<{ replyText: string; assistantMessage: AssistantMessage }>();
			turns.push({ signal: args.signal, resolve: pending.resolve });
			return pending.promise;
		});
		const start = BtwController.prototype.start;
		vi.spyOn(BtwController.prototype, "start").mockImplementation(function (this: BtwController, question) {
			btw = this;
			return start.call(this, question);
		});
		await mode.handleBtwCommand("Slow side question");
		sourceFile = manager.getSessionFile()!;
		sourceId = manager.getSessionId();
		const artifacts = manager.getArtifactsDir()!;
		const record = (await BtwHistoryStore.open(artifacts)).getRecords()[0]!;
		recordPath = path.join(artifacts, "btw-history", `entry-${record.id}.json`);
		originalRecord = await Bun.file(recordPath).text();
	});
	afterEach(async () => {
		for (const turn of turns) turn.resolve(answer("Cleanup"));
		// Restore only this test's deliberately corrupted/deleted checkpoint so even
		// a failing pre-fix run can drain the sticky write before fixture removal.
		if (!(await Bun.file(recordPath).exists())) await Bun.write(recordPath, originalRecord);
		vi.restoreAllMocks();
		await btw.flush();
		await btw.dispose();
		mode.stop();
		await session.dispose();
		auth.close();
		directory.removeSync();
		resetSettingsForTest();
	});

	async function targetSession(): Promise<string> {
		const target = SessionManager.create(directory.path(), directory.path());
		target.appendMessage({ role: "user", content: "Target session", timestamp: Date.now() });
		await target.ensureOnDisk();
		const file = target.getSessionFile()!;
		await target.close();
		return file;
	}

	async function picker(file: string): Promise<SessionSelectorComponent> {
		const list = await SessionManager.list(directory.path(), directory.path());
		const selected = list.find(item => item.path === file);
		if (!selected) throw new Error("Expected saved picker target");
		vi.spyOn(SessionManager, "list").mockResolvedValue([selected]);
		await new SelectorController(mode).showSessionSelector();
		const component = vi.spyOn(mode.ui, "showOverlay").mock.calls.at(-1)?.[0];
		if (!(component instanceof SessionSelectorComponent)) throw new Error("Expected session selector");
		return component;
	}

	async function startTransition(action: "delete command" | "picker delete" | "picker resume") {
		if (action === "delete command") {
			vi.spyOn(SelectorController.prototype, "showSessionSelector").mockResolvedValue(undefined);
			return { finished: mode.handleSessionDeleteCommand() };
		}
		const panel = await picker(action === "picker delete" ? sourceFile : await targetSession());
		const done = Promise.withResolvers<void>();
		if (action === "picker delete") {
			const remove = FileSessionStorage.prototype.deleteSessionWithArtifacts;
			vi.spyOn(FileSessionStorage.prototype, "deleteSessionWithArtifacts").mockImplementation(
				async function (this: FileSessionStorage, file) {
					try {
						await remove.call(this, file);
						done.resolve();
					} catch (error) {
						done.reject(error);
						throw error;
					}
				},
			);
			panel.handleInput("\x1b[3~");
		} else {
			const resume = SelectorController.prototype.handleResumeSession;
			vi.spyOn(SelectorController.prototype, "handleResumeSession").mockImplementation(async function (
				this: SelectorController,
				...args
			) {
				try {
					const result = await resume.apply(this, args);
					done.resolve();
					return result;
				} catch (error) {
					done.reject(error);
					throw error;
				}
			});
		}
		panel.handleInput("\n");
		return { finished: done.promise };
	}

	it.each(["delete command", "picker delete", "picker resume"] as const)(
		"%s waits for cancelled BTW persistence before changing the source session",
		async action => {
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const upsert = BtwHistoryStore.prototype.upsert;
			vi.spyOn(BtwHistoryStore.prototype, "upsert").mockImplementationOnce(
				async function (this: BtwHistoryStore, record) {
					entered.resolve();
					await release.promise;
					await upsert.call(this, record);
				},
			);
			try {
				const { finished } = await startTransition(action);
				await entered.promise;
				expect(turns[0]!.signal?.aborted).toBe(true);
				expect(manager.getSessionId()).toBe(sourceId);
				expect(await Bun.file(sourceFile).exists()).toBe(true);
				expect(await Bun.file(recordPath).text()).toBe(originalRecord);
				release.resolve();
				await finished;
				expect(manager.getSessionId()).not.toBe(sourceId);
				turns[0]!.resolve(answer("Late answer must not resurrect deleted history"));
				await Promise.resolve();
				await btw.flush();
				if (action === "picker resume") {
					expect((await Bun.file(recordPath).json()).status).toBe("cancelled");
				} else {
					expect(await Bun.file(sourceFile).exists()).toBe(false);
					expect(await Bun.file(recordPath).exists()).toBe(false);
				}
				await mode.handleBtwCommand("New session side question");
				expect(turns).toHaveLength(2);
				turns[1]!.resolve(answer("New session answer"));
				await Promise.resolve();
				await btw.flush();
				expect((await BtwHistoryStore.open(manager.getArtifactsDir() ?? undefined)).getRecords()[0]?.answer).toBe(
					"New session answer",
				);
			} finally {
				release.resolve();
			}
		},
	);

	it.each(["delete", "resume"] as const)("keeps the source intact when BTW persistence blocks %s", async action => {
		const target = action === "resume" ? await targetSession() : undefined;
		const corrupt = "{broken checkpoint";
		await Bun.write(recordPath, corrupt);
		try {
			const operation = action === "delete" ? mode.handleSessionDeleteCommand() : mode.handleResumeSession(target!);
			await expect(operation).rejects.toThrow("BTW history could not be saved");
			expect(manager.getSessionId()).toBe(sourceId);
			expect(await Bun.file(sourceFile).exists()).toBe(true);
			expect(await Bun.file(recordPath).text()).toBe(corrupt);
		} finally {
			await Bun.write(recordPath, originalRecord);
		}
	});

	it("leaves BTW running when the delete confirmation is declined", async () => {
		vi.spyOn(mode, "showHookConfirm").mockResolvedValue(false);
		await mode.handleSessionDeleteCommand();
		expect(manager.getSessionId()).toBe(sourceId);
		expect(turns[0]!.signal?.aborted).toBe(false);
		expect(await Bun.file(recordPath).text()).toBe(originalRecord);
	});

	it("deletes an inactive picker entry without interrupting the current BTW", async () => {
		const target = await targetSession();
		const panel = await picker(target);
		const removed = Promise.withResolvers<void>();
		const remove = FileSessionStorage.prototype.deleteSessionWithArtifacts;
		vi.spyOn(FileSessionStorage.prototype, "deleteSessionWithArtifacts").mockImplementation(
			async function (this: FileSessionStorage, file) {
				await remove.call(this, file);
				removed.resolve();
			},
		);
		panel.handleInput("\x1b[3~");
		panel.handleInput("\n");
		await removed.promise;
		expect(await Bun.file(target).exists()).toBe(false);
		expect(manager.getSessionId()).toBe(sourceId);
		expect(turns[0]!.signal?.aborted).toBe(false);
		expect(await Bun.file(recordPath).text()).toBe(originalRecord);
	});

	describe.each(["initial", "reinitialized"] as const)("%s extension command context", binding => {
		async function transition(action: "newSession" | "switchSession" | "branch") {
			const controller = new ExtensionUiController(mode);
			await controller.initHooksAndCustomTools();
			if (binding === "reinitialized") controller.initializeHookRunner(extensionRunner.getUIContext(), true);
			const context = extensionRunner.createCommandContext();
			const target = action === "switchSession" ? await targetSession() : manager.getLeafId()!;
			return () => {
				if (action === "newSession") return context.newSession();
				if (action === "switchSession") return context.switchSession(target);
				return context.branch(target);
			};
		}

		it.each(["newSession", "switchSession", "branch"] as const)(
			"%s settles BTW before switching and ignores the old request's late answer",
			async action => {
				const run = await transition(action);
				expect(await run()).toEqual({ cancelled: false });
				expect(manager.getSessionId()).not.toBe(sourceId);
				expect(turns[0]!.signal?.aborted).toBe(true);
				const saved = await Bun.file(recordPath).text();
				expect(JSON.parse(saved).status).toBe("cancelled");
				turns[0]!.resolve(answer("Late answer from the old session"));
				await Promise.resolve();
				await btw.flush();
				expect(await Bun.file(recordPath).text()).toBe(saved);
				await mode.handleBtwCommand("Side question in the destination");
				expect(turns).toHaveLength(2);
				turns[1]!.resolve(answer("Destination answer"));
				await Promise.resolve();
				await btw.flush();
				expect(
					(await BtwHistoryStore.open(manager.getArtifactsDir() ?? undefined))
						.getRecords()
						.find(record => record.question === "Side question in the destination")?.answer,
				).toBe("Destination answer");
			},
		);

		it.each(["newSession", "switchSession", "branch"] as const)(
			"%s leaves the source session intact when the BTW checkpoint cannot be saved",
			async action => {
				const run = await transition(action);
				const corrupt = "{invalid checkpoint";
				await Bun.write(recordPath, corrupt);
				try {
					await expect(run()).rejects.toThrow("BTW history could not be saved");
					expect(manager.getSessionId()).toBe(sourceId);
					expect(await Bun.file(sourceFile).exists()).toBe(true);
					expect(await Bun.file(recordPath).text()).toBe(corrupt);
				} finally {
					await Bun.write(recordPath, originalRecord);
				}
			},
		);
	});
});
