import { describe, expect, test } from "bun:test";
import type { DraftContents, DraftSink } from "../src/components/composer/useComposerDraft";
import { sendDraft } from "../src/components/composer/useComposerDraft";
import { RpcBridge } from "../src/rpc/bridge";
import { messageText, TranscriptModel } from "../src/rpc/transcript";
import type { AgentHandle, PoolStatus, RelayEvent, Transport } from "../src/rpc/transport";

/**
 * The complaint: "cuando abro una sesión y envío un mensaje tarda mucho en
 * mostrarse en la UI". Measured against a live sidecar, the first prompt of a
 * session waits ~3.7s for MCP mounting before the server echoes it back, and
 * until then the transcript was empty — the message the user sent did not
 * exist on screen. These assert what is on screen, never how it got there.
 */

class MockTransport implements Transport {
	sent: string[] = [];
	#emit: ((event: RelayEvent) => void) | null = null;
	#tabId = "";
	async start(tabId: string, onEvent: (event: RelayEvent) => void): Promise<AgentHandle> {
		this.#tabId = tabId;
		this.#emit = onEvent;
		return { pid: 1, resumed: false, prewarmed: false };
	}
	async send(_tabId: string, line: string): Promise<void> {
		this.sent.push(line);
	}
	async suspend(): Promise<void> {}
	async kill(): Promise<void> {}
	async poolStatus(): Promise<PoolStatus> {
		return { live: 1, maxLive: 3, prewarmReady: true, tabs: [this.#tabId] };
	}
	frames(...frames: object[]): void {
		this.#emit?.({ event: "frames", data: { tabId: this.#tabId, lines: frames.map(f => JSON.stringify(f)) } });
	}
	idOf(index: number): string {
		return JSON.parse(this.sent[index]).id;
	}
}

async function connected() {
	const transport = new MockTransport();
	const bridge = new RpcBridge("tab-1", transport);
	await bridge.start();
	transport.frames({ type: "ready", protocolVersion: 1, maxFrameBytes: 1048576 });
	return { transport, bridge };
}

const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/** What a viewer would read off the transcript, in order. */
const shown = (bridge: RpcBridge) =>
	bridge
		.getSnapshot()
		.transcript.filter(entry => entry.kind === "message")
		.map(entry => (entry.kind === "message" ? `${entry.role}: ${messageText(entry.content)}` : ""));

const userFrame = (text: string, timestamp: number) => ({
	role: "user",
	content: [{ type: "text", text }],
	timestamp,
});

describe("the sent message is on screen before the server answers", () => {
	test("it appears while the send is still in flight, and the echo does not double it", async () => {
		const { transport, bridge } = await connected();

		bridge.echoUserMessage("hola");
		await settle();
		// The whole defect in one assertion: nothing has come back from the
		// sidecar yet and the message is already readable.
		expect(shown(bridge)).toEqual(["user: hola"]);

		// ~3.7s later, the server finally says what it recorded — twice, as it
		// always does for a user message.
		transport.frames(
			{ type: "message_start", message: userFrame("hola", 1700) },
			{ type: "message_end", message: userFrame("hola", 1700) },
		);
		await settle();
		expect(shown(bridge)).toEqual(["user: hola"]);
	});

	test("the server's own wording wins when it rewrote the message", async () => {
		const { transport, bridge } = await connected();
		bridge.echoUserMessage("/review");
		await settle();
		expect(shown(bridge)).toEqual(["user: /review"]);

		// `AgentSession.prompt` runs expandSlashCommand/expandPromptTemplate over
		// the text and records *that*, so the echo is nothing like what was typed.
		transport.frames({ type: "message_start", message: userFrame("Review the working tree and report.", 90) });
		await settle();
		expect(shown(bridge)).toEqual(["user: Review the working tree and report."]);
	});

	test("a prompt the server refuses after acknowledging it takes its message back", async () => {
		const { transport, bridge } = await connected();
		const refusals: string[] = [];
		void bridge.prompt("hola", undefined, cause => refusals.push(cause.message)).catch(() => {});
		const token = bridge.echoUserMessage("hola");
		await settle();
		expect(shown(bridge)).toEqual(["user: hola"]);

		const id = transport.idOf(0);
		transport.frames({ type: "response", command: "prompt", id, success: true });
		await settle();
		transport.frames({ type: "response", command: "prompt", id, success: false, error: "No model selected." });
		await settle();
		expect(refusals).toEqual(["No model selected."]);

		bridge.retractUserEcho(token);
		await settle();
		// Nothing unsent is left standing in the transcript.
		expect(shown(bridge)).toEqual([]);
	});

	/*
	 * The 38 ACP builtins the slash menu advertises — `/mcp`, `/model`, `/compact`
	 * and the rest — never reach `AgentSession.prompt`: rpc-mode intercepts them
	 * and answers on the response itself. No user message is recorded and no frame
	 * ever arrives to claim the echo, so the answer has to be read off the
	 * response, or the bubble stands there for the life of the session and every
	 * later message lands in its slot.
	 */
	test("a command the server answers by itself reports that the agent never took it", async () => {
		const { transport, bridge } = await connected();
		const took = bridge.prompt("/mcp list");
		await settle();
		transport.frames({
			type: "response",
			id: transport.idOf(0),
			command: "prompt",
			success: true,
			data: { agentInvoked: false },
		});
		expect(await took).toBe(false);
	});

	test("a prompt that did start a turn reports that it was taken", async () => {
		const { transport, bridge } = await connected();
		const took = bridge.prompt("hola");
		await settle();
		transport.frames({ type: "response", id: transport.idOf(0), command: "prompt", success: true });
		// A prompt the agent took answers with no data at all.
		expect(await took).toBe(true);
	});

	test("a reload while the send is in flight does not swallow it", async () => {
		const { transport, bridge } = await connected();
		bridge.echoUserMessage("in flight");
		await settle();

		const reload = bridge.reloadMessages();
		transport.frames({
			type: "response",
			command: "get_messages",
			id: transport.idOf(0),
			success: true,
			data: {
				messages: [
					userFrame("older", 1),
					{ role: "assistant", content: [{ type: "text", text: "sure" }], timestamp: 2 },
				],
			},
		});
		await reload;
		await settle();
		expect(shown(bridge)).toEqual(["user: older", "assistant: sure", "user: in flight"]);

		transport.frames({ type: "message_start", message: userFrame("in flight", 3) });
		await settle();
		expect(shown(bridge)).toEqual(["user: older", "assistant: sure", "user: in flight"]);
	});
});

describe("sendDraft draws and retracts in the right order", () => {
	function contents(): DraftContents {
		return { draft: "ship it", attachments: [], references: [] };
	}

	function sink(send: DraftSink["send"]) {
		const log: string[] = [];
		const draftSink: DraftSink = {
			send: (...args) => {
				log.push("send");
				return send(...args);
			},
			echo: message => {
				log.push(`echo:${message}`);
				return "tok";
			},
			retract: token => log.push(`retract:${token}`),
			clear: () => log.push("clear"),
			restore: () => log.push("restore"),
			reportError: () => log.push("error"),
		};
		return { sink: draftSink, log };
	}

	test("the message is drawn before it is written to the wire", async () => {
		const { sink: s, log } = sink(async () => true);
		await sendDraft("ship it", contents(), s);
		expect(log).toEqual(["echo:ship it", "send", "clear"]);
	});

	test("a send that is rejected outright removes what it drew", async () => {
		const { sink: s, log } = sink(() => Promise.reject(new Error("no live session")));
		await sendDraft("ship it", contents(), s);
		expect(log).toEqual(["echo:ship it", "send", "retract:tok", "error"]);
	});

	test("a command the server answered by itself takes its message back", async () => {
		const { sink: s, log } = sink(async () => false);
		await sendDraft("/mcp list", contents(), s);
		// Cleared like any accepted send — the composer should empty — then the
		// message is withdrawn, because nothing will ever echo it.
		expect(log).toEqual(["echo:/mcp list", "send", "clear", "retract:tok"]);
	});

	test("a send refused after the acknowledgement removes it too", async () => {
		const late = Promise.withResolvers<(cause: Error) => void>();
		const { sink: s, log } = sink(async (_message, _images, refused) => {
			// The server acknowledges the frame and only then starts the turn, so
			// the refusal lands after the composer has already been told it went.
			late.resolve(refused);
			return true;
		});
		await sendDraft("ship it", contents(), s);
		(await late.promise)(new Error("no API key"));
		expect(log).toEqual(["echo:ship it", "send", "clear", "retract:tok", "restore", "error"]);
	});

	test("a refusal that beats the clear still removes what was drawn", async () => {
		const { sink: s, log } = sink(async (_message, _images, refused) => {
			// Same batch of frames: the relay hands the webview both answers and
			// they are read synchronously, before the await below resumes.
			refused(new Error("no API key"));
			return true;
		});
		await sendDraft("ship it", contents(), s);
		expect(log).toEqual(["echo:ship it", "send", "retract:tok", "error"]);
	});
});

describe("TranscriptModel echoes", () => {
	test("an unclaimed echo does not put the next message in the wrong bubble", () => {
		const model = new TranscriptModel();
		model.echo("/mcp");
		model.echo("second");
		model.apply({ type: "message_start", message: userFrame("second", 3000) });
		expect(model.entries.map(e => (e.kind === "message" ? messageText(e.content) : ""))).toEqual(["/mcp", "second"]);
	});

	test("retracting an echo leaves a running tool card still updatable", () => {
		const model = new TranscriptModel();
		const token = model.echo("ship it");
		model.apply({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash" });
		model.retract(token);
		model.apply({ type: "tool_execution_end", toolCallId: "t1", result: "done" });
		const tool = model.entries[0];
		expect(tool.kind === "tool" && tool.running).toBe(false);
		expect(tool.kind === "tool" && tool.result).toBe("done");
	});
});
