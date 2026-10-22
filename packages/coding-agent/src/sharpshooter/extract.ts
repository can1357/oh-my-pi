import { type } from "@oh-my-pi/omptype";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { completeSimple, Effort, type Model, retryTransientCompletion } from "@oh-my-pi/pi-ai";
import { clampThinkingLevelForModel } from "@oh-my-pi/pi-catalog/model-thinking";
import { getSegmenter } from "@oh-my-pi/pi-tui";
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

import { cfgSharpshooterMinPromptLength, cfgSharpshooterModel } from "./settings";

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
const kExtractionInFlightMessage = Symbol("sharpshooter.extractionInFlightMessage");
const kExtractionHandledMessages = Symbol("sharpshooter.extractionHandledMessages");
const kExtractionPendingQueue = Symbol("sharpshooter.extractionPendingQueue");
const kExtractionParked = Symbol("sharpshooter.extractionParked");

export interface SharpshooterExtractionOptions {
	session: AgentSession;
	settings: Settings;
	modelRegistry: ModelRegistry;
	agentDir: string;
	/** The just-committed user message; falls back to the transcript's latest user message. */
	message?: AgentMessage;
}

/** A dropped prompt plus the project it belonged to when it was dropped. */
export interface PendingExtraction {
	options: SharpshooterExtractionOptions;
	/**
	 * Captured at drop time. A `/move` can land between the drop and the
	 * retry; binding the bank then would file the prompt's decisions in the
	 * project it was never written in.
	 */
	cwd: string;
	/**
	 * Built at drop time from the transcript the prompt was written in. `/new`, a
	 * session switch, or compaction can replace `session.messages` before the slot
	 * drains; rebuilding then would scan the replacement transcript for the
	 * referent context and attribute the prompt's decisions to the wrong turns.
	 */
	envelope: SharpshooterEnvelope;
	/**
	 * Captured at drop time. `/new` or a session switch can change `session.sessionId`
	 * before the slot drains; stamping the retried deltas with the new id would file a
	 * prompt from one session under another, and the consolidator groups by session.
	 */
	sessionId: string;
}

/** What a retried prompt carries from the moment it was dropped. */
export type ExtractionRetry = Pick<PendingExtraction, "cwd" | "envelope" | "sessionId">;

// Bound the model spend a burst of dropped prompts can trigger after the
// slot clears; beyond this the newest prompts are still transcript history
// for whichever prompt extracts next.
const MAX_PENDING_EXTRACTIONS = 4;

// Empty prompts never reach the length gate, so a floor of 1 filters nothing;
// 2 is the smallest floor that still drops one-character acks ("好", "y").
const MIN_PROMPT_LENGTH_FLOOR = 2;

interface ExtractionHost extends AgentSession {
	[kExtractionInFlight]?: Promise<void>;
	/**
	 * The message the in-flight run was started on. A catch-up that names this
	 * same message is already being extracted; `undefined` when the run was
	 * started without a snapshot.
	 */
	[kExtractionInFlightMessage]?: AgentMessage | undefined;
	/**
	 * Every user prompt this session has already enrolled for extraction, keyed
	 * by message identity. Enrollment is idempotent for the whole session rather
	 * than only for the concurrently-in-flight window: a live restart (a primary
	 * backend switch, or `sharpshooter.enabled` off→on) re-fires the catch-up for
	 * a transcript whose newest prompt may already have settled. Weakly held, so a
	 * prompt (and any image blocks it carries) is released once the transcript
	 * drops it, rather than pinned for the session's lifetime.
	 */
	[kExtractionHandledMessages]?: WeakSet<AgentMessage>;
	/** Prompts dropped while the slot was busy, retried in order when it clears. */
	[kExtractionPendingQueue]?: PendingExtraction[];
	/**
	 * Set while the queue waits for the leg that replaces the released one. An
	 * extraction that settles in that window must not drain it: with no subscription
	 * the queued prompts have no leg, and if pairing is switched off meanwhile they
	 * would be extracted after it was disabled.
	 */
	[kExtractionParked]?: true;
}

/**
 * Retry dropped prompts in drop order, serially. Called from the in-flight
 * extraction's `finally`; each retried prompt re-enters the normal guard, so
 * a prompt dropped during a retry queues behind it and this loop yields.
 */
async function drainSharpshooterExtractionQueue(session: AgentSession): Promise<void> {
	const host = session as ExtractionHost;
	for (;;) {
		if (session.isDisposed || host[kExtractionInFlight] || host[kExtractionParked]) return;
		const pending = host[kExtractionPendingQueue]?.shift();
		if (!pending) return;
		maybeStartSharpshooterExtraction(pending.options, pending);
		if (host[kExtractionInFlight]) await host[kExtractionInFlight];
	}
}

/**
 * Drop prompts queued for a retry. The queue belongs to the pairing that is
 * being released: with no subscription of its own, a retry would extract a
 * prompt for a project the session no longer pairs with.
 */
export function clearPendingSharpshooterExtraction(session: AgentSession): void {
	const host = session as ExtractionHost;
	delete host[kExtractionPendingQueue];
	delete host[kExtractionParked];
}

/**
 * Keep the queue for the leg that is about to replace the released one, and stop it
 * from draining until that leg takes it. The caller owns clearing it if no leg arrives.
 */
export function parkPendingSharpshooterQueue(session: AgentSession): void {
	(session as ExtractionHost)[kExtractionParked] = true;
}

/**
 * Take the prompts queued for a retry, leaving the session with no queue. A leg
 * restart that keeps pairing replaces the subscription that owned the queue, so
 * the prompts have to travel with it rather than be dropped: the new leg
 * suppresses its catch-up for a rebind, and nothing else re-enrolls a prompt
 * that only ever reached the queue. The caller hands the taken prompts to the
 * leg it installs in place of the one it released.
 */
export function takePendingSharpshooterQueue(session: AgentSession): PendingExtraction[] {
	const host = session as ExtractionHost;
	const queue = host[kExtractionPendingQueue] ?? [];
	delete host[kExtractionPendingQueue];
	delete host[kExtractionParked];
	return queue;
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
	const selector = cfgSharpshooterModel.get(settings);
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

/**
 * Start best-effort extraction for one committed user prompt without blocking the caller.
 * `retry` is what a queued prompt captured at drop time; fresh starts omit it.
 */
export function maybeStartSharpshooterExtraction(
	options: SharpshooterExtractionOptions,
	retry?: ExtractionRetry,
): void {
	try {
		const { session } = options;
		if (session.isDisposed) return;
		const host = session as ExtractionHost;
		// Keyed by message identity, which both firesites can supply: `message_start`
		// pins the committed message, and the install's catch-up pins
		// `session.messages.at(-1)` out of that same transcript array. Checked ahead
		// of the in-flight branch so a settled prompt is skipped even though the slot
		// it once held is free again.
		const handled = (host[kExtractionHandledMessages] ??= new WeakSet());
		if (options.message && handled.has(options.message)) return;
		if (host[kExtractionInFlight]) {
			// One model call at a time. A prompt dropped here is otherwise lost
			// outright: notably the first prompt after a `/move`, whose slot is
			// held across the rebind by the source prompt's extraction. Queue it
			// with the project it belonged to at drop time.
			// A snapshot that is already being extracted, or already queued for a
			// retry, is one extraction: a catch-up can name the very prompt that
			// holds the slot (a live toggle mid-turn), and queueing it a second
			// time would extract that prompt twice.
			if (options.message) {
				if (host[kExtractionInFlightMessage] === options.message) return;
				if (host[kExtractionPendingQueue]?.some(pending => pending.options.message === options.message)) return;
			}
			const queue = (host[kExtractionPendingQueue] ??= []);
			if (queue.length >= MAX_PENDING_EXTRACTIONS) {
				logger.debug("Sharpshooter extraction backlog full; dropping prompt", {
					sessionId: session.sessionId,
				});
				return;
			}
			const queued = retry?.envelope ?? buildSharpshooterEnvelope(session.messages, options.message);
			if (!queued) return;
			queue.push({
				cwd: retry?.cwd ?? session.sessionManager.getCwd(),
				options,
				envelope: queued,
				sessionId: retry?.sessionId ?? session.sessionId,
			});
			return;
		}
		const envelope = retry?.envelope ?? buildSharpshooterEnvelope(session.messages, options.message);
		if (!envelope) return;
		const trimmedPrompt = envelope.prompt.trim();
		if (trimmedPrompt.startsWith("/")) return;
		// Count user-perceived characters, not UTF-16 units: `.length` reports 2 for "👍".
		const minLength = Math.max(MIN_PROMPT_LENGTH_FLOOR, cfgSharpshooterMinPromptLength.get(options.settings));
		let characters = 0;
		for (const _grapheme of getSegmenter().segment(trimmedPrompt)) {
			if (++characters >= minLength) break;
		}
		if (characters < minLength) return;

		// Bind the bank now. The model call below can outlive a `/move`, and the
		// deltas belong to the project whose prompt produced them.
		const cwd = retry?.cwd ?? session.sessionManager.getCwd();
		const run = runSharpshooterExtraction(options, envelope, cwd, retry?.sessionId ?? session.sessionId)
			.catch(error => {
				logger.debug("Sharpshooter extraction failed", { error: String(error), sessionId: session.sessionId });
			})
			.finally(() => {
				host[kExtractionInFlight] = undefined;
				host[kExtractionInFlightMessage] = undefined;
				void drainSharpshooterExtractionQueue(session);
			});
		host[kExtractionInFlight] = run;
		host[kExtractionInFlightMessage] = options.message;
		// Enrolled at the slot, not at the fire: a prompt that is only queued has
		// not been extracted yet, and its retry re-enters this same guard.
		if (options.message) handled.add(options.message);
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
	/**
	 * The project the prompt was written in, captured before the model call.
	 * `/move` can land while extraction is in flight, and a decision earned in the
	 * source project is not a decision about the destination.
	 */
	cwd: string,
	/** The session the prompt was written in; deltas are stamped with it, not with the live id. */
	promptSessionId: string,
): Promise<void> {
	const { session, settings, modelRegistry, agentDir } = options;
	const model = await resolveSharpshooterModel(settings, modelRegistry);
	if (!model || session.isDisposed) return;

	const input = prompt.render(extractInputTemplate, { ...envelope });
	const response = await retryTransientCompletion(
		() =>
			completeSimple(
				model,
				{
					systemPrompt: [prompt.render(extractSystemTemplate)],
					messages: [{ role: "user", content: [{ type: "text", text: input }], timestamp: Date.now() }],
					tools: [recordDeltasTool],
				},
				{
					apiKey: modelRegistry.resolver(model, session.sessionId),
					sessionId: session.sessionId,
					maxTokens: 2048,
					reasoning: clampThinkingLevelForModel(model, Effort.Low),
					toolChoice: "required",
				},
			),
		{ provider: model.provider },
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
			const delta = admitDelta(candidate, envelope.prompt, promptSessionId);
			if (!delta) continue;
			if (session.isDisposed) return;
			await appendSharpshooterDelta(agentDir, cwd, delta);
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
