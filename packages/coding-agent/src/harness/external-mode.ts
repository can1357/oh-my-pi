import { OhMyPiMcpServer, type OhMyPiMcpServerOptions, type McpTransport } from "../mcp/server";
import { DefaultLocalLLMPort } from "./llm-port";
import type {
	HarnessSessionInterface,
	ToolDescriptor,
	ToolInvocationRequest,
	ToolInvocationResult,
	WorkspacePolicy,
} from "./types";

export interface ExternalHarnessConfig {
	enabled: boolean;
	allowedTools?: string[];
	allowWrite?: boolean;
	allowExecution?: boolean;
	workspaceRoot?: string;
}

export interface ResolvedExternalHarnessConfig {
	readonly enabled: boolean;
	readonly allowedTools: readonly string[];
	readonly allowWrite: boolean;
	readonly allowExecution: boolean;
	readonly workspaceRoot: string;
}

export interface ExternalHarnessError {
	readonly code: string;
	readonly message: string;
}

export const EXTERNAL_HARNESS_DISABLED_ERROR: ExternalHarnessError = Object.freeze({
	code: "EXTERNAL_HARNESS_DISABLED",
	message: "External harness mode is disabled for this OhMyPi workspace.",
});

const WRITE_TOOLS = new Set([
	"write",
	"edit",
	"ast_edit",
	"patch",
	"notebook_edit",
	"save_file",
	"write_file",
	"edit_file",
	"insert_edit_into_file",
	"replace_string_in_file",
	"create_file",
]);

const EXECUTION_TOOLS = new Set([
	"bash",
	"exec",
	"terminal",
	"shell",
	"run_command",
	"execute_command",
	"run_in_terminal",
]);

export class ExternalHarnessController {
	#enabled: boolean;
	readonly #baseConfig: Omit<ResolvedExternalHarnessConfig, "enabled">;

	// ponytail: hardcoded write/exec sets cover std tools; upgrade to dynamic tool schema capabilities when plugin manifest adds permission hints.
	constructor(config?: Partial<ExternalHarnessConfig>) {
		this.#enabled = config?.enabled ?? false;
		this.#baseConfig = Object.freeze({
			allowedTools: Object.freeze(config?.allowedTools ? [...config.allowedTools] : []),
			allowWrite: config?.allowWrite ?? false,
			allowExecution: config?.allowExecution ?? false,
			workspaceRoot: config?.workspaceRoot ?? process.cwd(),
		});
	}

	get enabled(): boolean {
		return this.#enabled;
	}

	isEnabled(): boolean {
		return this.#enabled;
	}

	enable(): void {
		this.#enabled = true;
	}

	disable(): void {
		this.#enabled = false;
	}

	get config(): ResolvedExternalHarnessConfig {
		return {
			...this.#baseConfig,
			enabled: this.#enabled,
		};
	}

	canOperate(): boolean {
		return this.#enabled;
	}

	verifyCanOperate(): { allowed: boolean; error?: ExternalHarnessError } {
		if (!this.#enabled) {
			return {
				allowed: false,
				error: EXTERNAL_HARNESS_DISABLED_ERROR,
			};
		}
		return { allowed: true };
	}

	assertCanOperate(): void {
		if (!this.#enabled) {
			const err = new Error(EXTERNAL_HARNESS_DISABLED_ERROR.message);
			(err as any).code = EXTERNAL_HARNESS_DISABLED_ERROR.code;
			throw err;
		}
	}

	isToolAllowed(toolName: string): boolean {
		return this.checkToolPermission(toolName).allowed;
	}

	checkToolPermission(toolName: string): { allowed: boolean; error?: ExternalHarnessError } {
		if (!this.#enabled) {
			return {
				allowed: false,
				error: EXTERNAL_HARNESS_DISABLED_ERROR,
			};
		}

		if (WRITE_TOOLS.has(toolName) && !this.#baseConfig.allowWrite) {
			return {
				allowed: false,
				error: {
					code: "PERMISSION_DENIED",
					message: `Write operations are not permitted by external harness policy for tool "${toolName}".`,
				},
			};
		}

		if (EXECUTION_TOOLS.has(toolName) && !this.#baseConfig.allowExecution) {
			return {
				allowed: false,
				error: {
					code: "PERMISSION_DENIED",
					message: `Execution operations are not permitted by external harness policy for tool "${toolName}".`,
				},
			};
		}

		const isExplicitlyAllowed =
			this.#baseConfig.allowedTools.includes("*") || this.#baseConfig.allowedTools.includes(toolName);

		if (!isExplicitlyAllowed) {
			return {
				allowed: false,
				error: {
					code: "PERMISSION_DENIED",
					message: `Tool "${toolName}" is not permitted by external harness policy.`,
				},
			};
		}

		return { allowed: true };
	}

	authorizeExternalCall(toolName: string): { allowed: boolean; reason?: string } {
		const check = this.checkToolPermission(toolName);
		return {
			allowed: check.allowed,
			...(check.error ? { reason: check.error.message } : {}),
		};
	}

	authorizeInvocation(toolName: string): { allowed: boolean; error?: ExternalHarnessError } {
		return this.checkToolPermission(toolName);
	}

	assertCanInvoke(toolName: string): void {
		const result = this.checkToolPermission(toolName);
		if (!result.allowed && result.error) {
			const err = new Error(result.error.message);
			(err as any).code = result.error.code;
			throw err;
		}
	}
}

export class DefaultInProcessHarness implements HarnessSessionInterface {
	readonly sessionId: string;
	readonly workspacePolicy: WorkspacePolicy;
	readonly #tools: Map<string, ToolDescriptor> = new Map();
	readonly #handlers: Map<string, (req: ToolInvocationRequest) => Promise<ToolInvocationResult>> = new Map();

	constructor(cwd: string) {
		this.sessionId = `harness_${Date.now()}`;
		this.workspacePolicy = {
			cwd,
			readOnly: false,
			allowNetwork: true,
		};
	}

	registerTool(
		descriptor: ToolDescriptor,
		handler?: (req: ToolInvocationRequest) => Promise<ToolInvocationResult>,
	): void {
		this.#tools.set(descriptor.name, descriptor);
		if (handler) {
			this.#handlers.set(descriptor.name, handler);
		}
	}

	getTools(): readonly ToolDescriptor[] {
		return Array.from(this.#tools.values());
	}

	getTool(name: string): ToolDescriptor | undefined {
		return this.#tools.get(name);
	}

	hasTool(name: string): boolean {
		return this.#tools.has(name);
	}

	async invokeTool(request: ToolInvocationRequest): Promise<ToolInvocationResult> {
		const handler = this.#handlers.get(request.toolName);
		if (handler) {
			return handler(request);
		}
		if (!this.#tools.has(request.toolName)) {
			return {
				callId: request.callId,
				toolName: request.toolName,
				content: [{ type: "text", text: `Tool not found: "${request.toolName}"` }],
				isError: true,
			};
		}
		return {
			callId: request.callId,
			toolName: request.toolName,
			content: [{ type: "text", text: `Executed ${request.toolName}` }],
		};
	}
}

export interface ExternalHarnessHook {
	readonly controller: ExternalHarnessController;
	readonly server: OhMyPiMcpServer;
	handleMessage(message: unknown): Promise<unknown>;
	connectTransport(transport: McpTransport): void;
	invokeTool(request: ToolInvocationRequest): Promise<ToolInvocationResult>;
}

export interface ConnectedHarnessPairOptions {
	externalConfig?: ExternalHarnessConfig;
	externalMode?: ExternalHarnessConfig;
	harness?: HarnessSessionInterface;
	llmPort?: DefaultLocalLLMPort;
	externalController?: ExternalHarnessController;
	mcpServerOptions?: OhMyPiMcpServerOptions;
}

export interface ConnectedHarnessPair {
	readonly harness: HarnessSessionInterface;
	readonly mcpServer: OhMyPiMcpServer;
	readonly llmPort: DefaultLocalLLMPort;
	readonly externalController: ExternalHarnessController;
	readonly controller: ExternalHarnessController;
	readonly externalHook?: ExternalHarnessHook;
}

export function createConnectedHarnessPair(options?: ConnectedHarnessPairOptions): ConnectedHarnessPair {
	const controller =
		options?.externalController ??
		new ExternalHarnessController(options?.externalConfig ?? options?.externalMode);

	const harness = options?.harness ?? new DefaultInProcessHarness(controller.config.workspaceRoot);

	const llmPort = options?.llmPort ?? new DefaultLocalLLMPort();
	llmPort.connect(harness);

	const mcpServer = new OhMyPiMcpServer(harness, {
		...options?.mcpServerOptions,
		externalController: controller,
	});

	let externalHook: ExternalHarnessHook | undefined;
	if (controller.isEnabled()) {
		externalHook = {
			controller,
			server: mcpServer,
			handleMessage: (msg: unknown) => mcpServer.handleMessage(msg),
			connectTransport: (transport: McpTransport) => mcpServer.connectTransport(transport),
			invokeTool: async (req: ToolInvocationRequest) => {
				const auth = controller.authorizeInvocation(req.toolName);
				if (!auth.allowed) {
					return {
						callId: req.callId,
						toolName: req.toolName,
						content: [{ type: "text", text: JSON.stringify(auth.error) }],
						isError: true,
					};
				}
				return harness.invokeTool(req);
			},
		};
	}

	return {
		harness,
		mcpServer,
		llmPort,
		externalController: controller,
		controller,
		externalHook,
	};
}
