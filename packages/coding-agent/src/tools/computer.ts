import { type Type, type } from "@oh-my-pi/omptype";
import type { AgentToolResult, ToolApprovalDecision } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { classifyModel } from "@oh-my-pi/pi-catalog/identity";
import type { DesktopCapabilities } from "@oh-my-pi/pi-natives";
import { once } from "@oh-my-pi/pi-utils";
import { callSessionTool } from "../eval/js/tool-bridge";
import type { EvalPreludeContext, EvalPreludeDefinition } from "../eval/preludes";
import { enforceInlineByteCap } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { type ComputerCallStep, isReadOnlyComputerCall, renderComputerCall } from "./computer/call";
import type { ComputerScreenshot, ComputerSessionSnapshot } from "./computer/protocol";
import { type ComputerController, ComputerSupervisor, registerComputerController } from "./computer/supervisor";
import type { ToolSession } from "./index";
import { renderCallChain, renderFunctionRun } from "./run-code";
import { throwIfAborted } from "./tool-errors";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { clampTimeout } from "./tool-timeouts";

import {
	cfgComputerDisplay,
	cfgComputerEnabled,
	cfgComputerMaxHeight,
	cfgComputerMaxWidth,
	cfgToolsMaxTimeout,
} from "./settings";

// Image transports that cannot preserve native screenshot detail resize frames
// without returning transformed dimensions. Keep their native coordinate frames
// below the empirically verified threshold so pointer actions match what the
// model sees. Claude paths predate the resolved transport capability and retain
// their established model-family fallback.
const COORDINATE_SAFE_MAX_CAPTURE_WIDTH = 1280;
const COORDINATE_SAFE_MAX_CAPTURE_HEIGHT = 896;

function usesCoordinateSafeImageSizing(model: Model | undefined): boolean {
	if (!model) return false;
	const compat = model.compat;
	return (
		(!!compat && "supportsImageDetailOriginal" in compat && compat.supportsImageDetailOriginal === false) ||
		model.identity.class === "anthropic" ||
		(model.requestModelId !== undefined &&
			classifyModel(model.provider, model.requestModelId, { lenient: true }).class === "anthropic")
	);
}

interface ComputerRunParams {
	action: "run";
	code?: string;
	fn?: string;
	args?: unknown[];
	read_only?: boolean;
	timeout?: number;
}

interface ComputerCallParams {
	action: "call";
	chain: ComputerCallStep[];
	timeout?: number;
}

type ComputerParams = ComputerRunParams | ComputerCallParams | { action: "capabilities" } | { action: "close" };
type ComputerParamsSchema = Type<ComputerParams>;

const getComputerParamsSchema: () => ComputerParamsSchema = once(() =>
	type({
		action: "'run'",
		"code?": type("string").describe(
			"JavaScript executed in the persistent computer session; top-level await allowed; `desktop`, `wait`, `assert` in scope",
		),
		"fn?": type("string").describe("serialized function receiving the computer run scope and positional args"),
		"args?": type("unknown[]").describe("positional function arguments"),
		"read_only?": type("boolean").describe(
			"true = desktop inspection only: screenshots and ax reads allowed, desktop input/mutation blocked",
		),
		"timeout?": type("number").describe("run budget in seconds"),
		"+": "reject",
	})
		.or({
			action: "'call'",
			chain: type({ method: "string", args: "unknown[]" })
				.array()
				.describe("desktop helper invocation with at most one window/element handle hop"),
			"timeout?": type("number").describe("run budget in seconds"),
			"+": "reject",
		})
		.or({ action: "'capabilities'", "+": "reject" })
		.or({ action: "'close'", "+": "reject" }),
);

interface ComputerPreludeDetails {
	code?: string;
	readOnly?: boolean;
	screenshots: ComputerScreenshot[];
	value?: unknown;
	backend?: string;
	capturePermission?: string;
	inputPermission?: string;
	axPermission?: string;
}

/** Creates the session-scoped controller used by the computer prelude. */
export type ComputerControllerFactory = (session: ToolSession) => ComputerController;

/** Capability inspection, explicitly read-only runs, and inspection-only direct calls use read approval. */
export function computerApproval(args: unknown): ToolApprovalDecision {
	if (args === null || typeof args !== "object" || Array.isArray(args) || !("action" in args)) return "exec";
	if (args.action === "capabilities") return "read";
	if (args.action === "call") {
		// Malformed chains fall to exec here and fail schema validation at invoke time.
		try {
			return "chain" in args && Array.isArray(args.chain) && isReadOnlyComputerCall(args.chain) ? "read" : "exec";
		} catch {
			return "exec";
		}
	}
	return args.action === "run" && "read_only" in args && args.read_only === true ? "read" : "exec";
}

/** Create the enabled-only computer host prelude for one tool session. */
export function createComputerPrelude(
	session: ToolSession,
	createController: ComputerControllerFactory = currentSession =>
		new ComputerSupervisor(currentSession, undefined, undefined, callSessionTool),
): EvalPreludeDefinition {
	const controller = createController(session);
	const unregisterOwner = registerComputerController(session.getEvalKernelOwnerId?.() ?? undefined, controller);
	// Eval-first-use boundary: source/declaration assets stay unloaded until a
	// JavaScript or Python kernel actually asks for its enabled preludes.
	const { computerPreludeAssets } = require("./computer/prelude-definition");
	let closed = false;
	const lifetime: ComputerLifetime = {
		isClosed: () => closed,
		close: async () => {
			if (closed) return;
			closed = true;
			unregisterOwner();
			await controller.close();
		},
	};

	return {
		name: "computer",
		documentation: computerPreludeAssets.documentation,
		javascript: computerPreludeAssets.javascript,
		python: computerPreludeAssets.python,
		exports: ["computer"],
		codeModeDeclarations: computerPreludeAssets.codeModeDeclarations,
		approval: computerApproval,
		enabled: () => cfgComputerEnabled.get(session.settings) === true,
		invoke: async (parameters, context) => {
			const parsed = getComputerParamsSchema()(parameters);
			if (parsed instanceof type.errors) {
				throw new ToolError(`computer received invalid arguments: ${parsed.summary}`);
			}
			return await invokeComputer(session, controller, parsed, context, lifetime);
		},
		status: describeComputerCall,
	};
}

/** Status-tree line for a completed computer call: `desktop.window(3).focus()`, `run(fn)`, `close`. */
function describeComputerCall(parameters: unknown): string | undefined {
	const parsed = getComputerParamsSchema()(parameters);
	if (parsed instanceof type.errors) return undefined;
	switch (parsed.action) {
		case "call":
			return `desktop.${renderCallChain(parsed.chain)}`;
		case "run":
			return `run(${parsed.fn !== undefined ? "fn" : (parsed.code?.trim().split("\n", 1)[0] ?? "")})`;
		case "capabilities":
		case "close":
			return parsed.action;
	}
}

interface ComputerLifetime {
	isClosed(): boolean;
	close(): Promise<void>;
}

async function invokeComputer(
	session: ToolSession,
	controller: ComputerController,
	params: ComputerParams,
	context: EvalPreludeContext,
	lifetime: ComputerLifetime,
): Promise<AgentToolResult<unknown>> {
	throwIfAborted(context.signal);

	switch (params.action) {
		case "run":
		case "call":
			if (lifetime.isClosed()) throw new ToolError("Computer session is closed");
			return await runComputer(session, controller, params, context.signal);
		case "capabilities": {
			const capabilities = lifetime.isClosed()
				? undefined
				: await controller.capabilities(buildComputerSnapshot(session, true), context.signal);
			throwIfAborted(context.signal);
			return {
				content: [
					{
						type: "text",
						text: capabilities ? stringifyReturnValue(capabilities) : "Computer capabilities unavailable",
					},
				],
				details: capabilities,
			};
		}
		case "close":
			await lifetime.close();
			throwIfAborted(context.signal);
			return { content: [{ type: "text", text: "Closed computer session" }] };
	}
}

const COMPUTER_RUN_SCOPE: readonly string[] = ["desktop", "wait", "assert"];

function resolveComputerRunCode(params: ComputerRunParams | ComputerCallParams): string {
	if (params.action === "call") return renderComputerCall(params.chain);
	const code = params.code?.trim();
	const fn = params.fn?.trim();
	const hasCode = code !== undefined && code.length > 0;
	const hasFunction = fn !== undefined && fn.length > 0;
	if (hasCode === hasFunction) {
		throw new ToolError("Action 'run' requires exactly one of 'code' or 'fn'.");
	}
	if (hasFunction && fn !== undefined) {
		return renderFunctionRun(fn, COMPUTER_RUN_SCOPE, params.args ?? []);
	}
	if (hasCode && code !== undefined) return code;
	throw new ToolError("Action 'run' requires exactly one of 'code' or 'fn'.");
}

/** Freezes the current session settings into the snapshot every worker command carries. */
function buildComputerSnapshot(session: ToolSession, readOnly: boolean): ComputerSessionSnapshot {
	const coordinateSafe = usesCoordinateSafeImageSizing(session.getActiveModel?.());
	const configuredMaxWidth = cfgComputerMaxWidth.get(session.settings);
	const configuredMaxHeight = cfgComputerMaxHeight.get(session.settings);
	return {
		cwd: session.cwd,
		sessionId: session.getEvalSessionId?.() ?? session.getSessionId?.() ?? "computer",
		captureMaxWidth: coordinateSafe
			? Math.min(configuredMaxWidth, COORDINATE_SAFE_MAX_CAPTURE_WIDTH)
			: configuredMaxWidth,
		captureMaxHeight: coordinateSafe
			? Math.min(configuredMaxHeight, COORDINATE_SAFE_MAX_CAPTURE_HEIGHT)
			: configuredMaxHeight,
		display: cfgComputerDisplay.get(session.settings),
		readOnly,
	};
}

async function runComputer(
	session: ToolSession,
	controller: ComputerController,
	params: ComputerRunParams | ComputerCallParams,
	signal?: AbortSignal,
): Promise<AgentToolResult<unknown>> {
	const code = resolveComputerRunCode(params);
	// Direct inspection calls run read-only so the desktop guard backs the read approval tier.
	const readOnly = params.action === "call" ? isReadOnlyComputerCall(params.chain) : (params.read_only ?? false);
	const timeoutSeconds = clampTimeout("computer", params.timeout, cfgToolsMaxTimeout.get(session.settings));
	const snapshot = buildComputerSnapshot(session, readOnly);
	const run = await controller.run(code, timeoutSeconds * 1000, snapshot, signal);
	throwIfAborted(signal);

	const details: ComputerPreludeDetails = {
		code,
		readOnly: snapshot.readOnly,
		screenshots: run.screenshots,
	};
	if (run.returnValue !== undefined) details.value = run.returnValue;
	populateCapabilityDetails(details, run.capabilities);

	const text = run.displays
		.filter((content): content is { type: "text"; text: string } => content.type === "text")
		.map(content => content.text)
		.join("\n");
	const cappedText = await enforceInlineByteCap(text, {
		saveArtifact: full => saveComputerOutputArtifact(session, full),
	});
	const content: AgentToolResult<ComputerPreludeDetails>["content"] = [];
	if (cappedText) content.push({ type: "text", text: cappedText });
	for (const image of run.displays) {
		if (image.type === "image") content.push({ ...image, detail: "original" });
	}
	return { content, details };
}

function stringifyReturnValue(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}

function populateCapabilityDetails(
	details: ComputerPreludeDetails,
	capabilities: DesktopCapabilities | undefined,
): void {
	if (!capabilities) return;
	details.backend = capabilities.backend;
	details.capturePermission = capabilities.capturePermission;
	details.inputPermission = capabilities.inputPermission;
	details.axPermission = capabilities.axPermission;
}

/** Persist over-cap computer run output as a session artifact; mirrors the browser run save path. */
async function saveComputerOutputArtifact(session: ToolSession, fullText: string): Promise<string | undefined> {
	try {
		const alloc = await session.allocateOutputArtifact?.("computer-original");
		if (!alloc?.path || !alloc.id) return undefined;
		await Bun.write(alloc.path, fullText);
		return alloc.id;
	} catch {
		return undefined;
	}
}
