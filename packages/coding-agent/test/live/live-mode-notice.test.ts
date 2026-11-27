import { afterEach, describe, expect, test, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Message, UserMessage } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { LiveSessionController, type LiveSessionControllerOptions } from "@oh-my-pi/pi-coding-agent/live/controller";
import type { LiveServerEvent } from "@oh-my-pi/pi-coding-agent/live/protocol";
import * as liveTransport from "@oh-my-pi/pi-coding-agent/live/transport";
import type { LiveTransportOptions } from "@oh-my-pi/pi-coding-agent/live/transport";
import {
	convertMessagesForContextView,
	convertToLlm,
	LIVE_DELEGATION_MESSAGE_TYPE,
	LIVE_ENDED_MESSAGE_TYPE,
	markDuringLiveCall,
	wrapSteeringForModel,
} from "@oh-my-pi/pi-coding-agent/session/messages";
import { prompt } from "@oh-my-pi/pi-utils";
import liveEndedTemplate from "../../src/live/prompts/live-ended.md" with { type: "text" };
import voiceRequestTemplate from "../../src/live/prompts/voice-request.md" with { type: "text" };

afterEach(() => {
	vi.restoreAllMocks();
});

const ENDED = prompt.render(liveEndedTemplate);
const VOICE_PREFIX = prompt.render(voiceRequestTemplate, { request: "\u0001" }).split("\u0001")[0];

let clock = 0;

function typed(text: string, extra?: Partial<UserMessage>): AgentMessage {
	return { role: "user", content: text, attribution: "user", timestamp: ++clock, ...extra };
}

function answer(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-codex-responses",
		provider: "openai-codex",
		model: "gpt-5.5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: ++clock,
	};
}

function textOf(message: Message): string {
	if (typeof message.content === "string") return message.content;
	let text = "";
	for (const part of message.content) if (part.type === "text") text += part.text;
	return text;
}

/** What the model reads, one line per message: `voice: <request>`, `ended`, or `<role>: <text>`. */
function label(message: Message): string {
	const text = textOf(message);
	if (text === ENDED) return "ended";
	if (text.startsWith(VOICE_PREFIX)) return `voice: ${text.slice(VOICE_PREFIX.length)}`;
	return `${message.role}: ${text}`;
}

function seen(messages: AgentMessage[]): string[] {
	return convertToLlm(messages).map(label);
}

/**
 * An `AgentSession` stand-in holding one transcript per session id. Each spoken request stays in
 * dispatch until the test admits it, as `AgentSession` holds one through compaction or its turn.
 */
function fakeSession() {
	const transcripts = new Map<string, AgentMessage[]>();
	let current = "a";
	let disposed = false;
	const pending: (() => void)[] = [];
	const inFlight: Promise<boolean>[] = [];
	const transcript = (id: string): AgentMessage[] => {
		let messages = transcripts.get(id);
		if (!messages) {
			messages = [];
			transcripts.set(id, messages);
		}
		return messages;
	};
	const session = {
		modelRegistry: { authStorage: {} },
		model: { provider: "openai-codex" },
		settings: Settings.isolated({}),
		sessionId: "s1",
		subscribe: () => () => {},
		sendCustomMessage: (message: { customType: string; content: string; attribution: "user" | "agent" }) => {
			const target = current;
			const delivered = (async () => {
				if (message.customType === LIVE_DELEGATION_MESSAGE_TYPE) {
					const { promise, resolve } = Promise.withResolvers<void>();
					pending.push(resolve);
					await promise;
					// AgentSession drops a request whose session was disposed while it waited.
					if (disposed) return false;
				}
				transcript(target).push({
					role: "custom",
					customType: message.customType,
					content: message.content,
					display: true,
					attribution: message.attribution,
					timestamp: ++clock,
				});
				return false;
			})();
			inFlight.push(delivered);
			return delivered;
		},
	} as unknown as LiveSessionControllerOptions["session"];
	return {
		session,
		transcript,
		switchTo: (id: string) => {
			current = id;
		},
		dispose: () => {
			disposed = true;
		},
		admitAll: async () => {
			for (const resolve of pending.splice(0)) resolve();
			await Promise.all(inFlight.splice(0));
		},
	};
}

/** Starts a live call on `session` whose realtime events the test feeds through `say`. */
async function startCall(session: LiveSessionControllerOptions["session"]) {
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
	const controller = new LiveSessionController({
		session,
		extractAssistantText: () => "",
		sdpOffer: "v=0 offer",
		callbacks: { onPhase: () => {}, onLevels: () => {}, onTranscript: () => {}, onTerminal: () => {} },
	});
	await controller.start();
	return {
		controller,
		say: (text: string) => {
			if (!onEvent) throw new Error("live transport was not created");
			onEvent({
				type: "delegation.created",
				item: { type: "delegation", target: "client", id: text, content: [{ type: "input_text", text }] },
			});
		},
	};
}

describe("live call end as the coding agent sees it", () => {
	test("after an idle stop, the next typed prompt is preceded by one end notice", async () => {
		const fake = fakeSession();
		const call = await startCall(fake.session);
		call.say("list the names");
		await fake.admitAll();
		const transcript = fake.transcript("a");
		transcript.push(answer("Ann and Bo."));
		await call.controller.stop();
		transcript.push(typed("show them as a table"));

		expect(seen(transcript)).toEqual([
			"voice: list the names",
			"assistant: Ann and Bo.",
			"ended",
			"user: show them as a table",
		]);
		// `/context` shows the notice as part of the typed prompt it precedes.
		const view = convertMessagesForContextView(transcript);
		expect(view.map(entry => [label(entry.message), entry.sourceIndex])).toEqual([
			["voice: list the names", 0],
			["assistant: Ann and Bo.", 1],
			["ended", 2],
			["user: show them as a table", 2],
		]);
	});

	test("a stop while the answer streams puts the notice before the typed prompt, not after it", async () => {
		const fake = fakeSession();
		const call = await startCall(fake.session);
		call.say("list the names");
		await fake.admitAll();
		await call.controller.stop();
		// The turn the stop interrupted finishes; the user steers into it, then types again.
		const transcript = fake.transcript("a");
		transcript.push(typed("use a table", { steering: true }), answer("| name |"), typed("and their ages?"));

		expect(convertToLlm(wrapSteeringForModel(transcript)).map(label)).toEqual([
			"voice: list the names",
			"ended",
			expect.stringContaining("use a table"),
			"assistant: | name |",
			"user: and their ages?",
		]);
	});

	test("an in-call steer keeps the answer spoken, even when the steer is replayed after disconnect", async () => {
		const fake = fakeSession();
		const call = await startCall(fake.session);
		call.say("list the names");
		await fake.admitAll();
		const transcript = fake.transcript("a");
		const steer = typed("only the first two", { steering: true });
		expect(fake.session.activeVoiceCall).toBeDefined();
		markDuringLiveCall(steer);
		transcript.push(steer, answer("Ann and Bo."));
		expect(convertToLlm(wrapSteeringForModel(transcript)).map(label)).not.toContain("ended");
		await call.controller.stop();
		expect(fake.session.activeVoiceCall).toBeUndefined();
		transcript.push(typed("now as a table"));
		const replay = JSON.parse(JSON.stringify(transcript)) as AgentMessage[];
		expect(convertToLlm(wrapSteeringForModel(replay)).map(label)).toEqual([
			"voice: list the names",
			expect.stringContaining("only the first two"),
			"assistant: Ann and Bo.",
			"ended",
			"user: now as a table",
		]);
	});

	test("a later call's spoken request keeps its voice notice and no stale end notice", async () => {
		const fake = fakeSession();
		const first = await startCall(fake.session);
		first.say("list the names");
		await fake.admitAll();
		const transcript = fake.transcript("a");
		transcript.push(answer("Ann and Bo."));
		await first.controller.stop();
		const second = await startCall(fake.session);
		second.say("read them again");
		await fake.admitAll();
		transcript.push(answer("Ann and Bo, again."));

		expect(seen(transcript)).toEqual([
			"voice: list the names",
			"assistant: Ann and Bo.",
			"voice: read them again",
			"assistant: Ann and Bo, again.",
		]);

		await second.controller.stop();
		transcript.push(typed("now as a table"));
		expect(seen(transcript).slice(-2)).toEqual(["ended", "user: now as a table"]);
	});

	test("a transcript resumed after a crash mid-call hears the end once, before the first typed prompt", async () => {
		const fake = fakeSession();
		const call = await startCall(fake.session);
		call.say("list the names");
		call.say("read them again");
		await fake.admitAll();
		const transcript = fake.transcript("a");
		transcript.push(answer("Ann and Bo."));
		// The process dies here: no stop, so nothing past the spoken requests is saved.
		const sentBeforeCrash = seen([...transcript]);
		const resumed = [...transcript, typed("show them as a table"), answer("| name |"), typed("add ages")];

		const afterResume = seen(resumed);
		expect(afterResume).toEqual([
			"voice: list the names",
			"voice: read them again",
			"assistant: Ann and Bo.",
			"ended",
			"user: show them as a table",
			"assistant: | name |",
			"user: add ages",
		]);
		expect(afterResume.slice(0, sentBeforeCrash.length)).toEqual(sentBeforeCrash);
	});

	test("both transcripts of a call switched mid-way hear the end before their next typed prompt", async () => {
		const fake = fakeSession();
		const call = await startCall(fake.session);
		call.say("list the names");
		await fake.admitAll();
		fake.switchTo("b");
		call.say("read them again");
		await fake.admitAll();
		await call.controller.stop();

		const b = [...fake.transcript("b"), typed("as a table")];
		expect(seen(b)).toEqual(["voice: read them again", "ended", "user: as a table"]);
		// Later the user returns to the first transcript and types there.
		const a = [...fake.transcript("a"), typed("and their ages?")];
		expect(seen(a)).toEqual(["voice: list the names", "ended", "user: and their ages?"]);
	});

	test("a call whose spoken request never reached the transcript adds no end notice", async () => {
		const fake = fakeSession();
		const call = await startCall(fake.session);
		call.say("list the names");
		await call.controller.stop();
		fake.dispose();
		await fake.admitAll();

		expect(fake.transcript("a")).toEqual([]);
		expect(seen([typed("hello"), answer("Hi."), typed("list the names")])).toEqual([
			"user: hello",
			"assistant: Hi.",
			"user: list the names",
		]);
	});

	test("turns already sent render the same on every request as the history grows", () => {
		const history: AgentMessage[] = [typed("hello"), answer("Hi.")];
		history.push({
			role: "custom",
			customType: LIVE_DELEGATION_MESSAGE_TYPE,
			content: "list the names",
			display: true,
			attribution: "agent",
			timestamp: ++clock,
		});
		const requests: Message[][] = [];
		for (const next of [answer("Ann and Bo."), typed("as a table"), answer("| name |"), typed("add ages")]) {
			history.push(next);
			requests.push(convertToLlm(history));
		}
		for (let index = 1; index < requests.length; index++) {
			expect(requests[index].slice(0, requests[index - 1].length)).toEqual(requests[index - 1]);
		}
		expect(requests.at(-1)?.map(label)).toEqual([
			"user: hello",
			"assistant: Hi.",
			"voice: list the names",
			"assistant: Ann and Bo.",
			"ended",
			"user: as a table",
			"assistant: | name |",
			"user: add ages",
		]);
		expect(requests.at(-1)).toEqual(convertToLlm([...history]));
	});

	test("an end notice saved in the transcript is neither repeated nor left dangling", () => {
		const delegation: AgentMessage = {
			role: "custom",
			customType: LIVE_DELEGATION_MESSAGE_TYPE,
			content: "list the names",
			display: true,
			attribution: "agent",
			timestamp: ++clock,
		};
		const saved = (): AgentMessage => ({
			role: "custom",
			customType: LIVE_ENDED_MESSAGE_TYPE,
			content: ENDED,
			display: false,
			attribution: "agent",
			timestamp: ++clock,
		});

		expect(seen([delegation, answer("Ann and Bo."), saved(), typed("as a table")])).toEqual([
			"voice: list the names",
			"assistant: Ann and Bo.",
			"ended",
			"user: as a table",
		]);
		expect(seen([delegation, typed("as a table"), answer("| name |"), saved(), typed("add ages")])).toEqual([
			"voice: list the names",
			"ended",
			"user: as a table",
			"assistant: | name |",
			"user: add ages",
		]);
	});
});
