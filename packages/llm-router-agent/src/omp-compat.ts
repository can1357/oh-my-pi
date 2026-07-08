import type { Preference, RequestInput, RouteDecision } from "./types.js";

export interface OmpLikeExtensionApi {
	zod?: any;
	logger?: {
		info?: (...args: unknown[]) => void;
		warn?: (...args: unknown[]) => void;
		error?: (...args: unknown[]) => void;
	};
	setLabel?: (label: string) => void;
	registerTool?: (definition: Record<string, unknown>) => void;
	registerCommand?: (name: string, definition: Record<string, unknown>) => void;
	on?: (eventName: string, handler: (...args: any[]) => unknown | Promise<unknown>) => void;
	setModel?: (...args: unknown[]) => Promise<unknown> | unknown;
}

export function getZod(pi: OmpLikeExtensionApi): any {
	return pi.zod?.z ?? pi.zod;
}

export function makeRequestSchema(z: any): any {
	if (!z?.object) return {};
	const preference = z.enum ? z.enum(["speed", "quality", "cost", "safety", "balanced"]) : z.string().optional();
	return z.object({
		message: z.string().describe?.("User request to route") ?? z.string(),
		preference: preference.optional?.() ?? preference,
		tier: z.string().optional(),
		tags: z.array?.(z.string()).optional?.() ?? z.any?.().optional?.(),
		metadata: z.record?.(z.string(), z.any()).optional?.() ?? z.any?.().optional?.(),
	});
}

export function makeValidationSchema(z: any): any {
	if (!z?.object) return {};
	return z.object({
		output: z.string(),
		message: z.string().optional(),
		requireJson: z.boolean?.().optional?.() ?? z.any?.().optional?.(),
	});
}

export function extractInputText(event: unknown): string {
	if (typeof event === "string") return event;
	if (!event || typeof event !== "object") return "";
	const record = event as Record<string, unknown>;
	for (const key of ["message", "input", "text", "content", "prompt"]) {
		const value = record[key];
		if (typeof value === "string") return value;
		if (Array.isArray(value)) {
			const text = value
				.map(item =>
					typeof item === "string" ? item : isRecord(item) && typeof item.text === "string" ? item.text : "",
				)
				.join("\n")
				.trim();
			if (text) return text;
		}
	}
	return "";
}

export function normalizeCommandArgs(args: unknown): string[] {
	if (Array.isArray(args)) return args.map(String);
	if (typeof args === "string") return splitShellish(args);
	if (isRecord(args)) {
		const raw = args.args ?? args.argv ?? args.input ?? args.text;
		if (Array.isArray(raw)) return raw.map(String);
		if (typeof raw === "string") return splitShellish(raw);
	}
	return [];
}

export function requestFromToolParams(params: unknown): RequestInput {
	const record = isRecord(params) ? params : {};
	return {
		message: String(record.message ?? ""),
		user: {
			tier: typeof record.tier === "string" ? record.tier : undefined,
			preference: toPreference(record.preference),
		},
		tags: Array.isArray(record.tags) ? record.tags.map(String) : [],
		metadata: isRecord(record.metadata) ? record.metadata : {},
	};
}

export function formatDecision(decision: RouteDecision): string {
	return [
		`selected=${decision.selectedModel}`,
		`selector=${decision.selector}`,
		`confidence=${Math.round(decision.confidence * 100)}%`,
		`task=${decision.taskType}`,
		`reasons=${decision.reasons.join(", ") || "weighted objective score"}`,
		`fallback=${decision.fallbackChain.join(" -> ")}`,
	].join("\n");
}

export async function tryApplyModel(
	pi: OmpLikeExtensionApi,
	ctx: any,
	decision: RouteDecision,
): Promise<{ applied: boolean; selector?: string; reason?: string }> {
	if (!pi.setModel) return { applied: false, reason: "pi.setModel is unavailable" };
	const selectors = [decision.selector, ...decision.fallbackSelectors].filter(uniqueString);
	for (const selector of selectors) {
		try {
			const resolved = ctx?.models?.resolve ? await ctx.models.resolve(selector) : undefined;
			if (resolved) {
				const provider = resolved.provider ?? resolved.providerId ?? resolved.providerName;
				const modelId = resolved.modelId ?? resolved.id ?? resolved.name;
				if (provider && modelId) {
					await pi.setModel(provider, modelId);
					return { applied: true, selector };
				}
				await pi.setModel(resolved);
				return { applied: true, selector };
			}
			await pi.setModel(selector);
			return { applied: true, selector };
		} catch (error) {
			pi.logger?.warn?.(
				`Router failed to apply selector ${selector}:`,
				error instanceof Error ? error.message : String(error),
			);
		}
	}
	return { applied: false, reason: "No selector could be resolved or applied" };
}

function toPreference(value: unknown): Preference {
	return value === "speed" || value === "quality" || value === "cost" || value === "safety" || value === "balanced"
		? value
		: "balanced";
}

function splitShellish(input: string): string[] {
	const matches = input.match(/"([^"]*)"|'([^']*)'|\S+/g) ?? [];
	return matches.map(token => token.replace(/^(["'])(.*)\1$/, "$2"));
}

function isRecord(value: unknown): value is Record<string, any> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uniqueString(value: string, index: number, array: string[]): boolean {
	return value.length > 0 && array.indexOf(value) === index;
}
