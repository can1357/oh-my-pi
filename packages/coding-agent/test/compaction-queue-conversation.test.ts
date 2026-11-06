import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import { generateRoomKey, importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import * as collabCrypto from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabGuestLink } from "@oh-my-pi/pi-coding-agent/collab/guest";
import { COLLAB_PROTO, formatCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { startLocalRelay } from "../../collab-web/scripts/local-relay";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import { getEditorTheme } from "@oh-my-pi/pi-tui/theme/tui-adapters";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";
import { assistantMsg } from "./utilities";

const cleanups: Array<() => Promise<void>> = [];
const originalImage = { type: "image" as const, mimeType: "image/png", data: "b2xk" };
const newerImage = { type: "image" as const, mimeType: "image/png", data: "bmV3" };

beforeEach(async () => {
	const theme = await getThemeByName("dark");
	if (!theme) throw new Error("Expected bundled dark theme");
	setThemeInstance(theme);
});

afterEach(async () => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function harness(factory?: ExtensionFactory) {
	const dir = TempDir.createSync("@omp-queue-conversation-");
	const auth = await AuthStorage.create(":memory:");
	auth.keys.setRuntime("anthropic", "test-key");
	const registry = new ModelRegistry(auth, dir.join("models.yml"));
	const manager = SessionManager.create(dir.path(), dir.join("sessions"));
	const runtime = new ExtensionRuntime();
	const runner = factory
		? new ExtensionRunner(
				[await loadExtensionFromFactory(factory, dir.path(), new EventBus(), runtime, "queue-conversation")],
				runtime,
				dir.path(),
				manager,
				registry,
			)
		: undefined;
	const mock = createMockModel({ responses: [{ content: ["done"] }] });
	const agent = new Agent({
		initialState: { model: getBundledModel("anthropic", "claude-sonnet-4-5")!, systemPrompt: ["Test"], tools: [] },
		streamFn: mock.stream,
	});
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		modelRegistry: registry,
		extensionRunner: runner,
		settings: Settings.isolated({
			"compaction.enabled": false,
			"compaction.keepRecentTokens": 1,
			"retry.enabled": false,
		}),
	});
	const editor = new CustomEditor(getEditorTheme());
	const history = HistoryStorage.open(dir.join("history.db"));
	editor.setHistoryStorage(history);
	const ctx = createInteractiveModeContext({
		session,
		sessionManager: manager,
		editor,
		skillCommands: new Map<string, Skill>(),
		fileSlashCommands: new Set<string>(),
		compactionQueuedMessages: [],
		recordLocalSubmission: () => () => {},
		withLocalSubmission: async <T>(_text: string, fn: () => Promise<T>) => fn(),
		clearTransientSessionUi: () => {},
		resetTranscript: () => {},
		reloadTodos: async () => {},
		runYieldCompaction: () => {},
		eventController: {
			resetTranscriptAnchors: () => {},
			takeDisplaceableComponents: () => [],
			dispatchSessionEvent: async () => {},
		},
		statusLine: {
			setCollabStatus: () => {},
			resetActiveTime: () => {},
		},
		resetObserverRegistry: () => {},
		syncRunningSubagentBadge: () => {},
	});
	const helpers = new UiHelpers(ctx);
	const input = new InputController(ctx);
	const commands = new CommandController(ctx);
	ctx.isKnownSlashCommand = text => helpers.isKnownSlashCommand(text);
	ctx.queueCompactionMessage = (...args) => helpers.queueCompactionMessage(...args);
	ctx.restoreCompactionQueueToEditor = (...args) => input.restoreCompactionQueueToEditor(...args);
	ctx.flushCompactionQueue = options => helpers.flushCompactionQueue(options);
	ctx.handleNewCommand = () => commands.handleClearCommand();
	cleanups.push(async () => {
		await session.dispose();
		auth.close();
		HistoryStorage.close();
		await dir.remove();
	});
	return { dir, auth, registry, manager, session, agent, editor, history, ctx, helpers, input, commands };
}

describe("compaction queue conversation ownership", () => {
	it("keeps newer illustrated follow-up queued during an admitted prompt rollback", async () => {
		const h = await harness();
		const credentials = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const reported = Promise.withResolvers<void>();
		vi.spyOn(h.registry, "getApiKey").mockImplementation(async () => {
			credentials.resolve();
			await release.promise;
			return undefined;
		});
		vi.spyOn(h.ctx, "showError").mockImplementation(() => reported.resolve());
		h.helpers.queueCompactionMessage("old [Image #1]", "followUp", [originalImage]);
		const old = h.ctx.compactionQueuedMessages[0];
		await h.helpers.flushCompactionQueue({ willRetry: false });
		await credentials.promise;
		h.editor.setText("/compact");
		await h.input.handleFollowUp();
		expect(h.ctx.yieldCompaction).toBeDefined();
		h.editor.pendingImages = [newerImage];
		h.editor.pendingImageLinks = ["local://newer.png"];
		h.editor.imageLinks = h.editor.pendingImageLinks;
		h.editor.setText("newer [Image #1]");
		await h.input.handleFollowUp();
		const newer = h.ctx.compactionQueuedMessages[0];
		h.editor.pendingImages = [newerImage];
		h.editor.pendingImageLinks = ["local://draft.png"];
		h.editor.imageLinks = h.editor.pendingImageLinks;
		h.editor.setText("draft after both [Image #1]");
		release.resolve();
		await reported.promise;

		expect(h.ctx.compactionQueuedMessages).toEqual([old, newer]);
		expect(h.ctx.compactionQueuedMessages[0]).toBe(old);
		expect(h.ctx.compactionQueuedMessages[1]).toBe(newer);
		expect(newer?.images).toEqual([newerImage]);
		h.input.restoreCompactionQueueToEditor();
		expect(h.editor.getExpandedText()).toContain("old [Image #2]");
		expect(h.editor.getExpandedText()).toContain("newer [Image #3]");
		expect(h.editor.getExpandedText()).toContain("draft after both [Image #1]");
		expect(h.editor.pendingImages).toEqual([newerImage, originalImage, newerImage]);
		expect(h.editor.pendingImageLinks[0]).toBe("local://draft.png");
		expect(h.editor.imageLinks?.[0]).toBe("local://draft.png");
	});

	it.each([
		{ firstCompletion: 0, lookupThrows: false },
		{ firstCompletion: 1, lookupThrows: false },
		{ firstCompletion: 0, lookupThrows: true },
		{ firstCompletion: 1, lookupThrows: true },
	])("keeps detached batches ordered after real manual compaction (%j)", async ({ firstCompletion, lookupThrows }) => {
		const compactEntered = Promise.withResolvers<void>();
		const compactRelease = Promise.withResolvers<void>();
		const h = await harness(pi => {
			pi.on("session_before_compact", async event => {
				compactEntered.resolve();
				await compactRelease.promise;
				return {
					compaction: {
						summary: "Earlier completed work.",
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
					},
				};
			});
		});
		h.manager.appendMessage({ role: "user", content: "completed request one", timestamp: 1 });
		h.manager.appendMessage(assistantMsg("completed answer one"));
		h.manager.appendMessage({ role: "user", content: "completed request two", timestamp: 2 });
		h.manager.appendMessage(assistantMsg("completed answer two"));
		h.agent.replaceMessages(h.manager.buildSessionContext().messages);
		const reached = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
		const release = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
		const reports = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
		let lookups = 0;
		let reported = 0;
		vi.spyOn(h.registry, "getApiKey").mockImplementation(async () => {
			const index = lookups++;
			if (index > 1) throw new Error("unexpected extra credential lookup");
			reached[index].resolve();
			await release[index].promise;
			if (lookupThrows) throw new Error("Credential lookup failed");
			return undefined;
		});
		let observeRecovery = false;
		const report = () => {
			if (!observeRecovery) return;
			const index = reported++;
			reports[index]?.resolve();
		};
		vi.spyOn(h.ctx, "showError").mockImplementation(report);
		vi.spyOn(h.ctx, "showStatus").mockImplementation(report);
		h.helpers.queueCompactionMessage("older detached batch", "followUp");
		const older = h.ctx.compactionQueuedMessages[0];
		await h.helpers.flushCompactionQueue({ willRetry: false });
		await reached[0].promise;
		const compacting = h.commands.executeCompaction({ suppressContinuation: true });
		try {
			await compactEntered.promise;
			h.editor.setText("newer detached batch");
			await h.input.handleFollowUp();
			const newer = h.ctx.compactionQueuedMessages[0];
			compactRelease.resolve();
			expect(await compacting).toBe("ok");
			await reached[1].promise;
			observeRecovery = true;
			release[firstCompletion].resolve();
			await reports[0].promise;
			release[1 - firstCompletion].resolve();
			await reports[1].promise;
			expect(h.ctx.compactionQueuedMessages).toEqual([older, newer]);
			expect(h.ctx.compactionQueuedMessages[0]).toBe(older);
			expect(h.ctx.compactionQueuedMessages[1]).toBe(newer);
			expect(h.session.getQueuedMessages()).toMatchObject({ steering: [], followUp: [] });
		} finally {
			compactRelease.resolve();
			for (const barrier of release) barrier.resolve();
			await compacting;
			await h.session.waitForAdmittedSubmissions();
		}
	});

	it("consumes a real queued /new once and restores only its old-conversation remainder", async () => {
		const h = await harness();
		const oldId = h.manager.getSessionId();
		const newSession = vi.spyOn(h.session, "newSession");
		const prompt = vi.spyOn(h.session, "prompt");
		const showError = vi.spyOn(h.ctx, "showError");
		h.helpers.queueCompactionMessage("/new", "followUp");
		h.helpers.queueCompactionMessage("old conversation question [Image #1]", "followUp", [originalImage]);
		h.editor.pendingImages = [newerImage];
		h.editor.pendingImageLinks = ["local://newer.png"];
		h.editor.imageLinks = h.editor.pendingImageLinks;
		h.editor.setText("new draft [Image #1]");

		await h.helpers.flushCompactionQueue({ willRetry: false });
		await h.session.waitForIdle();

		expect(h.ctx.session).toBe(h.session);
		expect(h.manager.getSessionId()).not.toBe(oldId);
		expect(newSession).toHaveBeenCalledTimes(1);
		expect(showError.mock.calls).toEqual([]);
		expect(prompt).not.toHaveBeenCalled();
		expect(h.ctx.compactionQueuedMessages).toEqual([]);
		expect(h.editor.getExpandedText()).toBe("old conversation question [Image #2]\n\nnew draft [Image #1]");
		expect(h.editor.pendingImages).toEqual([newerImage, originalImage]);
		expect(h.editor.pendingImageLinks[0]).toBe("local://newer.png");
		expect(JSON.stringify(h.manager.getEntries())).not.toContain("old conversation question");
		await h.helpers.flushCompactionQueue({ willRetry: false });
		expect(newSession).toHaveBeenCalledTimes(1);
	});

	it.each([false, true])(
		"returns a late old-conversation cancellation or failure without taking the newer queue or its origin (lookup throws=%s)",
		async lookupThrows => {
			const h = await harness();
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const reported = Promise.withResolvers<void>();
			const unownedDrop = vi.fn();
			h.session.setPromptDropped(unownedDrop);
			vi.spyOn(h.registry, "getApiKey").mockImplementation(async () => {
				entered.resolve();
				await release.promise;
				if (lookupThrows) throw new Error("Credential lookup failed");
				return undefined;
			});
			try {
				h.helpers.queueCompactionMessage("old origin [Image #1]", "followUp", [originalImage]);
				await h.helpers.flushCompactionQueue({ willRetry: false });
				await entered.promise;
				await h.session.newSession();
				h.helpers.queueCompactionMessage("new origin [Image #1]", "followUp", [newerImage]);
				const newer = h.ctx.compactionQueuedMessages[0];
				const newerOrigin = h.ctx.compactionQueueOrigin;
				h.editor.pendingImages = [newerImage];
				h.editor.pendingImageLinks = ["local://current.png"];
				h.editor.imageLinks = h.editor.pendingImageLinks;
				h.editor.setText("current draft [Image #1]");
				const recorded = h.history.getRecent(10);
				vi.spyOn(h.ctx, "showError").mockImplementation(() => reported.resolve());
				vi.spyOn(h.ctx, "showStatus").mockImplementation(() => reported.resolve());
				release.resolve();
				await reported.promise;

				expect(h.ctx.compactionQueuedMessages).toEqual([newer]);
				expect(h.ctx.compactionQueueOrigin).toBe(newerOrigin);
				expect(h.editor.getExpandedText()).toBe("old origin [Image #2]\n\ncurrent draft [Image #1]");
				expect(h.editor.pendingImages).toEqual([newerImage, originalImage]);
				expect(h.editor.pendingImageLinks[0]).toBe("local://current.png");
				expect(h.history.getRecent(10)).toEqual(recorded);
				expect(JSON.stringify(h.manager.getEntries())).not.toContain("old origin");
				// Batch recovery replaces generic host recovery; running both would duplicate or discard input.
				expect(unownedDrop).not.toHaveBeenCalled();
			} finally {
				release.resolve();
				await h.session.waitForAdmittedSubmissions();
			}
		},
	);

	it("rejects stale first admission after real deferred-extension loading without duplicate editor recovery", async () => {
		const h = await harness();
		const loading = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		h.session.setDeferredExtensionLoader(async () => {
			loading.resolve();
			await release.promise;
		});
		const prompt = vi.spyOn(h.session, "prompt");
		h.helpers.queueCompactionMessage("before deferred loading", "followUp");
		await h.helpers.flushCompactionQueue({ willRetry: false });
		await loading.promise;
		await h.session.newSession();
		h.editor.setText("current draft");
		const recovered = Promise.withResolvers<void>();
		vi.spyOn(h.ctx, "showStatus").mockImplementation(() => recovered.resolve());
		release.resolve();
		const [result] = await Promise.allSettled([prompt.mock.results[0]?.value]);
		await recovered.promise;

		expect(result.status).toBe("rejected");
		expect(h.editor.getExpandedText()).toBe("before deferred loading\n\ncurrent draft");
		expect(h.ctx.compactionQueuedMessages).toEqual([]);
		expect(JSON.stringify(h.manager.getEntries())).not.toContain("before deferred loading");
		expect(h.session.getQueuedMessages()).toMatchObject({ steering: [], followUp: [] });
	});

	it("admits deferred input in the original conversation after a real adopted switch rolls back", async () => {
		const h = await harness();
		const originalId = h.manager.getSessionId();
		const targetCwd = h.dir.join("target-cwd");
		await fs.mkdir(targetCwd);
		const target = SessionManager.create(targetCwd, h.dir.join("target-sessions"));
		await target.ensureOnDisk();
		const targetFile = target.getSessionFile()!;
		await target.close();
		const loading = Promise.withResolvers<void>();
		const loaderRelease = Promise.withResolvers<void>();
		const adopted = Promise.withResolvers<void>();
		const rollbackRelease = Promise.withResolvers<void>();
		h.session.setDeferredExtensionLoader(async () => {
			loading.resolve();
			await loaderRelease.promise;
		});
		const prompt = vi.spyOn(h.session, "prompt");
		h.helpers.queueCompactionMessage("original conversation input", "followUp");
		await h.helpers.flushCompactionQueue({ willRetry: false });
		await loading.promise;
		const switching = h.session.switchSession(targetFile, {
			keepModel: true,
			onCwdChange: async () => {
				adopted.resolve();
				await rollbackRelease.promise;
				return false;
			},
		});
		try {
			await adopted.promise;
			expect(h.manager.getSessionId()).not.toBe(originalId);
			expect(h.session.isSessionTransitioning).toBe(true);
			loaderRelease.resolve();
			await h.session.loadDeferredExtensions();
			// Give the actual SDK continuation a turn while the real transition
			// still owns temporary B. No fixed microtask count or sleep guesses.
			const turn = Promise.withResolvers<void>();
			setImmediate(turn.resolve);
			await turn.promise;
			rollbackRelease.resolve();
			expect(await switching).toBe(false);
			const [dispatch] = await Promise.allSettled([prompt.mock.results[0]?.value]);
			expect(dispatch).toMatchObject({ status: "fulfilled", value: true });
			await h.session.waitForAdmittedSubmissions();

			expect(h.manager.getSessionId()).toBe(originalId);
			expect(h.ctx.compactionQueuedMessages).toEqual([]);
			expect(h.editor.getExpandedText()).toBe("");
			expect(h.manager.getEntries()).toContainEqual(
				expect.objectContaining({
					type: "message",
					message: expect.objectContaining({
						role: "user",
						content: expect.arrayContaining([
							expect.objectContaining({ type: "text", text: "original conversation input" }),
						]),
					}),
				}),
			);
		} finally {
			loaderRelease.resolve();
			rollbackRelease.resolve();
			await switching;
			await h.session.waitForAdmittedSubmissions();
		}
	});

	it.each([false, true])("returns a real no-socket guest batch in FIFO order (willRetry=%s)", async willRetry => {
		const h = await harness();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const importKey = collabCrypto.importRoomKey;
		vi.spyOn(collabCrypto, "importRoomKey").mockImplementation(async encoded => {
			const key = await importKey(encoded);
			entered.resolve();
			await release.promise;
			return key;
		});
		const guest = new CollabGuestLink(h.ctx);
		const joining = guest.join(formatCollabLink("ws://localhost:1", "FifoGuestAdmission", generateRoomKey()));
		const joined = Promise.allSettled([joining]);
		try {
			await entered.promise;
			const prompt = vi.spyOn(h.session, "prompt");
			h.helpers.queueCompactionMessage("first [Image #1]", "followUp", [originalImage]);
			h.helpers.queueCompactionMessage("second [Image #1]", "followUp", [newerImage]);
			h.editor.pendingImages = [newerImage];
			h.editor.pendingImageLinks = ["local://current.png"];
			h.editor.imageLinks = h.editor.pendingImageLinks;
			h.editor.setText("current [Image #1]");
			await h.helpers.flushCompactionQueue({ willRetry });

			expect(h.editor.getExpandedText()).toBe("first [Image #2]\n\nsecond [Image #3]\n\ncurrent [Image #1]");
			expect(h.editor.pendingImages).toEqual([newerImage, originalImage, newerImage]);
			expect(h.editor.pendingImageLinks[0]).toBe("local://current.png");
			expect(h.ctx.compactionQueuedMessages).toEqual([]);
			expect(prompt).not.toHaveBeenCalled();
		} finally {
			await guest.leave("cancel before socket creation");
			release.resolve();
			const [result] = await joined;
			expect(result.status).toBe("rejected");
		}
	});

	it.each([false, true])("rechecks a real switch after skill loading (cancel=%s)", async cancel => {
		const transitionEntered = Promise.withResolvers<void>();
		const transitionRelease = Promise.withResolvers<void>();
		const h = await harness(pi => {
			pi.on("session_before_switch", async () => {
				transitionEntered.resolve();
				await transitionRelease.promise;
				return cancel ? { cancel: true } : undefined;
			});
		});
		const target = SessionManager.create(h.dir.path(), h.dir.join("target"));
		await target.ensureOnDisk();
		const targetFile = target.getSessionFile()!;
		await target.close();
		const skillPath = h.dir.join("skill.md");
		await Bun.write(skillPath, "---\nname: held\n---\nOriginal conversation skill body.\n");
		h.ctx.skillCommands.set("skill:held", {
			name: "held",
			description: "",
			filePath: skillPath,
			baseDir: h.dir.path(),
			source: "test",
		});
		const loaded = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const build = h.session.buildUserSkillPrompt.bind(h.session);
		vi.spyOn(h.session, "buildUserSkillPrompt").mockImplementation(async (...args) => {
			const result = await build(...args);
			loaded.resolve();
			await release.promise;
			return result;
		});
		const prompt = vi.spyOn(h.session, "promptCustomMessage");
		h.helpers.queueCompactionMessage("/skill:held", "followUp");
		const originalId = h.manager.getSessionId();
		const flushing = h.helpers.flushCompactionQueue({ willRetry: false });
		await loaded.promise;
		const switching = h.session.switchSession(targetFile, { keepModel: true });
		await transitionEntered.promise;
		release.resolve();
		transitionRelease.resolve();
		expect(await switching).toBe(!cancel);
		await flushing;
		await h.session.waitForIdle();

		expect(h.manager.getSessionId() === originalId).toBe(cancel);
		if (cancel) {
			expect(prompt).toHaveBeenCalledTimes(1);
			await expect(prompt.mock.results[0]?.value).resolves.toBe(true);
			expect(h.editor.getExpandedText()).toBe("");
			expect(JSON.stringify(h.manager.getEntries())).toContain("Original conversation skill body.");
		} else {
			expect(prompt).not.toHaveBeenCalled();
			expect(h.editor.getExpandedText()).toBe("/skill:held");
			expect(JSON.stringify(h.manager.getEntries())).not.toContain("Original conversation skill body.");
		}
	});

	it.each(["compaction", "yield"] as const)(
		"recovers a published no-socket guest follow-up before local %s can capture it",
		async busy => {
			const busyEntered = Promise.withResolvers<void>();
			const busyRelease = Promise.withResolvers<void>();
			const h = await harness(pi => {
				pi.on("session_before_compact", async event => {
					busyEntered.resolve();
					await busyRelease.promise;
					return {
						compaction: {
							summary: "Completed earlier requests.",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					};
				});
			});
			await h.manager.ensureOnDisk();
			const relay = startLocalRelay();
			const roomKey = generateRoomKey();
			const key = await importRoomKey(roomKey);
			const host = new CollabSocket({ wsUrl: `${relay.url}/r/BusyGuestAdmission`, role: "host", key });
			const opened = Promise.withResolvers<void>();
			const received: string[] = [];
			host.onOpen = () => opened.resolve();
			host.onFrame = frame => {
				if (frame.t === "prompt") received.push(frame.text);
				if (frame.t === "hello")
					host.send({
						t: "welcome",
						proto: COLLAB_PROTO,
						header: { type: "session", id: "busy-host", timestamp: new Date(0).toISOString(), cwd: h.dir.path() },
						state: {
							isStreaming: false,
							queuedMessageCount: 0,
							cwd: h.dir.path(),
							participants: [{ name: "Host", role: "host" }],
						},
						agents: [],
						entryCount: 0,
					});
			};
			const keyEntered = Promise.withResolvers<void>();
			const keyRelease = Promise.withResolvers<void>();
			const guest = new CollabGuestLink(h.ctx);
			let joining: Promise<void> | undefined;
			let replica: string | undefined;
			let busyWork: Promise<unknown> | undefined;
			try {
				host.connect();
				await opened.promise;
				if (busy === "compaction") {
					h.manager.appendMessage({ role: "user", content: "completed request one", timestamp: 1 });
					h.manager.appendMessage(assistantMsg("completed answer one"));
					h.manager.appendMessage({ role: "user", content: "completed request two", timestamp: 2 });
					h.manager.appendMessage(assistantMsg("completed answer two"));
					h.agent.replaceMessages(h.manager.buildSessionContext().messages);
					busyWork = h.commands.executeCompaction({ suppressContinuation: true });
				} else {
					vi.spyOn(h.registry, "getApiKey").mockImplementation(async () => {
						busyEntered.resolve();
						await busyRelease.promise;
						return undefined;
					});
					busyWork = Promise.allSettled([h.session.prompt("admitted before joining")]);
				}
				await busyEntered.promise;
				if (busy === "yield") {
					h.editor.setText("/compact");
					await h.input.handleFollowUp();
				}
				const importKey = collabCrypto.importRoomKey;
				vi.spyOn(collabCrypto, "importRoomKey").mockImplementation(async encoded => {
					const result = await importKey(encoded);
					keyEntered.resolve();
					await keyRelease.promise;
					return result;
				});
				joining = guest.join(formatCollabLink(relay.url, "BusyGuestAdmission", roomKey));
				await keyEntered.promise;
				expect(h.ctx.collabGuest).toBe(guest);
				const prompt = vi.spyOn(h.session, "prompt");
				h.editor.pendingImages = [originalImage];
				h.editor.pendingImageLinks = ["local://submitted.png"];
				h.editor.imageLinks = h.editor.pendingImageLinks;
				h.editor.setText("not admitted [Image #1]");
				const submitting = h.input.handleFollowUp();
				h.editor.pendingImages = [newerImage];
				h.editor.pendingImageLinks = ["local://current.png"];
				h.editor.imageLinks = h.editor.pendingImageLinks;
				h.editor.setText("current [Image #1]");
				await submitting;

				expect(h.ctx.compactionQueuedMessages).toEqual([]);
				const recovered = "not admitted [Image #2]\n\ncurrent [Image #1]";
				expect(h.editor.getExpandedText()).toBe(recovered);
				expect(h.editor.pendingImages).toEqual([newerImage, originalImage]);
				expect(h.editor.pendingImageLinks).toEqual(["local://current.png", "local://submitted.png"]);
				expect(prompt).not.toHaveBeenCalled();
				busyRelease.resolve();
				await busyWork;
				keyRelease.resolve();
				await joining;
				replica = h.manager.getSessionFile();
				expect(h.editor.getExpandedText()).toBe(recovered);
				expect(received).toEqual([]);
			} finally {
				busyRelease.resolve();
				keyRelease.resolve();
				await busyWork;
				await joining;
				if (joining) replica ??= h.manager.getSessionFile();
				if (h.ctx.collabGuest) {
					h.ctx.handleResumeSession = async file => {
						await h.session.switchSession(file, { keepModel: true });
					};
					await guest.leave("cleanup");
				}
				host.close();
				relay.stop();
				if (replica) await fs.unlink(replica);
			}
		},
	);

	it.each(["join", "leave"] as const)(
		"recovers direct and queued guest input once throughout real %s restoration",
		async phase => {
			const h = await harness();
			await h.manager.ensureOnDisk();
			const localFile = h.manager.getSessionFile()!;
			const relay = startLocalRelay();
			const room = `QueueAdmission_${phase}`;
			const roomKey = generateRoomKey();
			const key = await importRoomKey(roomKey);
			const host = new CollabSocket({ wsUrl: `${relay.url}/r/${room}`, role: "host", key });
			const opened = Promise.withResolvers<void>();
			const received: string[] = [];
			const accepted = Promise.withResolvers<void>();
			const framesApplied = Promise.withResolvers<void>();
			host.onOpen = () => opened.resolve();
			host.onFrame = frame => {
				if (frame.t === "hello") {
					host.send({
						t: "welcome",
						proto: COLLAB_PROTO,
						header: {
							type: "session",
							id: "host-session",
							timestamp: new Date(0).toISOString(),
							cwd: h.dir.path(),
						},
						state: {
							isStreaming: false,
							queuedMessageCount: 0,
							cwd: h.dir.path(),
							participants: [{ name: "Host", role: "host" }],
						},
						agents: [],
						entryCount: 0,
					});
				} else if (frame.t === "prompt") {
					received.push(frame.text);
					accepted.resolve();
				} else if (frame.t === "abort") {
					framesApplied.resolve();
				}
			};
			const guest = new CollabGuestLink(h.ctx);
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			let replicaFile: string | undefined;
			let joining: Promise<void> | undefined;
			let leaving: Promise<void> | undefined;
			const prompt = vi.spyOn(h.session, "prompt");
			try {
				host.connect();
				await opened.promise;
				if (phase === "join") {
					const importKey = collabCrypto.importRoomKey;
					vi.spyOn(collabCrypto, "importRoomKey").mockImplementation(async encoded => {
						const result = await importKey(encoded);
						entered.resolve();
						await release.promise;
						return result;
					});
				}
				joining = guest.join(formatCollabLink(relay.url, room, roomKey));
				if (phase === "leave") {
					await joining;
					replicaFile = h.manager.getSessionFile();
					h.ctx.handleResumeSession = async file => {
						entered.resolve();
						await release.promise;
						await h.session.switchSession(file, { keepModel: true });
					};
					leaving = guest.leave("test");
				}
				await entered.promise;
				expect(h.ctx.collabGuest).toBe(guest);
				h.editor.pendingImages = [originalImage];
				h.editor.pendingImageLinks = ["local://direct.png"];
				h.editor.imageLinks = h.editor.pendingImageLinks;
				h.editor.setText("direct [Image #1]");
				await h.input.handleFollowUp();
				h.helpers.queueCompactionMessage("queued [Image #1]", "followUp", [newerImage], { preserveDraft: true });
				await h.helpers.flushCompactionQueue({ willRetry: false });
				const recovered = h.editor.getExpandedText();
				expect(recovered.match(/direct/g)).toHaveLength(1);
				expect(recovered.match(/queued/g)).toHaveLength(1);
				expect(h.editor.pendingImages).toEqual([originalImage, newerImage]);
				expect(h.editor.pendingImageLinks[0]).toBe("local://direct.png");
				expect(h.ctx.compactionQueuedMessages).toEqual([]);
				release.resolve();
				await joining;
				if (phase === "join") replicaFile = h.manager.getSessionFile();
				await leaving;
				// Snapshot activation and local restoration both clear transient queues.
				expect(h.editor.getExpandedText()).toBe(recovered);
				expect(h.editor.pendingImages).toEqual([originalImage, newerImage]);
				expect(h.editor.pendingImageLinks[0]).toBe("local://direct.png");
				expect(received).toEqual([]);
				expect(prompt).not.toHaveBeenCalled();
				expect(h.ctx.compactionQueuedMessages).toEqual([]);
				if (phase === "join") {
					guest.sendPrompt("accepted control");
					await accepted.promise;
					expect(received).toEqual(["accepted control"]);
					const hotkeys = vi.fn();
					hotkeys.mockImplementationOnce(() => {
						throw new Error("local command failed");
					});
					h.ctx.handleHotkeysCommand = hotkeys;
					h.helpers.queueCompactionMessage("accepted batch", "followUp", undefined, { preserveDraft: true });
					h.helpers.queueCompactionMessage("/hotkeys", "followUp", undefined, { preserveDraft: true });
					await h.helpers.flushCompactionQueue({ willRetry: false });
					await h.helpers.flushCompactionQueue({ willRetry: false });
					guest.sendAbort();
					await framesApplied.promise;
					expect(received).toEqual(["accepted control", "accepted batch"]);
					expect(hotkeys).toHaveBeenCalledTimes(2);
				} else {
					expect(h.manager.getSessionFile()).toBe(localFile);
					expect(h.ctx.collabGuest).toBeUndefined();
				}
			} finally {
				release.resolve();
				await joining?.catch(() => {});
				if (h.ctx.collabGuest) {
					h.ctx.handleResumeSession = async file => {
						await h.session.switchSession(file, { keepModel: true });
					};
					await guest.leave("cleanup");
				}
				host.close();
				relay.stop();
				if (replicaFile && replicaFile !== localFile) await fs.unlink(replicaFile);
			}
		},
	);
});
