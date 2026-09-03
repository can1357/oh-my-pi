import { MessageFramer } from "../../src/jsonrpc/message-framing";

interface JsonRpcMessage {
	jsonrpc: "2.0";
	id?: string | number;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: unknown;
}

interface OpenDocumentParams {
	textDocument: { uri: string; version: number; text: string };
}

interface ChangeDocumentParams {
	textDocument: { uri: string; version: number };
}

interface CloseDocumentParams {
	textDocument: { uri: string };
}

let initializeCount = 0;
let processId: number | null = null;
const didOpen: Record<string, number> = {};
const didChange: Record<string, number[]> = {};
const didClose: string[] = [];
const notifications: string[] = [];
const documents = new Map<string, { version: number; text: string }>();
let nextServerRequestId = 1;
const pendingServerRequests = new Map<
	string | number,
	{ resolve: (response: { result: unknown; error: unknown }) => void }
>();

function send(message: JsonRpcMessage): void {
	const json = JSON.stringify(message);
	const bytes = Buffer.byteLength(json);
	process.stdout.write(`Content-Length: ${bytes}\r\n\r\n${json}`);
}

function respond(id: string | number, result: unknown, error?: unknown): void {
	if (error === undefined) send({ jsonrpc: "2.0", id, result });
	else send({ jsonrpc: "2.0", id, error });
}

function publishDiagnostics(uri: string, version: number): void {
	send({
		jsonrpc: "2.0",
		method: "textDocument/publishDiagnostics",
		params: {
			uri,
			version,
			diagnostics: [
				{
					range: {
						start: { line: 0, character: 0 },
						end: { line: 0, character: 1 },
					},
					message: "fake",
					severity: 2,
				},
			],
		},
	});
}

async function requestClient(method: string, params: unknown): Promise<{ result: unknown; error: unknown }> {
	const id = `fake-${nextServerRequestId++}`;
	const { promise, resolve } = Promise.withResolvers<{ result: unknown; error: unknown }>();
	pendingServerRequests.set(id, { resolve });
	send({ jsonrpc: "2.0", id, method, params });
	return promise;
}

async function handleRequest(message: JsonRpcMessage): Promise<void> {
	const id = message.id;
	if (id === undefined || message.method === undefined) return;

	switch (message.method) {
		case "initialize": {
			initializeCount++;
			const params = message.params as { processId?: number | null } | undefined;
			processId = params?.processId ?? null;
			respond(id, {
				capabilities: {},
				serverInfo: { name: "fake-lsp", version: String(process.pid) },
			});
			break;
		}
		case "test/state": {
			const didChangeSnapshot: Record<string, number[]> = {};
			for (const uri in didChange) didChangeSnapshot[uri] = [...didChange[uri]];
			respond(id, {
				initializeCount,
				processId,
				didOpen: { ...didOpen },
				didChange: didChangeSnapshot,
				didClose: [...didClose],
				notifications: [...notifications],
			});
			break;
		}
		case "test/documentText": {
			const params = message.params as { uri: string };
			respond(id, documents.get(params.uri)?.text ?? null);
			break;
		}
		case "test/echo":
			respond(id, message.params);
			break;
		case "test/serverRequest": {
			const params = message.params as { method: string; params: unknown };
			const response = await requestClient(params.method, params.params);
			respond(id, response);
			break;
		}
		case "shutdown":
			respond(id, null);
			break;
		default:
			respond(id, undefined, { code: -32601, message: `Method not found: ${message.method}` });
	}
}

function handleNotification(message: JsonRpcMessage): void {
	if (message.method === undefined) return;
	notifications.push(message.method);

	switch (message.method) {
		case "textDocument/didOpen": {
			const params = message.params as OpenDocumentParams;
			const { uri, version, text } = params.textDocument;
			didOpen[uri] = (didOpen[uri] ?? 0) + 1;
			documents.set(uri, { version, text });
			publishDiagnostics(uri, version);
			break;
		}
		case "textDocument/didChange": {
			const params = message.params as ChangeDocumentParams;
			const { uri, version } = params.textDocument;
			didChange[uri] ??= [];
			didChange[uri].push(version);
			const previous = documents.get(uri);
			documents.set(uri, { version, text: previous?.text ?? "" });
			publishDiagnostics(uri, version);
			break;
		}
		case "textDocument/didClose": {
			const params = message.params as CloseDocumentParams;
			const { uri } = params.textDocument;
			didClose.push(uri);
			documents.delete(uri);
			break;
		}
		case "exit":
			process.exit(0);
	}
}

function handleMessage(message: JsonRpcMessage): void {
	if (message.method !== undefined) {
		if (message.id !== undefined) void handleRequest(message);
		else handleNotification(message);
		return;
	}
	if (message.id === undefined) return;
	const pending = pendingServerRequests.get(message.id);
	if (!pending) return;
	pendingServerRequests.delete(message.id);
	pending.resolve({ result: message.result ?? null, error: message.error ?? null });
}

const framer = new MessageFramer(Buffer.alloc(0));
for await (const chunk of Bun.stdin.stream()) {
	framer.push(Buffer.from(chunk));
	for (const text of framer.drain(() => {})) {
		handleMessage(JSON.parse(text) as JsonRpcMessage);
	}
}
