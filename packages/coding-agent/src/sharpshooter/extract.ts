import { type } from "@oh-my-pi/omptype";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { completeSimple, Effort, type Model, retryTransientCompletion } from "@oh-my-pi/pi-ai";
import { clampThinkingLevelForModel } from "@oh-my-pi/pi-catalog/model-thinking";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { getModelMatchPreferences, resolveModelRoleValue, resolveRoleSelection } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import extractInputTemplate from "../prompts/memories/sharpshooter-extract-input.md" with { type: "text" };
import extractSystemTemplate from "../prompts/memories/sharpshooter-extract-system.md" with { type: "text" };
import type { AgentSession } from "../session/agent-session";
import { customMessageContentText } from "../session/checkpoint-entries";
import { appendSharpshooterDelta } from "./queue";
import type { SharpshooterDelta, SharpshooterDeltaKind, SharpshooterDeltaSource, SharpshooterFriction } from "./types";

const SHARPSHOOTER_DELTA_KINDS = {
	architecture_decision: true,
	product_decision: true,
	style_decision: true,
	constraint: true,
	rejected_approach: true,
	correction: true,
} satisfies Record<SharpshooterDeltaKind, true>;
const SHARPSHOOTER_DELTA_SOURCES = {
	explicit_user: true,
	contextual_resolution: true,
} satisfies Record<SharpshooterDeltaSource, true>;

const deltaSchema = type({
	kind: "'architecture_decision' | 'product_decision' | 'style_decision' | 'constraint' | 'rejected_approach' | 'correction'",
	statement: "string",
	"rejectedAlternative?": "string",
	"rationale?": "string",
	source: "'explicit_user' | 'contextual_resolution'",
	evidence: "string",
	friction: {
		corrective: "boolean",
		regression: "boolean",
		subtle: "boolean",
	},
});

const recordDeltasTool = {
	name: "record_deltas",
	description: "Record every durable project-decision delta supported by the current user prompt.",
	parameters: type({ deltas: deltaSchema.array() }),
};

const kExtractionInFlight = Symbol("sharpshooter.extractionInFlight");

interface ExtractionHost extends AgentSession {
	[kExtractionInFlight]?: Promise<void>;
}

/**
 * Await the session's in-flight extraction, bounded by `timeoutMs`. Called from
 * session disposal so short-lived processes (print mode) do not exit before a
 * just-fired extraction persists its deltas.
 */
export async function flushSharpshooterExtraction(session: AgentSession, timeoutMs = 5_000): Promise<void> {
	const pending = (session as ExtractionHost)[kExtractionInFlight];
	if (!pending) return;
	await Promise.race([pending, Bun.sleep(Math.max(0, timeoutMs))]);
}

export interface SharpshooterEnvelope {
	prompt: string;
	previousHuman?: string;
	assistantContext?: string;
}

interface DeltaCandidate {
	kind?: unknown;
	statement?: unknown;
	rejectedAlternative?: unknown;
	rationale?: unknown;
	source?: unknown;
	evidence?: unknown;
	friction?: unknown;
}

function visibleMessageText(message: AgentMessage): string {
	const content = "content" in message ? message.content : undefined;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return customMessageContentText(content as Parameters<typeof customMessageContentText>[0]);
}

function cleanEnvelopeContext(text: string, maxChars: number): string | undefined {
	const cleaned = text
		.replace(/(```|~~~)[\s\S]*?\1/g, "[code omitted]")
		.replace(/\s+/g, " ")
		.trim();
	if (!cleaned) return undefined;
	return cleaned.slice(0, maxChars);
}

/** Build the extraction prompt and its bounded referent context from a transcript snapshot. */
export function buildSharpshooterEnvelope(
	messages: AgentMessage[],
	current?: AgentMessage,
): SharpshooterEnvelope | undefined {
	// The triggering message may not be in `messages` yet (message_start fires
	// before the session transcript appends), so scan strictly before it when
	// present and treat the whole snapshot as history otherwise.
	let currentUserIndex = messages.length;
	if (current) {
		const index = messages.lastIndexOf(current);
		if (index >= 0) currentUserIndex = index;
	} else {
		currentUserIndex = -1;
		for (let index = messages.length - 1; index >= 0; index--) {
			if (messages[index]?.role === "user") {
				currentUserIndex = index;
				break;
			}
		}
		if (currentUserIndex < 0) return undefined;
	}

	const currentMessage = current ?? messages[currentUserIndex];
	if (currentMessage?.role !== "user") return undefined;
	const currentPrompt = visibleMessageText(currentMessage).trim();
	if (!currentPrompt) return undefined;

	let previousHuman: string | undefined;
	let assistantContext: string | undefined;
	let foundPreviousHuman = false;
	let foundAssistantContext = false;
	for (let index = currentUserIndex - 1; index >= 0; index--) {
		const message = messages[index];
		if (!message) continue;
		if (!foundPreviousHuman && message.role === "user") {
			foundPreviousHuman = true;
			previousHuman = cleanEnvelopeContext(visibleMessageText(message), 400);
		}
		if (!foundAssistantContext && message.role === "assistant") {
			foundAssistantContext = true;
			assistantContext = cleanEnvelopeContext(visibleMessageText(message), 800);
		}
		if (foundPreviousHuman && foundAssistantContext) break;
	}

	return {
		prompt: currentPrompt,
		...(previousHuman ? { previousHuman } : {}),
		...(assistantContext ? { assistantContext } : {}),
	};
}

/** Resolve the configured extraction model, then fall back to the `smol` role. */
export async function resolveSharpshooterModel(
	settings: Settings,
	modelRegistry: ModelRegistry,
): Promise<Model | undefined> {
	const selector = settings.get("sharpshooter.model");
	if (selector) {
		const resolved = resolveModelRoleValue(selector, modelRegistry.getAll(), {
			settings,
			matchPreferences: getModelMatchPreferences(settings),
		});
		if (resolved.model) return resolved.model;
		logger.debug("Sharpshooter extraction model selector did not resolve", { selector });
	}

	const fallback = resolveRoleSelection(["smol"], settings, modelRegistry.getAvailable())?.model;
	if (!fallback) logger.debug("Sharpshooter extraction skipped: no model available");
	return fallback;
}

/** Start best-effort extraction for one committed user prompt without blocking the caller. */
export function maybeStartSharpshooterExtraction(options: {
	session: AgentSession;
	settings: Settings;
	modelRegistry: ModelRegistry;
	agentDir: string;
	/** The just-committed user message; falls back to the transcript's latest user message. */
	message?: AgentMessage;
}): void {
	try {
		const { session } = options;
		if (session.isDisposed || (session as ExtractionHost)[kExtractionInFlight]) return;
		const envelope = buildSharpshooterEnvelope(session.messages, options.message);
		if (!envelope) return;
		const trimmedPrompt = envelope.prompt.trim();
		if (trimmedPrompt.startsWith("/") || trimmedPrompt.length < 16) return;

		const run = runSharpshooterExtraction(options, envelope)
			.catch(error => {
				logger.debug("Sharpshooter extraction failed", { error: String(error), sessionId: session.sessionId });
			})
			.finally(() => {
				(session as ExtractionHost)[kExtractionInFlight] = undefined;
			});
		(session as ExtractionHost)[kExtractionInFlight] = run;
	} catch (error) {
		logger.debug("Sharpshooter extraction could not start", { error: String(error) });
	}
}

async function runSharpshooterExtraction(
	options: {
		session: AgentSession;
		settings: Settings;
		modelRegistry: ModelRegistry;
		agentDir: string;
	},
	envelope: SharpshooterEnvelope,
): Promise<void> {
	const { session, settings, modelRegistry, agentDir } = options;
	const model = await resolveSharpshooterModel(settings, modelRegistry);
	if (!model || session.isDisposed) return;

	const input = prompt.render(extractInputTemplate, { ...envelope });
	const response = await retryTransientCompletion(() =>
		completeSimple(
			model,
			{
				systemPrompt: [prompt.render(extractSystemTemplate)],
				messages: [{ role: "user", content: [{ type: "text", text: input }], timestamp: Date.now() }],
				tools: [recordDeltasTool],
			},
			{
				apiKey: modelRegistry.resolver(model),
				maxTokens: 2048,
				reasoning: clampThinkingLevelForModel(model, Effort.Low),
				toolChoice: "required",
			},
		),
	);
	if (response.stopReason === "error") {
		throw new Error(response.errorMessage || "Sharpshooter extraction model error");
	}

	for (const block of response.content) {
		if (block.type !== "toolCall" || block.name !== recordDeltasTool.name) continue;
		const args = block.arguments;
		if (!args || typeof args !== "object" || !("deltas" in args) || !Array.isArray(args.deltas)) {
			logger.debug("Sharpshooter extraction rejected malformed record_deltas call");
			continue;
		}
		for (const candidate of args.deltas) {
			const delta = admitDelta(candidate, envelope.prompt, session.sessionId);
			if (!delta) continue;
			if (session.isDisposed) return;
			await appendSharpshooterDelta(agentDir, session.sessionManager.getCwd(), delta);
		}
	}
}

function admitDelta(candidate: unknown, currentPrompt: string, sessionId: string): SharpshooterDelta | undefined {
	if (!candidate || typeof candidate !== "object") {
		logger.debug("Sharpshooter extraction rejected non-object delta");
		return undefined;
	}
	const raw = candidate as DeltaCandidate;
	if (typeof raw.statement !== "string" || !raw.statement.trim()) {
		logger.debug("Sharpshooter extraction rejected delta with empty statement");
		return undefined;
	}
	if (typeof raw.evidence !== "string" || !raw.evidence || !currentPrompt.includes(raw.evidence)) {
		logger.debug("Sharpshooter extraction rejected delta with unverifiable evidence", { evidence: raw.evidence });
		return undefined;
	}
	if (typeof raw.kind !== "string" || !Object.hasOwn(SHARPSHOOTER_DELTA_KINDS, raw.kind)) {
		logger.debug("Sharpshooter extraction rejected delta with invalid kind", { kind: raw.kind });
		return undefined;
	}
	if (typeof raw.source !== "string" || !Object.hasOwn(SHARPSHOOTER_DELTA_SOURCES, raw.source)) {
		logger.debug("Sharpshooter extraction rejected delta with invalid source", { source: raw.source });
		return undefined;
	}
	const friction = parseFriction(raw.friction);
	if (!friction) {
		logger.debug("Sharpshooter extraction rejected delta with invalid friction");
		return undefined;
	}

	return {
		v: 1,
		kind: raw.kind as SharpshooterDeltaKind,
		statement: raw.statement.trim(),
		...(typeof raw.rejectedAlternative === "string" && raw.rejectedAlternative.trim()
			? { rejectedAlternative: raw.rejectedAlternative.trim() }
			: {}),
		...(typeof raw.rationale === "string" && raw.rationale.trim() ? { rationale: raw.rationale.trim() } : {}),
		source: raw.source as SharpshooterDeltaSource,
		evidence: raw.evidence,
		friction,
		sessionId,
		ts: Date.now(),
	};
}

function parseFriction(value: unknown): SharpshooterFriction | undefined {
	if (!value || typeof value !== "object") return undefined;
	const friction = value as Record<string, unknown>;
	if (
		typeof friction.corrective !== "boolean" ||
		typeof friction.regression !== "boolean" ||
		typeof friction.subtle !== "boolean"
	) {
		return undefined;
	}
	return {
		corrective: friction.corrective,
		regression: friction.regression,
		subtle: friction.subtle,
	};
}
