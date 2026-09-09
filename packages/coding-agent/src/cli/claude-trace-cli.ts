/**
 * Fully automated Claude Code /v1/messages capture helper.
 *
 * Starts a local CONNECT proxy, MITMs TLS using a local self-signed debug
 * certificate, drives Claude Code through a headless PTY/xterm, and returns the
 * first completed /v1/messages request/response exchange.
 */
import * as net from "node:net";
import * as path from "node:path";
import * as tls from "node:tls";
import * as zlib from "node:zlib";
import { PtySession } from "@oh-my-pi/pi-natives";
import xterm from "@oh-my-pi/pi-utils/vterm";

const DEFAULT_PROXY_HOST = "127.0.0.1";
const DEFAULT_PROXY_PORT = 8080;
const DEFAULT_COMMAND = "claude";
const DEFAULT_MESSAGE = "hi";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_INPUT_DELAY_MS = 3_000;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;
const DOUBLE_CRLF = Buffer.from("\r\n\r\n", "latin1");
const CRLF = Buffer.from("\r\n", "latin1");
const TEXT_DECODER = new TextDecoder();

// Debug-only local MITM certificate. Claude is launched with
// NODE_TLS_REJECT_UNAUTHORIZED=0, so the certificate has no trust value; it only
// lets Node's TLS stack complete the CONNECT tunnel handshake.
export const CLAUDE_TRACE_DEBUG_CERT = `-----BEGIN CERTIFICATE-----
MIIDFzCCAf+gAwIBAgIUAe9omAqLbydZc5ZYZGhwbbpMSF0wDQYJKoZIhvcNAQEL
BQAwGzEZMBcGA1UEAwwQb21wLWNsYXVkZS10cmFjZTAeFw0yNjA2MDIwODA2MjFa
Fw0zNjA1MzAwODA2MjFaMBsxGTAXBgNVBAMMEG9tcC1jbGF1ZGUtdHJhY2UwggEi
MA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQCmpGe5T8B0oA2L82Rn5JJdXOBS
ZX0DyBjiIK+Tqe8T3oAr41XDLnweqtrMDSBDYbVqAoKjNbaTUSYYcxSm0MAVs63w
08SfJmShZM9pElfANqXqMiyhksFgji7JEyt/rbbId207a7s5KvRvm3g/sxN/wGtr
C5LCLMlc2GWEGD8qrVIQbmLw884qvtXi70RFUPP3Wpy4wGMWSdE+9IA27R5cMJS5
oHsO4HGB6J8VzLY+HGY2yr4BJ9qrAyjd1UetFd9RdcjyWpsbAfX8nWP+uleTNOiT
ExNz7dPt/k6OPLNmI1iT/ruRS0uUzHZTimPd67TPQR/70RaW7Bh5wArawGw9AgMB
AAGjUzBRMB0GA1UdDgQWBBQa4Ir8P3GAolZoPiuB4V2cq3riAjAfBgNVHSMEGDAW
gBQa4Ir8P3GAolZoPiuB4V2cq3riAjAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3
DQEBCwUAA4IBAQClPYki235gDEUu7eDm60qsAGWxbKVv4pSh+vB+xgNgzMk4aOuU
mSfp8Y8covwklph8VfDoKTaEGqqX0Q5s74Ctl6Mwy7b0u8Zztk/g4GynLocI7TQD
ftZMgZka49+FkEsjp+XZtQbO4vOL5UsccpsLhFQQQuhVyiJ4gNo/VzgvSDkBuf3Q
Rz7xFiDKCqFEoMPty4+nKEw5832FJ5mDCOyMk6fGSO8Wbt/hmRQQFu2cSdoBs0OT
AQQJETQjPkKeTDX4jdSAlOeKwfyjfdfgeQuMkzX8xafisJa66MLPzOVbIuGbvbWD
QVCd76iYPcfNK+JZUhmAUvTHSuwgJMZ6+NgI
-----END CERTIFICATE-----`;

export const CLAUDE_TRACE_DEBUG_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCmpGe5T8B0oA2L
82Rn5JJdXOBSZX0DyBjiIK+Tqe8T3oAr41XDLnweqtrMDSBDYbVqAoKjNbaTUSYY
cxSm0MAVs63w08SfJmShZM9pElfANqXqMiyhksFgji7JEyt/rbbId207a7s5KvRv
m3g/sxN/wGtrC5LCLMlc2GWEGD8qrVIQbmLw884qvtXi70RFUPP3Wpy4wGMWSdE+
9IA27R5cMJS5oHsO4HGB6J8VzLY+HGY2yr4BJ9qrAyjd1UetFd9RdcjyWpsbAfX8
nWP+uleTNOiTExNz7dPt/k6OPLNmI1iT/ruRS0uUzHZTimPd67TPQR/70RaW7Bh5
wArawGw9AgMBAAECggEADX2mhA3H0pPuj35J36X/5Me9xWM//AwOr6febwGalazg
Ctg3EOZ01/VptzaiKQetAdhoLmxidooNn9HD7JQJKPid7q7w7m1+R26mN/xrLD2A
WyBqv+iQoo+ANs5y1BMChuIxmVY/FwFk6UWDNlekuXqgzPln4okbrYTmBbaszniO
Mu1SI/3fpnTA3iJ634FUSRVoUPP8r0WEEUtpW1wAhsJR701gvKRYw/+YcRglkhm7
T4l6TuBcgIVzUqAc3oZLHVIMKN0ZprZSeopSRozTcUANfYONakvK9Hx1qf+/rmTR
qZHg2uOxlqvxyABnwdk8rmyFx8YqUeN9jaAbbXxtBQKBgQDQRjc0gVg4STqcFqUu
FW35MZ88S7+xTuRd/EG1dpsu2lptx1yhSLTsF5GfxBQKXCQUfWrpkyuCmlV6s+wJ
H0LSyAJQ4ffBsFterQz7dRKTlhRJNk5PYn8jjNCAuBYVSbQZqZ3yZgG3CT3G5+PZ
8Ln3tJHqTRfP5B8KTMcNYiLI0wKBgQDM0/gdb9Dvdz/32GIpxwNNIb52IxnNVVrm
M69+4XNg6CqvctZFuaMQ03W2J5IKAdESaCGLz9pwHZRjfBORcw3BPKD2QkfN5NJg
hWvLlfAsblCYiCCjTCB6rf1OJOQ5fHoNFh1wqDaQCk0flsb9nlZmQQR5ZUHaJhSC
QqMmeKvMrwKBgQDDzp+sH0Z/dGlDwg59auw/caWRHG4WFmOg8L4eCmoO/H4z41B0
2VQu+mGQYNmue733/Yl8Gz62xL5EY88vLFK4tA1pWWiCknj0Y6Fm70QNuPVNd17c
R2/cTlDgEzG/xdEqp0q1T62hFXEdBXoztZxBA2SDcQNIEeIU3uXs8SxevQKBgFp4
acf+wody4aNERR900sV32RtvJ49lWxAA1kwxone0NF5oV7JWa2scK4r4cW3QHZuG
uQJ7HV2WAxvqCu6cpf+rGuGKpxKPNkkBxXoX0Qye8SReRCQ8lL/7J74jV1b43yP2
l6xR8D+w/R2tyFjvXfQuVZ6VFgAX/8kFS/DLLf7rAoGAcnFgCwyzcq6FWL8iW23J
GnbZ0IQk6SPch87MzMmnOFlEXrCf5l832vwI65tNzOoB0yQoWVfBv5sb4Zy9zeFj
FbkpRZC0Kfi9PLzDV4IawoIINYthOJxIKJg+yrmrUWCggXxwdzYIYKLRIskMXoYs
mNMXfUstElEcKO7+DKiPi6U=
-----END PRIVATE KEY-----`;

export interface HeaderEntry {
	name: string;
	value: string;
}

export interface CapturedRequest {
	method: string;
	path: string;
	version: string;
	headers: HeaderEntry[];
	body: string;
}

export interface CapturedResponse {
	statusCode: number | undefined;
	statusMessage: string;
	version: string;
	headers: HeaderEntry[];
	body: string;
}

export interface CapturedMessagesExchange {
	target: string;
	request: CapturedRequest;
	response: CapturedResponse;
}

export interface ClaudeMessagesProxyOptions {
	host?: string;
	port?: number;
	upstreamTlsRejectUnauthorized?: boolean;
}

interface ParsedHttpMessage {
	startLine: string;
	method?: string;
	path?: string;
	version: string;
	statusCode?: number;
	statusMessage?: string;
	headers: HeaderEntry[];
	body: Buffer;
}

interface ConnectTarget {
	host: string;
	port: number;
	display: string;
}

type BodyMode = { kind: "none" } | { kind: "fixed"; length: number } | { kind: "chunked" } | { kind: "until-end" };

interface ParserState {
	head: Omit<ParsedHttpMessage, "body">;
	bodyMode: BodyMode;
}

interface ChunkedParseResult {
	complete: boolean;
	consumed: number;
	body: Buffer;
}

interface CaptureWaiter {
	resolve: (exchange: CapturedMessagesExchange) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

export interface ClaudeTraceCommandArgs {
	command?: string;
	message?: string;
	cwd?: string;
	host?: string;
	port?: number;
	timeoutMs?: number;
	inputDelayMs?: number;
	json?: boolean;
	upstreamTlsRejectUnauthorized?: boolean;
}

const XtermTerminal = xterm.Terminal;

function headerValue(headers: readonly HeaderEntry[], name: string): string | undefined {
	for (const header of headers) {
		if (header.name.toLowerCase() === name) return header.value;
	}
	return undefined;
}

function hasChunkedTransfer(headers: readonly HeaderEntry[]): boolean {
	const value = headerValue(headers, "transfer-encoding");
	return (
		value
			?.toLowerCase()
			.split(",")
			.some(part => part.trim() === "chunked") === true
	);
}

function contentLength(headers: readonly HeaderEntry[]): number {
	const value = headerValue(headers, "content-length");
	if (!value) return 0;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isSafeInteger(parsed) || parsed < 0) {
		throw new Error(`Invalid Content-Length header: ${value}`);
	}
	return parsed;
}
interface PendingCapturedRequest {
	target: string;
	request: CapturedRequest;
}

function parseHeaders(headText: string): { startLine: string; headers: HeaderEntry[] } {
	const lines = headText.split("\r\n");
	const startLine = lines[0] ?? "";
	const headers: HeaderEntry[] = [];
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i]!;
		const colon = line.indexOf(":");
		if (colon <= 0) continue;
		headers.push({ name: line.slice(0, colon), value: line.slice(colon + 1).trim() });
	}
	return { startLine, headers };
}

function parseRequestStartLine(startLine: string): Pick<ParsedHttpMessage, "method" | "path" | "version"> {
	const parts = startLine.split(/\s+/u);
	return {
		method: parts[0] ?? "",
		path: parts[1] ?? "",
		version: parts[2] ?? "",
	};
}

function parseResponseStartLine(
	startLine: string,
): Pick<ParsedHttpMessage, "statusCode" | "statusMessage" | "version"> {
	const match = /^(HTTP\/\d(?:\.\d)?)\s+(\d{3})(?:\s+(.*))?$/u.exec(startLine);
	if (!match) return { version: "", statusCode: undefined, statusMessage: "" };
	return {
		version: match[1]!,
		statusCode: Number.parseInt(match[2]!, 10),
		statusMessage: match[3] ?? "",
	};
}

function responseHasNoBody(statusCode: number | undefined): boolean {
	if (statusCode === undefined) return false;
	return (statusCode >= 100 && statusCode < 200) || statusCode === 204 || statusCode === 304;
}

function parseChunkedBody(buffer: Buffer): ChunkedParseResult {
	let offset = 0;
	const chunks: Buffer[] = [];
	while (true) {
		const lineEnd = buffer.indexOf(CRLF, offset);
		if (lineEnd < 0) return { complete: false, consumed: 0, body: Buffer.alloc(0) };
		const sizeLine = buffer.subarray(offset, lineEnd).toString("latin1");
		const semicolon = sizeLine.indexOf(";");
		const sizeText = (semicolon >= 0 ? sizeLine.slice(0, semicolon) : sizeLine).trim();
		const size = Number.parseInt(sizeText, 16);
		if (!Number.isSafeInteger(size) || size < 0) {
			throw new Error(`Invalid chunk size: ${sizeLine}`);
		}
		const dataStart = lineEnd + CRLF.length;
		if (size === 0) {
			if (buffer.length < dataStart + CRLF.length) return { complete: false, consumed: 0, body: Buffer.alloc(0) };
			if (buffer.subarray(dataStart, dataStart + CRLF.length).equals(CRLF)) {
				return { complete: true, consumed: dataStart + CRLF.length, body: Buffer.concat(chunks) };
			}
			const trailerEnd = buffer.indexOf(DOUBLE_CRLF, dataStart);
			if (trailerEnd < 0) return { complete: false, consumed: 0, body: Buffer.alloc(0) };
			return { complete: true, consumed: trailerEnd + DOUBLE_CRLF.length, body: Buffer.concat(chunks) };
		}
		const chunkEnd = dataStart + size;
		if (buffer.length < chunkEnd + CRLF.length) return { complete: false, consumed: 0, body: Buffer.alloc(0) };
		chunks.push(buffer.subarray(dataStart, chunkEnd));
		offset = chunkEnd + CRLF.length;
	}
}

class HttpMessageParser {
	readonly #kind: "request" | "response";
	#buffer = Buffer.alloc(0);
	#state: ParserState | null = null;

	constructor(kind: "request" | "response") {
		this.#kind = kind;
	}

	push(chunk: Buffer): ParsedHttpMessage[] {
		if (chunk.length > 0) {
			const data = Buffer.from(chunk);
			this.#buffer = this.#buffer.length === 0 ? data : Buffer.concat([this.#buffer, data]);
		}
		return this.#drain(false);
	}

	finish(): ParsedHttpMessage[] {
		return this.#drain(true);
	}

	#bodyMode(head: Omit<ParsedHttpMessage, "body">): BodyMode {
		if (this.#kind === "response" && responseHasNoBody(head.statusCode)) return { kind: "none" };
		if (hasChunkedTransfer(head.headers)) return { kind: "chunked" };
		const length = contentLength(head.headers);
		if (length > 0) return { kind: "fixed", length };
		if (this.#kind === "response") return { kind: "until-end" };
		return { kind: "none" };
	}

	#parseHead(): ParserState | null {
		const headerEnd = this.#buffer.indexOf(DOUBLE_CRLF);
		if (headerEnd < 0) return null;
		const headText = this.#buffer.subarray(0, headerEnd).toString("latin1");
		const { startLine, headers } = parseHeaders(headText);
		this.#buffer = this.#buffer.subarray(headerEnd + DOUBLE_CRLF.length);
		if (this.#kind === "request") {
			const request = parseRequestStartLine(startLine);
			const head = { startLine, headers, ...request };
			return { head, bodyMode: this.#bodyMode(head) };
		}
		const response = parseResponseStartLine(startLine);
		const head = { startLine, headers, ...response };
		return { head, bodyMode: this.#bodyMode(head) };
	}

	#drain(final: boolean): ParsedHttpMessage[] {
		const messages: ParsedHttpMessage[] = [];
		while (true) {
			if (!this.#state) {
				const state = this.#parseHead();
				if (!state) break;
				this.#state = state;
			}
			const state = this.#state;
			if (state.bodyMode.kind === "none") {
				messages.push({ ...state.head, body: Buffer.alloc(0) });
				this.#state = null;
				continue;
			}
			if (state.bodyMode.kind === "fixed") {
				if (this.#buffer.length < state.bodyMode.length) break;
				const body = this.#buffer.subarray(0, state.bodyMode.length);
				this.#buffer = this.#buffer.subarray(state.bodyMode.length);
				messages.push({ ...state.head, body });
				this.#state = null;
				continue;
			}
			if (state.bodyMode.kind === "chunked") {
				const result = parseChunkedBody(this.#buffer);
				if (!result.complete) break;
				this.#buffer = this.#buffer.subarray(result.consumed);
				messages.push({ ...state.head, body: result.body });
				this.#state = null;
				continue;
			}
			if (!final) break;
			const body = this.#buffer;
			this.#buffer = Buffer.alloc(0);
			messages.push({ ...state.head, body });
			this.#state = null;
		}
		return messages;
	}
}

function parseConnectTarget(raw: string): ConnectTarget | null {
	if (!raw) return null;
	if (raw.startsWith("[")) {
		const end = raw.indexOf("]");
		if (end < 0) return null;
		const host = raw.slice(1, end);
		const portText = raw.startsWith(":", end + 1) ? raw.slice(end + 2) : "443";
		const port = Number.parseInt(portText, 10);
		if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) return null;
		return { host, port, display: `[${host}]:${port}` };
	}
	const colon = raw.lastIndexOf(":");
	const host = colon >= 0 ? raw.slice(0, colon) : raw;
	const portText = colon >= 0 ? raw.slice(colon + 1) : "443";
	const port = Number.parseInt(portText, 10);
	if (!host || !Number.isSafeInteger(port) || port <= 0 || port > 65535) return null;
	return { host, port, display: `${host}:${port}` };
}

function pathNameFromRequestTarget(requestTarget: string): string {
	if (requestTarget.startsWith("http://") || requestTarget.startsWith("https://")) {
		try {
			return new URL(requestTarget).pathname;
		} catch {
			return requestTarget;
		}
	}
	const query = requestTarget.indexOf("?");
	return query >= 0 ? requestTarget.slice(0, query) : requestTarget;
}

function isMessagesRequest(message: ParsedHttpMessage): boolean {
	return pathNameFromRequestTarget(message.path ?? "") === "/v1/messages";
}

// Claude Code fires a background warmup/classification call on its small fast
// model (a haiku variant, ANTHROPIC_SMALL_FAST_MODEL) before sending the user's
// real message. Skip it so the capture lands on the actual prompt.
function isBackgroundModelRequest(message: ParsedHttpMessage): boolean {
	try {
		const parsed = JSON.parse(decodeBody(message.headers, message.body)) as { model?: unknown };
		return typeof parsed.model === "string" && parsed.model.toLowerCase().includes("haiku");
	} catch {
		return false;
	}
}

function decodeBody(headers: readonly HeaderEntry[], body: Buffer): string {
	const encoding = headerValue(headers, "content-encoding")?.toLowerCase().trim();
	try {
		if (encoding === "gzip") return zlib.gunzipSync(body).toString("utf8");
		if (encoding === "br") return zlib.brotliDecompressSync(body).toString("utf8");
		if (encoding === "deflate") return zlib.inflateSync(body).toString("utf8");
	} catch {
		return TEXT_DECODER.decode(body);
	}
	return TEXT_DECODER.decode(body);
}

function toCapturedRequest(message: ParsedHttpMessage): CapturedRequest {
	return {
		method: message.method ?? "",
		path: message.path ?? "",
		version: message.version,
		headers: message.headers,
		body: decodeBody(message.headers, message.body),
	};
}

function toCapturedResponse(message: ParsedHttpMessage): CapturedResponse {
	return {
		statusCode: message.statusCode,
		statusMessage: message.statusMessage ?? "",
		version: message.version,
		headers: message.headers,
		body: decodeBody(message.headers, message.body),
	};
}

function formatHeaders(headers: readonly HeaderEntry[]): string {
	return headers.map(header => `${header.name}: ${header.value}`).join("\n");
}

export function formatCapturedMessagesExchange(exchange: CapturedMessagesExchange): string {
	const requestHeaders = formatHeaders(exchange.request.headers);
	const responseHeaders = formatHeaders(exchange.response.headers);
	const responseLine =
		`${exchange.response.version || "HTTP"} ${exchange.response.statusCode ?? ""} ${exchange.response.statusMessage}`.trim();
	return [
		`# /v1/messages capture (${exchange.target})`,
		"",
		"## Request",
		`${exchange.request.method} ${exchange.request.path} ${exchange.request.version}`.trim(),
		"",
		"### Headers",
		requestHeaders,
		"",
		"### Body",
		exchange.request.body,
		"",
		"## Response",
		responseLine,
		"",
		"### Headers",
		responseHeaders,
		"",
		"### Body",
		exchange.response.body,
		"",
	].join("\n");
}

export class ClaudeMessagesProxy {
	readonly #host: string;
	readonly #requestedPort: number;
	readonly #upstreamTlsRejectUnauthorized: boolean;
	#server: net.Server | null = null;
	#sockets = new Set<net.Socket | tls.TLSSocket>();
	#completed: CapturedMessagesExchange[] = [];
	#waiters: CaptureWaiter[] = [];
	#stopped = false;
	#port = 0;

	constructor(options: ClaudeMessagesProxyOptions = {}) {
		this.#host = options.host ?? DEFAULT_PROXY_HOST;
		this.#requestedPort = options.port ?? DEFAULT_PROXY_PORT;
		this.#upstreamTlsRejectUnauthorized = options.upstreamTlsRejectUnauthorized ?? true;
	}

	get host(): string {
		return this.#host;
	}

	get port(): number {
		return this.#port;
	}

	get url(): string {
		return `http://${this.#host}:${this.#port}`;
	}

	async start(): Promise<void> {
		if (this.#server) return;
		const server = net.createServer(socket => this.#handleConnection(socket));
		this.#server = server;
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const onError = (error: Error) => reject(error);
		server.once("error", onError);
		server.listen(this.#requestedPort, this.#host, () => {
			server.off("error", onError);
			const address = server.address();
			if (!address || typeof address === "string") {
				reject(new Error("Proxy did not bind to a TCP address"));
				return;
			}
			this.#port = address.port;
			resolve();
		});
		await promise;
	}

	async stop(): Promise<void> {
		this.#stopped = true;
		for (const waiter of this.#waiters.splice(0)) {
			clearTimeout(waiter.timer);
			waiter.reject(new Error("Proxy stopped before a /v1/messages response completed"));
		}
		for (const socket of this.#sockets) {
			socket.destroy();
		}
		this.#sockets.clear();
		const server = this.#server;
		this.#server = null;
		if (!server) return;
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		server.close(error => {
			if (error) reject(error);
			else resolve();
		});
		await promise;
	}

	waitForCapture(timeoutMs: number): Promise<CapturedMessagesExchange> {
		const existing = this.#completed.shift();
		if (existing) return Promise.resolve(existing);
		if (this.#stopped) return Promise.reject(new Error("Proxy is stopped"));
		const { promise, resolve, reject } = Promise.withResolvers<CapturedMessagesExchange>();
		const timer = setTimeout(() => {
			const index = this.#waiters.findIndex(waiter => waiter.resolve === resolve);
			if (index >= 0) this.#waiters.splice(index, 1);
			reject(new Error("Timed out waiting for a completed /v1/messages response"));
		}, timeoutMs);
		this.#waiters.push({ resolve, reject, timer });
		return promise;
	}

	#complete(exchange: CapturedMessagesExchange): void {
		const waiter = this.#waiters.shift();
		if (waiter) {
			clearTimeout(waiter.timer);
			waiter.resolve(exchange);
			return;
		}
		this.#completed.push(exchange);
	}

	#track<T extends net.Socket | tls.TLSSocket>(socket: T): T {
		this.#sockets.add(socket);
		socket.once("close", () => this.#sockets.delete(socket));
		return socket;
	}

	#handleConnection(socket: net.Socket): void {
		this.#track(socket);
		let buffer = Buffer.alloc(0);
		const onData = (chunk: Buffer) => {
			const data = Buffer.from(chunk);
			buffer = buffer.length === 0 ? data : Buffer.concat([buffer, data]);
			const headerEnd = buffer.indexOf(DOUBLE_CRLF);
			if (headerEnd < 0) return;
			socket.off("data", onData);
			const head = buffer.subarray(0, headerEnd).toString("latin1");
			const rest = buffer.subarray(headerEnd + DOUBLE_CRLF.length);
			this.#handleProxyRequest(socket, head, rest);
		};
		socket.on("data", onData);
		socket.on("error", () => socket.destroy());
	}

	#handleProxyRequest(socket: net.Socket, head: string, rest: Buffer): void {
		const firstLine = head.split("\r\n", 1)[0] ?? "";
		const parts = firstLine.split(/\s+/u);
		if (parts[0] === "CONNECT") {
			const target = parseConnectTarget(parts[1] ?? "");
			if (!target) {
				socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
				return;
			}
			socket.write("HTTP/1.1 200 Connection Established\r\n\r\n", () => this.#openMitmTunnel(socket, target, rest));
			return;
		}
		this.#handleForwardProxyRequest(socket, head, rest);
	}

	#handleForwardProxyRequest(socket: net.Socket, head: string, rest: Buffer): void {
		const firstLine = head.split("\r\n", 1)[0] ?? "";
		const parts = firstLine.split(/\s+/u);
		const targetUrl = parts[1] ?? "";
		let target: ConnectTarget | null = null;
		if (targetUrl.startsWith("http://") || targetUrl.startsWith("https://")) {
			try {
				const parsed = new URL(targetUrl);
				const isHttps = parsed.protocol === "https:";
				const port = parsed.port ? Number.parseInt(parsed.port, 10) : isHttps ? 443 : 80;
				if (Number.isSafeInteger(port) && port > 0 && port <= 65535) {
					target = { host: parsed.hostname, port, display: `${parsed.hostname}:${port}` };
				}
			} catch {}
		}
		if (!target) {
			const headers = parseHeaders(head).headers;
			const hostHeader = headerValue(headers, "host");
			if (hostHeader) {
				target = parseConnectTarget(hostHeader);
			}
		}
		if (!target) {
			socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
			return;
		}
		const upstream = this.#track(
			net.connect({ host: target.host, port: target.port }, () => {
				upstream.write(head);
				upstream.write(DOUBLE_CRLF);
				if (rest.length > 0) upstream.write(rest);
				socket.pipe(upstream);
				upstream.pipe(socket);
			}),
		);
		upstream.on("error", () => socket.destroy());
	}

	#openMitmTunnel(socket: net.Socket, target: ConnectTarget, rest: Buffer): void {
		const clientTls = this.#track(
			new tls.TLSSocket(socket, {
				isServer: true,
				cert: CLAUDE_TRACE_DEBUG_CERT,
				key: CLAUDE_TRACE_DEBUG_KEY,
				ALPNProtocols: ["http/1.1"],
			}),
		);
		if (rest.length > 0) {
			clientTls.unshift(rest);
		}
		const upstreamTls = this.#track(
			tls.connect({
				host: target.host,
				port: target.port,
				servername: net.isIP(target.host) ? undefined : target.host,
				rejectUnauthorized: this.#upstreamTlsRejectUnauthorized,
				ALPNProtocols: ["http/1.1"],
			}),
		);
		const requestParser = new HttpMessageParser("request");
		const responseParser = new HttpMessageParser("response");
		const responseQueue: Array<PendingCapturedRequest | null> = [];
		const flushResponses = (messages: ParsedHttpMessage[]) => {
			for (const message of messages) {
				const pending = responseQueue.shift();
				if (!pending) continue;
				this.#complete({ ...pending, response: toCapturedResponse(message) });
			}
		};
		clientTls.on("data", chunk => {
			const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			upstreamTls.write(data);
			const messages = requestParser.push(data);
			for (const message of messages) {
				if (!isMessagesRequest(message) || isBackgroundModelRequest(message)) {
					responseQueue.push(null);
					continue;
				}
				responseQueue.push({ target: target.display, request: toCapturedRequest(message) });
			}
		});
		upstreamTls.on("data", chunk => {
			const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			clientTls.write(data);
			flushResponses(responseParser.push(data));
		});
		clientTls.on("end", () => {
			try {
				requestParser.finish();
			} catch {}
			upstreamTls.end();
		});
		upstreamTls.on("end", () => {
			try {
				flushResponses(responseParser.finish());
			} catch {}
			clientTls.end();
		});
		clientTls.on("error", () => upstreamTls.destroy());
		upstreamTls.on("error", () => clientTls.destroy());
	}
}
function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function shutdownPty(session: PtySession, runPromise: Promise<unknown>): Promise<void> {
	try {
		session.write("\x03");
	} catch {}
	await Bun.sleep(100);
	try {
		session.kill();
	} catch {}
	try {
		await runPromise;
	} catch {}
}

export async function runClaudeMessagesCapture(args: ClaudeTraceCommandArgs = {}): Promise<CapturedMessagesExchange> {
	const proxy = new ClaudeMessagesProxy({
		host: args.host ?? DEFAULT_PROXY_HOST,
		port: args.port ?? DEFAULT_PROXY_PORT,
		upstreamTlsRejectUnauthorized: args.upstreamTlsRejectUnauthorized,
	});
	await proxy.start();
	const session = new PtySession();
	const terminal = new XtermTerminal({
		cols: DEFAULT_COLS,
		rows: DEFAULT_ROWS,
		disableStdin: true,
		allowProposedApi: true,
		scrollback: 10_000,
	});
	terminal.onData(data => {
		try {
			session.write(data);
		} catch {}
	});
	const command = args.command ?? DEFAULT_COMMAND;
	const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const message = args.message ?? DEFAULT_MESSAGE;
	const cwd = path.resolve(args.cwd ?? process.cwd());
	const env = {
		HTTPS_PROXY: proxy.url,
		HTTP_PROXY: proxy.url,
		NODE_TLS_REJECT_UNAUTHORIZED: "0",
		TERM: "xterm-256color",
	};
	let ptyOutput = "";
	const runPromise = session.start(
		{
			command,
			cwd,
			timeoutMs,
			env,
			cols: DEFAULT_COLS,
			rows: DEFAULT_ROWS,
		},
		(error, chunk) => {
			if (error || !chunk) return;
			ptyOutput += chunk;
			if (ptyOutput.length > 20_000) ptyOutput = ptyOutput.slice(-20_000);
			terminal.write(chunk);
		},
	);
	try {
		const outputSuffix = () => (ptyOutput.trim() ? `\n\nClaude output:\n${ptyOutput}` : "");
		void (async () => {
			await Bun.sleep(args.inputDelayMs ?? DEFAULT_INPUT_DELAY_MS);
			try {
				session.write(`${message}\r`);
			} catch (error) {
				ptyOutput += `\n[omp input write failed: ${errorMessage(error)}]\n`;
			}
		})();
		const captureRace = proxy.waitForCapture(timeoutMs).then(
			exchange => ({ kind: "capture" as const, exchange }),
			error => ({ kind: "capture-error" as const, error }),
		);
		const ptyRace = runPromise.then(
			() => ({ kind: "pty-exit" as const }),
			error => ({ kind: "pty-error" as const, error }),
		);
		const first = await Promise.race([captureRace, ptyRace]);
		if (first.kind === "capture") {
			await shutdownPty(session, runPromise);
			return first.exchange;
		}
		if (first.kind === "capture-error") {
			throw new Error(`${errorMessage(first.error)}${outputSuffix()}`);
		}
		const late = await Promise.race([captureRace, Bun.sleep(250).then(() => ({ kind: "late-timeout" as const }))]);
		if (late.kind === "capture") {
			await shutdownPty(session, runPromise);
			return late.exchange;
		}
		if (first.kind === "pty-error") {
			throw new Error(
				`Claude command failed before /v1/messages completed: ${errorMessage(first.error)}${outputSuffix()}`,
			);
		}
		throw new Error(`Claude command exited before /v1/messages completed${outputSuffix()}`);
	} finally {
		terminal.dispose();
		await proxy.stop();
	}
}

export async function runClaudeTraceCommand(args: ClaudeTraceCommandArgs = {}): Promise<void> {
	process.stderr.write(
		`Starting Claude trace proxy on ${args.host ?? DEFAULT_PROXY_HOST}:${args.port ?? DEFAULT_PROXY_PORT}\n`,
	);
	const exchange = await runClaudeMessagesCapture(args);
	const output = args.json ? `${JSON.stringify(exchange, null, 2)}\n` : formatCapturedMessagesExchange(exchange);
	process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
}
