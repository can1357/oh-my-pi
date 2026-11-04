import { expect, test } from "bun:test";
import * as os from "node:os";
import { IpcConnection, ipcEndpoint } from "@oh-my-pi/pi-natives";
import { type Component, Input, Text, TUI, type TuiDebugTreeNode } from "../src";
import { VirtualTerminal } from "./virtual-terminal";

interface DebugReply {
	ok: boolean;
	error?: string;
	lines?: string[];
	values?: Record<string, unknown>;
	tree?: { root: TuiDebugTreeNode };
	injected?: number;
}

class DebugClient {
	readonly #connection: IpcConnection;
	#pending: PromiseWithResolvers<DebugReply> | undefined;

	constructor(connection: IpcConnection) {
		this.#connection = connection;
		connection.start(
			frame => {
				const pending = this.#pending;
				this.#pending = undefined;
				pending?.resolve(JSON.parse(frame) as DebugReply);
			},
			reason => {
				const pending = this.#pending;
				this.#pending = undefined;
				pending?.reject(new Error(`debug socket closed: ${reason ?? "eof"}`));
			},
		);
	}

	async request(request: Record<string, unknown>): Promise<DebugReply> {
		if (this.#pending !== undefined) throw new Error("debug client request already pending");
		const pending = Promise.withResolvers<DebugReply>();
		this.#pending = pending;
		this.#connection.send(JSON.stringify(request));
		return pending.promise;
	}

	close(): void {
		this.#connection.destroy();
	}
}

async function nextEventLoopTurn(): Promise<void> {
	const turn = Promise.withResolvers<void>();
	setImmediate(turn.resolve);
	await turn.promise;
}

/** The TUI starts its debug listener asynchronously; dial until it binds. */
async function connectDebugSocket(path: string): Promise<DebugClient> {
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			return new DebugClient(await IpcConnection.connect(path, { framing: "lines", timeoutMs: 1000 }));
		} catch {
			await Bun.sleep(10);
		}
	}
	throw new Error(`debug socket did not become available: ${path}`);
}

function findNode(node: TuiDebugTreeNode, id: string): TuiDebugTreeNode | undefined {
	if (node.id === id) return node;
	for (const child of node.children ?? []) {
		const found = findNode(child, id);
		if (found !== undefined) return found;
	}
	return undefined;
}

async function paintedText(client: DebugClient): Promise<DebugReply> {
	for (let attempt = 0; attempt < 100; attempt++) {
		const reply = await client.request({ op: "text" });
		if (reply.ok) return reply;
		expect(reply.error).toContain("no frame painted yet");
		await nextEventLoopTurn();
	}
	throw new Error("TUI did not paint a debug frame");
}

test("OMP_TUI_DEBUG drives and inspects a live TUI", async () => {
	const previousDebugPath = process.env.OMP_TUI_DEBUG;
	const socketPath = ipcEndpoint(os.tmpdir(), `pi-tui-${process.pid}-${Bun.randomUUIDv7().slice(0, 8)}`);
	process.env.OMP_TUI_DEBUG = socketPath;
	const terminal = new VirtualTerminal(50, 12);
	const tui = new TUI(terminal);
	const title = new Text("Known debug content", 0, 0);
	const debugTitle: Component = title;
	debugTitle.debugId = "title";
	const input = new Input();
	const debugInput: Component = input;
	debugInput.debugId = "input";
	input.prompt = "Input: ";
	tui.addChild(title);
	tui.addChild(input);
	tui.setFocus(input);

	let client: DebugClient | undefined;
	try {
		tui.start();
		client = await connectDebugSocket(socketPath);
		const text = await paintedText(client);
		expect(text.lines?.join("\n")).toContain("Known debug content");
		const frame = await client.request({ op: "frame" });
		expect(frame.lines?.join("\n")).toContain("Known debug content");
		expect(await client.request({ op: "info" })).toMatchObject({ ok: true });

		const keys = await client.request({ op: "keys", keys: "'hello'" });
		expect(keys).toEqual({ ok: true, injected: 5 });
		const valuesAfterKeys = await client.request({ op: "values" });
		expect(JSON.stringify(valuesAfterKeys.values)).toContain("hello");
		const chords = await client.request({ op: "keys", keys: "C-a 'X' C-e" });
		expect(chords).toEqual({ ok: true, injected: 3 });
		const valuesAfterChords = await client.request({ op: "values" });
		expect(JSON.stringify(valuesAfterChords.values)).toContain("Xhello");

		const tree = await client.request({ op: "tree" });
		expect(tree.ok).toBe(true);
		expect(tree.tree?.root.kind).toBe("TUI");
		const inputNode = tree.tree === undefined ? undefined : findNode(tree.tree.root, "input");
		expect(inputNode?.kind).toBe("Input");
		expect(inputNode?.focusable).toBe(true);
		expect(inputNode?.focused).toBe(true);

		expect(await client.request({ op: "not-an-op" })).toEqual({ ok: false, error: "unknown op not-an-op" });
		expect(await client.request({ op: "bytes", data: "!" })).toEqual({ ok: true });
		expect(await client.request({ op: "paste", text: " pasted" })).toEqual({ ok: true });
		expect(await client.request({ op: "mouse", x: 1, y: 1 })).toEqual({ ok: true });
		const valuesAfterRawInput = await client.request({ op: "values" });
		expect(JSON.stringify(valuesAfterRawInput.values)).toContain("Xhello! pasted");
	} finally {
		client?.close();
		tui.stop();
		if (previousDebugPath === undefined) delete process.env.OMP_TUI_DEBUG;
		else process.env.OMP_TUI_DEBUG = previousDebugPath;
	}
});
