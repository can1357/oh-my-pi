import type { ImageContent } from "@pk-nerdsaver-ai/pi-ai";

/** What surface to capture when the overlay is invoked. */
export type CaptureMode = "screen" | "window" | "region" | "browser";

/** Whether a wire value names a supported capture mode. */
export function isCaptureMode(value: unknown): value is CaptureMode {
	switch (value) {
		case "screen":
		case "window":
		case "region":
		case "browser":
			return true;
		default:
			return false;
	}
}

/** A rectangular desktop capture area in physical pixels. */
export interface CaptureRegion {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Normalized annotation on a captured screenshot. */
export interface Annotation {
	id: string;
	type: "rectangle" | "point" | "arrow" | "blur";
	bounds: [number, number, number, number];
	label?: string;
}

/** Visual context captured from the desktop. */
export interface VisualContext {
	screenshotPath?: string;
	screenshotImage?: ImageContent;
	selectedRegion?: CaptureRegion;
	displayScale: number;
	annotations: Annotation[];
}

/** Foreground application metadata. */
export interface ForegroundAppContext {
	processName?: string;
	windowTitle?: string;
	executablePath?: string;
}

/** Browser context, when IX Bridge or a Chrome/Edge extension is available. */
export interface BrowserContext {
	url?: string;
	title?: string;
	tabId?: string;
	domSnapshotRef?: string;
	accessibilityTreeRef?: string;
}

/** Selection / clipboard text, if available. */
export interface SelectionContext {
	text?: string;
	clipboardText?: string;
}

/** The full context payload sent from the overlay to the agent runtime. */
export interface ContextPacket {
	captureId: string;
	timestamp: string;

	userRequest: string;
	captureMode: CaptureMode;

	visual: VisualContext;
	foregroundApp: ForegroundAppContext;
	browser: BrowserContext;
	selection: SelectionContext;

	availableCapabilities: string[];
}

/** Risk / approval level for an action. */
export type ActionLevel = 0 | 1 | 2 | 3;

/** A declared executor capability. */
export interface Capability {
	name: string;
	description?: string;
	sideEffect?: boolean;
	reversible?: boolean;
	approval?: "none" | "per-action" | "group" | "session";
	allowedFields?: string[];
}

/** A known executor that can run actions for the router. */
export interface Executor {
	id: string;
	name: string;
	location: "local" | "remote" | "cloud";
	capabilities: Capability[];
	applications?: string[];
	riskLevel: "low" | "medium" | "high";
	available: boolean;
}

/** A planned execution step produced by the router. */
export interface PlanStep {
	id: string;
	executorId: string;
	capability: string;
	arguments: Record<string, unknown>;
	level: ActionLevel;
	description: string;
	requiresApproval: boolean;
}

/** A task being delegated from the overlay. */
export interface Task {
	taskId: string;
	contextPacket: ContextPacket;
	plan: PlanStep[];
	createdAt: string;
	status: "pending" | "running" | "blocked" | "completed" | "failed";
}

/** An approval request surfaced to the user. */
export interface ApprovalRequest {
	actionId: string;
	stepId: string;
	level: ActionLevel;
	toolName: string;
	arguments: Record<string, unknown>;
	effects: string;
	scope?: "once" | "group" | "session" | "application";
}

/** Unified event protocol consumed by the overlay. */
export type AgentEvent =
	| { type: "task.started"; taskId: string }
	| { type: "agent.message.delta"; text: string }
	| { type: "plan.updated"; steps: PlanStep[] }
	| { type: "tool.requested"; callId: string; toolName: string; arguments: Record<string, unknown> }
	| { type: "approval.requested"; request: ApprovalRequest }
	| { type: "tool.started"; callId: string; toolName: string }
	| { type: "tool.completed"; callId: string; result: unknown; isError: boolean }
	| { type: "observation.updated"; screenshotRef?: string; contextPacket?: ContextPacket }
	| { type: "task.blocked"; taskId: string; reason: string }
	| { type: "task.completed"; taskId: string; summary: string }
	| { type: "task.failed"; taskId: string; error: string };

/** Generic agent worker abstraction. */
export interface AgentWorker {
	createSession(taskId: string, input: TaskInput): Promise<SessionHandle>;
	sendMessage(sessionId: string, message: string, images?: ImageContent[]): Promise<void>;
	approve(sessionId: string, actionId: string, decision: ApprovalDecision): Promise<void>;
	cancel(sessionId: string): Promise<void>;
	subscribe(sessionId: string): AsyncIterable<AgentEvent>;
}

/** A concrete task input passed to the worker. */
export interface TaskInput {
	contextPacket: ContextPacket;
	routing: RoutingDecision;
	preferredExecutor?: string;
}

/** A worker session handle. */
export interface SessionHandle {
	sessionId: string;
}

/** An approval decision from the user. */
export interface ApprovalDecision {
	allowed: boolean;
	scope?: "once" | "group" | "session" | "application";
	editedArguments?: Record<string, unknown>;
}

/** Routing decision returned by the router. */
export interface RoutingDecision {
	executorId: string;
	tools: string[];
	message: string;
	level: ActionLevel;
}
