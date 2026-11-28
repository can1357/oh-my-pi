import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ExtensionLiveStartOptions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { LiveSessionController, type LiveSessionControllerOptions } from "@oh-my-pi/pi-coding-agent/live/controller";
import type { LiveServerEvent } from "@oh-my-pi/pi-coding-agent/live/protocol";
import * as liveTransport from "@oh-my-pi/pi-coding-agent/live/transport";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import type { LiveTransportOptions } from "@oh-my-pi/pi-coding-agent/live/transport";
import { LiveCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/live-command-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { type OverlayHandle, Shell } from "@oh-my-pi/pi-coding-agent/ui/shell/index";
import { type JSXNode, signal } from "@oh-my-pi/pi-tui";
import { keyEvent } from "../../helpers/input-harness";

/** Fake InteractiveModeContext on a real shell, recording what replaced the composer. */
interface ContextHarness {
	ctx: InteractiveModeContext;
	shell: Shell;
	/** Every dialog mounted in the composer's place, in order. */
	dialogs: OverlayHandle[];
}

function createContext(): ContextHarness {
	const shell = new Shell();
	const dialogs: OverlayHandle[] = [];
	const ctx = {
		shell,
		settings: Settings.isolated({ "live.voice": "vale" }),
		keybindings: { keysFor: vi.fn(() => ["ctrl+l"]) },
		session: {},
		extractAssistantText: vi.fn(() => ""),
		showEditorAreaDialog: (factory: () => JSXNode) => {
			const handle = shell.overlays.show(factory);
			dialogs.push(handle);
			return handle;
		},
		showError: vi.fn(),
		presentAssistant: vi.fn(),
	} as unknown as InteractiveModeContext;
	return { ctx, shell, dialogs };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("LiveCommandController", () => {
	it("forwards the selected voice across the live-session boundary", async () => {
		const { ctx } = createContext();
		let receivedVoice: string | undefined;
		const controller = new LiveCommandController(ctx, options => {
			receivedVoice = options.voice;
			const session = new LiveSessionController(options);
			vi.spyOn(session, "start").mockResolvedValue();
			vi.spyOn(session, "stop").mockResolvedValue();
			return session;
		});

		try {
			await controller.handleCommand();
			expect(receivedVoice).toBe("vale");
		} finally {
			await controller.stop();
		}
	});

	it("stops the session and restores the composer when the live-toggle chord hits the focused visualizer", async () => {
		const { ctx, shell, dialogs } = createContext();
		const stop = vi.fn(async () => {});
		const controller = new LiveCommandController(ctx, options => {
			const session = new LiveSessionController(options);
			vi.spyOn(session, "start").mockResolvedValue();
			vi.spyOn(session, "stop").mockImplementation(stop);
			return session;
		});

		await controller.handleCommand();
		expect(controller.active).toBe(true);

		// The visualizer takes the composer's place and its focus;
		// Ctrl+L must end the call from there, not just from the composer.
		const [visualizer] = dialogs;
		if (!visualizer) throw new Error("expected the controller to mount the visualizer");
		expect(shell.focused()).toBe(visualizer.node);
		expect(visualizer.node.handlers.onKey?.(keyEvent("ctrl+l"))).toBe(true); // the keypress alone drives teardown
		for (let i = 0; !visualizer.closed && i < 20; i++) await Promise.resolve();

		expect(stop).toHaveBeenCalled();
		expect(visualizer.closed).toBe(true);
		// `active` stays true until #finish's fire-and-forget settling promise
		// clears; drain microtasks deterministically instead of sleeping.
		for (let i = 0; controller.active && i < 20; i++) await Promise.resolve();
		expect(controller.active).toBe(false);
	});

	it("gives an extension session its SDP answer, its events, and one end when `/live` stops it", async () => {
		const { ctx } = createContext();
		let receivedOffer: string | undefined;
		const controller = new LiveCommandController(ctx, options => {
			receivedOffer = options.sdpOffer;
			const session = new LiveSessionController(options);
			vi.spyOn(session, "start").mockImplementation(async () => {
				options.callbacks.onPhase("listening");
				options.callbacks.onTranscript({ role: "user", turn: 1, text: "list files", final: true });
			});
			Object.defineProperty(session, "sdpAnswer", { value: "v=0 answer" });
			// Like the real controller: the terminal callback fires once, however often stop() runs.
			let ended = false;
			vi.spyOn(session, "stop").mockImplementation(async () => {
				if (ended) return;
				ended = true;
				options.callbacks.onTerminal();
			});
			return session;
		});
		const phases: string[] = [];
		const transcripts: string[] = [];
		const ends: (Error | undefined)[] = [];

		const live = await controller.startRemote({
			sdpOffer: "v=0 offer",
			onPhase: phase => {
				phases.push(phase);
				throw new Error("observer bug");
			},
			onTranscript: transcript => transcripts.push(transcript.text),
			onEnd: error => ends.push(error),
		});

		expect(receivedOffer).toBe("v=0 offer");
		expect(live).toMatchObject({ sdpAnswer: "v=0 answer", voice: "vale" });
		expect(phases).toEqual(["listening"]);
		expect(transcripts).toEqual(["list files"]);
		// A throwing observer must not end the call.
		expect(controller.active).toBe(true);
		await expect(controller.startRemote({ sdpOffer: "v=0 again" })).rejects.toThrow("already active");

		await controller.handleCommand();
		await live.stop();
		expect(ends).toEqual([undefined]);
	});

	it("lets exactly one of two starts queued behind a closing session win", async () => {
		const { ctx } = createContext();
		const cleanup = Promise.withResolvers<void>();
		const created: { session: LiveSessionController; options: LiveSessionControllerOptions }[] = [];
		const controller = new LiveCommandController(ctx, options => {
			const session = new LiveSessionController(options);
			Object.defineProperty(session, "sdpAnswer", { value: `answer ${created.length}` });
			vi.spyOn(session, "start").mockResolvedValue();
			// The first session's teardown stays pending, so later starts wait on its cleanup.
			const isFirst = created.length === 0;
			vi.spyOn(session, "stop").mockImplementation(() => (isFirst ? cleanup.promise : Promise.resolve()));
			created.push({ session, options });
			return session;
		});

		await controller.startRemote({ sdpOffer: "first" });
		// The call drops on its own: the slot frees at once, its cleanup does not.
		created[0]!.options.callbacks.onTerminal(new Error("sideband closed"));
		const a = controller.startRemote({ sdpOffer: "a" });
		const b = controller.startRemote({ sdpOffer: "b" });
		cleanup.resolve();
		const results = await Promise.allSettled([a, b]);

		expect(results.map(result => result.status).sort()).toEqual(["fulfilled", "rejected"]);
		expect(results.find(result => result.status === "rejected")).toMatchObject({
			reason: expect.objectContaining({ message: expect.stringContaining("already active") }),
		});
		expect(created).toHaveLength(2);
		expect(controller.active).toBe(true);
	});

	it("presents the spoken reply in the accent tone", async () => {
		const { ctx } = createContext();
		const view = { message: signal(undefined), transient: signal(false), finalized: signal(false) };
		const present = vi.fn((..._args: Parameters<InteractiveModeContext["presentAssistant"]>) => view);
		Object.assign(ctx, { presentAssistant: present });
		const controller = new LiveCommandController(ctx, options => {
			const session = new LiveSessionController(options);
			vi.spyOn(session, "start").mockImplementation(async () => {
				options.callbacks.onTranscript({ role: "assistant", turn: 1, text: "Hello there", final: true });
			});
			vi.spyOn(session, "stop").mockResolvedValue();
			return session;
		});

		try {
			await controller.handleCommand();
			expect(present).toHaveBeenCalledTimes(1);
			const [message, options] = present.mock.calls[0]!;
			expect(message?.content).toEqual([{ type: "text", text: "Hello there" }]);
			expect(options).toEqual({ tone: "accent" });
			expect(view.finalized()).toBe(true);
		} finally {
			await controller.stop();
		}
	});

	it("rejects an extension start without an SDP offer before creating a session", async () => {
		const { ctx, dialogs } = createContext();
		const factory = vi.fn((options: LiveSessionControllerOptions) => new LiveSessionController(options));
		const controller = new LiveCommandController(ctx, factory);
		const untyped = { sdpOffer: undefined } as unknown as ExtensionLiveStartOptions;

		await expect(controller.startRemote(untyped)).rejects.toThrow("non-empty sdpOffer");
		await expect(controller.startRemote({ sdpOffer: "  " })).rejects.toThrow("non-empty sdpOffer");
		expect(factory).not.toHaveBeenCalled();
		expect(dialogs).toEqual([]);
		expect(controller.active).toBe(false);
	});

	it("surfaces a session factory failure from `/live` and puts the composer back", async () => {
		const { ctx, shell, dialogs } = createContext();
		const controller = new LiveCommandController(ctx, () => {
			throw new Error("factory broke");
		});
		await expect(controller.handleCommand()).rejects.toThrow("factory broke");
		expect(dialogs.every(dialog => dialog.closed)).toBe(true);
		expect(shell.overlays.open()).toBe(false);
		expect(controller.active).toBe(false);
	});
});

describe("LiveSessionController with a caller-owned peer", () => {
	it("mutes by phase only and reports no levels", () => {
		const phases: string[] = [];
		const levels: number[][] = [];
		const session = new LiveSessionController({
			session: {} as unknown as LiveSessionControllerOptions["session"],
			extractAssistantText: () => "",
			sdpOffer: "v=0 offer",
			callbacks: {
				onPhase: phase => phases.push(phase),
				onLevels: (input, output) => levels.push([input, output]),
				onTranscript: () => {},
				onTerminal: () => {},
			},
		});
		session.toggleMute();
		expect(phases.at(-1)).toBe("muted");
		expect(session.muted).toBe(true);
		expect(levels).toEqual([]);
	});

	it("keeps a muted call muted when the server starts the session or delegates work", async () => {
		let onEvent: ((event: LiveServerEvent) => void) | undefined;
		// bun's spyOn types a class export's implementation as `never`; the controller only needs
		// a constructible stand-in, so a plain function (not an arrow: it is called with `new`) suffices.
		const transportSpy = vi.spyOn(liveTransport, "LiveTransport") as unknown as {
			mockImplementation(implementation: (options: LiveTransportOptions) => object): void;
		};
		transportSpy.mockImplementation(function (options: LiveTransportOptions) {
			onEvent = options.callbacks.onEvent;
			return {
				connect: async () => {},
				setMuted: async () => {},
				send: async () => {},
				close: async () => {},
				sdpAnswer: "v=0 answer",
			};
		});
		const delegated: string[] = [];
		const phases: string[] = [];
		const agentSession = {
			modelRegistry: { authStorage: {} },
			settings: Settings.isolated(),
			sessionId: "s1",
			sessionManager: { getSessionId: () => "s1" },
			subscribe: () => () => {},
			sendCustomMessage: async (message: { content: string }) => {
				delegated.push(message.content);
			},
		} as unknown as LiveSessionControllerOptions["session"];
		const session = new LiveSessionController({
			session: agentSession,
			extractAssistantText: () => "",
			sdpOffer: "v=0 offer",
			callbacks: {
				onPhase: phase => phases.push(phase),
				onLevels: () => {},
				onTranscript: () => {},
				onTerminal: () => {},
			},
		});
		await session.start();
		session.toggleMute();
		onEvent!({ type: "session.started", session: { id: "rtc_1" } });
		onEvent!({
			type: "delegation.created",
			item: {
				type: "delegation",
				target: "client",
				id: "d1",
				content: [{ type: "input_text", text: "list files" }],
			},
		});

		expect(delegated).toEqual(["list files"]);
		// A remote peer re-enables its microphone on any phase but `muted`.
		expect(phases.slice(phases.indexOf("muted"))).toEqual(["muted"]);
		session.toggleMute();
		expect(phases.at(-1)).toBe("working");
		await session.stop();
	});

	it("hands the voice the answer when the run pauses on background work", async () => {
		let onEvent: ((event: LiveServerEvent) => void) | undefined;
		const transportSpy = vi.spyOn(liveTransport, "LiveTransport") as unknown as {
			mockImplementation(implementation: (options: LiveTransportOptions) => object): void;
		};
		const sent: { delegation_item_id?: string; content?: { text: string }[] }[] = [];
		const sentTwice = Promise.withResolvers<void>();
		transportSpy.mockImplementation(function (options: LiveTransportOptions) {
			onEvent = options.callbacks.onEvent;
			return {
				connect: async () => {},
				setMuted: async () => {},
				send: async (message: (typeof sent)[number]) => {
					sent.push(message);
					if (sent.length === 2) sentTwice.resolve();
				},
				close: async () => {},
				sdpAnswer: "v=0 answer",
			};
		});
		let emit: ((event: AgentSessionEvent) => void) | undefined;
		const agentSession = {
			modelRegistry: { authStorage: {} },
			settings: Settings.isolated(),
			sessionId: "s1",
			sessionManager: { getSessionId: () => "s1" },
			subscribe: (listener: (event: AgentSessionEvent) => void) => {
				emit = listener;
				return () => {};
			},
			sendCustomMessage: async () => {},
		} as unknown as LiveSessionControllerOptions["session"];
		const phases: string[] = [];
		const session = new LiveSessionController({
			session: agentSession,
			extractAssistantText: message =>
				(message.content as { type: string; text?: string }[]).map(block => block.text ?? "").join(""),
			sdpOffer: "v=0 offer",
			callbacks: {
				onPhase: phase => phases.push(phase),
				onLevels: () => {},
				onTranscript: () => {},
				onTerminal: () => {},
			},
		});
		await session.start();
		const delegate = (id: string, text: string) =>
			onEvent!({
				type: "delegation.created",
				item: { type: "delegation", target: "client", id, content: [{ type: "input_text", text }] },
			});
		const answer = (text: string) =>
			[{ role: "assistant", content: [{ type: "text", text }] }] as unknown as AgentMessage[];

		delegate("d1", "how is the work going?");
		// The session continuing the model's own work (a retry) is no answer yet.
		emit!({ type: "agent_pause", messages: answer("Retrying."), yielded: false, awaiting: false });
		// The model answered; subagents it started keep the run open, so no `agent_end` comes now.
		emit!({ type: "agent_pause", messages: answer("Two of five tasks are done."), yielded: true, awaiting: true });
		expect(phases.at(-1)).not.toBe("working");
		// The run's end, much later, must not repeat the answer the voice already has.
		emit!({ type: "agent_end", messages: answer("Two of five tasks are done.") });
		delegate("d2", "and now?");
		emit!({ type: "agent_pause", messages: answer("All five are done."), yielded: true, awaiting: false });
		await sentTwice.promise;

		expect(sent.map(message => [message.delegation_item_id, message.content?.[0]?.text])).toEqual([
			["d1", expect.stringContaining("Two of five tasks are done.")],
			["d2", expect.stringContaining("All five are done.")],
		]);
		await session.stop();
	});
});
