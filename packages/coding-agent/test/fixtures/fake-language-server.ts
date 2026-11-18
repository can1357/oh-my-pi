/**
 * Stdio language server for daemon `lsp` module tests. Speaks
 * Content-Length-framed JSON-RPC and exposes its own observations through
 * private methods:
 *
 * - `fake/state` (request): pid, ppid, initialize count, open/closed documents,
 *   every request id it received, and the `FAKE_LS_MARK` / `OMP_DAEMON_DIR`
 *   values of its own environment.
 * - `fake/echo` (request, `{ value, hold? }`): answers `{ value }`; with `hold`
 *   the answer waits for a `fake/release` notification.
 * - `fake/drain` (request): answers once every held echo has been answered.
 * - `fake/split` (request, `{ value }`): answers `{ value }` written in two
 *   chunks with a pause between them.
 * - `fake/exit` (notification, `{ code }`): exits with that code.
 */

interface Message {
	jsonrpc: "2.0";
	id?: string | number;
	method?: string;
	params?: Record<string, unknown>;
}

let initializeCount = 0;
const openDocuments = new Set<string>();
const closedDocuments: string[] = [];
const requestIds: Array<string | number> = [];
const held: Array<() => void> = [];
const drains: Array<() => void> = [];

function frame(message: unknown): Buffer {
	const body = Buffer.from(JSON.stringify(message), "utf8");
	return Buffer.concat([Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, "latin1"), body]);
}

function documentUri(params: Record<string, unknown>): string | undefined {
	const document = params.textDocument;
	if (typeof document !== "object" || document === null || !("uri" in document)) return undefined;
	return typeof document.uri === "string" ? document.uri : undefined;
}

function respond(id: string | number, result: unknown): void {
	process.stdout.write(frame({ jsonrpc: "2.0", id, result }));
}

function settleDrains(): void {
	if (held.length > 0) return;
	for (const drain of drains.splice(0)) drain();
}

async function handle(message: Message): Promise<void> {
	const params = message.params ?? {};
	if (message.id === undefined) {
		switch (message.method) {
			case "exit":
				process.exit(0);
				break;
			case "fake/exit":
				process.exit(typeof params.code === "number" ? params.code : 1);
				break;
			case "fake/release":
				for (const release of held.splice(0)) release();
				settleDrains();
				break;
			case "textDocument/didOpen": {
				const uri = documentUri(params);
				if (uri) openDocuments.add(uri);
				break;
			}
			case "textDocument/didClose": {
				const uri = documentUri(params);
				if (!uri) break;
				openDocuments.delete(uri);
				closedDocuments.push(uri);
				break;
			}
		}
		return;
	}
	const id = message.id;
	if (message.method === undefined) return;
	requestIds.push(id);
	switch (message.method) {
		case "initialize":
			initializeCount++;
			respond(id, {
				capabilities: { textDocumentSync: 1 },
				serverInfo: { name: "fake-language-server", version: String(process.pid) },
			});
			return;
		case "fake/state":
			respond(id, {
				pid: process.pid,
				ppid: process.ppid,
				initializeCount,
				open: [...openDocuments],
				closed: closedDocuments,
				requestIds,
				env: {
					mark: process.env.FAKE_LS_MARK ?? null,
					daemonDir: process.env.OMP_DAEMON_DIR ?? null,
				},
			});
			return;
		case "fake/echo":
			if (params.hold === true) {
				held.push(() => respond(id, { value: params.value }));
				return;
			}
			respond(id, { value: params.value });
			return;
		case "fake/drain":
			drains.push(() => respond(id, null));
			settleDrains();
			return;
		case "fake/split": {
			const bytes = frame({ jsonrpc: "2.0", id, result: { value: params.value } });
			const cut = bytes.indexOf("\r\n\r\n") + 6;
			process.stdout.write(bytes.subarray(0, cut));
			await Bun.sleep(30);
			process.stdout.write(bytes.subarray(cut));
			return;
		}
		default:
			respond(id, null);
	}
}

let buffer = Buffer.alloc(0);
for await (const chunk of Bun.stdin.stream()) {
	buffer = Buffer.concat([buffer, chunk]);
	while (true) {
		const headerEnd = buffer.indexOf("\r\n\r\n");
		if (headerEnd < 0) break;
		const length = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, headerEnd).toString("latin1"))?.[1]);
		const start = headerEnd + 4;
		if (buffer.byteLength < start + length) break;
		const message = JSON.parse(buffer.subarray(start, start + length).toString("utf8")) as Message;
		buffer = buffer.subarray(start + length);
		await handle(message);
	}
}
process.exit(0);
