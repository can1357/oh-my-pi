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

interface SentMessage {
	customType: string;
	display: boolean;
	options: { triggerTurn?: boolean; deliverAs?: string } | undefined;
}

afterEach(() => {
	vi.restoreAllMocks();
});

/** A started live session whose realtime events the test feeds, recording what reaches the agent session. */
async function liveSession() {
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
	const sent: SentMessage[] = [];
	const session = {
		modelRegistry: { authStorage: {} },
		model: { provider: "openai-codex" },
		settings: Settings.isolated({}),
		sessionId: "s1",
		subscribe: () => () => {},
		sendCustomMessage: async (message: SentMessage, options?: SentMessage["options"]) => {
			sent.push({ customType: message.customType, display: message.display, options });
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
		sent,
		delegate: (id: string, text: string) => {
			if (!onEvent) throw new Error("live transport was not created");
			onEvent({
				type: "delegation.created",
				item: { type: "delegation", target: "client", id, content: [{ type: "input_text", text }] },
			});
		},
	};
}

describe("live voice context for the coding agent", () => {
	test("a call that delegated work ends with hidden next-turn context, not a turn", async () => {
		const { controller, sent, delegate } = await liveSession();
		delegate("d1", "list the names");
		await controller.stop();

		expect(sent).toEqual([
			{ customType: LIVE_DELEGATION_MESSAGE_TYPE, display: true, options: { triggerTurn: true } },
			{ customType: LIVE_ENDED_MESSAGE_TYPE, display: false, options: { deliverAs: "nextTurn" } },
		]);
	});

	test("a call that delegated nothing tells the agent nothing", async () => {
		const { controller, sent } = await liveSession();
		await controller.stop();
		expect(sent).toEqual([]);
	});

	test("the model receives a spoken request inside a voice notice; the stored message keeps the bare request", () => {
		const request = "read the names out loud";
		const stored = {
			role: "custom" as const,
			customType: LIVE_DELEGATION_MESSAGE_TYPE,
			content: request,
			display: true,
			attribution: "agent" as const,
			timestamp: 1,
		};
		const [delegated] = convertToLlm([stored]);
		const content = delegated?.content;
		const text =
			typeof content === "string"
				? content
				: (content ?? []).map(part => ("text" in part ? part.text : "")).join("");

		expect(text).toMatch(/^<system-notice>\n[\s\S]+\n<\/system-notice>\nread the names out loud$/);
		expect(stored.content).toBe(request);
	});
});
