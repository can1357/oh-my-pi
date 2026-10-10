import { afterEach, beforeAll, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type {
	ExtensionAskDialogResult,
	ExtensionUIContext,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { cfgDisplaySmoothStreaming } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { pidAlive } from "@oh-my-pi/pi-coding-agent/ipc/private-endpoint";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { loadReplica } from "@oh-my-pi/pi-coding-agent/session/replica-view";
import { spawnSessionHost } from "@oh-my-pi/pi-coding-agent/session-host/client";
import { HostedClientLink } from "@oh-my-pi/pi-coding-agent/session-host/hosted-client";
import type { SessionHostEntry } from "@oh-my-pi/pi-coding-agent/session-host/registry";
import type { CmuxKind } from "@oh-my-pi/pi-coding-agent/tools/browser/cmux/rpc";
import { CmuxSocketClient } from "@oh-my-pi/pi-coding-agent/tools/browser/cmux/socket-client";
import { acquireBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import {
	acquireTab,
	getTabsMapForTest,
	releaseTabsForOwner,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { USER_TODO_EDIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/tools/todo";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { formatContextUsage } from "@oh-my-pi/pi-tui/chrome/context-thresholds";
import { StatusLineComponent } from "@oh-my-pi/pi-tui/status-line";
import { createInteractiveModeContext } from "../helpers/interactive-mode-context";
import { createTestSession, isolateAgentDir } from "../helpers/rpc-server-harness";
import { statusLineHost } from "@oh-my-pi/pi-coding-agent/modes/status-line-host";
import { createAssistantMessage } from "../helpers/agent-session-setup";
import { SessionHostFixture, startProxy, type TestSessionHost, waitFor } from "../helpers/session-host-harness";

/** What the TUI's dialog presenter does: show, then settle with the user's answer or `undefined` when aborted. */
interface FakeDialog {
	title: string;
	signal: AbortSignal | undefined;
	/** The host epoch the view showed when the dialog was presented (`undefined` while the first snapshot applies). */
	epoch: number | undefined;
	/** How many transcript repaints had happened by then. */
	renders: number;
	/** The user answering. Has no effect once the dialog was aborted. */
	answer(value: unknown): void;
}

interface ViewOptions {
	replicaDir?: string;
	realEvents?: boolean;
	/** Render the real status line over the local session instead of recording `setCollabStatus` calls. */
	realStatusLine?: boolean;
	/** The local session is a passive replica (the only kind a hosted client accepts). Default true. */
	passiveReplica?: boolean;
}

/** An `InteractiveModeContext` over a real local `AgentSession`, with the presenter seams recorded. */
class View {
	readonly events: AgentSessionEvent[] = [];
	readonly dialogs: FakeDialog[] = [];
	readonly closed: { hostAlive: boolean; message: string }[] = [];
	readonly showStatus = vi.fn<(message: string) => void>();
	readonly showError = vi.fn<(message: string) => void>();
	readonly showWarning = vi.fn<(message: string) => void>();
	readonly showHookNotify = vi.fn<(message: string, type?: "info" | "warning" | "error") => void>();
	readonly setHookStatus = vi.fn<(key: string, text: string | undefined) => void>();
	readonly setHookWidget = vi.fn<(key: string, content: unknown, options?: { placement?: string }) => void>();
	readonly openInBrowser = vi.fn<(url: string) => void>();
	readonly setEditorText = vi.fn<(text: string) => void>();
	readonly setCollabStatus = vi.fn<(status: { role: string; participantCount: number } | null) => void>();
	/** While set, the next repaint waits for it: the view stays on the old session. */
	renderGate: PromiseWithResolvers<void> | undefined;
	/** While set, a repaint fails with it. */
	renderFailure: Error | undefined;
	/** How many times the view was asked to repaint the transcript. */
	renderCount = 0;
	/** While set, every session event waits in the view's event handler: the transcript chain is busy. */
	eventGate: PromiseWithResolvers<void> | undefined;
	/** How many session events reached the view's event handler (counted before the gate). */
	eventsEntered = 0;
	/** The todo list the view held each time the HUD reloaded it. */
	readonly todosShown: string[] = [];
	/** What each transcript repaint was handed: the messages of the branch the view shows. */
	readonly rendered: string[] = [];
	/** `session.thinkingLevel` as each `thinking_level_changed` handler would have read it. */
	readonly thinkingAtEvent: (ThinkingLevel | undefined)[] = [];
	statusLine: StatusLineComponent | undefined;
	readonly ctx: InteractiveModeContext;
	link: HostedClientLink | undefined;

	private constructor(
		readonly local: AgentSession,
		readonly replicaDir: string,
		realEvents: boolean,
		realStatusLine: boolean,
	) {
		const present = <T>(title: string, signal: AbortSignal | undefined): Promise<T | undefined> => {
			const { promise, resolve } = Promise.withResolvers<T | undefined>();
			this.dialogs.push({
				title,
				signal,
				epoch: this.link?.epoch,
				renders: this.renderCount,
				answer: value => resolve(value as T),
			});
			signal?.addEventListener("abort", () => resolve(undefined), { once: true });
			return promise;
		};
		this.ctx = createInteractiveModeContext({
			session: local,
			sessionManager: local.sessionManager,
			hostedClientMode: true,
			eventController: {
				handleEvent: async event => {
					this.eventsEntered++;
					await this.eventGate?.promise;
					this.events.push(event);
					// The real handler restyles the editor from the session's level at this moment.
					if (event.type === "thinking_level_changed") this.thinkingAtEvent.push(this.local.thinkingLevel);
				},
				resetTranscriptAnchors: () => {},
				takeDisplaceableComponents: () => [],
				restorePendingToolResults: () => {},
			},
			statusLine: { setCollabStatus: this.setCollabStatus },
			editor: { setText: this.setEditorText },
			renderInitialMessages: async () => {
				this.renderCount++;
				this.rendered.push(
					JSON.stringify(
						this.local.buildTranscriptSessionContext({
							collapseCompactedHistory: false,
							keepDanglingToolCalls: false,
						}).messages,
					),
				);
				if (this.renderFailure) throw this.renderFailure;
				await this.renderGate?.promise;
			},
			showStatus: this.showStatus,
			showError: this.showError,
			showWarning: this.showWarning,
			reloadTodos: async () => void this.todosShown.push(JSON.stringify(this.local.getTodoPhases())),
			showHookNotify: this.showHookNotify,
			setHookStatus: this.setHookStatus,
			setHookWidget: this.setHookWidget,
			openInBrowser: this.openInBrowser,
			showHookSelector: (title, _options, dialogOptions) => present<string>(title, dialogOptions?.signal),
			showHookConfirm: async (title, _message, dialogOptions) =>
				(await present<boolean>(title, dialogOptions?.signal)) === true,
			showHookInput: (title, _placeholder, dialogOptions) => present<string>(title, dialogOptions?.signal),
			showHookEditor: (title, _prefill, dialogOptions) => present<string>(title, dialogOptions?.signal),
			showAskDialog: (_questions, dialogOptions) => present<ExtensionAskDialogResult>("ask", dialogOptions?.signal),
		});
		if (realEvents) this.ctx.eventController = new EventController(this.ctx);
		if (realStatusLine) {
			this.statusLine = new StatusLineComponent(local, statusLineHost);
			this.statusLine.updateSettings({
				preset: "custom",
				leftSegments: ["model", "collab", "context_pct"],
				rightSegments: ["session_name"],
				separator: "powerline-thin",
				sessionAccent: false,
				transparent: false,
			});
			this.ctx.statusLine = this.statusLine;
		}
	}

	static async create(baseDir: string, options: ViewOptions = {}): Promise<View> {
		const dir = await fs.mkdtemp(path.join(baseDir, "view-"));
		const local = await createTestSession(dir, { handler: { content: ["never asked"] } }, undefined, {
			passiveReplica: options.passiveReplica ?? true,
		});
		return new View(
			local,
			options.replicaDir ?? path.join(dir, "replicas"),
			options.realEvents ?? false,
			options.realStatusLine ?? false,
		);
	}

	async connect(entry: SessionHostEntry): Promise<HostedClientLink> {
		this.link = await HostedClientLink.connect({
			ctx: this.ctx,
			entry,
			replicaDir: this.replicaDir,
			onClosed: reason => this.closed.push(reason),
		});
		return this.link;
	}

	get hostLink(): HostedClientLink {
		if (!this.link) throw new Error("view is not connected");
		return this.link;
	}

	/** Host-originated events of one type, in arrival order. */
	eventsOf<T extends AgentSessionEvent["type"]>(type: T): Extract<AgentSessionEvent, { type: T }>[] {
		return this.events.filter((event): event is Extract<AgentSessionEvent, { type: T }> => event.type === type);
	}

	/** The status line as the user reads it. */
	statusText(): string {
		if (!this.statusLine) throw new Error("view has no real status line");
		return Bun.stripANSI(this.statusLine.getTopBorder(240).content);
	}
	async close(): Promise<void> {
		await this.link?.detach();
		this.statusLine?.dispose();
		await this.local.dispose();
	}
}

let fixture: SessionHostFixture;
const views: View[] = [];

beforeEach(async () => {
	fixture = await SessionHostFixture.create();
});
afterEach(async () => {
	vi.restoreAllMocks();
	for (const view of views.splice(0)) await view.close();
	await fixture.dispose();
});

async function openView(options: ViewOptions & { baseDir?: string } = {}): Promise<View> {
	const view = await View.create(options.baseDir ?? fixture.dir, options);
	views.push(view);
	return view;
}

/** A link to `host` on a fresh view. */
async function attach(host: TestSessionHost, options: ViewOptions = {}): Promise<View> {
	const view = await openView(options);
	await view.connect(await fixture.entry(host));
	return view;
}

/** One finished turn on the host from a throwaway client. */
async function seedTurn(host: TestSessionHost, text: string): Promise<void> {
	const client = await fixture.client(host);
	await client.start();
	await client.promptAndWait(text);
	await client.detach();
}

/** A session's entries as a snapshot delivers them: serialized, without the host's in-memory bookkeeping. */
function wireEntries(session: AgentSession): SessionEntry[] {
	return JSON.parse(JSON.stringify(session.sessionManager.getEntries()));
}

/**
 * Which entries a session holds, in order. A live `entry` frame is a copy taken at append time, and the host may
 * still annotate its own entry afterwards (e.g. an assistant message's `errorId`), so live replicas are compared by shape.
 */
function entryShape(session: AgentSession): string[] {
	return session.sessionManager
		.getEntries()
		.map(entry => `${entry.id}:${entry.type}:${entry.type === "message" ? entry.message.role : ""}`);
}

const isAgentEnd = (event: AgentSessionEvent): boolean => event.type === "agent_end";

async function exists(file: string): Promise<boolean> {
	return fs.access(file).then(
		() => true,
		() => false,
	);
}

/** A directory listing without the dotfile lock sidecars some platforms keep beside session files. */
function visibleFiles(names: string[]): string[] {
	return names.filter(name => !name.startsWith(".")).sort();
}

/**
 * Holds the next atomic publish of `file` open until `release`, then lets it through or, with `failure`, fails it.
 * Every other write goes through untouched. `held` settles once the publish is waiting: an atomic batch is
 * staged by then, and none of its entries has been announced.
 */
function holdNextPublish(file: string | undefined, failure?: Error): { held: Promise<void>; release: () => void } {
	const publishText = FileSessionStorage.prototype.writeTextAtomic;
	const publishLines = FileSessionStorage.prototype.writeLinesAtomic;
	const held = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let armed = true;
	// Holds the first publish of `file` on either atomic path: the manager streams through
	// `writeLinesAtomic` when the storage has it and falls back to `writeTextAtomic` otherwise.
	const gate = async (target: string): Promise<void> => {
		if (!armed || target !== file) return;
		armed = false;
		held.resolve();
		await release.promise;
		if (failure) throw failure;
	};
	spyOn(FileSessionStorage.prototype, "writeTextAtomic").mockImplementation(
		async function (this: FileSessionStorage, target, content, options) {
			await gate(target);
			return publishText.call(this, target, content, options);
		},
	);
	spyOn(FileSessionStorage.prototype, "writeLinesAtomic").mockImplementation(
		async function (this: FileSessionStorage, target, lines, options) {
			await gate(target);
			return publishLines.call(this, target, lines, options);
		},
	);
	return { held: held.promise, release: release.resolve };
}

describe("HostedClientLink", () => {
	it("mirrors the host transcript into an owner-private replica and never writes the host file", async () => {
		const host = await fixture.startHost();
		await seedTurn(host, "first question");
		await host.session.sessionManager.flush();
		const hostFile = host.session.sessionFile!;
		const before = Buffer.from(await Bun.file(hostFile).arrayBuffer());

		const view = await attach(host);

		expect(view.local.sessionManager.getEntries()).toEqual(wireEntries(host.session));
		expect(view.local.sessionManager.getEntries().length).toBeGreaterThan(1);
		const replica = view.local.sessionFile!;
		expect(path.dirname(replica)).toBe(view.replicaDir);
		expect(path.basename(replica)).toStartWith(`${host.hostId}-`);
		expect(replica).not.toBe(hostFile);
		expect(Buffer.from(await Bun.file(hostFile).arrayBuffer()).equals(before)).toBe(true);
		if (process.platform !== "win32") {
			expect((await fs.stat(replica)).mode & 0o777).toBe(0o600);
			expect((await fs.stat(view.replicaDir)).mode & 0o777).toBe(0o700);
		}
		// The view is idle locally and streaming/queue state is the host's.
		expect(view.local.isStreaming).toBe(false);
		expect(view.hostLink.isStreaming).toBe(false);
	});

	it("keeps each client of a host on its own replica file, even in a shared directory", async () => {
		const host = await fixture.startHost();
		const shared = path.join(fixture.dir, "shared-replicas");
		const a = await attach(host, { replicaDir: shared });
		const b = await attach(host, { replicaDir: shared });
		expect(a.local.sessionFile).not.toBe(b.local.sessionFile);

		await a.hostLink.prompt("hi");
		await waitFor(() => a.events.some(isAgentEnd) && b.events.some(isAgentEnd));

		for (const view of [a, b]) {
			expect(entryShape(view.local)).toEqual(entryShape(host.session));
		}
		expect(await fs.readdir(shared)).toHaveLength(2);
	});

	it("shows the branch the host is on when its leaf is not the last entry, todo list included", async () => {
		const host = await fixture.startHost();
		const manager = host.session.sessionManager;
		const userText = (text: string) => ({ role: "user" as const, content: text, timestamp: Date.now() });
		const todos = (task: string): TodoPhase[] => [{ name: "Work", tasks: [{ content: task, status: "pending" }] }];
		manager.appendMessage(userText("root question"));
		const forkPoint = manager.appendMessage(createAssistantMessage("root answer"));
		manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: todos("task A") });
		const branchA = manager.appendMessage(userText("take branch A"));
		manager.branch(forkPoint);
		manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: todos("task B") });
		manager.appendMessage(userText("take branch B"));
		// The host navigated back: its active branch ends at A while the journal's last entry sits on B.
		manager.branch(branchA);
		expect(manager.getLeafId()).toBe(branchA);

		const view = await attach(host);

		expect(view.local.sessionManager.getLeafId()).toBe(branchA);
		// The branch the user sees: what the repaint was handed, and what the agent holds.
		for (const shown of [view.rendered.at(-1)!, JSON.stringify(view.local.messages)]) {
			expect(shown).toContain("take branch A");
			expect(shown).not.toContain("take branch B");
		}
		// The todo list: the replica's canonical state, and what the HUD loaded from it.
		expect(view.local.getTodoPhases()).toEqual(todos("task A"));
		expect(JSON.parse(view.todosShown.at(-1)!)).toEqual(todos("task A"));
		// Both branches are in the replica; only which one is active differs from a plain load.
		expect(entryShape(view.local)).toEqual(entryShape(host.session));

		// What the host appends next continues its branch, so the view follows A.
		manager.appendMessage(userText("continue branch A"));
		await waitFor(() => JSON.stringify(view.local.messages).includes("continue branch A"));
		expect(JSON.stringify(view.local.messages)).not.toContain("take branch B");
		expect(view.local.sessionManager.getLeafId()).toBe(manager.getLeafId());
	});

	it("keeps its branch when the host appends a retained result off it, and follows the next active append", async () => {
		const host = await fixture.startHost();
		const manager = host.session.sessionManager;
		const userText = (text: string) => ({ role: "user" as const, content: text, timestamp: Date.now() });
		const root = manager.appendMessage(userText("question"));
		const tip = manager.appendMessage(userText("tip"));
		const view = await attach(host);
		const seenAll = () => view.local.sessionManager.getEntries().length === manager.getEntries().length;

		// Late work for a branch the host has left (a retained background result), recorded without moving its leaf.
		const retained = manager.appendMessageToBranch(userText("retained result"), root);
		expect(manager.getLeafId()).toBe(tip);
		await waitFor(seenAll);

		expect(view.local.sessionManager.getEntries().some(entry => entry.id === retained)).toBe(true);
		expect(view.local.sessionManager.getLeafId()).toBe(tip);
		expect(JSON.stringify(view.local.messages)).not.toContain("retained result");

		// The next append on the host's branch continues from the tip, not from the retained entry.
		const next = manager.appendMessage(userText("continue"));
		await waitFor(seenAll);
		expect(view.local.sessionManager.getLeafId()).toBe(next);
		expect(view.local.sessionManager.getEntries().find(entry => entry.id === next)?.parentId).toBe(tip);
		const shown = JSON.stringify(view.local.messages);
		expect(shown.indexOf("question")).toBeLessThan(shown.indexOf("tip"));
		expect(shown.indexOf("tip")).toBeLessThan(shown.indexOf("continue"));
		expect(shown).not.toContain("retained result");
	});

	it("converges on the host's branch when a batch publishes while a rename, a retained result and a usage record are recorded", async () => {
		const host = await fixture.startHost();
		const manager = host.session.sessionManager;
		const userText = (text: string) => ({ role: "user" as const, content: text, timestamp: Date.now() });
		const root = manager.appendMessage(userText("question"));
		await manager.ensureOnDisk();
		const view = await attach(host);
		const publish = holdNextPublish(manager.getSessionFile());
		const commit = manager.appendEntriesAtomically(() => {
			manager.appendMessage(userText("batched one"));
			manager.appendMessage(userText("batched two"));
		});
		await publish.held;
		manager.appendMessageToBranch(userText("retained result"), root);
		manager.appendModelUsage(
			{
				purpose: "auto-thinking",
				role: "smol",
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-haiku-4-5",
				stopReason: "stop",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			},
			{ sessionId: manager.getSessionId(), parentId: root },
		);
		const renamed = manager.setSessionName("Named mid-batch", "user");
		publish.release();
		await commit;
		await renamed;
		await waitFor(() => entryShape(view.local).length === entryShape(host.session).length);

		// Every entry arrived in the order the host recorded it, and the view ended on the host's leaf without
		// ever meeting a leaf whose entry it did not hold yet.
		expect(view.closed).toEqual([]);
		expect(view.showError).not.toHaveBeenCalled();
		expect(entryShape(view.local)).toEqual(entryShape(host.session));
		expect(view.local.sessionManager.getLeafId()).toBe(manager.getLeafId());
		expect(view.local.sessionManager.getBranch().map(entry => entry.id)).toEqual(
			manager.getBranch().map(entry => entry.id),
		);
		const shown = JSON.stringify(view.local.messages);
		expect(shown).toContain("batched one");
		expect(shown).toContain("batched two");
		expect(shown).not.toContain("retained result");
		expect(view.local.sessionManager.getSessionName()).toBe("Named mid-batch");
	});

	it("starts a client that attaches while a batch publishes from what was announced, and shows the batch once when it commits", async () => {
		const host = await fixture.startHost();
		const manager = host.session.sessionManager;
		const userText = (text: string) => ({ role: "user" as const, content: text, timestamp: Date.now() });
		const root = manager.appendMessage(userText("question"));
		await manager.ensureOnDisk();
		const announced = entryShape(host.session);
		const publish = holdNextPublish(manager.getSessionFile());
		const commit = manager.appendEntriesAtomically(() => {
			manager.appendMessage(userText("batched one"));
			manager.appendMessage(userText("batched two"));
		});
		await publish.held;
		const renamed = manager.setSessionName("Named mid-batch", "user");
		expect(entryShape(host.session)).toHaveLength(announced.length + 3);

		// The newcomer sees the session as announced: none of the staged rows, not their leaf, not the new name.
		const view = await attach(host);
		expect(entryShape(view.local)).toEqual(announced);
		expect(view.local.sessionManager.getLeafId()).toBe(root);
		expect(view.local.sessionManager.getSessionName()).toBeUndefined();
		expect(JSON.stringify(view.local.messages)).toContain("question");
		expect(JSON.stringify(view.local.messages)).not.toContain("batched");

		publish.release();
		await commit;
		await renamed;
		await waitFor(() => entryShape(view.local).length === entryShape(host.session).length);

		// Each staged row arrives once, in the host's order, and the view ends on the host's branch.
		expect(view.closed).toEqual([]);
		expect(entryShape(view.local)).toEqual(entryShape(host.session));
		expect(view.local.sessionManager.getLeafId()).toBe(manager.getLeafId());
		expect(view.local.sessionManager.getBranch().map(entry => entry.id)).toEqual(
			manager.getBranch().map(entry => entry.id),
		);
		const shown = JSON.stringify(view.local.messages);
		expect(shown.indexOf("question")).toBeLessThan(shown.indexOf("batched one"));
		expect(shown.indexOf("batched one")).toBeLessThan(shown.indexOf("batched two"));
		expect(view.local.sessionManager.getSessionName()).toBe("Named mid-batch");
	});

	it("never shows a client that attached while a batch was publishing the rows of that batch when it rolls back", async () => {
		const host = await fixture.startHost();
		const manager = host.session.sessionManager;
		const userText = (text: string) => ({ role: "user" as const, content: text, timestamp: Date.now() });
		const root = manager.appendMessage(userText("question"));
		await manager.ensureOnDisk();
		const announced = entryShape(host.session);
		const publish = holdNextPublish(manager.getSessionFile(), new Error("publish failed"));
		const commit = manager.appendEntriesAtomically(() => {
			manager.appendMessage(userText("staged one"));
			manager.appendMessage(userText("staged two"));
		});
		const outcome = commit.then(
			() => "committed",
			(error: Error) => error.message,
		);
		await publish.held;
		const retained = manager.appendMessageToBranch(userText("retained result"), root);

		const view = await attach(host);
		expect(entryShape(view.local)).toEqual(announced);
		expect(view.local.sessionManager.getLeafId()).toBe(root);
		expect(JSON.stringify(view.local.messages)).not.toContain("staged");

		// The host tells its operator on stderr that the publish failed (the persistence surface every RPC server
		// registers); the test captures it instead of printing it, and checks it was said.
		const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
		let written = "";
		try {
			publish.release();
			expect(await outcome).toBe("publish failed");
			await waitFor(() => entryShape(view.local).length === entryShape(host.session).length);
			written = stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
		} finally {
			stderr.mockRestore();
		}
		expect(written).toContain("Session persistence");

		// The rolled-back rows were never there to undo; the row recorded meanwhile survived and arrived once.
		expect(view.closed).toEqual([]);
		expect(entryShape(view.local)).toEqual([...announced, `${retained}:message:user`]);
		expect(entryShape(view.local)).toEqual(entryShape(host.session));
		expect(view.local.sessionManager.getLeafId()).toBe(root);
		expect(manager.getLeafId()).toBe(root);
		expect(JSON.stringify(view.local.messages)).not.toContain("staged");
		expect(JSON.stringify(view.local.messages)).not.toContain("retained result");
	});

	it("sends a prompt to the host and renders one turn from its events", async () => {
		const host = await fixture.startHost();
		const a = await attach(host);
		const b = await attach(host);

		await a.hostLink.prompt("hi");
		await waitFor(() => a.events.some(isAgentEnd) && b.events.some(isAgentEnd));

		const messageEntries = host.session.sessionManager.getEntries().filter(entry => entry.type === "message");
		expect(messageEntries.map(entry => (entry.type === "message" ? entry.message.role : ""))).toEqual([
			"user",
			"assistant",
		]);
		for (const view of [a, b]) {
			expect(view.eventsOf("agent_start")).toHaveLength(1);
			expect(view.eventsOf("agent_end")).toHaveLength(1);
			expect(view.eventsOf("message_start").map(event => event.message.role)).toEqual(["user", "assistant"]);
			expect(view.eventsOf("message_end").map(event => event.message.role)).toEqual(["user", "assistant"]);
			expect(entryShape(view.local)).toEqual(entryShape(host.session));
			expect(view.hostLink.isStreaming).toBe(false);
		}
		// The local replicas never ran a model call of their own.
		expect(a.local.isStreaming).toBe(false);
	});

	it("resolves a startup prompt only once its turn has ended, so the next one is not steered into it", async () => {
		const release = Promise.withResolvers<void>();
		const host = await fixture.startHost({}, release.promise);
		try {
			const a = await attach(host);
			// A command the host answers itself starts no turn and gets no prompt_result: it must not hang.
			await a.hostLink.promptToCompletion("/session");
			let settled = false;
			const first = a.hostLink.promptToCompletion("A").then(() => {
				settled = true;
			});
			await waitFor(() => a.hostLink.isStreaming);
			// Admitted after A on the same connection: A's own admission response has been read by now.
			await a.hostLink.prompt("B", undefined, "followUp");
			expect(settled).toBe(false);
			release.resolve();
			await first;
		} finally {
			release.resolve();
		}
	});

	it("renders a partial message once for a client that attaches mid-turn", async () => {
		const release = Promise.withResolvers<void>();
		const host = await fixture.startHost({}, release.promise);
		const a = await attach(host);
		await a.hostLink.prompt("go");
		await waitFor(() => a.eventsOf("message_update").length > 0);

		const late = await attach(host);
		expect(late.hostLink.isStreaming).toBe(true);
		const started = late.eventsOf("message_start").filter(event => event.message.role === "assistant");
		expect(started).toHaveLength(1);
		expect(late.events.findIndex(event => event.type === "message_update")).toBe(-1);

		release.resolve();
		await waitFor(() => late.events.some(isAgentEnd));
		// The first real delta continued the message: no second start, one end.
		expect(late.eventsOf("message_start").filter(event => event.message.role === "assistant")).toHaveLength(1);
		expect(late.eventsOf("message_end").filter(event => event.message.role === "assistant")).toHaveLength(1);
		expect(late.hostLink.isStreaming).toBe(false);
		expect(entryShape(late.local)).toEqual(entryShape(host.session));
	});

	it("lets the first answer to a host dialog win and dismisses the other client's dialog without a reply", async () => {
		let ui: ExtensionUIContext | undefined;
		const host = await fixture.startHost({ setToolUIContext: ctx => void (ui = ctx) });
		const a = await attach(host);
		const b = await attach(host);
		const sent = spyOn(RpcClient.prototype, "sendExtensionUiResponse");

		const confirmed = ui!.confirm("Proceed?", "Really?");
		await waitFor(() => a.dialogs.length === 1 && b.dialogs.length === 1);
		a.dialogs[0].answer(true);

		expect(await confirmed).toBe(true);
		await waitFor(() => b.dialogs[0].signal?.aborted === true);
		// A late answer from the dismissed dialog goes nowhere.
		b.dialogs[0].answer(false);
		await a.hostLink.abort();
		expect(sent).toHaveBeenCalledTimes(1);
		expect(sent.mock.calls[0][0]).toMatchObject({ type: "extension_ui_response", confirmed: true });
		expect(a.showError).not.toHaveBeenCalled();
	});

	it("withdraws a dialog when the host's cancel arrives, even while a slow event is still being applied", async () => {
		let ui: ExtensionUIContext | undefined;
		const host = await fixture.startHost({ setToolUIContext: ctx => void (ui = ctx) });
		const a = await attach(host);
		const b = await attach(host);
		const sent = spyOn(RpcClient.prototype, "sendExtensionUiResponse");
		const confirmed = ui!.confirm("Proceed?", "Really?");
		await waitFor(() => a.dialogs.length === 1 && b.dialogs.length === 1);

		// A's transcript chain is busy inside the first event of a turn that B starts.
		a.eventGate = Promise.withResolvers<void>();
		await b.hostLink.prompt("go");
		await waitFor(() => a.eventsEntered > 0);
		b.dialogs[0].answer(true);
		expect(await confirmed).toBe(true);

		// The cancel is acted on when it is received, not when the busy chain gets to it.
		await waitFor(() => a.dialogs[0].signal?.aborted === true);
		a.dialogs[0].answer(false);
		a.eventGate.resolve();
		await waitFor(() => a.events.some(isAgentEnd));
		expect(sent).toHaveBeenCalledTimes(1);
		expect(sent.mock.calls[0][0]).toMatchObject({ confirmed: true });
		expect(a.dialogs).toHaveLength(1);
	});

	it("withdraws the old view's dialog when a replacement arrives, even while a slow event is still being applied", async () => {
		let ui: ExtensionUIContext | undefined;
		const host = await fixture.startHost({ setToolUIContext: ctx => void (ui = ctx) });
		const a = await attach(host);
		const sent = spyOn(RpcClient.prototype, "sendExtensionUiResponse");
		const confirmed = ui!.confirm("Proceed?", "Really?");
		await waitFor(() => a.dialogs.length === 1);
		const oldEpoch = a.hostLink.epoch;

		a.eventGate = Promise.withResolvers<void>();
		const driver = await fixture.client(host);
		await driver.start();
		await driver.prompt("go");
		await waitFor(() => a.eventsEntered > 0);
		await host.session.newSession();

		// The replacement was received while the chain is busy: the dialog of the view it replaces is gone at once.
		await waitFor(() => a.dialogs[0].signal?.aborted === true);
		a.dialogs[0].answer(true);
		expect(sent).not.toHaveBeenCalled();

		// The snapshot lists the dialog as still open on the host, so the new view presents it once, and that one answers.
		a.eventGate.resolve();
		await waitFor(() => a.hostLink.epoch > oldEpoch && a.dialogs.length === 2);
		a.dialogs[1].answer(true);
		expect(await confirmed).toBe(true);
		expect(sent).toHaveBeenCalledTimes(1);
	});

	it("presents a dialog queued before a replacement only in the replacement's view", async () => {
		let ui: ExtensionUIContext | undefined;
		const host = await fixture.startHost({ setToolUIContext: ctx => void (ui = ctx) });
		const a = await attach(host);
		const sent = spyOn(RpcClient.prototype, "sendExtensionUiResponse");
		const oldEpoch = a.hostLink.epoch;
		const sessionFile = (await fixture.entry(host)).sessionFile;

		// A's transcript chain is busy inside the first event of a turn.
		a.eventGate = Promise.withResolvers<void>();
		const driver = await fixture.client(host);
		await driver.start();
		await driver.prompt("go");
		await waitFor(() => a.eventsEntered > 0);

		// The dialog, and then a replacement whose snapshot still lists it, are received behind that event.
		const confirmed = ui!.confirm("Proceed?", "Really?");
		await a.hostLink.abort();
		await host.session.newSession();
		await waitFor(async () => (await fixture.entry(host)).sessionFile !== sessionFile);
		await a.hostLink.abort();
		expect(a.dialogs).toHaveLength(0);

		a.eventGate.resolve();
		await waitFor(() => a.hostLink.epoch > oldEpoch && a.dialogs.length > 0);
		// It is shown once, by the view that replaced the one it was queued in, after that view's repaint.
		expect(a.dialogs).toHaveLength(1);
		expect(a.dialogs[0]).toMatchObject({ epoch: a.hostLink.epoch, renders: a.renderCount });
		a.dialogs[0].answer(true);
		expect(await confirmed).toBe(true);
		expect(sent).toHaveBeenCalledTimes(1);
		expect(a.dialogs).toHaveLength(1);
	});

	it("presents a dialog that two queued replacements both list only in the last of them", async () => {
		let ui: ExtensionUIContext | undefined;
		const host = await fixture.startHost({ setToolUIContext: ctx => void (ui = ctx) });
		const a = await attach(host);
		const sent = spyOn(RpcClient.prototype, "sendExtensionUiResponse");
		const confirmed = ui!.confirm("Proceed?", "Really?");
		await waitFor(() => a.dialogs.length === 1);
		const oldEpoch = a.hostLink.epoch;
		let sessionFile = (await fixture.entry(host)).sessionFile;

		a.eventGate = Promise.withResolvers<void>();
		const driver = await fixture.client(host);
		await driver.start();
		await driver.prompt("go");
		await waitFor(() => a.eventsEntered > 0);
		for (let replacement = 0; replacement < 2; replacement++) {
			const previous = sessionFile;
			await host.session.newSession();
			await waitFor(async () => {
				sessionFile = (await fixture.entry(host)).sessionFile;
				return sessionFile !== previous;
			});
		}
		await a.hostLink.abort();
		expect(a.dialogs[0].signal?.aborted).toBe(true);

		a.eventGate.resolve();
		await waitFor(() => a.hostLink.epoch > oldEpoch + 1 && a.dialogs.length > 1);
		// The first replacement's turn to present it came and went: only the last view shows it, once.
		expect(a.dialogs).toHaveLength(2);
		expect(a.dialogs[1]).toMatchObject({ epoch: a.hostLink.epoch, renders: a.renderCount });
		a.dialogs[0].answer(true);
		expect(sent).not.toHaveBeenCalled();
		a.dialogs[1].answer(true);
		expect(await confirmed).toBe(true);
		expect(sent).toHaveBeenCalledTimes(1);
	});

	it("does not present a dialog the host withdrew while the snapshot that lists it was still being applied", async () => {
		let ui: ExtensionUIContext | undefined;
		const host = await fixture.startHost({ setToolUIContext: ctx => void (ui = ctx) });
		const a = await attach(host);
		const b = await attach(host);
		const confirmed = ui!.confirm("Proceed?", "Really?");
		await waitFor(() => a.dialogs.length === 1 && b.dialogs.length === 1);
		const oldEpoch = a.hostLink.epoch;

		a.renderGate = Promise.withResolvers<void>();
		const repaints = a.renderCount;
		await host.session.newSession();
		// A is repainting the replacement, whose snapshot lists the open dialog; B shows it again at once.
		await waitFor(() => a.renderCount > repaints && b.dialogs.length === 2);
		b.dialogs[1].answer(true);
		expect(await confirmed).toBe(true);
		// Frames on A's connection arrive in order: once this abort is answered, the host's cancel has been received.
		await a.hostLink.abort();

		a.renderGate.resolve();
		await waitFor(() => a.hostLink.epoch > oldEpoch);
		// The withdrawn dialog was never put back on screen, not even for an instant.
		expect(a.dialogs).toHaveLength(1);
	});

	it("stays attached when the host replaces the session again before the view has reported its draft state for the first replacement", async () => {
		const host = await fixture.startHost();
		const a = await attach(host);
		const oldEpoch = a.hostLink.epoch;

		// A is still repainting the first replacement when the host moves on to a second one.
		a.renderGate = Promise.withResolvers<void>();
		const repaints = a.renderCount;
		await host.session.newSession();
		await waitFor(() => a.renderCount > repaints);
		await host.session.newSession();
		a.renderGate.resolve();

		await waitFor(() => a.hostLink.epoch > oldEpoch + 1 || a.closed.length > 0);
		// The first replacement is already out of date by the time its view settles; the second one is what A follows.
		expect(a.closed).toEqual([]);
		expect(a.showError).not.toHaveBeenCalled();
		expect(a.hostLink.epoch).toBeGreaterThan(oldEpoch + 1);
	});

	it("presents a dialog that was already open at attach time, and answers it", async () => {
		let ui: ExtensionUIContext | undefined;
		const host = await fixture.startHost({ setToolUIContext: ctx => void (ui = ctx) });
		const a = await attach(host);
		const picked = ui!.select("Pick one", ["x", { label: "y", description: "second" }]);
		await waitFor(() => a.dialogs.length === 1);

		const late = await attach(host);
		expect(late.dialogs).toHaveLength(1);
		expect(late.dialogs[0].title).toBe("Pick one");
		late.dialogs[0].answer("y");

		expect(await picked).toBe("y");
		await waitFor(() => a.dialogs[0].signal?.aborted === true);
		// Exactly one presentation per request, though the id arrived by snapshot.
		expect(late.dialogs).toHaveLength(1);
	});

	it("answers input, editor and cancelled dialogs in the shape the host expects", async () => {
		let ui: ExtensionUIContext | undefined;
		const host = await fixture.startHost({ setToolUIContext: ctx => void (ui = ctx) });
		const a = await attach(host);

		const typed = ui!.input("Name?", "placeholder");
		await waitFor(() => a.dialogs.length === 1);
		a.dialogs[0].answer("ada");
		expect(await typed).toBe("ada");

		const edited = ui!.editor("Notes", "seed text");
		await waitFor(() => a.dialogs.length === 2);
		a.dialogs[1].answer("edited text");
		expect(await edited).toBe("edited text");

		const refused = ui!.select("Pick", ["x"]);
		await waitFor(() => a.dialogs.length === 3);
		a.dialogs[2].answer(undefined);
		expect(await refused).toBeUndefined();
	});

	it("opts in to the rich ask dialog and returns its answers", async () => {
		let ui: ExtensionUIContext | undefined;
		const host = await fixture.startHost({ setToolUIContext: ctx => void (ui = ctx) });
		const a = await attach(host);
		expect(ui!.askDialog).toBeDefined();

		const asked = ui!.askDialog!([{ id: "q1", question: "Which?", options: [{ label: "A" }, { label: "B" }] }]);
		await waitFor(() => a.dialogs.length === 1);
		a.dialogs[0].answer({
			kind: "submit",
			results: [{ id: "q1", question: "Which?", options: ["A", "B"], multi: false, selectedOptions: ["B"] }],
		} satisfies ExtensionAskDialogResult);

		const result = await asked;
		expect(result).toMatchObject({ kind: "submit", results: [{ id: "q1", selectedOptions: ["B"] }] });
	});

	it("returns discuss-instead as chat and a dismissed ask as no answer", async () => {
		let ui: ExtensionUIContext | undefined;
		const host = await fixture.startHost({ setToolUIContext: ctx => void (ui = ctx) });
		const a = await attach(host);
		const questions = [{ id: "q1", question: "Which?", options: [{ label: "A" }, { label: "B" }] }];

		const discussed = ui!.askDialog!(questions);
		await waitFor(() => a.dialogs.length === 1);
		a.dialogs[0].answer({ kind: "chat" } satisfies ExtensionAskDialogResult);
		expect(await discussed).toEqual({ kind: "chat" });

		const dismissed = ui!.askDialog!(questions);
		await waitFor(() => a.dialogs.length === 2);
		a.dialogs[1].answer(undefined);
		expect(await dismissed).toBeUndefined();
	});

	it("keeps an ask answer's notes and pasted images on their way to the host", async () => {
		let ui: ExtensionUIContext | undefined;
		const host = await fixture.startHost({ setToolUIContext: ctx => void (ui = ctx) });
		const a = await attach(host);
		const noteImage = { type: "image", data: "bm90ZQ==", mimeType: "image/png" } as const;
		const answerImage = { type: "image", data: "YW5zd2Vy", mimeType: "image/jpeg" } as const;

		const asked = ui!.askDialog!([
			{ id: "q1", question: "Which?", options: [{ label: "A" }, { label: "B" }] },
			{ id: "q2", question: "Anything else?", options: [{ label: "C" }, { label: "D" }] },
		]);
		await waitFor(() => a.dialogs.length === 1);
		a.dialogs[0].answer({
			kind: "submit",
			results: [
				{
					id: "q1",
					question: "Which?",
					options: ["A", "B"],
					multi: false,
					selectedOptions: ["A"],
					note: "because [Image #1]",
					noteImages: [noteImage],
				},
				{
					id: "q2",
					question: "Anything else?",
					options: ["C", "D"],
					multi: false,
					selectedOptions: [],
					customInput: "see [Image #1]",
					customInputImages: [answerImage],
				},
			],
		} satisfies ExtensionAskDialogResult);

		const result = await asked;
		expect(result).toMatchObject({
			kind: "submit",
			results: [
				{ id: "q1", selectedOptions: ["A"], note: "because [Image #1]", noteImages: [noteImage] },
				{ id: "q2", selectedOptions: [], customInput: "see [Image #1]", customInputImages: [answerImage] },
			],
		});
		// Answers without notes or images stay free of the new fields.
		const plain = ui!.askDialog!([{ id: "q1", question: "Which?", options: [{ label: "A" }] }]);
		await waitFor(() => a.dialogs.length === 2);
		a.dialogs[1].answer({
			kind: "submit",
			results: [{ id: "q1", question: "Which?", options: ["A"], multi: false, selectedOptions: ["A"] }],
		} satisfies ExtensionAskDialogResult);
		const plainResult = await plain;
		expect(plainResult?.kind === "submit" && Object.keys(plainResult.results[0]).sort()).toEqual([
			"customInput",
			"id",
			"multi",
			"options",
			"question",
			"selectedOptions",
		]);
	});

	it("leaves a dialog unanswered on the host when the client detaches", async () => {
		let ui: ExtensionUIContext | undefined;
		const host = await fixture.startHost({ setToolUIContext: ctx => void (ui = ctx) });
		const a = await attach(host);
		const b = await attach(host);
		const sent = spyOn(RpcClient.prototype, "sendExtensionUiResponse");
		const confirmed = ui!.confirm("Proceed?", "Really?");
		await waitFor(() => a.dialogs.length === 1 && b.dialogs.length === 1);

		await a.hostLink.detach();
		expect(a.dialogs[0].signal?.aborted).toBe(true);
		a.dialogs[0].answer(false);
		await fixture.waitForClients(host, 1);

		expect(sent).not.toHaveBeenCalled();
		// The host kept running and the question stayed answerable by the remaining client.
		b.dialogs[0].answer(true);
		expect(await confirmed).toBe(true);
		expect(a.closed).toEqual([]);
	});

	it("shows a follow-up queued on the host in every client's queue", async () => {
		const release = Promise.withResolvers<void>();
		const host = await fixture.startHost({}, release.promise);
		const a = await attach(host);
		const b = await attach(host);
		await a.hostLink.prompt("go");
		await waitFor(() => a.hostLink.isStreaming && b.hostLink.isStreaming);

		await a.hostLink.prompt("later", undefined, "followUp");
		await waitFor(() => a.hostLink.queued.followUp.length === 1 && b.hostLink.queued.followUp.length === 1);
		expect(b.hostLink.queued).toEqual({ steering: [], followUp: ["later"] });

		expect(await b.hostLink.takeBackQueued()).toEqual({ outcome: "restored", text: "later" });
		await waitFor(() => a.hostLink.queued.followUp.length === 0 && b.hostLink.queued.followUp.length === 0);
		release.resolve();
		await waitFor(() => a.events.some(isAgentEnd));
	});

	describe("taking a queued message back", () => {
		/** A host held mid-turn by `go` from a first view, plus that view. */
		async function holdTurn(): Promise<{ host: TestSessionHost; view: View; release: () => void }> {
			const release = Promise.withResolvers<void>();
			const host = await fixture.startHost({}, release.promise);
			const view = await attach(host);
			await view.hostLink.prompt("go");
			await waitFor(() => view.hostLink.isStreaming);
			return { host, view, release: release.resolve };
		}

		it("takes nothing back when the host's report of which queued prompts carry attachments does not fit its queue", async () => {
			const release = Promise.withResolvers<void>();
			const host = await fixture.startHost({}, release.promise);
			// What a host that predates the report, or a frame that lost it, looks like to a reader that counts.
			vi.spyOn(host.session, "getQueuedMessageAttachments").mockReturnValue({ steering: [], followUp: [] });
			try {
				const live = await attach(host);
				await live.hostLink.prompt("go");
				await waitFor(() => live.hostLink.isStreaming);
				await live.hostLink.prompt("A", undefined, "followUp");
				await waitFor(() => live.hostLink.queued.followUp.length === 1);
				expect(await live.hostLink.takeBackQueued()).toEqual({ outcome: "unreported" });

				// A view that attaches now learns the queue from the snapshot, which has the same fault.
				const late = await attach(host);
				expect(late.hostLink.queued.followUp).toEqual(["A"]);
				expect(await late.hostLink.takeBackQueued()).toEqual({ outcome: "unreported" });
				expect(host.session.getQueuedMessages().followUp).toEqual(["A"]);
			} finally {
				release.resolve();
			}
		});

		it("reports a message the host no longer had as delivered", async () => {
			const { host, view, release } = await holdTurn();
			try {
				await view.hostLink.prompt("A", undefined, "followUp");
				await waitFor(() => view.hostLink.queued.followUp.length === 1);
				// The host delivers or drops it between the view's last frame and the request.
				vi.spyOn(host.session, "takeQueuedMessage").mockReturnValue(undefined);

				expect(await view.hostLink.takeBackQueued()).toEqual({ outcome: "delivered" });
			} finally {
				release();
			}
		});
	});

	it("rebuilds the view from a fresh replica file when the host replaces its session", async () => {
		let ui: ExtensionUIContext | undefined;
		const host = await fixture.startHost({ setToolUIContext: ctx => void (ui = ctx) });
		await seedTurn(host, "before");
		const a = await attach(host);
		const oldReplica = a.local.sessionFile!;
		const oldEpoch = a.hostLink.epoch;
		const confirmed = ui!.confirm("Still open?", "across the replacement");
		await waitFor(() => a.dialogs.length === 1);

		await host.session.newSession();
		await waitFor(() => a.hostLink.epoch > oldEpoch);

		const replica = a.local.sessionFile!;
		expect(replica).not.toBe(oldReplica);
		expect(path.dirname(replica)).toBe(a.replicaDir);
		expect(a.local.sessionManager.getEntries()).toEqual(wireEntries(host.session));
		expect(a.local.sessionManager.getEntries().some(entry => entry.type === "message")).toBe(false);
		// The superseded replica was deleted once the session switched off it; only the new one remains.
		expect(await Bun.file(oldReplica).exists()).toBe(false);
		expect(visibleFiles(await fs.readdir(a.replicaDir))).toEqual([path.basename(replica)]);
		if (process.platform !== "win32") expect((await fs.stat(replica)).mode & 0o777).toBe(0o600);
		// The dialog open before the replacement is dismissed, then presented once more from the new snapshot.
		expect(a.dialogs).toHaveLength(2);
		expect(a.dialogs[0].signal?.aborted).toBe(true);
		expect(a.dialogs[1].signal?.aborted).toBe(false);
		a.dialogs[1].answer(true);
		expect(await confirmed).toBe(true);
	});

	it("rejects a write from a view the host has moved past, and sends nothing that would mutate it", async () => {
		const host = await fixture.startHost();
		const a = await attach(host);
		const staleEpoch = a.hostLink.epoch;
		a.renderGate = Promise.withResolvers<void>();

		await host.session.newSession();
		const entriesAfterReplacement = host.session.sessionManager.getEntries().length;
		// The host moved on; this view is still repainting the old session.
		await expect(a.hostLink.prompt("draft")).rejects.toMatchObject({
			name: "RpcCommandError",
			code: "stale",
			epoch: expect.any(Number),
		});
		expect(host.session.sessionManager.getEntries()).toHaveLength(entriesAfterReplacement);

		a.renderGate.resolve();
		await waitFor(() => a.hostLink.epoch > staleEpoch);
		await a.hostLink.prompt("resent by the user");
		await waitFor(() => a.events.some(isAgentEnd));
		expect(host.session.sessionManager.getEntries().filter(entry => entry.type === "message")).toHaveLength(2);
	});

	it("shows peers' model and thinking changes from the host's state, not local credentials", async () => {
		const host = await fixture.startHost();
		const a = await attach(host);
		const b = await attach(host);

		await a.hostLink.setModel("anthropic", "claude-opus-4-5");
		await waitFor(() => b.local.agent.state.model?.id === "claude-opus-4-5");
		await a.hostLink.setThinkingLevel(ThinkingLevel.High);
		await waitFor(() => b.local.agent.state.thinkingLevel === ThinkingLevel.High);

		expect(a.local.agent.state.model?.id).toBe("claude-opus-4-5");
		// The host's event for the change arrives before its config update; its handler must already see the level.
		for (const view of [a, b]) expect(view.thinkingAtEvent).toContain(ThinkingLevel.High);
		expect(host.session.model?.id).toBe("claude-opus-4-5");
		// Nothing was persisted into the replica by mirroring.
		expect(entryShape(b.local)).toEqual(entryShape(host.session));
	});

	it("shows host command output and the number of attached clients", async () => {
		const host = await fixture.startHost();
		const a = await attach(host);
		await waitFor(() => a.setCollabStatus.mock.calls.some(([status]) => status?.participantCount === 1));
		expect(a.setCollabStatus.mock.calls[0][0]).toMatchObject({ role: "hosted", participantCount: 1 });

		const b = await attach(host);
		await waitFor(() => a.setCollabStatus.mock.calls.at(-1)?.[0]?.participantCount === 2);
		await b.hostLink.detach();
		await waitFor(() => a.setCollabStatus.mock.calls.at(-1)?.[0]?.participantCount === 1);

		await a.hostLink.prompt("/session");
		await waitFor(() => a.showStatus.mock.calls.some(([text]) => text.includes(host.session.sessionId)));
	});

	it("applies extension notifications, status, widgets and editor text locally", async () => {
		let ui: ExtensionUIContext | undefined;
		const host = await fixture.startHost({ setToolUIContext: ctx => void (ui = ctx) });
		const a = await attach(host);

		ui!.notify("careful\u001b[31m", "warning");
		ui!.setStatus("build", "ok\n\u001b[2Jbad");
		ui!.setWidget("todo", ["one", "two"], { placement: "belowEditor" });
		ui!.setEditorText("drafted by an extension");

		await waitFor(() => a.setEditorText.mock.calls.length === 1);
		expect(a.showHookNotify).toHaveBeenCalledWith("careful", "warning");
		expect(a.setHookStatus).toHaveBeenCalledWith("build", "ok bad");
		expect(a.setHookWidget).toHaveBeenCalledWith("todo", ["one", "two"], { placement: "belowEditor" });
		expect(a.setEditorText).toHaveBeenCalledWith("drafted by an extension");
	});

	it("shows a late attacher the statuses and widgets set before it attached, and removes them when it leaves", async () => {
		let ui: ExtensionUIContext | undefined;
		const host = await fixture.startHost({ setToolUIContext: ctx => void (ui = ctx) });
		// Extensions set these at boot, before any client is attached.
		ui!.setStatus("build", "ok");
		ui!.setStatus("gone", "soon");
		ui!.setStatus("gone", undefined);
		ui!.setWidget("todo", ["one"], { placement: "belowEditor" });

		const a = await attach(host);
		expect(a.setHookStatus).toHaveBeenCalledWith("build", "ok");
		expect(a.setHookStatus.mock.calls.some(([key, text]) => key === "gone" && text !== undefined)).toBe(false);
		expect(a.setHookWidget).toHaveBeenCalledWith("todo", ["one"], { placement: "belowEditor" });

		await a.hostLink.detach();
		expect(a.setHookStatus).toHaveBeenLastCalledWith("build", undefined);
		expect(a.setHookWidget).toHaveBeenLastCalledWith("todo", undefined);
	});

	it("refuses to attach outside hosted client mode, to another host, or to a malformed host id", async () => {
		const host = await fixture.startHost();
		const entry = await fixture.entry(host);
		const view = await openView();
		const attachWith = (override: Partial<SessionHostEntry>) =>
			HostedClientLink.connect({
				ctx: view.ctx,
				entry: { ...entry, ...override },
				replicaDir: view.replicaDir,
				onClosed: () => {},
			});
		const replicas = async () => (await fs.readdir(view.replicaDir).catch(() => [])).length;

		view.ctx.hostedClientMode = false;
		await expect(attachWith({})).rejects.toThrow(/hosted client mode/i);
		view.ctx.hostedClientMode = true;
		// An ordinary local session would release the host's resources when disposed.
		const ordinary = await openView({ passiveReplica: false });
		await expect(
			HostedClientLink.connect({ ctx: ordinary.ctx, entry, replicaDir: ordinary.replicaDir, onClosed: () => {} }),
		).rejects.toThrow(/passive replica/);
		await expect(attachWith({ hostId: "../../outside" })).rejects.toThrow(/Not a session host id/);
		await expect(attachWith({ hostId: "0123456789abcdef" })).rejects.toThrow(/expected 0123456789abcdef/);

		expect(await replicas()).toBe(0);
		await fixture.waitForClients(host, 0);
	});

	it("gives up its host connection when the first snapshot cannot be applied", async () => {
		let ui: ExtensionUIContext | undefined;
		const host = await fixture.startHost({ setToolUIContext: ctx => void (ui = ctx) });
		const view = await openView();
		view.renderFailure = new Error("repaint failed");
		const picked = ui!.select("Still open", ["x"]);

		await expect(view.connect(await fixture.entry(host))).rejects.toThrow("repaint failed");

		expect(view.link).toBeUndefined();
		expect(view.dialogs).toHaveLength(0);
		await fixture.waitForClients(host, 0);
		// The open question was neither answered nor cancelled by the failed attach.
		const retry = await attach(host);
		retry.dialogs[0].answer("x");
		expect(await picked).toBe("x");
		// The failed attach left no local copy of the transcript behind.
		expect(visibleFiles(await fs.readdir(view.replicaDir))).toEqual([]);
	});

	it("deletes only the replica files it created, as it supersedes them and when it leaves", async () => {
		const host = await fixture.startHost();
		await seedTurn(host, "before");
		const shared = path.join(fixture.dir, "shared-replicas");
		const a = await attach(host, { replicaDir: shared });
		const b = await attach(host, { replicaDir: shared });
		await Bun.write(path.join(shared, "unrelated.txt"), "not a replica");
		const first = a.local.sessionFile!;
		// A sidecar the replica's own session keeps beside its transcript.
		const artifacts = a.local.sessionManager.getArtifactsDir()!;
		await Bun.write(path.join(artifacts, "draft.txt"), "typed");
		const oldEpoch = a.hostLink.epoch;

		await host.session.newSession();
		await waitFor(() => a.hostLink.epoch > oldEpoch && b.hostLink.epoch > oldEpoch);

		expect(await Bun.file(first).exists()).toBe(false);
		expect(await exists(artifacts)).toBe(false);
		const current = (view: View): string => path.basename(view.local.sessionFile!);
		expect(visibleFiles(await fs.readdir(shared))).toEqual([current(a), current(b), "unrelated.txt"].sort());

		await a.hostLink.detach();

		// Leaving removes this client's copy only: the other client's replica, the stranger's file and the host's file stay.
		expect(visibleFiles(await fs.readdir(shared))).toEqual([current(b), "unrelated.txt"].sort());
		expect(await Bun.file(host.session.sessionFile!).exists()).toBe(true);
	});

	it("keeps a replica it could not remove owned, and removes it when the link ends", async () => {
		const host = await fixture.startHost();
		await seedTurn(host, "before");
		const shared = path.join(fixture.dir, "shared-replicas");
		const a = await attach(host, { replicaDir: shared });
		const b = await attach(host, { replicaDir: shared });
		await Bun.write(path.join(shared, "unrelated.txt"), "not a replica");
		const first = a.local.sessionFile!;
		const artifacts = a.local.sessionManager.getArtifactsDir()!;
		await Bun.write(path.join(artifacts, "draft.txt"), "typed");
		const drop = SessionManager.prototype.dropSession;
		let failures = 0;
		spyOn(SessionManager.prototype, "dropSession").mockImplementation(async function (
			this: SessionManager,
			sessionPath: string,
		) {
			// One transient failure, for the first copy of the first client only.
			if (sessionPath === first && failures === 0) {
				failures++;
				throw new Error("EBUSY: resource busy");
			}
			return drop.call(this, sessionPath);
		});
		const oldEpoch = a.hostLink.epoch;

		await host.session.newSession();
		await waitFor(() => a.hostLink.epoch > oldEpoch && b.hostLink.epoch > oldEpoch);

		// The superseded copy could not go: reported, still on disk with its artifacts, and still owned.
		expect(failures).toBe(1);
		expect(a.showWarning).toHaveBeenCalledWith(expect.stringContaining(first));
		expect(await exists(first)).toBe(true);
		expect(await exists(artifacts)).toBe(true);
		const currentOfA = a.local.sessionFile!;

		await a.hostLink.detach();

		// Leaving retries it. Both of this client's copies and their artifacts are gone; the other client's copy, the
		// stranger's file and the host's file are not touched.
		expect(await exists(first)).toBe(false);
		expect(await exists(artifacts)).toBe(false);
		expect(await exists(currentOfA)).toBe(false);
		expect(visibleFiles(await fs.readdir(shared))).toEqual(
			[path.basename(b.local.sessionFile!), "unrelated.txt"].sort(),
		);
		expect(await Bun.file(host.session.sessionFile!).exists()).toBe(true);
	});

	it("fails closed when a host frame cannot be applied: no more frames reach the view and the host keeps running", async () => {
		let ui: ExtensionUIContext | undefined;
		const host = await fixture.startHost({ setToolUIContext: ctx => void (ui = ctx) });
		const a = await attach(host);
		const sent = spyOn(RpcClient.prototype, "sendExtensionUiResponse");
		const confirmed = ui!.confirm("Still open", "when this view fails");
		await waitFor(() => a.dialogs.length === 1);
		const replicaFile = a.local.sessionFile!;

		a.renderGate = Promise.withResolvers<void>();
		const repaintsBefore = a.renderCount;
		await host.session.newSession();
		// The view applies the replacement, then waits in its repaint: whatever follows queues behind it.
		await waitFor(() => a.renderCount > repaintsBefore);
		const later = host.session.sessionManager.appendMessage({
			role: "user",
			content: "written after the replacement",
			timestamp: Date.now(),
		});
		// Frames reach this connection in order: once abort answers, the replacement and the entry are both queued
		// behind the repaint that is waiting on the gate.
		await a.hostLink.abort();
		a.renderGate.reject(new Error("repaint failed"));
		await waitFor(() => a.closed.length === 1);

		expect(a.closed[0].hostAlive).toBe(true);
		expect(a.closed[0].message).toBe(
			`session view update failed: repaint failed (host ${host.hostId} still running; omp attach ${host.hostId})`,
		);
		expect(a.showError).toHaveBeenCalledWith(expect.stringContaining("repaint failed"));
		// The queued entry never reached the half-replaced view.
		expect(a.local.sessionManager.getEntries().some(entry => entry.id === later)).toBe(false);
		// Dialogs were dismissed without an answer, the transport is gone, the host is untouched.
		expect(a.dialogs[0].signal?.aborted).toBe(true);
		a.dialogs[0].answer(true);
		expect(sent).not.toHaveBeenCalled();
		await fixture.waitForClients(host, 0);
		expect(host.exited).toBe(false);
		await expect(a.hostLink.prompt("after the failure")).rejects.toThrow();
		// The local copy of the transcript is gone, and the question stays answerable by another client.
		expect(await Bun.file(replicaFile).exists()).toBe(false);
		expect(visibleFiles(await fs.readdir(a.replicaDir))).toEqual([]);
		const b = await attach(host);
		b.dialogs[0].answer(true);
		expect(await confirmed).toBe(true);
	});

	it("leaves the host's browser tabs alone when its passive local replica is disposed", async () => {
		spyOn(CmuxSocketClient.prototype, "connect").mockResolvedValue(undefined);
		spyOn(CmuxSocketClient.prototype, "close").mockImplementation(() => undefined);
		spyOn(CmuxSocketClient.prototype, "request").mockImplementation(async (method: string) =>
			method === "browser.open_split" ? { surface_id: "surface-hosted", url: "about:blank" } : {},
		);
		const host = await fixture.startHost();
		await seedTurn(host, "the host works");
		const hostId = host.session.sessionId;
		const kind: CmuxKind = { kind: "cmux", socketPath: "/tmp/omp-test-hosted.sock", surface: "surface-hosted" };
		const browser = await acquireBrowser(kind, { cwd: "/tmp" });
		await acquireTab("hosted-tab", browser, { timeoutMs: 1_000, ownerSessionId: hostId });
		try {
			const a = await attach(host);
			// The replica adopts the host's session id from the snapshot header, which is what scopes the tab.
			expect(a.local.sessionManager.getSessionId()).toBe(hostId);
			await a.hostLink.detach();
			await a.local.dispose();
			expect(getTabsMapForTest().has("hosted-tab")).toBe(true);

			// Control: an ordinary session on the same transcript owns that id, and disposing it does release the tab.
			const ordinary = await openView({ passiveReplica: false });
			const { header, entries } = host.session.sessionManager.snapshotForReplication();
			await loadReplica(ordinary.local, path.join(ordinary.replicaDir, "ordinary.jsonl"), header, entries);
			await ordinary.local.dispose();
			expect(getTabsMapForTest().has("hosted-tab")).toBe(false);
		} finally {
			await releaseTabsForOwner(hostId, { kill: false });
		}
	});
});

describe("HostedClientLink with the real EventController and status line", () => {
	beforeAll(async () => {
		await initTheme(false);
	});
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		cfgDisplaySmoothStreaming.set(settings, false);
	});
	afterEach(() => {
		resetSettingsForTest();
	});

	const assistantBlocks = (view: View): AssistantMessageComponent[] =>
		view.ctx.chatContainer.children.filter(
			(child): child is AssistantMessageComponent => child instanceof AssistantMessageComponent,
		);

	it("draws a mid-turn reply once and finishes it in place as the host streams on", async () => {
		const release = Promise.withResolvers<void>();
		const host = await fixture.startHost({}, release.promise);
		const a = await attach(host);
		await a.hostLink.prompt("go");
		await waitFor(() => a.eventsOf("message_update").length > 0);

		const late = await attach(host, { realEvents: true });
		expect(assistantBlocks(late)).toHaveLength(1);

		release.resolve();
		await waitFor(() => !late.hostLink.isStreaming);
		expect(assistantBlocks(late)).toHaveLength(1);
		expect(Bun.stripANSI(assistantBlocks(late)[0].render(80).join("\n"))).toContain("ok");
	});

	it("shows the host's model, thinking level, context and client count on every hosted status line", async () => {
		const host = await fixture.startHost();
		await seedTurn(host, "give the host some context");
		const a = await attach(host, { realStatusLine: true });
		const b = await attach(host, { realStatusLine: true });

		await a.hostLink.setModel("anthropic", "claude-opus-4-5");
		await a.hostLink.setThinkingLevel(ThinkingLevel.High);
		const usage = host.session.getContextUsage();
		expect(usage).toBeDefined();
		const context = formatContextUsage(usage!.percent, usage!.contextWindow, usage!.tokens);
		await waitFor(() =>
			[a, b].every(view => {
				const line = view.statusText();
				return line.includes(context) && line.includes("high") && line.includes("hosted:2");
			}),
		);

		for (const view of [a, b]) {
			expect(view.statusText()).toContain(host.session.model!.name.replace(/^Claude /, ""));
			// The model controls that the composer, the editor border and the selectors read.
			expect(view.local.thinkingLevel).toBe(ThinkingLevel.High);
			expect(view.local.configuredThinkingLevel()).toBe(ThinkingLevel.High);
			expect(view.local.isAutoThinking).toBe(false);
			expect(view.local.model?.id).toBe("claude-opus-4-5");
			// Mirroring wrote nothing of its own: the replica holds exactly the host's entries.
			expect(entryShape(view.local)).toEqual(entryShape(host.session));
		}
	});

	it("shows the host's rename on every hosted status line, with the replica journal still equal to the host's", async () => {
		const host = await fixture.startHost();
		await seedTurn(host, "name this session");
		const a = await attach(host, { realStatusLine: true });
		const b = await attach(host, { realStatusLine: true });
		const namedEverywhere = (name: string) => [a, b].every(view => view.statusText().includes(name));

		// A rename command: the host journals a title entry and sends `session_info_update`.
		await a.hostLink.prompt("/rename Renamed on the host");
		await waitFor(() => namedEverywhere("Renamed on the host"));
		// A title entry on its own (no info frame) reaches the status line the same way.
		await host.session.sessionManager.setSessionName("Renamed again", "user");
		await waitFor(() => namedEverywhere("Renamed again"));

		for (const view of [a, b]) {
			expect(view.local.sessionManager.getSessionName()).toBe("Renamed again");
			// Adopting the name journaled nothing of its own: the replica holds the host's entries, two renames included.
			expect(entryShape(view.local)).toEqual(entryShape(host.session));
			expect(view.local.sessionManager.getEntries().filter(entry => entry.type === "title_change")).toHaveLength(2);
		}
		// A client attaching afterwards gets the name from the snapshot.
		const late = await attach(host, { realStatusLine: true });
		expect(late.statusText()).toContain("Renamed again");
	});
});

// The proxy is a unix socket in front of the host's endpoint; Windows hosts listen on named pipes.
const itPosix = it.skipIf(process.platform === "win32");

describe("HostedClientLink transport", () => {
	itPosix("reports a lost connection with the host still running, without reconnecting", async () => {
		const host = await fixture.startHost();
		const proxy = await startProxy(await fixture.entry(host), fixture.dir);
		try {
			const view = await openView();
			await view.connect(proxy.entry);
			await fixture.waitForClients(host, 1);

			proxy.drop();
			await waitFor(() => view.closed.length === 1);

			expect(view.closed[0].hostAlive).toBe(true);
			expect(view.closed[0].message).toBe(
				`connection lost (host ${host.hostId} still running; omp attach ${host.hostId})`,
			);
			await fixture.waitForClients(host, 0);
			expect(view.closed).toHaveLength(1);
			expect(await fixture.entry(host)).toMatchObject({ clients: 0 });
		} finally {
			proxy.close();
		}
	});

	it("never reports an explicit detach or exit as a lost connection", async () => {
		const host = await fixture.startHost();
		const a = await attach(host);
		const b = await attach(host);

		await a.hostLink.detach();
		await fixture.waitForClients(host, 1);
		// The last client's exit stops the host.
		await b.hostLink.exit();
		await waitFor(() => host.exited);

		expect(a.closed).toEqual([]);
		expect(b.closed).toEqual([]);
	});

	itPosix(
		"finishes applying a first snapshot before a connection lost meanwhile rejects, then leaves nothing behind",
		async () => {
			const host = await fixture.startHost();
			const proxy = await startProxy(await fixture.entry(host), fixture.dir);
			try {
				const view = await openView();
				const activate = view.local.switchSession.bind(view.local);
				const entered = Promise.withResolvers<void>();
				const release = Promise.withResolvers<void>();
				let activated = false;
				spyOn(view.local, "switchSession").mockImplementation(async (sessionPath, options) => {
					entered.resolve();
					await release.promise;
					const switched = await activate(sessionPath, options);
					activated = true;
					return switched;
				});
				let settled = false;
				const connecting = view.connect(proxy.entry).finally(() => {
					settled = true;
				});
				// The replica is written and the session is being switched onto it when the connection dies.
				await entered.promise;
				expect(visibleFiles(await fs.readdir(view.replicaDir))).toHaveLength(1);
				proxy.drop();
				await fixture.waitForClients(host, 0);
				expect(settled).toBe(false);

				release.resolve();
				await expect(connecting).rejects.toThrow();

				// The activation had finished before the attempt gave up: nothing mutates the session afterwards, and the
				// copy is deleted after that, so it cannot be recreated under a caller that disposes or re-attaches.
				expect(activated).toBe(true);
				expect(visibleFiles(await fs.readdir(view.replicaDir))).toEqual([]);
				expect(view.link).toBeUndefined();
			} finally {
				proxy.close();
			}
		},
	);

	itPosix("opens only web URLs the host names, and shows anything else as an error", async () => {
		const host = await fixture.startHost();
		const proxy = await startProxy(await fixture.entry(host), fixture.dir);
		try {
			const view = await openView();
			await view.connect(proxy.entry);
			const open = (id: string, url: string, instructions?: string): void =>
				proxy.inject({ type: "extension_ui_request", id, method: "open_url", url, instructions });

			open("u1", "https://example.com/oauth?x=1&y=2", "Sign in\u001b]0;pwned\u0007");
			await waitFor(() => view.openInBrowser.mock.calls.length === 1);
			expect(view.openInBrowser).toHaveBeenCalledWith("https://example.com/oauth?x=1&y=2");
			expect(view.showStatus.mock.calls.at(-1)?.[0]).toBe("Opening https://example.com/oauth?x=1&y=2\nSign in");

			open("u2", "javascript:alert(1)");
			open("u3", "/etc/passwd");
			open("u4", "file:///etc/passwd");
			await waitFor(() => view.showError.mock.calls.length === 3);
			expect(view.openInBrowser).toHaveBeenCalledTimes(1);
			expect(view.showError.mock.calls[0][0]).toContain("javascript:alert(1)");
		} finally {
			proxy.close();
		}
	});

	itPosix("keeps applying entries from a host that predates the leaf field, as the new leaf", async () => {
		const host = await fixture.startHost();
		await seedTurn(host, "before");
		const proxy = await startProxy(await fixture.entry(host), fixture.dir);
		try {
			const view = await openView();
			await view.connect(proxy.entry);
			const entry: SessionEntry = {
				type: "message",
				id: "0ddba11f",
				parentId: view.local.sessionManager.getLeafId(),
				timestamp: new Date().toISOString(),
				message: { role: "user", content: "from an older host", timestamp: Date.now() },
			};

			// The frame a host without `leafId` sends: valid before the field existed, so it must still be delivered.
			proxy.inject({ type: "entry", seq: 1_000_000, entry });
			await waitFor(() => view.local.sessionManager.getLeafId() === entry.id);

			expect(JSON.stringify(view.local.messages)).toContain("from an older host");
			expect(view.closed).toEqual([]);
			expect(view.showError).not.toHaveBeenCalled();
		} finally {
			proxy.close();
		}
	});
});

describe("HostedClientLink with a host process", () => {
	let dir: string;
	let restoreAgentDir: () => void;
	const spawned: number[] = [];

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-hosted-client-"));
		restoreAgentDir = isolateAgentDir(path.join(dir, "agent"));
		// No network: a dummy key makes the model available, and discovery hits a closed port.
		await Bun.write(
			path.join(dir, "models.yml"),
			"providers:\n  anthropic:\n    baseUrl: http://127.0.0.1:9\n    apiKey: test-dummy-key\n",
		);
	});
	afterEach(async () => {
		for (const pid of spawned.splice(0)) if (pidAlive(pid)) process.kill(pid, "SIGKILL");
		restoreAgentDir();
		await removeWithRetries(dir);
	});

	it("reports that the host exited when its process dies", async () => {
		const entry = await spawnSessionHost({
			cwd: dir,
			registryDir: path.join(dir, "registry"),
			env: { PI_CODING_AGENT_DIR: dir, HOME: dir, USERPROFILE: dir },
			args: [
				"--no-extensions",
				"--no-skills",
				"--no-rules",
				"--provider",
				"anthropic",
				"--model",
				"claude-sonnet-4-5",
			],
		});
		spawned.push(entry.pid);
		const view = await openView();
		await view.connect(entry);

		process.kill(entry.pid, "SIGKILL");
		await waitFor(() => view.closed.length === 1, 15_000);

		expect(view.closed[0]).toEqual({ hostAlive: false, message: "host exited" });
	}, 150_000);
});
