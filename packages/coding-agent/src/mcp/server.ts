import * as readline from "node:readline";
import type { ExternalHarnessConfig, ExternalHarnessController } from "../harness/external-mode";
import { ExternalHarnessController as ExternalHarnessControllerImpl } from "../harness/external-mode";
import type {
	HarnessSessionInterface,
	ToolDescriptor,
	ToolInvocationRequest,
} from "../harness/types";

export interface McpTransport {
	send: (msg: any) => void;
	onMessage: (cb: (msg: any) => void) => void;
}

export interface OhMyPiMcpServerOptions {
	serverInfo?: {
		name?: string;
		version?: string;
	};
	protocolVersion?: string;
	externalController?: ExternalHarnessController;
	externalMode?: ExternalHarnessConfig;
}

export class OhMyPiMcpServer {
	readonly #harness: HarnessSessionInterface;
	readonly #serverInfo: { name: string; version: string };
	readonly #protocolVersion: string;
	readonly #externalController?: ExternalHarnessController;

	constructor(harness: HarnessSessionInterface, options?: OhMyPiMcpServerOptions) {
		this.#harness = harness;
		this.#serverInfo = {
			name: options?.serverInfo?.name ?? "ohmypi-mcp-server",
			version: options?.serverInfo?.version ?? "0.1.0",
		};
		this.#protocolVersion = options?.protocolVersion ?? "2024-11-05";
		if (options?.externalController) {
			this.#externalController = options.externalController;
		} else if (options?.externalMode) {
			this.#externalController = new ExternalHarnessControllerImpl(options.externalMode);
		}
	}

	get harness(): HarnessSessionInterface {
		return this.#harness;
	}

	get externalController(): ExternalHarnessController | undefined {
		return this.#externalController;
	}

	connectTransport(transport: {
		send: (msg: any) => void;
		onMessage: (cb: (msg: any) => void) => void;
	}): void {
		transport.onMessage(async (msg: any) => {
			try {
				const response = await this.handleMessage(msg);
				if (response !== null && response !== undefined) {
					transport.send(response);
				}
			} catch (err) {
				transport.send({
					jsonrpc: "2.0",
					id: null,
					error: {
						code: -32603,
						message: err instanceof Error ? err.message : "Internal error",
					},
				});
			}
		});
	}

	async handleMessage(message: unknown): Promise<unknown> {
		let parsed: unknown;
		if (typeof message === "string") {
			try {
				parsed = JSON.parse(message);
			} catch {
				return {
					jsonrpc: "2.0",
					id: null,
					error: {
						code: -32700,
						message: "Parse error",
					},
				};
			}
		} else if (message !== null && typeof message === "object") {
			parsed = message;
		} else {
			return {
				jsonrpc: "2.0",
				id: null,
				error: {
					code: -32600,
					message: "Invalid Request",
				},
			};
		}

		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return {
				jsonrpc: "2.0",
				id: null,
				error: {
					code: -32600,
					message: "Invalid Request",
				},
			};
		}

		const req = parsed as Record<string, unknown>;
		const hasId = "id" in req && req.id !== undefined;
		const id = hasId ? req.id : null;

		if (req.jsonrpc !== "2.0") {
			if (!hasId) return null;
			return {
				jsonrpc: "2.0",
				id,
				error: {
					code: -32600,
					message: "Invalid Request: jsonrpc must be '2.0'",
				},
			};
		}

		if (typeof req.method !== "string") {
			if (!hasId) return null;
			return {
				jsonrpc: "2.0",
				id,
				error: {
					code: -32600,
					message: "Invalid Request: method must be a string",
				},
			};
		}

		if (!hasId) {
			return null;
		}

		switch (req.method) {
			case "initialize": {
				return {
					jsonrpc: "2.0",
					id,
					result: {
						protocolVersion: this.#protocolVersion,
						capabilities: {
							tools: {},
						},
						serverInfo: this.#serverInfo,
					},
				};
			}

			case "tools/list": {
				if (this.#externalController && !this.#externalController.isEnabled()) {
					return {
						jsonrpc: "2.0",
						id,
						error: {
							code: "EXTERNAL_HARNESS_DISABLED",
							message: "External harness mode is disabled for this OhMyPi workspace.",
						},
					};
				}

				const descriptors = this.#harness.getTools();
				const allowedDescriptors = this.#externalController
					? descriptors.filter(tool => this.#externalController!.isToolAllowed(tool.name))
					: descriptors;
				const tools = allowedDescriptors.map((tool: ToolDescriptor) => {
					const rawParams = tool.parameters;
					const paramsObj =
						rawParams && typeof rawParams === "object" && !Array.isArray(rawParams)
							? (rawParams as Record<string, unknown>)
							: {};
					return {
						name: tool.name,
						description: tool.description ?? "",
						inputSchema: {
							...paramsObj,
							type: "object" as const,
							properties:
								paramsObj.properties &&
								typeof paramsObj.properties === "object" &&
								!Array.isArray(paramsObj.properties)
									? (paramsObj.properties as Record<string, unknown>)
									: {},
						},
					};
				});

				return {
					jsonrpc: "2.0",
					id,
					result: {
						tools,
					},
				};
			}

			case "tools/call": {
				const params = req.params as Record<string, unknown> | undefined;
				if (!params || typeof params.name !== "string") {
					return {
						jsonrpc: "2.0",
						id,
						error: {
							code: -32602,
							message: "Invalid params: 'name' is required",
						},
					};
				}

				const toolName = params.name;
				const toolArgs =
					params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
						? (params.arguments as Record<string, unknown>)
						: {};

				if (this.#externalController) {
					const auth = this.#externalController.authorizeInvocation(toolName);
					if (!auth.allowed) {
						return {
							jsonrpc: "2.0",
							id,
							error: auth.error ?? {
								code: "PERMISSION_DENIED",
								message: `Tool "${toolName}" is not permitted by external harness policy.`,
							},
						};
					}
				}

				if (typeof this.#harness.hasTool === "function" && !this.#harness.hasTool(toolName)) {
					return {
						jsonrpc: "2.0",
						id,
						result: {
							content: [
								{
									type: "text",
									text: JSON.stringify({
										error: "TOOL_UNAVAILABLE",
										message: `Tool "${toolName}" not found or unavailable`,
									}),
								},
							],
							isError: true,
						},
					};
				}

				try {
					const invocationReq: ToolInvocationRequest = {
						callId: `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
						toolName,
						arguments: toolArgs,
					};
					const invokeResult = await this.#harness.invokeTool(invocationReq);

					const isError = Boolean(
						invokeResult &&
							typeof invokeResult === "object" &&
							(invokeResult as { isError?: boolean }).isError,
					);

					let content: unknown[];
					if (
						invokeResult &&
						typeof invokeResult === "object" &&
						Array.isArray((invokeResult as { content?: unknown[] }).content)
					) {
						content = (invokeResult as { content: unknown[] }).content;
					} else {
						content = [
							{
								type: "text",
								text:
									typeof invokeResult === "string"
										? invokeResult
										: JSON.stringify(invokeResult ?? null),
							},
						];
					}

					return {
						jsonrpc: "2.0",
						id,
						result: {
							content,
							...(isError ? { isError: true } : {}),
						},
					};
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					return {
						jsonrpc: "2.0",
						id,
						result: {
							content: [
								{
									type: "text",
									text: JSON.stringify({ error: "EXECUTION_ERROR", message }),
								},
							],
							isError: true,
						},
					};
				}
			}

			case "ping": {
				return {
					jsonrpc: "2.0",
					id,
					result: {},
				};
			}

			default: {
				return {
					jsonrpc: "2.0",
					id,
					error: {
						code: -32601,
						message: `Method not found: ${req.method}`,
					},
				};
			}
		}
	}

	startStdioServer(): void {
		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
			terminal: false,
		});

		rl.on("line", async (line: string) => {
			const trimmed = line.trim();
			if (trimmed.length === 0) return;
			try {
				const response = await this.handleMessage(trimmed);
				if (response !== null && response !== undefined) {
					process.stdout.write(`${JSON.stringify(response)}\n`);
				}
			} catch (err) {
				const errorResponse = {
					jsonrpc: "2.0",
					id: null,
					error: {
						code: -32603,
						message: err instanceof Error ? err.message : "Internal error",
					},
				};
				process.stdout.write(`${JSON.stringify(errorResponse)}\n`);
			}
		});
	}
}
