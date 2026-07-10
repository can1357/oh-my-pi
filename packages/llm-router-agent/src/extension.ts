import { LLMRouter } from "./agent.js";
import {
	extractInputText,
	formatDecision,
	getZod,
	makeRequestSchema,
	makeValidationSchema,
	normalizeCommandArgs,
	type OmpLikeExtensionApi,
	requestFromToolParams,
	tryApplyModel,
} from "./omp-compat.js";
import {
	createTaskSpawnPolicy,
	isTaskSpawnEnabled,
	type RouterSpawnPolicyInput,
	type RouterSpawnPolicyResult,
	type RouterSpawnRouteCandidate,
} from "./task-spawn-policy.js";
import { summarizeTelemetry } from "./telemetry.js";
import {
	exportToolRoutingExamplesFromTelemetry,
	formatToolUseRecord,
	normalizeToolCaptureConfig,
	summarizeToolUseTelemetry,
} from "./tool-capture.js";
import type { RequestInput, RouteDecision, ToolUseCaptureInput, ToolUseCaptureRecord, ToolUsePhase } from "./types.js";

let lastDecision: RouteDecision | undefined;
let lastToolUse: ToolUseCaptureRecord | undefined;

export default async function llmRouterExtension(pi: OmpLikeExtensionApi): Promise<void> {
	let routerPromise: Promise<LLMRouter> | undefined;
	pi.setLabel?.("LLM Router");
	const z = getZod(pi);

	const getRouter = () => {
		routerPromise ??= LLMRouter.load().catch(error => {
			routerPromise = undefined;
			throw error;
		});
		return routerPromise;
	};

	if (pi.registerTool) {
		pi.registerTool({
			name: "router_decide",
			label: "LLM Router Decide",
			description:
				"Choose the best configured model route for a user request and return feature/scores/validation plan.",
			parameters: makeRequestSchema(z),
			async execute(_toolCallId: string, params: unknown) {
				const router = await getRouter();
				const request = requestFromToolParams(params);
				const decision = await router.decideAndLog(request, { surface: "tool" });
				lastDecision = decision;
				return {
					content: [{ type: "text", text: formatDecision(decision) }],
					details: decision,
				};
			},
		});

		pi.registerTool({
			name: "router_validate_output",
			label: "LLM Router Validate Output",
			description:
				"Validate output using the router's validation plan. If no prior route exists, creates one from message.",
			parameters: makeValidationSchema(z),
			async execute(_toolCallId: string, params: unknown) {
				const record = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
				const output = String(record.output ?? "");
				const router = await getRouter();
				const decision =
					lastDecision ??
					router.decide({
						message: String(record.message ?? "Validate this output"),
						expectedOutput: { format: record.requireJson ? "json" : "text" },
					});
				const result = router.validate(decision.requestId, output, decision);
				return {
					content: [
						{
							type: "text",
							text: result.passed
								? "Validation passed."
								: `Validation failed: ${result.issues.map(i => i.message).join("; ")}`,
						},
					],
					details: result,
				};
			},
		});

		pi.registerTool({
			name: "router_capture_tool_use",
			label: "LLM Router Capture Tool Use",
			description:
				"Record a tool call/result/error as compact telemetry for tool-routing training and context-saving summaries.",
			parameters: makeToolCaptureSchema(z),
			async execute(_toolCallId: string, params: unknown) {
				const router = await getRouter();
				const input = toolCaptureInputFromParams(params, lastDecision);
				const captured = await router.captureTool(input, { surface: "tool", source: "router_capture_tool_use" });
				if (captured) lastToolUse = captured;
				return {
					content: [
						{
							type: "text",
							text: captured
								? formatToolUseRecord(captured)
								: "Tool-use capture is disabled or this tool is ignored by config.",
						},
					],
					details: captured,
				};
			},
		});

		pi.registerTool({
			name: "router_export_tool_training",
			label: "LLM Router Export Tool Training",
			description: "Export captured tool-use telemetry into compact JSONL examples for tool-routing cross-training.",
			parameters: makeToolExportSchema(z),
			async execute(_toolCallId: string, params: unknown) {
				const router = await getRouter();
				const record = isRecord(params) ? params : {};
				const captureConfig = normalizeToolCaptureConfig(router.config);
				const inputPath = typeof record.inputPath === "string" ? record.inputPath : captureConfig.path;
				const outputPath =
					typeof record.outputPath === "string" ? record.outputPath : ".llm-router/tool-routing-training.jsonl";
				const exported = await exportToolRoutingExamplesFromTelemetry(inputPath, {
					outputPath,
					includeFailures: record.includeFailures === true,
					minSavedContextTokens:
						typeof record.minSavedContextTokens === "number" ? record.minSavedContextTokens : 0,
				});
				return {
					content: [
						{
							type: "text",
							text: `Exported ${exported.exported}/${exported.read} tool-routing examples to ${outputPath}.`,
						},
					],
					details: { read: exported.read, exported: exported.exported, outputPath },
				};
			},
		});
	}

	if (pi.registerCommand) {
		pi.registerCommand("router", {
			description:
				"Inspect and tune LLM router decisions. Usage: /router status | decide <prompt> | last | telemetry | tools | export-tools [path] | reload",
			async handler(args: unknown, ctx: any) {
				const argv = normalizeCommandArgs(args);
				const subcommand = argv[0] ?? "status";
				const router = subcommand === "reload" ? await reloadRouter() : await getRouter();
				if (subcommand === "status") {
					const current = ctx?.models?.current?.();
					const currentText = current
						? `current=${current.provider ?? current.providerId ?? "?"}/${current.modelId ?? current.id ?? current.name ?? "?"}`
						: "current=unknown";
					notify(ctx, `LLM Router loaded. ${currentText}. config=${router.configPath ?? "defaults"}`);
					return;
				}
				if (subcommand === "last") {
					notify(ctx, lastDecision ? formatDecision(lastDecision) : "No route decision has been recorded yet.");
					return;
				}
				if (subcommand === "reload") {
					notify(ctx, `LLM Router config reloaded from ${router.configPath ?? "defaults"}.`);
					return;
				}
				if (subcommand === "telemetry") {
					const path = router.config.telemetry?.path ?? ".llm-router/telemetry.jsonl";
					try {
						const summary = await summarizeTelemetry(path);
						notify(
							ctx,
							`telemetry total=${summary.total} failures=${summary.failures} byModel=${JSON.stringify(summary.byModel)}`,
						);
					} catch (error) {
						notify(
							ctx,
							`Telemetry unavailable: ${error instanceof Error ? error.message : String(error)}`,
							"warn",
						);
					}
					return;
				}

				if (subcommand === "tools" || subcommand === "tool-telemetry") {
					const captureConfig = normalizeToolCaptureConfig(router.config);
					try {
						const summary = await summarizeToolUseTelemetry(captureConfig.path);
						notify(
							ctx,
							`toolTelemetry total=${summary.total} failures=${summary.failures} saved≈${summary.savedContextTokensEstimate}t byTool=${JSON.stringify(summary.byTool)}`,
						);
					} catch (error) {
						notify(
							ctx,
							`Tool telemetry unavailable: ${error instanceof Error ? error.message : String(error)}`,
							"warn",
						);
					}
					return;
				}
				if (subcommand === "tool-last") {
					notify(
						ctx,
						lastToolUse ? formatToolUseRecord(lastToolUse) : "No captured tool use has been recorded yet.",
					);
					return;
				}
				if (subcommand === "export-tools") {
					const captureConfig = normalizeToolCaptureConfig(router.config);
					const outputPath = argv[1] ?? ".llm-router/tool-routing-training.jsonl";
					try {
						const exported = await exportToolRoutingExamplesFromTelemetry(captureConfig.path, {
							outputPath,
							includeFailures: argv.includes("--include-failures"),
						});
						notify(ctx, `Exported ${exported.exported}/${exported.read} tool-routing examples to ${outputPath}.`);
					} catch (error) {
						notify(
							ctx,
							`Tool training export failed: ${error instanceof Error ? error.message : String(error)}`,
							"error",
						);
					}
					return;
				}
				if (subcommand === "decide" || subcommand === "route") {
					const message = argv.slice(1).join(" ").trim();
					if (!message) {
						notify(ctx, "Usage: /router decide <prompt>", "warn");
						return;
					}
					const decision = await router.decideAndLog({ message }, { surface: "command" });
					lastDecision = decision;
					if (router.config.extension?.mode === "try-set-model") {
						const applied = await tryApplyModel(pi, ctx, decision);
						notify(
							ctx,
							`${formatDecision(decision)}\napplied=${applied.applied}${applied.reason ? ` reason=${applied.reason}` : ""}`,
						);
					} else {
						notify(ctx, formatDecision(decision));
					}
					return;
				}
				notify(
					ctx,
					"Usage: /router status | decide <prompt> | last | telemetry | tools | tool-last | export-tools [path] | reload",
					"warn",
				);
			},
		});
	}

	// Spawn-only Qwen policy: register only when taskSpawn.enabled is true.
	// Missing/default/false means zero handler, zero fetch, no assignment telemetry.
	await registerTaskSpawnPolicyHandler(pi, getRouter);

	if (pi.on) {
		pi.on("input", async (event: unknown, ctx: any) => {
			const router = await getRouter();
			if (router.config.extension?.routeOnInput === false) return;
			const message = extractInputText(event);
			if (!message.trim()) return;
			const request: RequestInput = {
				message,
				user: { preference: undefined },
				runtime: runtimeFromContext(ctx),
			};
			const decision = await router.decideAndLog(request, { surface: "input-hook" });
			lastDecision = decision;
			if (router.config.extension?.mode === "try-set-model") {
				await tryApplyModel(pi, ctx, decision);
			}
			if (router.config.extension?.notifyOnInput) {
				notify(ctx, formatDecision(decision));
			}
		});

		for (const eventName of ["tool_use", "tool_call", "tool_start", "tool_result", "tool_end", "tool_error"]) {
			pi.on(eventName, async (event: unknown, ctx: any) => {
				const router = await getRouter();
				const input = toolCaptureInputFromRuntimeEvent(eventName, event, ctx, lastDecision);
				if (!input) return;
				const captured = await router.captureTool(input, { surface: "runtime-hook", eventName });
				if (captured) lastToolUse = captured;
			});
		}

		pi.on("turn_end", async (_event: unknown) => {
			// Hook reserved for outcome telemetry. Runtime payloads differ across forks, so this is intentionally no-op until wired.
		});
	}

	async function reloadRouter(): Promise<LLMRouter> {
		routerPromise = LLMRouter.load();
		return routerPromise;
	}
}

async function registerTaskSpawnPolicyHandler(
	pi: OmpLikeExtensionApi,
	getRouter: () => Promise<LLMRouter>,
): Promise<void> {
	if (!pi.on) return;
	let router: LLMRouter;
	try {
		router = await getRouter();
	} catch (error) {
		pi.logger?.warn?.("LLM Router task-spawn policy registration skipped", error);
		return;
	}
	if (!isTaskSpawnEnabled(router.config)) return;

	const policy = createTaskSpawnPolicy(router.config);
	pi.on("task_spawn_policy", async (event: unknown) => {
		const input = toRouterSpawnPolicyInput(event);
		const signal = extractAbortSignal(event);
		const result = await policy(input, signal);
		return toCoreSpawnPolicyResult(result);
	});
}

function toRouterSpawnPolicyInput(event: unknown): RouterSpawnPolicyInput {
	const record = isRecord(event) ? event : {};
	const eligibleRaw = Array.isArray(record.eligible) ? record.eligible : [];
	const eligible: RouterSpawnRouteCandidate[] = eligibleRaw.map(candidate => {
		const item = isRecord(candidate) ? candidate : {};
		return {
			selector: stringFrom(item.selector) ?? "",
			tier: toRouterTier(item.tier),
			provider: stringFrom(item.provider),
			modelId: stringFrom(item.modelId),
			maxRequests: numberFrom(item.maxRequests) ?? 0,
			maxRuntimeMs: numberFrom(item.maxRuntimeMs) ?? 0,
		};
	});

	return {
		correlationId: stringFrom(record.correlationId) ?? "",
		agentName: stringFrom(record.agentName) ?? "",
		assignment: stringFrom(record.assignment) ?? "",
		workClass: record.workClass === "judgment" ? "judgment" : "mechanical",
		autonomy:
			record.autonomy === "bound" || record.autonomy === "supervised" || record.autonomy === "independent"
				? record.autonomy
				: "independent",
		eligible,
		requestedModel: stringFrom(record.requestedModel),
		fusionSidekick: record.fusionSidekick === true,
		manualModelSelection: record.manualModelSelection === true,
	};
}

function toCoreSpawnPolicyResult(result: RouterSpawnPolicyResult): Record<string, unknown> {
	return {
		allow: result.allow === true,
		reasonCode: result.reasonCode,
		candidateSelectors: result.candidateSelectors,
		maxRequests: result.maxRequests,
		maxRuntimeMs: result.maxRuntimeMs,
		routeLabel: result.routeLabel,
	};
}

function toRouterTier(value: unknown): RouterSpawnRouteCandidate["tier"] {
	if (value === "light" || value === "mid" || value === "frontier") return value;
	return "mid";
}

function extractAbortSignal(event: unknown): AbortSignal | undefined {
	if (!isRecord(event)) return undefined;
	const signal = event.signal;
	return signal instanceof AbortSignal ? signal : undefined;
}

function numberFrom(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function makeToolCaptureSchema(z: any): any {
	if (!z?.object) return {};
	const phase = z.enum ? z.enum(["requested", "started", "completed", "failed", "skipped"]) : z.string();
	return z.object({
		toolName: z.string(),
		namespace: z.string().optional(),
		phase: phase.optional?.() ?? phase,
		requestId: z.string().optional(),
		conversationId: z.string().optional(),
		turnId: z.string().optional(),
		toolCallId: z.string().optional(),
		args: z.any?.().optional?.() ?? z.any?.(),
		result: z.any?.().optional?.() ?? z.any?.(),
		error: z.any?.().optional?.() ?? z.any?.(),
		argsJson: z.string().optional(),
		resultJson: z.string().optional(),
		errorJson: z.string().optional(),
		promptPreview: z.string().optional(),
		latencyMs: z.number?.().optional?.() ?? z.any?.().optional?.(),
		metadata: z.record?.(z.string(), z.any()).optional?.() ?? z.any?.().optional?.(),
	});
}

function makeToolExportSchema(z: any): any {
	if (!z?.object) return {};
	return z.object({
		inputPath: z.string().optional(),
		outputPath: z.string().optional(),
		includeFailures: z.boolean?.().optional?.() ?? z.any?.().optional?.(),
		minSavedContextTokens: z.number?.().optional?.() ?? z.any?.().optional?.(),
	});
}

function toolCaptureInputFromParams(params: unknown, decision?: RouteDecision): ToolUseCaptureInput {
	const record = isRecord(params) ? params : {};
	return {
		toolName: String(record.toolName ?? record.name ?? "unknown_tool"),
		namespace: typeof record.namespace === "string" ? record.namespace : undefined,
		phase: toToolUsePhase(record.phase),
		requestId: typeof record.requestId === "string" ? record.requestId : decision?.requestId,
		conversationId: typeof record.conversationId === "string" ? record.conversationId : undefined,
		turnId: typeof record.turnId === "string" ? record.turnId : undefined,
		toolCallId: typeof record.toolCallId === "string" ? record.toolCallId : undefined,
		args: parseJsonField(record.argsJson, record.args),
		result: parseJsonField(record.resultJson, record.result),
		error: parseJsonField(record.errorJson, record.error),
		promptPreview: typeof record.promptPreview === "string" ? record.promptPreview : undefined,
		latencyMs: typeof record.latencyMs === "number" ? record.latencyMs : undefined,
		route: decision ? pickRoute(decision) : undefined,
		metadata: isRecord(record.metadata) ? record.metadata : {},
	};
}

function toolCaptureInputFromRuntimeEvent(
	eventName: string,
	event: unknown,
	ctx: any,
	decision?: RouteDecision,
): ToolUseCaptureInput | undefined {
	const record = isRecord(event) ? event : {};
	const toolName = getToolName(record);
	if (!toolName) return undefined;
	const phase = toToolUsePhase(record.phase ?? record.status) ?? phaseFromEventName(eventName);
	return {
		toolName,
		namespace: typeof record.namespace === "string" ? record.namespace : undefined,
		phase,
		requestId: stringFrom(record.requestId ?? record.request_id ?? ctx?.requestId ?? decision?.requestId),
		conversationId: stringFrom(record.conversationId ?? record.conversation_id ?? ctx?.conversationId),
		turnId: stringFrom(record.turnId ?? record.turn_id ?? ctx?.turnId),
		messageId: stringFrom(record.messageId ?? record.message_id),
		toolCallId: stringFrom(record.toolCallId ?? record.tool_call_id ?? record.id),
		args: record.args ?? record.arguments ?? record.input ?? record.parameters,
		result: record.result ?? record.output ?? record.response,
		error: record.error ?? record.exception,
		availableTools: availableToolsFromContext(ctx),
		promptPreview: stringFrom(record.promptPreview ?? record.prompt ?? record.message),
		latencyMs:
			typeof record.latencyMs === "number"
				? record.latencyMs
				: typeof record.durationMs === "number"
					? record.durationMs
					: undefined,
		route: decision ? pickRoute(decision) : undefined,
		metadata: { runtimeEventName: eventName },
	};
}

function getToolName(record: Record<string, unknown>): string | undefined {
	const direct = record.toolName ?? record.tool_name ?? record.name;
	if (typeof direct === "string") return direct;
	const tool = record.tool;
	if (typeof tool === "string") return tool;
	if (isRecord(tool) && typeof tool.name === "string") return tool.name;
	if (isRecord(tool) && typeof tool.id === "string") return tool.id;
	return undefined;
}

function phaseFromEventName(eventName: string): ToolUsePhase {
	if (eventName.includes("error")) return "failed";
	if (eventName.includes("result") || eventName.includes("end")) return "completed";
	if (eventName.includes("start")) return "started";
	if (eventName.includes("call")) return "requested";
	return "completed";
}

function toToolUsePhase(value: unknown): ToolUsePhase | undefined {
	if (
		value === "requested" ||
		value === "started" ||
		value === "completed" ||
		value === "failed" ||
		value === "skipped"
	)
		return value;
	if (value === "success" || value === "succeeded" || value === "complete") return "completed";
	if (value === "error" || value === "failure" || value === "failed") return "failed";
	return undefined;
}

function parseJsonField(json: unknown, fallback: unknown): unknown {
	if (typeof json !== "string") return fallback;
	try {
		return JSON.parse(json);
	} catch {
		return json;
	}
}

function availableToolsFromContext(ctx: any): string[] | undefined {
	const tools = ctx?.tools?.list?.() ?? ctx?.tools;
	if (!Array.isArray(tools)) return undefined;
	return tools
		.map((tool: any) => (typeof tool === "string" ? tool : (tool?.name ?? tool?.id)))
		.filter((value: unknown): value is string => typeof value === "string");
}

function pickRoute(decision: RouteDecision): ToolUseCaptureInput["route"] {
	return {
		selectedModel: decision.selectedModel,
		selector: decision.selector,
		confidence: decision.confidence,
		taskType: decision.taskType,
		reasons: decision.reasons,
		fallbackChain: decision.fallbackChain,
	};
}

function stringFrom(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, any> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function runtimeFromContext(ctx: any): RequestInput["runtime"] {
	const usage = typeof ctx?.getContextUsage === "function" ? safeCall(() => ctx.getContextUsage()) : undefined;
	const runtime: RequestInput["runtime"] = {};
	if (usage && typeof usage === "object" && "remainingTokens" in usage && typeof usage.remainingTokens === "number") {
		runtime.latencyBudgetMs = usage.remainingTokens < 20_000 ? 6_000 : undefined;
	}
	return runtime;
}

function notify(ctx: any, message: string, level: "info" | "warn" | "error" = "info"): void {
	if (ctx?.ui?.notify) {
		ctx.ui.notify(message, level);
		return;
	}
	// Headless mode: best effort via console.
	if (level === "error") console.error(message);
	else console.log(message);
}

function safeCall<T>(fn: () => T): T | undefined {
	try {
		return fn();
	} catch {
		return undefined;
	}
}
