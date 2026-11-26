import { afterEach, describe, expect, test, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { LiveSessionController, type LiveSessionControllerOptions } from "@oh-my-pi/pi-coding-agent/live/controller";
import type { LiveServerEvent } from "@oh-my-pi/pi-coding-agent/live/protocol";
import * as liveTransport from "@oh-my-pi/pi-coding-agent/live/transport";
import type { LiveTransportOptions } from "@oh-my-pi/pi-coding-agent/live/transport";
import {
	convertToLlm,
	LIVE_DELEGATION_MESSAGE_TYPE,
	LIVE_ENDED_MESSAGE_TYPE,
} from "@oh-my-pi/pi-coding-agent/session/messages";

afterEach(() => {
	vi.restoreAllMocks();
});

/**
 * A started live call whose realtime events the test feeds. Each spoken request stays in dispatch until
 * the test admits it, as `AgentSession` holds one through compaction or its turn.
 */
async function liveCall() {
	let onEvent: ((event: LiveServerEvent) => void) | undefined;
	// bun's spyOn types a class export's implementation as `never`; a plain constructible function suffices.
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
	let transcript = "a";
	let disposed = false;
	const admitted: { transcript: string; customType: string }[] = [];
	const pending: (() => void)[] = [];
	const session = {
		modelRegistry: { authStorage: {} },
		model: { provider: "openai-codex" },
		settings: Settings.isolated({}),
		sessionId: "s1",
		sessionManager: { getSessionId: () => transcript },
		get isDisposed() {
			return disposed;
		},
		subscribe: () => () => {},
		sendCustomMessage: async (message: { customType: string }) => {
			const target = transcript;
			if (message.customType === LIVE_DELEGATION_MESSAGE_TYPE) {
				const { promise, resolve } = Promise.withResolvers<void>();
				pending.push(resolve);
				await promise;
				// AgentSession drops a request whose session was disposed while it waited.
				if (disposed) return false;
			}
			admitted.push({ transcript: target, customType: message.customType });
			return false;
		},
	} as unknown as LiveSessionControllerOptions["session"];
	const controller = new LiveSessionController({
		session,
		extractAssistantText: () => "",
		sdpOffer: "v=0 offer",
		callbacks: { onPhase: () => {}, onLevels: () => {}, onTranscript: () => {}, onTerminal: () => {} },
	});
	await controller.start();
	return {
		controller,
		admitted,
		switchTranscript: (id: string) => {
			transcript = id;
		},
		dispose: () => {
			disposed = true;
		},
		delegate: (text: string) => {
			if (!onEvent) throw new Error("live transport was not created");
			onEvent({
				type: "delegation.created",
				item: { type: "delegation", target: "client", id: text, content: [{ type: "input_text", text }] },
			});
		},
		admitAll: async () => {
			for (const resolve of pending.splice(0)) resolve();
			await Bun.sleep(0);
		},
	};
}

describe("live voice context for the coding agent", () => {
	test("the call-ended notice lands only after every spoken request was admitted", async () => {
		const call = await liveCall();
		call.delegate("list the names");
		call.delegate("read them again");
		await call.controller.stop();
		await Bun.sleep(0);
		expect(call.admitted).toEqual([]);

		await call.admitAll();
		expect(call.admitted.map(entry => entry.customType)).toEqual([
			LIVE_DELEGATION_MESSAGE_TYPE,
			LIVE_DELEGATION_MESSAGE_TYPE,
			LIVE_ENDED_MESSAGE_TYPE,
		]);
	});

	test("a call stopped after a transcript switch writes nothing into the new transcript", async () => {
		const call = await liveCall();
		call.delegate("list the names");
		await call.admitAll();
		call.switchTranscript("b");
		await call.controller.stop();
		await Bun.sleep(0);

		expect(call.admitted).toEqual([{ transcript: "a", customType: LIVE_DELEGATION_MESSAGE_TYPE }]);
	});

	test("a call whose request was dropped by a disposed session sends no end notice", async () => {
		const call = await liveCall();
		call.delegate("list the names");
		await call.controller.stop();
		call.dispose();
		await call.admitAll();

		expect(call.admitted).toEqual([]);
	});

	test("the model receives a spoken request after a voice notice", () => {
		const request = "read the names out loud";
		const [delegated] = convertToLlm([
			{
				role: "custom",
				customType: LIVE_DELEGATION_MESSAGE_TYPE,
				content: request,
				display: true,
				attribution: "agent",
				timestamp: 1,
			},
		]);
		const content = delegated?.content;
		const text =
			typeof content === "string"
				? content
				: (content ?? []).map(part => ("text" in part ? part.text : "")).join("");

		expect(text.endsWith(`\n${request}`)).toBe(true);
		expect(text.slice(0, -request.length).trim()).not.toBe("");
	});
});
