/**
 * Contract (#4049 follow-up): a writable TUI guest must answer host
 * `ui-request` frames instead of silently dropping them. The guest presents
 * the ask through the hook selector/editor seam, answers with `ui-response`
 * (explicit cancel included), honors `ui-request-end` as
 * dismiss-without-responding, and clears stale presentations on resync/leave
 * so replayed requests never double-answer.
 *
 * The host side of the wire contract (broadcast, replay-on-hello, response
 * resolution) is covered by read-only.test.ts; here a scripted host socket
 * drives a real CollabGuestLink over the in-memory relay so every guest→host
 * frame is observable.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fsp from "node:fs/promises";
import { setImmediate as tick } from "node:timers/promises";
import { generateRoomKey, importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabGuestLink } from "@oh-my-pi/pi-coding-agent/collab/guest";
import { CollabHost, WITHDRAWN_GUEST_REPLY_LIMIT_MS } from "@oh-my-pi/pi-coding-agent/collab/host";
import {
	COLLAB_PROTO,
	type CollabFrame,
	type CollabSessionState,
	type CollabUiRequestDraft,
	formatCollabLink,
	parseCollabLink,
} from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type {
	ExtensionAskDialogQuestion,
	ExtensionUIDialogOptions,
	ExtensionUISelectItem,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import {
	DialogSupersededError,
	WITHDRAWN_DIALOG_REPLY_MS,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { ExtensionUiController } from "@oh-my-pi/pi-coding-agent/modes/controllers/extension-ui-controller";
import type { InteractiveModeContext, InteractiveSelectorDialogOptions } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AskDialogComponent } from "@oh-my-pi/pi-tui/overlays/ask-dialog";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";
import { instrumentRelay, waitFor } from "./helpers/throttled-host";

// In-memory transport: shared FakeWebSocket + InMemoryRelay harness (see
// ./helpers/in-memory-relay), same contract as the other collab tests.

// ── Guest harness ───────────────────────────────────────────────────────────

/** One hook-dialog presentation captured from the guest link. */
interface DialogStub {
	kind: "select" | "editor";
	title: string;
	options?: ExtensionUISelectItem[];
	prefill?: string;
	dialogOptions?: ExtensionUIDialogOptions;
	/** Flipped when the guest dismissed the presentation via the abort signal. */
	aborted: boolean;
	whenAborted: Promise<void>;
	/** Simulate the user submitting (string) or cancelling (undefined). */
	settle(value: string | undefined): void;
}

interface UiResponseRecord {
	reqId: number;
	value: string | undefined;
}

interface GuestUiHarness {
	guest: CollabGuestLink;
	hostSocket: CollabSocket;
	/** Every presentation the guest ever made, in order. */
	dialogLog: DialogStub[];
	/** Every ui-response the scripted host ever received, in order. */
	uiResponses: UiResponseRecord[];
	nextDialog(): Promise<DialogStub>;
	nextUiResponse(): Promise<UiResponseRecord>;
	/** Every hello the guest sent, in order. */
	hellos: Extract<CollabFrame, { t: "hello" }>[];
	/**
	 * Deterministic apply-chain barrier: send a sentinel `error` frame and
	 * resolve once the guest surfaces it. Frames apply strictly in arrival
	 * order, so every frame sent before the sentinel has fully applied.
	 */
	barrier(): Promise<void>;
	/** Re-send the welcome (resync); the guest clears stale presentations on it. */
	sendWelcome(): void;
	cleanup(): Promise<void>;
}

function makeState(): CollabSessionState {
	return {
		isStreaming: false,
		queuedMessageCount: 0,
		sessionName: "host session",
		cwd: "/tmp",
		participants: [{ name: "Host", role: "host" }],
	};
}

/** A real CollabGuestLink joined to a room; its hook dialogs are stubs that stay open until a test settles them. */
interface GuestLinkHarness {
	guest: CollabGuestLink;
	/** Every presentation the guest ever made, in order. */
	dialogLog: DialogStub[];
	nextDialog(): Promise<DialogStub>;
}

async function joinGuestLink(link: string, onError: (message: string) => void = () => {}): Promise<GuestLinkHarness> {
	const dialogLog: DialogStub[] = [];
	const dialogQueue: DialogStub[] = [];
	const dialogWaiters: ((stub: DialogStub) => void)[] = [];
	const presentStub = (
		fields: Omit<DialogStub, "aborted" | "whenAborted" | "settle">,
	): Promise<string | undefined> => {
		const { promise, resolve } = Promise.withResolvers<string | undefined>();
		const abortGate = Promise.withResolvers<void>();
		let settled = false;
		const stub: DialogStub = {
			...fields,
			aborted: false,
			whenAborted: abortGate.promise,
			settle: value => {
				if (settled) return;
				settled = true;
				resolve(value);
			},
		};
		// Mirror ExtensionUiController.#presentDialog: an abort settles the
		// dialog with undefined and dismisses it.
		fields.dialogOptions?.signal?.addEventListener(
			"abort",
			() => {
				stub.aborted = true;
				abortGate.resolve();
				if (!settled) {
					settled = true;
					resolve(undefined);
				}
			},
			{ once: true },
		);
		dialogLog.push(stub);
		const waiter = dialogWaiters.shift();
		if (waiter) waiter(stub);
		else dialogQueue.push(stub);
		return promise;
	};
	const nextDialog = (): Promise<DialogStub> => {
		const queued = dialogQueue.shift();
		if (queued) return Promise.resolve(queued);
		const { promise, resolve } = Promise.withResolvers<DialogStub>();
		dialogWaiters.push(resolve);
		return promise;
	};

	const ctx = {
		collabGuest: undefined as CollabGuestLink | undefined,
		settings: Settings.isolated(),
		sessionManager: {
			getSessionFile: () => null,
			getSessionName: () => "local session",
			getCwd: () => "/local",
		},
		session: {
			messages: [],
			switchSession: () => Promise.resolve(),
			newSession: () => Promise.resolve(),
			agent: {
				state: { model: undefined },
				setModel: () => {},
				setThinkingLevel: () => {},
				setDisableReasoning: () => {},
			},
		},
		statusContainer: { clear: () => {} },
		pendingShellContainer: { clear: () => {} },
		pendingMessagesContainer: { clear: () => {} },
		compactionQueuedMessages: [],
		streamingComponent: undefined,
		streamingMessage: undefined,
		transcriptMessageComponents: new WeakMap(),
		pendingTools: new Map(),
		loadingAnimation: undefined,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			resetActiveTime: () => {},
			markActivityStart: () => {},
			markActivityEnd: () => {},
		},
		ui: { requestRender: () => {} },
		chatContainer: { clear: () => {}, disposeChildren: () => {} },
		resetObserverRegistry: () => {},
		renderInitialMessages: () => {},
		reloadTodos: () => Promise.resolve(),
		showStatus: () => {},
		showError: onError,
		updateEditorTopBorder: () => {},
		updateEditorBorderColor: () => {},
		eventController: {
			dispatchSessionEvent: () => Promise.resolve(),
			takeDisplaceableComponents: () => [],
			resetTranscriptAnchors: () => {},
		},
		syncRunningSubagentBadge: () => {},
		setCollabGuest: (guest: InteractiveModeContext["collabGuest"]) => {
			Object.assign(ctx, { collabGuest: guest });
		},
		closeLinkBrowser: () => {},
		rerenderInLinkBrowser: () => {},
		rebuildTranscriptScrollback: () => {},
		showHookSelector: (
			title: string,
			options: ExtensionUISelectItem[],
			dialogOptions?: InteractiveSelectorDialogOptions,
		): Promise<string | undefined> => presentStub({ kind: "select", title, options, dialogOptions }),
		showHookEditor: (
			title: string,
			prefill?: string,
			dialogOptions?: ExtensionUIDialogOptions,
		): Promise<string | undefined> => presentStub({ kind: "editor", title, prefill, dialogOptions }),
	} as unknown as InteractiveModeContext;

	const guest = new CollabGuestLink(ctx);
	await guest.join(link);
	return { guest, dialogLog, nextDialog };
}

async function makeHarness(opts?: { readOnly?: boolean }): Promise<GuestUiHarness> {
	const roomId = "ui-request-room";
	const roomKey = generateRoomKey();
	const cryptoKey = await importRoomKey(roomKey);
	const link = formatCollabLink("ws://localhost:8788", roomId, roomKey);

	const uiResponses: UiResponseRecord[] = [];
	const responseQueue: UiResponseRecord[] = [];
	const responseWaiters: ((record: UiResponseRecord) => void)[] = [];
	const nextUiResponse = (): Promise<UiResponseRecord> => {
		const queued = responseQueue.shift();
		if (queued) return Promise.resolve(queued);
		const { promise, resolve } = Promise.withResolvers<UiResponseRecord>();
		responseWaiters.push(resolve);
		return promise;
	};

	let barrierSeq = 0;
	const errorWaiters = new Map<string, () => void>();
	const barrier = (): Promise<void> => {
		const sentinel = `__barrier_${++barrierSeq}__`;
		const { promise, resolve } = Promise.withResolvers<void>();
		errorWaiters.set(sentinel, resolve);
		hostSocket.send({ t: "error", message: sentinel });
		return promise;
	};
	const hellos: Extract<CollabFrame, { t: "hello" }>[] = [];

	const hostSocket = new CollabSocket({ wsUrl: `ws://localhost:8788/r/${roomId}`, role: "host", key: cryptoKey });
	const hostOpen = Promise.withResolvers<void>();
	const sendWelcome = (): void => {
		hostSocket.send({
			t: "welcome",
			proto: COLLAB_PROTO,
			header: { type: "session", id: "remote-session", timestamp: "2026-06-30T00:00:00Z", cwd: "/tmp" },
			state: makeState(),
			agents: [],
			entryCount: 0,
			readOnly: opts?.readOnly ? true : undefined,
		});
	};
	hostSocket.onOpen = () => hostOpen.resolve();
	hostSocket.onFrame = frame => {
		if (frame.t === "hello") {
			hellos.push(frame);
			sendWelcome();
		}
		if (frame.t === "ui-response") {
			const record: UiResponseRecord = { reqId: frame.reqId, value: frame.value };
			uiResponses.push(record);
			const waiter = responseWaiters.shift();
			if (waiter) waiter(record);
			else responseQueue.push(record);
		}
	};
	hostSocket.connect();
	await hostOpen.promise;

	const { guest, dialogLog, nextDialog } = await joinGuestLink(link, message => {
		// The guest prefixes host error frames ("Collab host: <message>");
		// match the embedded sentinel.
		for (const [sentinel, waiter] of errorWaiters) {
			if (message.includes(sentinel)) {
				errorWaiters.delete(sentinel);
				waiter();
				return;
			}
		}
	});

	return {
		guest,
		hostSocket,
		dialogLog,
		uiResponses,
		hellos,
		nextDialog,
		nextUiResponse,
		barrier,
		sendWelcome,
		cleanup: async () => {
			await guest.leave("test cleanup").catch(() => {});
			hostSocket.close();
		},
	};
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

const harnessCleanups: (() => Promise<void>)[] = [];
let writeSpy: { mockRestore(): void } | null = null;
let renameSpy: { mockRestore(): void } | null = null;

beforeEach(() => {
	installInMemoryRelay();
	writeSpy = spyOn(Bun, "write").mockResolvedValue(0);
	renameSpy = spyOn(fsp, "rename").mockResolvedValue(undefined);
});

afterEach(async () => {
	for (const cleanup of harnessCleanups.splice(0).reverse()) await cleanup();
	writeSpy?.mockRestore();
	renameSpy?.mockRestore();
	writeSpy = null;
	renameSpy = null;
	uninstallInMemoryRelay();
});

async function openHarness(opts?: { readOnly?: boolean }): Promise<GuestUiHarness> {
	const harness = await makeHarness(opts);
	harnessCleanups.push(harness.cleanup);
	return harness;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("collab TUI guest ui-request handling (#4049)", () => {
	it("presents a select ui-request through the hook selector and round-trips the answer", async () => {
		const h = await openHarness();
		h.hostSocket.send({
			t: "ui-request",
			request: {
				reqId: 1,
				kind: "select",
				title: "Deploy?",
				options: ["Yes", { label: "No", description: "abort the deploy" }],
				initialIndex: 1,
				selectionMarker: "radio",
				checkedIndices: [0],
				markableCount: 2,
				helpText: "pick one",
			},
		});

		const dialog = await h.nextDialog();
		expect(dialog.kind).toBe("select");
		expect(dialog.title).toBe("Deploy?");
		expect(dialog.options).toEqual(["Yes", { label: "No", description: "abort the deploy" }]);
		expect(dialog.dialogOptions?.initialIndex).toBe(1);
		expect(dialog.dialogOptions?.selectionMarker).toBe("radio");
		expect(dialog.dialogOptions?.checkedIndices).toEqual([0]);
		expect(dialog.dialogOptions?.markableCount).toBe(2);
		expect(dialog.dialogOptions?.helpText).toBe("pick one");

		dialog.settle("Yes");
		expect(await h.nextUiResponse()).toEqual({ reqId: 1, value: "Yes" });
	});

	it("presents an editor ui-request and sends an explicit cancel as ui-response without a value", async () => {
		const h = await openHarness();
		h.hostSocket.send({
			t: "ui-request",
			request: { reqId: 2, kind: "editor", title: "Edit the prompt", prefill: "draft text" },
		});

		const dialog = await h.nextDialog();
		expect(dialog.kind).toBe("editor");
		expect(dialog.title).toBe("Edit the prompt");
		expect(dialog.prefill).toBe("draft text");

		dialog.settle(undefined); // user cancelled (escape) — must still answer, like web's Cancel
		const response = await h.nextUiResponse();
		expect(response.reqId).toBe(2);
		expect(response.value).toBeUndefined();
	});

	it("dismisses the presentation on ui-request-end and never responds for the ended request", async () => {
		const h = await openHarness();
		h.hostSocket.send({
			t: "ui-request",
			request: { reqId: 3, kind: "select", title: "Answered elsewhere", options: ["A"] },
		});
		const dialog = await h.nextDialog();
		expect(dialog.aborted).toBe(false);

		h.hostSocket.send({ t: "ui-request-end", reqId: 3 });
		await dialog.whenAborted;
		expect(dialog.aborted).toBe(true);

		// A late settle on the dismissed dialog must also stay silent.
		dialog.settle("A");

		// Prove silence via wire ordering: a fresh request's response is the
		// first and only ui-response the host ever receives.
		h.hostSocket.send({
			t: "ui-request",
			request: { reqId: 4, kind: "select", title: "Next", options: ["B"] },
		});
		const next = await h.nextDialog();
		next.settle("B");
		expect(await h.nextUiResponse()).toEqual({ reqId: 4, value: "B" });
		expect(h.uiResponses).toEqual([{ reqId: 4, value: "B" }]);
	});

	it("clears stale presentations on resync and answers the replayed request exactly once", async () => {
		const h = await openHarness();
		h.hostSocket.send({
			t: "ui-request",
			request: { reqId: 7, kind: "select", title: "Pending ask", options: ["Go"] },
		});
		const first = await h.nextDialog();

		// Resync: the host re-welcomes and replays every still-pending request
		// (mirrors CollabHost.#handleHello for writable peers).
		h.sendWelcome();
		h.hostSocket.send({
			t: "ui-request",
			request: { reqId: 7, kind: "select", title: "Pending ask", options: ["Go"] },
		});

		await first.whenAborted; // stale presentation dismissed by the resync
		const replay = await h.nextDialog();
		expect(replay.title).toBe("Pending ask");
		expect(replay.aborted).toBe(false);

		replay.settle("Go");
		expect(await h.nextUiResponse()).toEqual({ reqId: 7, value: "Go" });
		expect(h.uiResponses).toEqual([{ reqId: 7, value: "Go" }]);
	});

	it("dismisses a pending presentation on leave without responding", async () => {
		const h = await openHarness();
		h.hostSocket.send({
			t: "ui-request",
			request: { reqId: 9, kind: "editor", title: "Still open" },
		});
		const dialog = await h.nextDialog();

		await h.guest.leave("user left");
		await dialog.whenAborted;
		expect(dialog.aborted).toBe(true);
		// Socket detached on leave and the identity check already failed: no
		// response was recorded for the dismissed ask.
		expect(h.uiResponses).toEqual([]);
	});

	it("delivers an answer still being sealed when the guest leaves", async () => {
		const h = await openHarness();
		h.hostSocket.send({ t: "ui-request", request: { reqId: 4, kind: "select", title: "Deploy?", options: ["Yes"] } });
		const dialog = await h.nextDialog();
		const sealing = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const realEncrypt = crypto.subtle.encrypt.bind(crypto.subtle);
		const encrypt = vi
			.spyOn(crypto.subtle, "encrypt")
			.mockImplementationOnce(async (...args: Parameters<typeof crypto.subtle.encrypt>) => {
				sealing.resolve();
				await release.promise;
				return realEncrypt(...args);
			});
		try {
			dialog.settle("Yes");
			// The guest's socket has taken the answer and is sealing it when the person leaves.
			await sealing.promise;
			const leaving = h.guest.leave("user left");
			release.resolve();
			await leaving;
			await waitFor(() => h.uiResponses.length > 0, "the host never received the answer");
			expect(h.uiResponses).toEqual([{ reqId: 4, value: "Yes" }]);
		} finally {
			release.resolve();
			encrypt.mockRestore();
		}
	});

	it("never presents ui-requests on a read-only link", async () => {
		const h = await openHarness({ readOnly: true });
		h.hostSocket.send({
			t: "ui-request",
			request: { reqId: 11, kind: "select", title: "Should not show", options: ["X"] },
		});

		await h.barrier(); // frames apply in order: the ui-request has fully applied
		expect(h.dialogLog).toHaveLength(0);
		expect(h.uiResponses).toEqual([]);
	});

	it("tells the host it replies to withdrawals, and replies without a value to one it had not answered", async () => {
		const h = await openHarness();
		expect(h.hellos.at(-1)).toMatchObject({ cancelReplies: true });
		h.hostSocket.send({
			t: "ui-request",
			request: { reqId: 12, kind: "select", title: "Deploy?", options: ["Yes", "No"] },
		});
		const dialog = await h.nextDialog();

		// A person's message on the host withdrew the question before this guest answered it.
		h.hostSocket.send({ t: "ui-request-end", reqId: 12, withdrawn: true });
		await dialog.whenAborted;
		expect(await h.nextUiResponse()).toEqual({ reqId: 12, value: undefined });
	});
});

// ── Proto handshake (#4049: ui-request frames require COLLAB_PROTO >= 3) ───
//
// The ui-request/ui-response grammar shipped without a proto bump, so v2
// guests joined fine and silently dropped host asks. These tests pin the
// enforcement: a real CollabHost must reject stale-proto hellos with an
// observable error frame (never a welcome), current-proto guests must still
// complete a full ui-request round trip, and a rejected CollabGuestLink
// join must fail fast with the host's reason instead of hanging until the
// welcome timeout.

/** Minimal InteractiveModeContext double: only the members CollabHost touches. */
function makeHostContext(): InteractiveModeContext {
	return {
		settings: Settings.isolated(),
		sessionManager: {
			getSessionId: () => "sess-proto",
			getCwd: () => "/tmp",
			snapshotForReplication: () => ({
				header: { type: "session", id: "sess-proto", timestamp: new Date().toISOString(), cwd: "/tmp" },
				entries: [],
			}),
			onEntryAppended: undefined,
		},
		session: {
			isStreaming: false,
			queuedMessageCount: 0,
			sessionName: "proto test",
			model: undefined,
			thinkingLevel: undefined,
			subscribe: () => () => {},
			emitNotice: () => {},
			promptCustomMessage: () => Promise.resolve(),
			abort: () => Promise.resolve(),
		},
		eventBus: undefined,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
		},
		ui: { requestRender: () => {} },
		showStatus: () => {},
		collabHost: undefined,
	} as unknown as InteractiveModeContext;
}

/** A guest that speaks raw frames, so a test decides each reply. */
interface RawWireGuest {
	socket: CollabSocket;
	nextFrame(): Promise<CollabFrame>;
}

/** Raw wire-speaking guest with a configurable hello proto, name and `cancelReplies`. */
async function joinRawGuest(
	link: string,
	proto: number,
	options: { cancelReplies?: boolean; name?: string } = {},
): Promise<RawWireGuest> {
	const parsed = parseCollabLink(link);
	if ("error" in parsed) throw new Error(parsed.error);
	const writeToken = parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined;
	const key = await importRoomKey(parsed.key);
	const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
	const queue: CollabFrame[] = [];
	const waiters: ((frame: CollabFrame) => void)[] = [];
	// Directed welcome/error/ui frames only: the host's debounced broadcasts
	// (state/agents/entry/event/bus) and the snapshot-chunk train interleave
	// nondeterministically with the frames these tests assert on.
	const filtered: Record<string, true> = {
		state: true,
		agents: true,
		entry: true,
		event: true,
		bus: true,
		"snapshot-chunk": true,
	};
	socket.onFrame = frame => {
		if (filtered[frame.t]) return;
		const waiter = waiters.shift();
		if (waiter) waiter(frame);
		else queue.push(frame);
	};
	socket.onOpen = () =>
		socket.send({
			t: "hello",
			proto,
			name: options.name ?? `guest-v${proto}`,
			writeToken,
			...(options.cancelReplies ? { cancelReplies: true } : {}),
		});
	socket.connect();
	const nextFrame = (): Promise<CollabFrame> => {
		const queued = queue.shift();
		if (queued) return Promise.resolve(queued);
		const { promise, resolve } = Promise.withResolvers<CollabFrame>();
		waiters.push(resolve);
		return promise;
	};
	return { socket, nextFrame };
}

describe("collab proto handshake (#4049)", () => {
	it("host rejects a stale-proto hello with a protocol-mismatch error and never welcomes or admits the guest", async () => {
		const host = new CollabHost(makeHostContext());
		await host.start("ws://localhost:8787");
		const guest = await joinRawGuest(host.link, COLLAB_PROTO - 1);
		try {
			const reply = await guest.nextFrame();
			if (reply.t !== "error") throw new Error(`expected error, got ${reply.t}`);
			expect(reply.message).toContain("protocol mismatch");
			expect(reply.message).toContain(`host speaks v${COLLAB_PROTO}`);
			expect(reply.message).toContain(`guest sent v${COLLAB_PROTO - 1}`);
			// The rejected guest was never admitted. A host ask is retained for a
			// later writer instead of being exposed to the stale peer.
			expect(host.participants.filter(p => p.role !== "host")).toEqual([]);
			const abort = new AbortController();
			const pending = host.requestGuestUi({ kind: "select", title: "anyone?", options: ["Yes"] }, abort.signal);
			if (!pending) throw new Error("expected retained UI request");
			abort.abort();
			expect(await pending).toEqual({ kind: "unavailable" });
		} finally {
			guest.socket.close();
			await host.stop("test done");
		}
	});

	it("CollabGuestLink.join fails fast with the host's rejection message instead of hanging for the welcome", async () => {
		// Scripted host that rejects every hello the way CollabHost does for a
		// proto mismatch. The real guest must surface that message from join().
		const roomId = "proto-reject-room";
		const roomKey = generateRoomKey();
		const cryptoKey = await importRoomKey(roomKey);
		const link = formatCollabLink("ws://localhost:8788", roomId, roomKey);
		const hostSocket = new CollabSocket({ wsUrl: `ws://localhost:8788/r/${roomId}`, role: "host", key: cryptoKey });
		const hostOpen = Promise.withResolvers<void>();
		hostSocket.onOpen = () => hostOpen.resolve();
		hostSocket.onFrame = frame => {
			if (frame.t === "hello") {
				hostSocket.send({
					t: "error",
					message: `protocol mismatch: host speaks v${COLLAB_PROTO + 1}, guest sent v${frame.proto}`,
				});
			}
		};
		hostSocket.connect();
		await hostOpen.promise;

		const ctx = {
			settings: Settings.isolated(),
			sessionManager: { getSessionFile: () => null },
			syncRunningSubagentBadge: () => {},
			setCollabGuest: (guest: InteractiveModeContext["collabGuest"]) => {
				Object.assign(ctx, { collabGuest: guest });
			},
		} as unknown as InteractiveModeContext;
		const guest = new CollabGuestLink(ctx);
		try {
			await expect(guest.join(link)).rejects.toThrow(/protocol mismatch/);
		} finally {
			hostSocket.close();
		}
	});
});

// ── Host dialog vs collab teardown (#4049 follow-up) ────────────────────────
//
// `ExtensionUiController.#raceCollabDialog` mirrors a hook dialog to writable
// guests and races the two surfaces. Teardown (/collab stop, non-reconnectable
// relay drop) settles every pending guest ask as `unavailable`; that is NOT a
// guest answer, so the local dialog the host user may be typing in must keep
// running and win with its eventual value. Only a genuine guest settlement —
// answer or explicit cancel (`answered` with undefined) — dismisses it.

/** One local hook-dialog presentation captured from the stub controller. */
interface LocalDialogStub {
	title: string;
	signal: AbortSignal | undefined;
	/** Simulate the host user submitting (string) or cancelling (undefined). */
	settle(value: string | undefined): void;
}

/**
 * ExtensionUiController with the TUI dialog seam stubbed out: presentations
 * are recorded instead of mounted, and abort mirrors `#presentDialog`
 * (settles the dialog with undefined).
 */
class StubDialogController extends ExtensionUiController {
	readonly localDialogs: LocalDialogStub[] = [];

	override showHookSelector(
		title: string,
		_options: ExtensionUISelectItem[],
		dialogOptions?: InteractiveSelectorDialogOptions,
	): Promise<string | undefined> {
		const { promise, resolve } = Promise.withResolvers<string | undefined>();
		let settled = false;
		const settle = (value: string | undefined): void => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		dialogOptions?.signal?.addEventListener("abort", () => settle(undefined), { once: true });
		this.localDialogs.push({ title, signal: dialogOptions?.signal, settle });
		return promise;
	}
}

describe("collab host dialog vs teardown (#4049 follow-up)", () => {
	async function openRace(): Promise<{
		host: CollabHost;
		controller: StubDialogController;
		guest: { socket: CollabSocket; nextFrame(): Promise<CollabFrame> };
		result: Promise<string | undefined>;
		dialog: LocalDialogStub;
		requestFrame: CollabFrame & { t: "ui-request" };
		cleanup(): Promise<void>;
	}> {
		const ctx = makeHostContext();
		const host = new CollabHost(ctx);
		await host.start("ws://localhost:8787");
		ctx.collabHost = host;
		const controller = new StubDialogController(ctx);
		const guest = await joinRawGuest(host.link, COLLAB_PROTO);
		const welcome = await guest.nextFrame();
		if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);

		const result = controller.showCollabAwareSelector("Deploy?", ["Yes", "No"]);
		const requestFrame = await guest.nextFrame();
		if (requestFrame.t !== "ui-request") throw new Error(`expected ui-request, got ${requestFrame.t}`);
		const dialog = controller.localDialogs[0];
		if (!dialog) throw new Error("expected the local dialog to be presented alongside the guest ask");
		return {
			host,
			controller,
			guest,
			result,
			dialog,
			requestFrame,
			cleanup: async () => {
				guest.socket.close();
				await host.stop("test done");
			},
		};
	}

	it("lets a later writer dismiss a host dialog that was opened with no peers", async () => {
		const ctx = makeHostContext();
		const host = new CollabHost(ctx);
		await host.start("ws://localhost:8787");
		ctx.collabHost = host;
		const controller = new StubDialogController(ctx);
		let guest: { socket: CollabSocket; nextFrame(): Promise<CollabFrame> } | undefined;
		try {
			const result = controller.showCollabAwareSelector("Deploy later?", ["Yes", "No"]);
			const dialog = controller.localDialogs[0];
			if (!dialog) throw new Error("expected the local dialog before a writer joined");

			guest = await joinRawGuest(host.link, COLLAB_PROTO);
			const welcome = await guest.nextFrame();
			if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);
			// Force a directed frame after hello so a missing replay fails without
			// relying on a timeout: the pending ui-request must precede this error.
			guest.socket.send({ t: "agent-cmd", cmd: "chat", agentId: "barrier", text: "" });
			const request = await guest.nextFrame();
			if (request.t !== "ui-request") throw new Error(`expected ui-request, got ${request.t}`);
			expect(request.request.title).toBe("Deploy later?");

			guest.socket.send({ t: "ui-response", reqId: request.request.reqId, value: undefined });
			expect(await result).toBeUndefined();
			expect(dialog.signal?.aborted).toBe(true);
		} finally {
			guest?.socket.close();
			await host.stop("test done");
		}
	});

	it("keeps the local dialog running through collab teardown and returns its eventual answer", async () => {
		const race = await openRace();
		try {
			await race.host.stop("host stopped collab");
			// Deterministic bug discriminator, no clock: buggy code treated
			// teardown's settlement as a remote win — the race resolved
			// undefined before the local dialog could answer. Fixed code keeps
			// the local dialog live, so `result` stays pending until it
			// settles and wins with its value.
			race.dialog.settle("stay-local");
			expect(await race.result).toBe("stay-local");
			expect(race.dialog.signal?.aborted).toBe(false);
		} finally {
			await race.cleanup();
		}
	});

	it("dismisses the local dialog and returns undefined on a genuine guest cancel", async () => {
		const race = await openRace();
		try {
			race.guest.socket.send({ t: "ui-response", reqId: race.requestFrame.request.reqId, value: undefined });
			expect(await race.result).toBeUndefined();
			expect(race.dialog.signal?.aborted).toBe(true);
		} finally {
			await race.cleanup();
		}
	});

	it("dismisses the local dialog and returns the guest's value when the guest answers first", async () => {
		const race = await openRace();
		try {
			race.guest.socket.send({ t: "ui-response", reqId: race.requestFrame.request.reqId, value: "No" });
			expect(await race.result).toBe("No");
			expect(race.dialog.signal?.aborted).toBe(true);
		} finally {
			await race.cleanup();
		}
	});
});

// ── Guest ask "unavailable" literal answer (#4375: tagged guest results) ────
//
// A guest may legitimately answer with the literal string "unavailable" (e.g.
// a status option). The old `#requestGuestUiString` flattened
// `CollabGuestUiResult` to `string | "unavailable" | undefined`, so that answer
// collided with the transport-unavailable sentinel and cancelled the whole ask
// instead of recording the answer. `CollabHost.requestGuestUi` already returns
// a tagged `CollabGuestUiResult`; this test pins the wire-level contract: a
// guest "unavailable" answer is `{ kind: "answered", value: "unavailable" }`,
// not `{ kind: "unavailable" }`.

describe("guest ask unavailable literal answer (#4375)", () => {
	it("preserves a guest answer of 'unavailable' as answered, not transport-unavailable", async () => {
		const ctx = makeHostContext();
		const host = new CollabHost(ctx);
		await host.start("ws://localhost:8787");
		ctx.collabHost = host;
		try {
			const guest = await joinRawGuest(host.link, COLLAB_PROTO);
			const welcome = await guest.nextFrame();
			if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);

			const pending = host.requestGuestUi({
				kind: "select",
				title: "Status?",
				options: ["available", "unavailable", "busy"],
			});
			if (!pending) throw new Error("expected writable guest UI request");
			const request = await guest.nextFrame();
			if (request.t !== "ui-request") throw new Error(`expected ui-request, got ${request.t}`);
			// Guest answers with the literal string "unavailable" — this must be
			// treated as a real answer, not a transport-unavailable sentinel.
			guest.socket.send({ t: "ui-response", reqId: request.request.reqId, value: "unavailable" });
			const result = await pending;
			expect(result).toEqual({ kind: "answered", value: "unavailable" });
			guest.socket.close();
		} finally {
			await host.stop("test done");
		}
	});
});

// ── Guest ask multi-select Next gating (#4375: PRRT_kwDOQxs0bc6OFbDW) ───────
//
// The local rich dialog disables the Next row on a single-question
// multi-select until at least one option or custom input is chosen. The guest
// mirror has no "disabled row" concept on the wire, so it must OMIT Next from
// the option list until an answer exists, then include it on the next round.
// This test pins that wire-level contract by inspecting consecutive
// ui-request frames.

/** Context double with the extra members `#showLocalAskDialog` touches when
 *  mounting the local AskDialogComponent. The local dialog is never driven
 *  (no input), so it never settles and the remote guest wins the race.
 *  Reuses makeHostContext for the CollabHost-facing members. */
function makeAskHostContext(): InteractiveModeContext {
	const base = makeHostContext();
	// Stub only the surface the local ask-dialog mount path calls: container
	// clear/addChild, ui focus/render, and editor (dispose path). The real
	// InteractiveModeContext has many more members; the double-cast below is
	// the established test pattern in this file (see makeHostContext) for a
	// complex interface that is only partially exercised.
	const stub = {
		...base,
		editorContainer: { clear: () => {}, addChild: () => {} },
		editor: { getText: () => "", setText: () => {} },
		closeLinkBrowser: () => {},
		ui: {
			requestRender: () => {},
			setFocus: () => {},
			terminal: { rows: 40, columns: 80 },
			addInputListener: () => () => {},
		},
	};
	return stub as unknown as InteractiveModeContext;
}

describe("guest ask host reconnect", () => {
	it.each(["guest", "host"])("lets a writer answer an open ask after a %s disconnect", async disconnect => {
		const relay = installInMemoryRelay();
		const probe = instrumentRelay(relay, { throttle: false });
		const ctx = makeAskHostContext();
		const host = new CollabHost(ctx);
		await host.start("ws://localhost:8787");
		ctx.collabHost = host;
		const controller = new ExtensionUiController(ctx);
		const abort = new AbortController();
		const firstGuest = await joinRawGuest(host.link, COLLAB_PROTO);
		let rejoined: { socket: CollabSocket; nextFrame(): Promise<CollabFrame> } | undefined;
		try {
			expect((await firstGuest.nextFrame()).t).toBe("welcome");
			const result = controller.showAskDialog(
				[{ id: "lock", question: "How should it lock?", options: [{ label: "ACCESS EXCLUSIVE" }] }],
				{ signal: abort.signal },
			);
			expect((await firstGuest.nextFrame()).t).toBe("ui-request");

			if (disconnect === "host") {
				const previousSocket = probe.hostSocket();
				previousSocket.close();
				await waitFor(() => probe.hostSocket() !== previousSocket && host.relayConnected, "host did not reconnect");
			} else {
				firstGuest.socket.close();
			}
			rejoined = await joinRawGuest(host.link, COLLAB_PROTO);
			expect((await rejoined.nextFrame()).t).toBe("welcome");
			// A directed error is a barrier: a retained ask must arrive before it.
			rejoined.socket.send({ t: "agent-cmd", cmd: "chat", agentId: "barrier", text: "" });
			const request = await rejoined.nextFrame();
			expect(request.t).toBe("ui-request");
			if (request.t !== "ui-request") throw new Error("pending ask was lost across the host reconnect");
			rejoined.socket.send({ t: "ui-response", reqId: request.request.reqId, value: "ACCESS EXCLUSIVE" });
			expect(await result).toMatchObject({
				kind: "submit",
				results: [{ id: "lock", selectedOptions: ["ACCESS EXCLUSIVE"] }],
			});
		} finally {
			abort.abort();
			firstGuest.socket.close();
			rejoined?.socket.close();
			await host.stop("test done");
		}
	});
});

describe("guest ask room ownership", () => {
	it.each(["next question", "custom answer"])("does not mirror a %s to a successor room", async followup => {
		const ctx = makeAskHostContext();
		const host = new CollabHost(ctx);
		await host.start("ws://localhost:8787");
		ctx.collabHost = host;
		const successor = new CollabHost(ctx);
		const guest = await joinRawGuest(host.link, COLLAB_PROTO);
		const abort = new AbortController();
		const replaced = Promise.withResolvers<void>();
		const requestGuestUi = host.requestGuestUi.bind(host);
		const requestSpy = spyOn(host, "requestGuestUi").mockImplementation((request, signal) => {
			const response = requestGuestUi(request, signal);
			// Exercise the settled-answer / suspended-loop boundary. Ending the old
			// room cannot change this already answered promise to unavailable.
			void response?.then(() => {
				void host.stop("replaced");
				ctx.collabHost = successor;
				replaced.resolve();
			});
			return response;
		});
		try {
			expect((await guest.nextFrame()).t).toBe("welcome");
			const questions: ExtensionAskDialogQuestion[] = [
				{ id: "first", question: "Original room question?", options: [{ label: "Alpha" }] },
			];
			if (followup === "next question") {
				questions.push({ id: "second", question: "Private next question?", options: [{ label: "Beta" }] });
			}
			const controller = new ExtensionUiController(ctx);
			const result = controller.showAskDialog(questions, { signal: abort.signal });
			const request = await guest.nextFrame();
			if (request.t !== "ui-request") throw new Error(`expected ui-request, got ${request.t}`);
			guest.socket.send({
				t: "ui-response",
				reqId: request.request.reqId,
				value: followup === "next question" ? "Alpha" : "Other (type your own)",
			});
			await replaced.promise;
			await Bun.sleep(0);
			// Pending requests are replayed to the next writer even before start().
			// The successor must have no retained question from the original ask.
			expect(successor.inputRequired).toBe(false);
			abort.abort();
			expect(await result).toBeUndefined();
		} finally {
			abort.abort();
			requestSpy.mockRestore();
			guest.socket.close();
			await host.stop("test done");
			await successor.stop("test done");
		}
	});
});

describe("guest ask multi-select Next gating (#4375 PRRT_kwDOQxs0bc6OFbDW)", () => {
	/** Skip ui-request-end dismissal frames, wait for the next ui-request. */
	async function nextUiRequest(guest: {
		nextFrame(): Promise<CollabFrame>;
	}): Promise<CollabFrame & { t: "ui-request" }> {
		for (;;) {
			const frame = await guest.nextFrame();
			if (frame.t === "ui-request") return frame;
			// ui-request-end / other non-request frames are expected between
			// rounds; keep draining until the next request arrives.
		}
	}

	/** Extract string labels from a select ui-request's options, narrowing the
	 *  discriminated union so `options` is visible to the type checker. */
	function selectLabels(frame: CollabFrame & { t: "ui-request" }): string[] {
		if (frame.request.kind !== "select") throw new Error(`expected select, got ${frame.request.kind}`);
		return frame.request.options.map(o => (typeof o === "string" ? o : o.label));
	}

	it("omits Next from the first ui-request, includes it after a toggle", async () => {
		const ctx = makeAskHostContext();
		const host = new CollabHost(ctx);
		await host.start("ws://localhost:8787");
		ctx.collabHost = host;
		const controller = new ExtensionUiController(ctx);
		try {
			const guest = await joinRawGuest(host.link, COLLAB_PROTO);
			const welcome = await guest.nextFrame();
			if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);

			const questions: ExtensionAskDialogQuestion[] = [
				{
					id: "q1",
					question: "Pick several?",
					options: [{ label: "Option A" }, { label: "Option B" }],
					multi: true,
				},
			];
			const result = controller.showAskDialog(questions);

			// First ui-request: Next must be absent (no answer yet).
			const first = await nextUiRequest(guest);
			const firstLabels = selectLabels(first);
			expect(firstLabels).not.toContain("Next →");

			// Guest toggles Option A — a real answer, not Next/Other/Chat.
			guest.socket.send({ t: "ui-response", reqId: first.request.reqId, value: "Option A" });

			// Second ui-request: Next must now be present.
			const second = await nextUiRequest(guest);
			const secondLabels = selectLabels(second);
			expect(secondLabels).toContain("Next →");

			// Guest selects Next to submit.
			guest.socket.send({ t: "ui-response", reqId: second.request.reqId, value: "Next →" });
			const settled = await result;
			expect(settled?.kind).toBe("submit");
			if (settled?.kind === "submit") {
				expect(settled.results[0]?.selectedOptions).toEqual(["Option A"]);
			}
			guest.socket.close();
		} finally {
			await host.stop("test done");
		}
	});

	it("sends sanitized display copies to the guest while echoing original labels", async () => {
		// \r-degenerate args must not splatter the guest selector, and the
		// guest's answer (given against display labels) must map back to the
		// original correlation values in the result.
		const ctx = makeAskHostContext();
		const host = new CollabHost(ctx);
		await host.start("ws://localhost:8787");
		ctx.collabHost = host;
		const controller = new ExtensionUiController(ctx);
		try {
			const guest = await joinRawGuest(host.link, COLLAB_PROTO);
			const welcome = await guest.nextFrame();
			if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);

			const questions: ExtensionAskDialogQuestion[] = [
				{
					id: "q1",
					question: "Pick\r\rone?",
					options: [{ label: "Retry\rnow", description: "Try\r\ragain." }, { label: "Abort" }],
				},
			];
			const result = controller.showAskDialog(questions);

			const first = await nextUiRequest(guest);
			expect(JSON.stringify(first.request)).not.toContain("\r");
			expect(selectLabels(first).slice(0, 2)).toEqual(["Retry now", "Abort"]);

			// Guest answers with the sanitized display label.
			guest.socket.send({ t: "ui-response", reqId: first.request.reqId, value: "Retry now" });
			const settled = await result;
			expect(settled?.kind).toBe("submit");
			if (settled?.kind === "submit") {
				expect(settled.results[0]?.options).toEqual(["Retry\rnow", "Abort"]);
				expect(settled.results[0]?.selectedOptions).toEqual(["Retry\rnow"]);
			}
			guest.socket.close();
		} finally {
			await host.stop("test done");
		}
	});

	it("maps multi-select guest toggles back to original labels", async () => {
		// Same display/identity split through the checkbox path: the guest
		// toggles sanitized rows (checkedIndices round-trips against the
		// originals), submits via Next, and the result echoes originals.
		const ctx = makeAskHostContext();
		const host = new CollabHost(ctx);
		await host.start("ws://localhost:8787");
		ctx.collabHost = host;
		const controller = new ExtensionUiController(ctx);
		try {
			const guest = await joinRawGuest(host.link, COLLAB_PROTO);
			const welcome = await guest.nextFrame();
			if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);

			const questions: ExtensionAskDialogQuestion[] = [
				{
					id: "q2",
					question: "Pick\rseveral?",
					options: [{ label: "Gamma\rG" }, { label: "Delta" }],
					multi: true,
				},
			];
			const result = controller.showAskDialog(questions);

			const first = await nextUiRequest(guest);
			expect(JSON.stringify(first.request)).not.toContain("\r");
			guest.socket.send({ t: "ui-response", reqId: first.request.reqId, value: "Gamma G" });

			const second = await nextUiRequest(guest);
			expect(selectLabels(second)).toContain("Next →");
			guest.socket.send({ t: "ui-response", reqId: second.request.reqId, value: "Next →" });

			const settled = await result;
			expect(settled?.kind).toBe("submit");
			if (settled?.kind === "submit") {
				expect(settled.results[0]?.options).toEqual(["Gamma\rG", "Delta"]);
				expect(settled.results[0]?.selectedOptions).toEqual(["Gamma\rG"]);
			}
			guest.socket.close();
		} finally {
			await host.stop("test done");
		}
	});

	it("disambiguates guest rows that sanitize alike and keeps sentinel actions", async () => {
		// Two options sanitizing to one label must render as distinct rows or
		// the second row answers the first; a sanitized label matching a
		// runtime sentinel must not trigger that action either.
		const ctx = makeAskHostContext();
		const host = new CollabHost(ctx);
		await host.start("ws://localhost:8787");
		ctx.collabHost = host;
		const controller = new ExtensionUiController(ctx);
		try {
			const guest = await joinRawGuest(host.link, COLLAB_PROTO);
			const welcome = await guest.nextFrame();
			if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);

			const questions: ExtensionAskDialogQuestion[] = [
				{
					id: "q3",
					question: "Retry?",
					options: [{ label: "Retry\rnow" }, { label: "Retry now" }],
				},
				{
					id: "q4",
					question: "Discuss?",
					options: [{ label: "Chat\rabout this" }, { label: "Beta" }],
				},
			];
			const result = controller.showAskDialog(questions);

			const first = await nextUiRequest(guest);
			expect(JSON.stringify(first.request)).not.toContain("\r");
			expect(selectLabels(first).slice(0, 2)).toEqual(["Retry now", "Retry now (2)"]);
			// Second row answers the second original, not the first.
			guest.socket.send({ t: "ui-response", reqId: first.request.reqId, value: "Retry now (2)" });

			const second = await nextUiRequest(guest);
			expect(JSON.stringify(second.request)).not.toContain("\r");
			expect(selectLabels(second).slice(0, 2)).toEqual(["Chat about this (2)", "Beta"]);
			// Sanitized sentinel text answers the option — not a chat redirect.
			guest.socket.send({ t: "ui-response", reqId: second.request.reqId, value: "Chat about this (2)" });

			const settled = await result;
			expect(settled?.kind).toBe("submit");
			if (settled?.kind === "submit") {
				expect(settled.results[0]?.selectedOptions).toEqual(["Retry now"]);
				expect(settled.results[1]?.selectedOptions).toEqual(["Chat\rabout this"]);
			}
			guest.socket.close();
		} finally {
			await host.stop("test done");
		}
	});

	it("coerces malformed guest questions instead of rejecting the race", async () => {
		// A JS extension can supply a question entry without a string
		// `question` field; the guest path must not throw inside the
		// sanitizer and reject the whole showAskDialog race.
		const ctx = makeAskHostContext();
		const host = new CollabHost(ctx);
		await host.start("ws://localhost:8787");
		ctx.collabHost = host;
		const controller = new ExtensionUiController(ctx);
		try {
			const guest = await joinRawGuest(host.link, COLLAB_PROTO);
			const welcome = await guest.nextFrame();
			if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);

			const questions = [{ id: "q1", options: [{ label: "Alpha" }] }] as unknown as ExtensionAskDialogQuestion[];
			const result = controller.showAskDialog(questions);

			const first = await nextUiRequest(guest);
			if (first.request.kind !== "select") throw new Error(`expected select, got ${first.request.kind}`);
			expect(first.request.title).toBe("");
			guest.socket.send({ t: "ui-response", reqId: first.request.reqId, value: "Alpha" });

			const settled = await result;
			expect(settled?.kind).toBe("submit");
			if (settled?.kind === "submit") {
				expect(settled.results[0]?.id).toBe("q1");
				expect(settled.results[0]?.question).toBe("");
				expect(settled.results[0]?.selectedOptions).toEqual(["Alpha"]);
			}
			guest.socket.close();
		} finally {
			await host.stop("test done");
		}
	});
});

describe("guest ask closed by the host person's message", () => {
	it("returns the guest's finished answers with the host's, the host's winning where both answered", async () => {
		const ctx = makeAskHostContext();
		// Capture the host's own ask dialog so the host's person can answer in it.
		let local: AskDialogComponent | undefined;
		ctx.editorContainer.addChild = child => {
			if (child instanceof AskDialogComponent) local = child;
		};
		const host = new CollabHost(ctx);
		await host.start("ws://localhost:8787");
		ctx.collabHost = host;
		const controller = new ExtensionUiController(ctx);
		const superseded = new AbortController();
		try {
			const guest = await joinRawGuest(host.link, COLLAB_PROTO);
			const welcome = await guest.nextFrame();
			if (welcome.t !== "welcome") throw new Error(`expected welcome, got ${welcome.t}`);
			const nextRequest = async (): Promise<CollabFrame & { t: "ui-request" }> => {
				for (;;) {
					const frame = await guest.nextFrame();
					if (frame.t === "ui-request") return frame;
				}
			};

			const result = controller.showAskDialog(
				[
					{ id: "first", question: "First?", options: [{ label: "Alpha" }, { label: "Gamma" }] },
					{ id: "second", question: "Second?", options: [{ label: "Beta" }] },
					{ id: "third", question: "Third?", options: [{ label: "Delta" }] },
				],
				{ signal: superseded.signal },
			);
			// The host's person answers the first question; the guest answers it differently.
			local?.handleInput("\r");
			guest.socket.send({ t: "ui-response", reqId: (await nextRequest()).request.reqId, value: "Gamma" });
			guest.socket.send({ t: "ui-response", reqId: (await nextRequest()).request.reqId, value: "Beta" });
			await nextRequest();
			// The guest is on the third question when the host's person sends a message.
			superseded.abort(new DialogSupersededError());

			expect(await result).toMatchObject({
				kind: "submit",
				interrupted: true,
				results: [
					{ id: "first", selectedOptions: ["Alpha"] },
					{ id: "second", selectedOptions: ["Beta"] },
					{ id: "third", selectedOptions: [], customInput: undefined },
				],
			});
			guest.socket.close();
		} finally {
			superseded.abort();
			await host.stop("test done");
		}
	});

	it("releases the ask within one round trip when an idle guest is shown the question", async () => {
		const ctx = makeAskHostContext();
		const host = new CollabHost(ctx);
		await host.start("ws://localhost:8787");
		ctx.collabHost = host;
		const controller = new ExtensionUiController(ctx);
		const superseded = new AbortController();
		try {
			// A real TUI guest; nobody answers the question it shows.
			const guest = await joinGuestLink(host.link);
			harnessCleanups.push(() => guest.guest.leave("test cleanup").catch(() => {}));
			const result = controller.showAskDialog(
				[{ id: "deploy", question: "Deploy?", options: [{ label: "Yes" }, { label: "No" }] }],
				{ signal: superseded.signal },
			);
			const dialog = await guest.nextDialog();
			let released = false;
			void result.then(() => {
				released = true;
			});

			// On a fake clock the two-second window for guests that send no acknowledgement never ends: only the
			// acknowledgement this guest sends by itself when it reads the withdrawal can release the ask.
			vi.useFakeTimers();
			try {
				superseded.abort(new DialogSupersededError());
				for (let turn = 0; turn < 5_000 && !released; turn++) await tick();
			} finally {
				vi.useRealTimers();
			}

			expect(released).toBe(true);
			expect(dialog.aborted).toBe(true);
			expect(host.inputRequired).toBe(false);
			expect(await result).toMatchObject({
				kind: "submit",
				interrupted: true,
				results: [{ id: "deploy", selectedOptions: [], unanswered: true }],
			});
		} finally {
			superseded.abort();
			await host.stop("test done");
		}
	});
});

// ── Withdrawn guest request ─────────────────────────────────────────────────
//
// A message from the host's person withdraws a guest's open request. It settles with the first answer
// from a writer it still waits for, else `unavailable` once each writer it was shown to has replied,
// left, or run out of time, or once its caller stops waiting.

describe("withdrawn guest request", () => {
	const select: CollabUiRequestDraft = { kind: "select", title: "Deploy?", options: ["Yes", "No"] };

	/** Lets relay deliveries and frame encryption run; never advances a clock. */
	async function drain(): Promise<void> {
		for (let turn = 0; turn < 100; turn++) await tick();
	}

	async function startHost(ctx = makeHostContext()): Promise<CollabHost> {
		const host = new CollabHost(ctx);
		await host.start("ws://localhost:8787");
		harnessCleanups.push(() => host.stop("test done"));
		return host;
	}

	async function joinWriter(host: CollabHost, name: string, cancelReplies: boolean): Promise<RawWireGuest> {
		const guest = await joinRawGuest(host.link, COLLAB_PROTO, { name, cancelReplies });
		harnessCleanups.push(async () => guest.socket.close());
		expect((await guest.nextFrame()).t).toBe("welcome");
		return guest;
	}

	async function nextRequestId(guest: RawWireGuest): Promise<number> {
		const frame = await guest.nextFrame();
		if (frame.t !== "ui-request") throw new Error(`expected a ui-request, got ${frame.t}`);
		return frame.request.reqId;
	}

	/** The guest reads the withdrawal; a raw guest sends nothing back unless the test does. */
	async function readWithdrawal(guest: RawWireGuest, reqId: number): Promise<void> {
		expect(await guest.nextFrame()).toEqual({ t: "ui-request-end", reqId, withdrawn: true });
	}

	/** Sends `frame` and waits until it is sealed and handed to the relay, so the next send cannot overtake it. */
	async function sendInOrder(guest: RawWireGuest, frame: CollabFrame): Promise<void> {
		guest.socket.send(frame);
		await guest.socket.flush();
		await drain();
	}

	function watch<T>(promise: Promise<T>): { readonly settled: boolean } {
		const state = { settled: false };
		void promise.then(() => {
			state.settled = true;
		});
		return state;
	}

	it("stops waiting for a guest that never replies once its time runs out, naming it in the status meanwhile", async () => {
		const ctx = makeHostContext();
		const waits: string[][] = [];
		Object.assign(ctx.statusLine, {
			setCollabStatus: (status: { waitingOn?: readonly string[] } | null) =>
				waits.push([...(status?.waitingOn ?? [])]),
		});
		const host = await startHost(ctx);
		// A paused browser tab: connected, opted in, reads nothing.
		const guest = await joinWriter(host, "paused tab", true);
		const superseded = new AbortController();
		const result = host.requestGuestUi(select, superseded.signal)!;
		const reqId = await nextRequestId(guest);
		const ended = watch(result);
		vi.useFakeTimers();
		try {
			superseded.abort(new DialogSupersededError());
			await readWithdrawal(guest, reqId);
			vi.advanceTimersByTime(WITHDRAWN_GUEST_REPLY_LIMIT_MS - 1);
			await drain();
			expect(ended.settled).toBe(false);
			// Nobody is asked anything, yet the host's turn waits: the status says on whom.
			expect(host.inputRequired).toBe(false);
			expect(host.awaitingGuests).toEqual(["paused tab"]);
			expect(waits.at(-1)).toEqual(["paused tab"]);

			vi.advanceTimersByTime(1);
			await drain();
			expect(ended.settled).toBe(true);
			expect(await result).toEqual({ kind: "unavailable" });
			expect(host.awaitingGuests).toEqual([]);
			expect(waits.at(-1)).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});

	describe("hears only the writers it still waits for", () => {
		it("ignores an answer a guest sends after its own reply to the withdrawal", async () => {
			const host = await startHost();
			const first = await joinWriter(host, "first", true);
			const second = await joinWriter(host, "second", true);
			const superseded = new AbortController();
			const result = host.requestGuestUi(select, superseded.signal)!;
			const reqId = await nextRequestId(first);
			await nextRequestId(second);
			superseded.abort(new DialogSupersededError());
			await readWithdrawal(first, reqId);
			await readWithdrawal(second, reqId);

			await sendInOrder(first, { t: "ui-response", reqId });
			await sendInOrder(first, { t: "ui-response", reqId, value: "Yes" });
			await sendInOrder(second, { t: "ui-response", reqId, value: "No" });

			expect(await result).toEqual({ kind: "answered", value: "No" });
		});

		it("ignores an answer from a guest that predates cancel replies once its window has passed", async () => {
			const host = await startHost();
			const legacy = await joinWriter(host, "legacy", false);
			const current = await joinWriter(host, "current", true);
			const superseded = new AbortController();
			const result = host.requestGuestUi(select, superseded.signal)!;
			const reqId = await nextRequestId(legacy);
			await nextRequestId(current);
			vi.useFakeTimers();
			try {
				superseded.abort(new DialogSupersededError());
				await readWithdrawal(legacy, reqId);
				await readWithdrawal(current, reqId);
				vi.advanceTimersByTime(WITHDRAWN_DIALOG_REPLY_MS);
				await sendInOrder(legacy, { t: "ui-response", reqId, value: "Yes" });
				await sendInOrder(current, { t: "ui-response", reqId, value: "No" });
				expect(await result).toEqual({ kind: "answered", value: "No" });
			} finally {
				vi.useRealTimers();
			}
		});

		it("ignores an answer from a guest that joined after the withdrawal", async () => {
			const host = await startHost();
			const shown = await joinWriter(host, "shown", true);
			const superseded = new AbortController();
			const result = host.requestGuestUi(select, superseded.signal)!;
			const reqId = await nextRequestId(shown);
			superseded.abort(new DialogSupersededError());
			await readWithdrawal(shown, reqId);
			const late = await joinWriter(host, "late", true);

			await sendInOrder(late, { t: "ui-response", reqId, value: "Yes" });
			await sendInOrder(shown, { t: "ui-response", reqId, value: "No" });

			expect(await result).toEqual({ kind: "answered", value: "No" });
		});
	});

	it.each(["before", "after"] as const)(
		"keeps an answer still decrypting when its guest leaves, withdrawn %s the host sees it leave",
		async order => {
			const host = await startHost();
			const guest = await joinWriter(host, "leaving", true);
			const superseded = new AbortController();
			const result = host.requestGuestUi(select, superseded.signal)!;
			const reqId = await nextRequestId(guest);
			// The host has received the guest's answer but is still decrypting it when the relay reports the
			// guest gone.
			const opened = Promise.withResolvers<void>();
			const realDecrypt = crypto.subtle.decrypt.bind(crypto.subtle);
			const decrypt = vi
				.spyOn(crypto.subtle, "decrypt")
				.mockImplementation(async (...args: Parameters<typeof crypto.subtle.decrypt>) => {
					await opened.promise;
					return realDecrypt(...args);
				});
			try {
				await sendInOrder(guest, { t: "ui-response", reqId, value: "No" });
				if (order === "before") superseded.abort(new DialogSupersededError());
				guest.socket.close();
				await waitFor(() => host.participants.length === 1, "host never saw the guest leave");
				if (order === "after") superseded.abort(new DialogSupersededError());
				const ended = watch(result);
				await drain();
				expect(ended.settled).toBe(false);

				opened.resolve();
				expect(await result).toEqual({ kind: "answered", value: "No" });
			} finally {
				opened.resolve();
				decrypt.mockRestore();
			}
		},
	);

	it("takes an answer still decrypting when its guest leaves for a request nobody withdrew", async () => {
		const host = await startHost();
		const guest = await joinWriter(host, "leaving", true);
		const result = host.requestGuestUi(select)!;
		const reqId = await nextRequestId(guest);
		const opened = Promise.withResolvers<void>();
		const realDecrypt = crypto.subtle.decrypt.bind(crypto.subtle);
		const decrypt = vi
			.spyOn(crypto.subtle, "decrypt")
			.mockImplementation(async (...args: Parameters<typeof crypto.subtle.decrypt>) => {
				await opened.promise;
				return realDecrypt(...args);
			});
		try {
			// The relay forwarded the answer while the guest was present; the host is still decrypting it when
			// the guest's departure arrives.
			await sendInOrder(guest, { t: "ui-response", reqId, value: "No" });
			guest.socket.close();
			await waitFor(() => host.participants.length === 1, "host never saw the guest leave");
			const ended = watch(result);
			opened.resolve();
			await waitFor(() => ended.settled, "the host dropped the answer its guest sent before leaving");
			expect(await result).toEqual({ kind: "answered", value: "No" });
		} finally {
			opened.resolve();
			decrypt.mockRestore();
		}
	});

	it("does not wait on a writer that left before the request was shown, while its frames still decrypt", async () => {
		const host = await startHost();
		const leaving = await joinWriter(host, "left earlier", true);
		const opened = Promise.withResolvers<void>();
		const realDecrypt = crypto.subtle.decrypt.bind(crypto.subtle);
		const decrypt = vi
			.spyOn(crypto.subtle, "decrypt")
			.mockImplementation(async (...args: Parameters<typeof crypto.subtle.decrypt>) => {
				await opened.promise;
				return realDecrypt(...args);
			});
		try {
			// The writer leaves with a frame the host has received but not yet decrypted.
			await sendInOrder(leaving, { t: "prompt", text: "still decrypting" });
			leaving.socket.close();
			await waitFor(() => host.participants.length === 1, "host never saw the guest leave");
			// Only then does the host ask, so that writer is never shown the request and cannot reply to its
			// withdrawal.
			const superseded = new AbortController();
			const result = host.requestGuestUi(select, superseded.signal)!;
			const ended = watch(result);
			superseded.abort(new DialogSupersededError());
			await drain();
			expect(host.awaitingGuests).toEqual([]);
			expect(ended.settled).toBe(true);
			expect(await result).toEqual({ kind: "unavailable" });
		} finally {
			opened.resolve();
			decrypt.mockRestore();
		}
	});

	it("ends a withdrawn request at once when its caller stops waiting, leaving room for later questions", async () => {
		const host = await startHost();
		// Connected and opted in, but never replies: only the caller can end the wait in time.
		const guest = await joinWriter(host, "silent", true);
		// More than the host keeps open at once (64), so a request left behind would refuse a later one.
		for (let cycle = 0; cycle < 65; cycle++) {
			const superseded = new AbortController();
			const run = new AbortController();
			const result = host.requestGuestUi(select, superseded.signal);
			if (!result) throw new Error(`cycle ${cycle}: the host refused a new question`);
			const reqId = await nextRequestId(guest);
			superseded.abort(new DialogSupersededError(run.signal));
			await readWithdrawal(guest, reqId);
			const ended = watch(result);
			run.abort();
			await drain();
			expect(ended.settled).toBe(true);
			expect(await result).toEqual({ kind: "unavailable" });
			// Its end reaches the guest too.
			expect(await guest.nextFrame()).toEqual({ t: "ui-request-end", reqId });
		}
		expect(host.awaitingGuests).toEqual([]);
	});
});
