import { createServer } from "node:net";
import { delimiter, join } from "node:path";
import type { Subprocess } from "bun";
import { nanoid } from "nanoid";
import { getShellConfig, killProcessTree } from "../utils/shell";
import { getOrCreateSnapshot } from "../utils/shell-snapshot";
import { logger } from "./logger";
import { acquireSharedGateway, releaseSharedGateway } from "./python-gateway-coordinator";
import { PYTHON_PRELUDE } from "./python-prelude";
import { htmlToBasicMarkdown } from "./tools/web-scrapers/types";
import { ScopeSignal } from "./utils";

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();
const HEARTBEAT_INTERVAL_MS = 5000;
const HEARTBEAT_TIMEOUT_MS = 2000;
const HEARTBEAT_FAILURE_LIMIT = 1;
const GATEWAY_STARTUP_TIMEOUT_MS = 30000;
const GATEWAY_STARTUP_ATTEMPTS = 3;
const TRACE_IPC = process.env.OMP_PYTHON_IPC_TRACE === "1";
const PRELUDE_INTROSPECTION_SNIPPET = "import json\nprint(json.dumps(__omp_prelude_docs__()))";

interface ExternalGatewayConfig {
	url: string;
	token?: string;
}

function getExternalGatewayConfig(): ExternalGatewayConfig | null {
	const url = process.env.OMP_PYTHON_GATEWAY_URL;
	if (!url) return null;
	return {
		url: url.replace(/\/$/, ""),
		token: process.env.OMP_PYTHON_GATEWAY_TOKEN,
	};
}

const DEFAULT_ENV_ALLOWLIST = new Set([
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"LC_MESSAGES",
	"TERM",
	"TERM_PROGRAM",
	"TERM_PROGRAM_VERSION",
	"TMPDIR",
	"TEMP",
	"TMP",
	"XDG_CACHE_HOME",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_RUNTIME_DIR",
	"SSH_AUTH_SOCK",
	"SSH_AGENT_PID",
	"CONDA_PREFIX",
	"CONDA_DEFAULT_ENV",
	"VIRTUAL_ENV",
	"PYTHONPATH",
]);

const DEFAULT_ENV_ALLOW_PREFIXES = ["LC_", "XDG_", "OMP_"];

const DEFAULT_ENV_DENYLIST = new Set([
	"OPENAI_API_KEY",
	"ANTHROPIC_API_KEY",
	"GOOGLE_API_KEY",
	"GEMINI_API_KEY",
	"OPENROUTER_API_KEY",
	"PERPLEXITY_API_KEY",
	"EXA_API_KEY",
	"AZURE_OPENAI_API_KEY",
	"MISTRAL_API_KEY",
]);

export interface JupyterHeader {
	msg_id: string;
	session: string;
	username: string;
	date: string;
	msg_type: string;
	version: string;
}

export interface JupyterMessage {
	channel: string;
	header: JupyterHeader;
	parent_header: Record<string, unknown>;
	metadata: Record<string, unknown>;
	content: Record<string, unknown>;
	buffers?: Uint8Array[];
}

export type KernelDisplayOutput = { type: "json"; data: unknown } | { type: "image"; data: string; mimeType: string };

export interface KernelExecuteOptions {
	signal?: AbortSignal;
	onChunk?: (text: string) => Promise<void> | void;
	onDisplay?: (output: KernelDisplayOutput) => Promise<void> | void;
	timeoutMs?: number;
	silent?: boolean;
	storeHistory?: boolean;
	allowStdin?: boolean;
}

export interface KernelExecuteResult {
	status: "ok" | "error";
	executionCount?: number;
	error?: { name: string; value: string; traceback: string[] };
	cancelled: boolean;
	timedOut: boolean;
	stdinRequested: boolean;
}

export interface PreludeHelper {
	name: string;
	signature: string;
	docstring: string;
	category: string;
}

interface KernelStartOptions {
	cwd: string;
	env?: Record<string, string | undefined>;
	useSharedGateway?: boolean;
}

export interface PythonKernelAvailability {
	ok: boolean;
	pythonPath?: string;
	reason?: string;
}

function filterEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
	const filtered: Record<string, string | undefined> = {};
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) continue;
		if (DEFAULT_ENV_DENYLIST.has(key)) continue;
		if (DEFAULT_ENV_ALLOWLIST.has(key)) {
			filtered[key] = value;
			continue;
		}
		if (DEFAULT_ENV_ALLOW_PREFIXES.some((prefix) => key.startsWith(prefix))) {
			filtered[key] = value;
		}
	}
	return filtered;
}

async function resolveVenvPath(cwd: string): Promise<string | null> {
	if (process.env.VIRTUAL_ENV) return process.env.VIRTUAL_ENV;
	const candidates = [join(cwd, ".venv"), join(cwd, "venv")];
	for (const candidate of candidates) {
		if (await Bun.file(candidate).exists()) {
			return candidate;
		}
	}
	return null;
}

async function resolvePythonRuntime(cwd: string, baseEnv: Record<string, string | undefined>) {
	const env = { ...baseEnv };
	const venvPath = env.VIRTUAL_ENV ?? (await resolveVenvPath(cwd));
	if (venvPath) {
		env.VIRTUAL_ENV = venvPath;
		const binDir = process.platform === "win32" ? join(venvPath, "Scripts") : join(venvPath, "bin");
		const pythonCandidate = join(binDir, process.platform === "win32" ? "python.exe" : "python");
		if (await Bun.file(pythonCandidate).exists()) {
			env.PATH = env.PATH ? `${binDir}${delimiter}${env.PATH}` : binDir;
			return { pythonPath: pythonCandidate, env };
		}
	}

	const pythonPath = Bun.which("python") ?? Bun.which("python3");
	if (!pythonPath) {
		throw new Error("Python executable not found on PATH");
	}
	return { pythonPath, env };
}

export async function checkPythonKernelAvailability(cwd: string): Promise<PythonKernelAvailability> {
	if (process.env.BUN_ENV === "test" || process.env.NODE_ENV === "test" || process.env.OMP_PYTHON_SKIP_CHECK === "1") {
		return { ok: true };
	}

	const externalConfig = getExternalGatewayConfig();
	if (externalConfig) {
		return checkExternalGatewayAvailability(externalConfig);
	}

	try {
		const { env } = await getShellConfig();
		const baseEnv = filterEnv(env);
		const runtime = await resolvePythonRuntime(cwd, baseEnv);
		const result = Bun.spawnSync(
			[
				runtime.pythonPath,
				"-c",
				"import importlib.util,sys;sys.exit(0 if importlib.util.find_spec('kernel_gateway') and importlib.util.find_spec('ipykernel') else 1)",
			],
			{ cwd, env: runtime.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
		);
		if (result.exitCode === 0) {
			return { ok: true, pythonPath: runtime.pythonPath };
		}
		return {
			ok: false,
			pythonPath: runtime.pythonPath,
			reason:
				"kernel_gateway (jupyter-kernel-gateway) or ipykernel not installed. Run: python -m pip install jupyter_kernel_gateway ipykernel",
		};
	} catch (err: unknown) {
		return { ok: false, reason: err instanceof Error ? err.message : String(err) };
	}
}

async function checkExternalGatewayAvailability(config: ExternalGatewayConfig): Promise<PythonKernelAvailability> {
	try {
		const headers: Record<string, string> = {};
		if (config.token) {
			headers.Authorization = `token ${config.token}`;
		}

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 5000);

		const response = await fetch(`${config.url}/api/kernelspecs`, {
			headers,
			signal: controller.signal,
		});
		clearTimeout(timeout);

		if (response.ok) {
			return { ok: true };
		}

		if (response.status === 401 || response.status === 403) {
			return {
				ok: false,
				reason: `External gateway at ${config.url} requires authentication. Set OMP_PYTHON_GATEWAY_TOKEN.`,
			};
		}

		return {
			ok: false,
			reason: `External gateway at ${config.url} returned status ${response.status}`,
		};
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.includes("abort") || message.includes("timeout")) {
			return {
				ok: false,
				reason: `External gateway at ${config.url} is not reachable (timeout)`,
			};
		}
		return {
			ok: false,
			reason: `External gateway at ${config.url} is not reachable: ${message}`,
		};
	}
}

async function allocatePort(): Promise<number> {
	return await new Promise((resolve, reject) => {
		const server = createServer();
		server.unref();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address && typeof address === "object") {
				const port = address.port;
				server.close((err: Error | null | undefined) => {
					if (err) {
						reject(err);
					} else {
						resolve(port);
					}
				});
			} else {
				server.close();
				reject(new Error("Failed to allocate port"));
			}
		});
	});
}

function normalizeDisplayText(text: string): string {
	return text.endsWith("\n") ? text : `${text}\n`;
}

export function deserializeWebSocketMessage(data: ArrayBuffer): JupyterMessage | null {
	const view = new DataView(data);
	const offsetCount = view.getUint32(0, true);

	if (offsetCount < 1) return null;

	const offsets: number[] = [];
	for (let i = 0; i < offsetCount; i++) {
		offsets.push(view.getUint32(4 + i * 4, true));
	}

	const msgStart = offsets[0];
	const msgEnd = offsets.length > 1 ? offsets[1] : data.byteLength;
	const msgBytes = new Uint8Array(data, msgStart, msgEnd - msgStart);
	const msgText = TEXT_DECODER.decode(msgBytes);

	try {
		const msg = JSON.parse(msgText) as {
			channel: string;
			header: JupyterHeader;
			parent_header: Record<string, unknown>;
			metadata: Record<string, unknown>;
			content: Record<string, unknown>;
		};

		const buffers: Uint8Array[] = [];
		for (let i = 1; i < offsets.length; i++) {
			const start = offsets[i];
			const end = i + 1 < offsets.length ? offsets[i + 1] : data.byteLength;
			buffers.push(new Uint8Array(data, start, end - start));
		}

		return { ...msg, buffers };
	} catch {
		return null;
	}
}

export function serializeWebSocketMessage(msg: JupyterMessage): ArrayBuffer {
	const msgText = JSON.stringify({
		channel: msg.channel,
		header: msg.header,
		parent_header: msg.parent_header,
		metadata: msg.metadata,
		content: msg.content,
	});
	const msgBytes = TEXT_ENCODER.encode(msgText);

	const buffers = msg.buffers ?? [];
	const offsetCount = 1 + buffers.length;
	const headerSize = 4 + offsetCount * 4;

	let totalSize = headerSize + msgBytes.length;
	for (const buf of buffers) {
		totalSize += buf.length;
	}

	const result = new ArrayBuffer(totalSize);
	const view = new DataView(result);
	const bytes = new Uint8Array(result);

	view.setUint32(0, offsetCount, true);

	let offset = headerSize;
	view.setUint32(4, offset, true);
	bytes.set(msgBytes, offset);
	offset += msgBytes.length;

	for (let i = 0; i < buffers.length; i++) {
		view.setUint32(4 + (i + 1) * 4, offset, true);
		bytes.set(buffers[i], offset);
		offset += buffers[i].length;
	}

	return result;
}

export class PythonKernel {
	readonly id: string;
	readonly kernelId: string;
	readonly gatewayProcess: Subprocess | null;
	readonly gatewayUrl: string;
	readonly sessionId: string;
	readonly username: string;
	readonly isSharedGateway: boolean;
	readonly #authToken?: string;

	#ws: WebSocket | null = null;
	#disposed = false;
	#alive = true;
	#heartbeatTimer?: NodeJS.Timeout;
	#heartbeatFailures = 0;
	#messageHandlers = new Map<string, (msg: JupyterMessage) => void>();
	#channelHandlers = new Map<string, Set<(msg: JupyterMessage) => void>>();

	private constructor(
		id: string,
		kernelId: string,
		gatewayProcess: Subprocess | null,
		gatewayUrl: string,
		sessionId: string,
		username: string,
		isSharedGateway: boolean,
		authToken?: string,
	) {
		this.id = id;
		this.kernelId = kernelId;
		this.gatewayProcess = gatewayProcess;
		this.gatewayUrl = gatewayUrl;
		this.sessionId = sessionId;
		this.username = username;
		this.isSharedGateway = isSharedGateway;
		this.#authToken = authToken;

		if (this.gatewayProcess) {
			this.gatewayProcess.exited.then(() => {
				this.#alive = false;
			});
		}
	}

	#authHeaders(): Record<string, string> {
		if (!this.#authToken) return {};
		return { Authorization: `token ${this.#authToken}` };
	}

	static async start(options: KernelStartOptions): Promise<PythonKernel> {
		const availability = await checkPythonKernelAvailability(options.cwd);
		if (!availability.ok) {
			throw new Error(availability.reason ?? "Python kernel unavailable");
		}

		const externalConfig = getExternalGatewayConfig();
		if (externalConfig) {
			return PythonKernel.startWithExternalGateway(externalConfig);
		}

		// Try shared gateway first (unless explicitly disabled)
		if (options.useSharedGateway !== false) {
			try {
				const sharedResult = await acquireSharedGateway(options.cwd);
				if (sharedResult) {
					return PythonKernel.startWithSharedGateway(sharedResult.url, options.cwd);
				}
			} catch (err) {
				logger.warn("Failed to acquire shared gateway, falling back to local", {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		return PythonKernel.startWithLocalGateway(options);
	}

	private static async startWithExternalGateway(config: ExternalGatewayConfig): Promise<PythonKernel> {
		const headers: Record<string, string> = { "Content-Type": "application/json" };
		if (config.token) {
			headers.Authorization = `token ${config.token}`;
		}

		const createResponse = await fetch(`${config.url}/api/kernels`, {
			method: "POST",
			headers,
			body: JSON.stringify({ name: "python3" }),
		});

		if (!createResponse.ok) {
			throw new Error(`Failed to create kernel on external gateway: ${await createResponse.text()}`);
		}

		const kernelInfo = (await createResponse.json()) as { id: string };
		const kernelId = kernelInfo.id;

		const kernel = new PythonKernel(nanoid(), kernelId, null, config.url, nanoid(), "omp", false, config.token);

		try {
			await kernel.connectWebSocket();
			kernel.startHeartbeat();
			const preludeResult = await kernel.execute(PYTHON_PRELUDE, { silent: true, storeHistory: false });
			if (preludeResult.cancelled || preludeResult.status === "error") {
				throw new Error("Failed to initialize Python kernel prelude");
			}
			return kernel;
		} catch (err: unknown) {
			await kernel.shutdown();
			throw err;
		}
	}

	private static async startWithSharedGateway(gatewayUrl: string, _cwd: string): Promise<PythonKernel> {
		const createResponse = await fetch(`${gatewayUrl}/api/kernels`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "python3" }),
		});

		if (!createResponse.ok) {
			await releaseSharedGateway();
			throw new Error(`Failed to create kernel on shared gateway: ${await createResponse.text()}`);
		}

		const kernelInfo = (await createResponse.json()) as { id: string };
		const kernelId = kernelInfo.id;

		const kernel = new PythonKernel(nanoid(), kernelId, null, gatewayUrl, nanoid(), "omp", true);

		try {
			await kernel.connectWebSocket();
			kernel.startHeartbeat();
			const preludeResult = await kernel.execute(PYTHON_PRELUDE, { silent: true, storeHistory: false });
			if (preludeResult.cancelled || preludeResult.status === "error") {
				throw new Error("Failed to initialize Python kernel prelude");
			}
			return kernel;
		} catch (err: unknown) {
			await kernel.shutdown();
			throw err;
		}
	}

	private static async startWithLocalGateway(options: KernelStartOptions): Promise<PythonKernel> {
		const { shell, env } = await getShellConfig();
		const filteredEnv = filterEnv(env);
		const runtime = await resolvePythonRuntime(options.cwd, filteredEnv);
		const snapshotPath = await getOrCreateSnapshot(shell, env).catch((err: unknown) => {
			logger.warn("Failed to resolve shell snapshot for Python kernel", {
				error: err instanceof Error ? err.message : String(err),
			});
			return null;
		});

		const kernelEnv: Record<string, string | undefined> = {
			...runtime.env,
			...options.env,
			PYTHONUNBUFFERED: "1",
			OMP_SHELL_SNAPSHOT: snapshotPath ?? undefined,
		};

		const pythonPathParts = [options.cwd, kernelEnv.PYTHONPATH].filter(Boolean).join(delimiter);
		if (pythonPathParts) {
			kernelEnv.PYTHONPATH = pythonPathParts;
		}

		let gatewayProcess: Subprocess | null = null;
		let gatewayUrl: string | null = null;
		let lastError: string | null = null;

		for (let attempt = 0; attempt < GATEWAY_STARTUP_ATTEMPTS; attempt += 1) {
			const gatewayPort = await allocatePort();
			const candidateUrl = `http://127.0.0.1:${gatewayPort}`;
			const candidateProcess = Bun.spawn(
				[
					runtime.pythonPath,
					"-m",
					"kernel_gateway",
					"--KernelGatewayApp.ip=127.0.0.1",
					`--KernelGatewayApp.port=${gatewayPort}`,
					"--KernelGatewayApp.port_retries=0",
					"--KernelGatewayApp.allow_origin=*",
					"--JupyterApp.answer_yes=true",
				],
				{
					cwd: options.cwd,
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
					env: kernelEnv,
				},
			);

			let exited = false;
			candidateProcess.exited
				.then(() => {
					exited = true;
				})
				.catch(() => {
					exited = true;
				});

			const startTime = Date.now();
			while (Date.now() - startTime < GATEWAY_STARTUP_TIMEOUT_MS) {
				if (exited) break;
				try {
					const response = await fetch(`${candidateUrl}/api/kernelspecs`);
					if (response.ok) {
						gatewayProcess = candidateProcess;
						gatewayUrl = candidateUrl;
						break;
					}
				} catch {
					// Gateway not ready yet
				}
				await Bun.sleep(100);
			}

			if (gatewayProcess && gatewayUrl) break;

			killProcessTree(candidateProcess.pid);
			lastError = exited ? "Kernel gateway process exited during startup" : "Kernel gateway failed to start";
		}

		if (!gatewayProcess || !gatewayUrl) {
			throw new Error(lastError ?? "Kernel gateway failed to start");
		}

		const createResponse = await fetch(`${gatewayUrl}/api/kernels`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "python3" }),
		});

		if (!createResponse.ok) {
			killProcessTree(gatewayProcess.pid);
			throw new Error(`Failed to create kernel: ${await createResponse.text()}`);
		}

		const kernelInfo = (await createResponse.json()) as { id: string };
		const kernelId = kernelInfo.id;

		const kernel = new PythonKernel(nanoid(), kernelId, gatewayProcess, gatewayUrl, nanoid(), "omp", false);

		try {
			await kernel.connectWebSocket();
			kernel.startHeartbeat();
			const preludeResult = await kernel.execute(PYTHON_PRELUDE, { silent: true, storeHistory: false });
			if (preludeResult.cancelled || preludeResult.status === "error") {
				throw new Error("Failed to initialize Python kernel prelude");
			}
			return kernel;
		} catch (err: unknown) {
			await kernel.shutdown();
			throw err;
		}
	}

	private async connectWebSocket(): Promise<void> {
		const wsBase = this.gatewayUrl.replace(/^http/, "ws");
		let wsUrl = `${wsBase}/api/kernels/${this.kernelId}/channels`;
		if (this.#authToken) {
			wsUrl += `?token=${encodeURIComponent(this.#authToken)}`;
		}

		return new Promise((resolve, reject) => {
			const ws = new WebSocket(wsUrl);
			ws.binaryType = "arraybuffer";

			const timeout = setTimeout(() => {
				ws.close();
				reject(new Error("WebSocket connection timeout"));
			}, 10000);

			ws.onopen = () => {
				clearTimeout(timeout);
				this.#ws = ws;
				resolve();
			};

			ws.onerror = (event) => {
				clearTimeout(timeout);
				reject(new Error(`WebSocket error: ${event}`));
			};

			ws.onclose = () => {
				this.#alive = false;
			};

			ws.onmessage = (event) => {
				let msg: JupyterMessage | null = null;
				if (event.data instanceof ArrayBuffer) {
					msg = deserializeWebSocketMessage(event.data);
				} else if (typeof event.data === "string") {
					try {
						msg = JSON.parse(event.data) as JupyterMessage;
					} catch {
						return;
					}
				}
				if (!msg) return;

				if (TRACE_IPC) {
					logger.debug("Kernel IPC recv", { channel: msg.channel, msgType: msg.header.msg_type });
				}

				const parentId = (msg.parent_header as { msg_id?: string }).msg_id;
				if (parentId) {
					const handler = this.#messageHandlers.get(parentId);
					if (handler) handler(msg);
				}

				const channelHandlers = this.#channelHandlers.get(msg.channel);
				if (channelHandlers) {
					for (const handler of channelHandlers) {
						handler(msg);
					}
				}
			};
		});
	}

	isAlive(): boolean {
		return this.#alive && !this.#disposed && this.#ws?.readyState === WebSocket.OPEN;
	}

	async execute(code: string, options?: KernelExecuteOptions): Promise<KernelExecuteResult> {
		if (!this.isAlive()) {
			throw new Error("Python kernel is not running");
		}

		const msgId = nanoid();
		const msg: JupyterMessage = {
			channel: "shell",
			header: {
				msg_id: msgId,
				session: this.sessionId,
				username: this.username,
				date: new Date().toISOString(),
				msg_type: "execute_request",
				version: "5.5",
			},
			parent_header: {},
			metadata: {},
			content: {
				code,
				silent: options?.silent ?? false,
				store_history: options?.storeHistory ?? !(options?.silent ?? false),
				user_expressions: {},
				allow_stdin: options?.allowStdin ?? false,
				stop_on_error: true,
			},
		};

		let status: "ok" | "error" = "ok";
		let executionCount: number | undefined;
		let error: { name: string; value: string; traceback: string[] } | undefined;
		let replyReceived = false;
		let idleReceived = false;
		let stdinRequested = false;
		let cancelled = false;
		let timedOut = false;

		using executionSignal = new ScopeSignal({ signal: options?.signal, timeout: options?.timeoutMs });

		return new Promise((resolve) => {
			const cleanup = () => {
				this.#messageHandlers.delete(msgId);
				resolve({ status, executionCount, error, cancelled, timedOut, stdinRequested });
			};

			const checkDone = () => {
				if (replyReceived && idleReceived) {
					cleanup();
				}
			};

			executionSignal.catch(async () => {
				cancelled = true;
				timedOut = executionSignal.timedOut();
				await this.interrupt();
				cleanup();
			});

			this.#messageHandlers.set(msgId, async (response) => {
				switch (response.header.msg_type) {
					case "execute_reply": {
						replyReceived = true;
						const replyStatus = response.content.status;
						status = replyStatus === "error" ? "error" : "ok";
						if (typeof response.content.execution_count === "number") {
							executionCount = response.content.execution_count;
						}
						checkDone();
						break;
					}
					case "stream": {
						const text = String(response.content.text ?? "");
						if (text && options?.onChunk) {
							await options.onChunk(text);
						}
						break;
					}
					case "execute_result":
					case "display_data": {
						const { text, outputs } = this.renderDisplay(response.content);
						if (text && options?.onChunk) {
							await options.onChunk(text);
						}
						if (outputs.length > 0 && options?.onDisplay) {
							for (const output of outputs) {
								await options.onDisplay(output);
							}
						}
						break;
					}
					case "error": {
						const traceback = Array.isArray(response.content.traceback)
							? response.content.traceback.map((line: unknown) => String(line))
							: [];
						error = {
							name: String(response.content.ename ?? "Error"),
							value: String(response.content.evalue ?? ""),
							traceback,
						};
						const text = traceback.length > 0 ? `${traceback.join("\n")}\n` : `${error.name}: ${error.value}\n`;
						if (options?.onChunk) {
							await options.onChunk(text);
						}
						break;
					}
					case "status": {
						const state = response.content.execution_state;
						if (state === "idle") {
							idleReceived = true;
							checkDone();
						}
						break;
					}
					case "input_request": {
						stdinRequested = true;
						if (options?.onChunk) {
							await options.onChunk(
								"[stdin] Kernel requested input. Interactive stdin is not supported; provide input programmatically.\n",
							);
						}
						this.sendMessage({
							channel: "stdin",
							header: {
								msg_id: nanoid(),
								session: this.sessionId,
								username: this.username,
								date: new Date().toISOString(),
								msg_type: "input_reply",
								version: "5.5",
							},
							parent_header: response.header as unknown as Record<string, unknown>,
							metadata: {},
							content: { value: "" },
						});
						break;
					}
				}
			});

			this.sendMessage(msg);
		});
	}

	async introspectPrelude(): Promise<PreludeHelper[]> {
		let output = "";
		const result = await this.execute(PRELUDE_INTROSPECTION_SNIPPET, {
			silent: false,
			storeHistory: false,
			onChunk: (text) => {
				output += text;
			},
		});
		if (result.cancelled || result.status === "error") {
			throw new Error("Failed to introspect Python prelude");
		}
		const trimmed = output.trim();
		if (!trimmed) return [];
		try {
			return JSON.parse(trimmed) as PreludeHelper[];
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			throw new Error(`Failed to parse Python prelude docs: ${message}`);
		}
	}

	async interrupt(): Promise<void> {
		try {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 2000);
			await fetch(`${this.gatewayUrl}/api/kernels/${this.kernelId}/interrupt`, {
				method: "POST",
				headers: this.#authHeaders(),
				signal: controller.signal,
			});
			clearTimeout(timeout);
		} catch (err: unknown) {
			logger.warn("Failed to interrupt kernel via API", { error: err instanceof Error ? err.message : String(err) });
		}

		try {
			const msg: JupyterMessage = {
				channel: "control",
				header: {
					msg_id: nanoid(),
					session: this.sessionId,
					username: this.username,
					date: new Date().toISOString(),
					msg_type: "interrupt_request",
					version: "5.5",
				},
				parent_header: {},
				metadata: {},
				content: {},
			};
			this.sendMessage(msg);
		} catch (err: unknown) {
			logger.warn("Failed to send interrupt request", { error: err instanceof Error ? err.message : String(err) });
		}
	}

	async shutdown(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#alive = false;

		if (this.#heartbeatTimer) {
			clearInterval(this.#heartbeatTimer);
			this.#heartbeatTimer = undefined;
		}

		try {
			await fetch(`${this.gatewayUrl}/api/kernels/${this.kernelId}`, {
				method: "DELETE",
				headers: this.#authHeaders(),
			});
		} catch (err: unknown) {
			logger.warn("Failed to delete kernel via API", { error: err instanceof Error ? err.message : String(err) });
		}

		if (this.#ws) {
			this.#ws.close();
			this.#ws = null;
		}

		if (this.isSharedGateway) {
			await releaseSharedGateway();
		} else if (this.gatewayProcess) {
			try {
				killProcessTree(this.gatewayProcess.pid);
			} catch (err: unknown) {
				logger.warn("Failed to terminate gateway process", {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
	}

	async ping(timeoutMs: number = HEARTBEAT_TIMEOUT_MS): Promise<boolean> {
		if (!this.isAlive()) return false;
		try {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), timeoutMs);
			const response = await fetch(`${this.gatewayUrl}/api/kernels/${this.kernelId}`, {
				signal: controller.signal,
				headers: this.#authHeaders(),
			});
			clearTimeout(timeout);
			if (response.ok) {
				this.#heartbeatFailures = 0;
				return true;
			}
			throw new Error(`Kernel status check failed: ${response.status}`);
		} catch (err: unknown) {
			this.#heartbeatFailures += 1;
			if (this.#heartbeatFailures > HEARTBEAT_FAILURE_LIMIT) {
				this.#alive = false;
				logger.warn("Kernel heartbeat failed", { error: err instanceof Error ? err.message : String(err) });
			}
			return false;
		}
	}

	private startHeartbeat(): void {
		if (this.#heartbeatTimer) return;
		this.#heartbeatTimer = setInterval(() => {
			void this.ping();
		}, HEARTBEAT_INTERVAL_MS);
	}

	private renderDisplay(content: Record<string, unknown>): { text: string; outputs: KernelDisplayOutput[] } {
		const data = content.data as Record<string, unknown> | undefined;
		if (!data) return { text: "", outputs: [] };

		const outputs: KernelDisplayOutput[] = [];
		if (typeof data["image/png"] === "string") {
			outputs.push({ type: "image", data: data["image/png"] as string, mimeType: "image/png" });
		}
		if (data["application/json"] !== undefined) {
			outputs.push({ type: "json", data: data["application/json"] });
		}

		if (typeof data["text/plain"] === "string") {
			return { text: normalizeDisplayText(String(data["text/plain"])), outputs };
		}
		if (data["text/html"] !== undefined) {
			const markdown = htmlToBasicMarkdown(String(data["text/html"])) || "";
			return { text: markdown ? normalizeDisplayText(markdown) : "", outputs };
		}
		return { text: "", outputs };
	}

	private sendMessage(msg: JupyterMessage): void {
		if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) {
			throw new Error("WebSocket not connected");
		}

		if (TRACE_IPC) {
			logger.debug("Kernel IPC send", {
				channel: msg.channel,
				msgType: msg.header.msg_type,
				msgId: msg.header.msg_id,
			});
		}

		const payload = {
			channel: msg.channel,
			header: msg.header,
			parent_header: msg.parent_header,
			metadata: msg.metadata,
			content: msg.content,
		};
		if (msg.buffers && msg.buffers.length > 0) {
			this.#ws.send(serializeWebSocketMessage(msg));
			return;
		}
		this.#ws.send(JSON.stringify(payload));
	}
}
