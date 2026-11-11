import { logger } from "@oh-my-pi/pi-utils";
import { VERSION } from "@oh-my-pi/pi-utils/dirs";
import type { Settings } from "../config/settings";
import type { CustomEntry } from "../session/session-entries";
import type { SessionManager } from "../session/session-manager";
import intentField from "../prompts/spotlight/intent-field.md" with { type: "text" };
import intentGuidance from "../prompts/spotlight/intent-guidance.md" with { type: "text" };
import { SpotlightClient } from "./client";
import {
	cfgSpotlightExperimentEnabled,
	cfgSpotlightExperimentHoldout,
	cfgSpotlightExperimentScoreFree,
	cfgSpotlightExperimentTools,
	cfgSpotlightModel,
	cfgSpotlightThinking,
	cfgSpotlightTimeoutMs,
	cfgSpotlightUrl,
} from "./settings";
import { newShapeState, type ShapeState } from "./shape";
import { ArtifactShapeSink, readArtifactText } from "./sink";
import {
	ALL_TOOLS,
	SPOTLIGHT_ENTRY,
	type SpotlightEntryType,
	type SpotlightSession,
	type SpotlightThinking,
} from "./types";

/**
 * Schema description of the tool-call intent field `i` in experiment sessions. Spotlight ranks output against the
 * intent, so it asks what the agent wants from the call's output; `PI_INTENT_DESC` still overrides it.
 */
export const SPOTLIGHT_INTENT_DESCRIPTION: string = intentField.trim();

/**
 * System-prompt guidance for `i` in experiment sessions (see {@link SPOTLIGHT_INTENT_DESCRIPTION});
 * `PI_INTENT_PROMPT` still overrides it.
 */
export const SPOTLIGHT_INTENT_GUIDANCE: string = intentGuidance.trim();

/** The journal fields of a `spotlight:session` entry: what the session shapes with, and the coin shares in effect. */
export interface SpotlightSessionEntry extends SpotlightShares {
	/** The tools whose results the session shapes and journals (`spotlight.experiment.tools`; `*`: every tool). */
	tools: string[];
	model: string;
	thinking: SpotlightThinking;
	/** Host of the Spotlight endpoint. */
	urlHost: string;
	piVersion: string;
}

/** The coins the experiment draws per result, as shares in [0, 1]. */
export interface SpotlightShares {
	/** Would-be cuts held out (`spotlight.experiment.holdout`). */
	holdout: number;
	/** Results not held out that are shaped without Spotlight (`spotlight.experiment.scoreFree`). */
	scoreFree: number;
}

/** The coins drawn for one result; at most one lands. */
export interface SpotlightCoins {
	holdout: boolean;
	scoreFree: boolean;
}

/** How an experiment draws its coins and which tools it shapes. */
export interface SpotlightExperimentOptions extends Partial<SpotlightShares> {
	/** Tool names whose results are shaped (`*`: every tool); default every tool. */
	tools?: readonly string[];
}

/** The `source` of the experiment's session notices. */
export const SPOTLIGHT_NOTICE_SOURCE = "spotlight";

/** The warning a session shows when Spotlight finds no Stencil credential. */
export const NO_CREDENTIAL_NOTICE =
	"No Stencil credential: Spotlight ranking is off, and tool output is cut by the unranked fallback rules. To restore it, run /login and choose Stencil, or set STENCIL_API_KEY.";

/**
 * The experiment's state for one session: the Spotlight client, the coin shares, and the per-session shaping state
 * (lines already shown, cuts made) shaping reads and updates.
 */
export class SpotlightExperiment implements SpotlightSession {
	readonly client: SpotlightClient;
	readonly thinking: SpotlightThinking;
	readonly sink: ArtifactShapeSink;
	shapeState: ShapeState = newShapeState();
	readonly shares: SpotlightShares;
	/** The configured tool list, as journaled. */
	readonly tools: readonly string[];
	/** The tools shaped, or null for every tool. */
	readonly #toolSet: ReadonlySet<string> | null;
	/** Calls whose result was already shaped (or kept) and journaled, so no wrapper does it twice. */
	#shapedCalls = new Set<string>();
	readonly #sessionManager: SessionManager;
	readonly #random: () => number;

	constructor(
		client: SpotlightClient,
		thinking: SpotlightThinking,
		sessionManager: SessionManager,
		options: SpotlightExperimentOptions = {},
		random: () => number = Math.random,
	) {
		this.client = client;
		this.thinking = thinking;
		this.shares = {
			holdout: Math.min(1, Math.max(0, options.holdout ?? 0)),
			scoreFree: Math.min(1, Math.max(0, options.scoreFree ?? 0)),
		};
		this.tools = (options.tools ?? [ALL_TOOLS]).flatMap(name =>
			typeof name === "string" && name.trim() ? [name.trim()] : [],
		);
		this.#toolSet = this.tools.includes(ALL_TOOLS) ? null : new Set(this.tools);
		this.#sessionManager = sessionManager;
		this.#random = random;
		this.sink = new ArtifactShapeSink(sessionManager);
	}

	/** Whether the session shapes and journals the results of `tool` (`spotlight.experiment.tools`). */
	shapesTool(tool: string): boolean {
		return this.#toolSet === null || this.#toolSet.has(tool);
	}

	/**
	 * Marks call `toolCallId` as shaped; false when it already was (a tool delegating to another under the same call
	 * id, a tool that shaped its own result before its wrapper returned).
	 */
	claimCall(toolCallId: string): boolean {
		if (this.#shapedCalls.has(toolCallId)) return false;
		this.#shapedCalls.add(toolCallId);
		return true;
	}

	/**
	 * The coins of one result the arm is about to shape, drawn before shaping so the groups are alike: `holdout` with
	 * probability {@link SpotlightShares.holdout}; else `scoreFree` with probability {@link SpotlightShares.scoreFree}.
	 * At most one lands, and none is drawn after it.
	 */
	drawCoins(): SpotlightCoins {
		const { holdout, scoreFree } = this.shares;
		if (holdout > 0 && this.#random() < holdout) return { holdout: true, scoreFree: false };
		return { holdout: false, scoreFree: scoreFree > 0 && this.#random() < scoreFree };
	}

	log(type: SpotlightEntryType, data: Record<string, unknown>): void {
		try {
			this.#sessionManager.appendCustomEntry(type, data);
		} catch (error) {
			logger.warn("spotlight: journal entry failed", { type, error: String(error) });
		}
	}

	/** The `spotlight:session` entry this session writes. */
	sessionEntry(): SpotlightSessionEntry {
		let urlHost = this.client.url;
		try {
			urlHost = new URL(this.client.url).host;
		} catch {
			// A malformed URL keeps its text; ranking reports the transport failure.
		}
		return {
			...this.shares,
			tools: [...this.tools],
			model: this.client.model,
			thinking: this.thinking,
			urlHost,
			piVersion: VERSION,
		};
	}

	/** Text of a session artifact (a tool's full output), or null when it is gone or unreadable. */
	readArtifact(id: string): Promise<string | null> {
		return readArtifactText(this.#sessionManager, id);
	}

	/**
	 * The agent session moved to another session file (new, resume, fork): its journal gets the live
	 * `spotlight:session` entry unless its last one already matches, and shaping starts over.
	 */
	onSessionChange(): void {
		this.shapeState = newShapeState();
		this.#shapedCalls = new Set();
		const last = lastSessionEntry(this.#sessionManager.getEntries());
		if (
			last?.holdout === this.shares.holdout &&
			last.scoreFree === this.shares.scoreFree &&
			last.tools?.join(",") === this.tools.join(",")
		) {
			return;
		}
		this.log(SPOTLIGHT_ENTRY.session, { ...this.sessionEntry() });
	}
}

/**
 * Starts the experiment for a session when `spotlight.experiment.enabled`: journals the `spotlight:session` entry
 * and wakes Spotlight, which ranks both shaping and `find`.
 */
export function startSpotlightExperiment(
	settings: Settings,
	sessionManager: SessionManager,
): SpotlightExperiment | undefined {
	if (!cfgSpotlightExperimentEnabled.get(settings)) return undefined;
	const client = spotlightClient(settings);
	const experiment = new SpotlightExperiment(client, cfgSpotlightThinking.get(settings), sessionManager, {
		holdout: cfgSpotlightExperimentHoldout.get(settings),
		scoreFree: cfgSpotlightExperimentScoreFree.get(settings),
		tools: cfgSpotlightExperimentTools.get(settings),
	});
	experiment.log(SPOTLIGHT_ENTRY.session, { ...experiment.sessionEntry() });
	client.warm();
	return experiment;
}

/**
 * How `omp find` ranks filenames outside a session: Spotlight's handle when `spotlight.experiment.enabled`, else
 * undefined (the judge ranks). Nothing is journaled, since no session exists.
 */
export function standaloneFindSpotlight(settings: Settings): Pick<SpotlightSession, "client" | "thinking"> | undefined {
	if (!cfgSpotlightExperimentEnabled.get(settings)) return undefined;
	return { client: spotlightClient(settings), thinking: cfgSpotlightThinking.get(settings) };
}

function spotlightClient(settings: Settings): SpotlightClient {
	return new SpotlightClient({
		url: cfgSpotlightUrl.get(settings),
		model: cfgSpotlightModel.get(settings),
		timeoutMs: cfgSpotlightTimeoutMs.get(settings),
	});
}

/** The session's last journaled `spotlight:session` entry, as far as it is well-formed. */
function lastSessionEntry(entries: readonly { type: string }[]): Partial<SpotlightSessionEntry> | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "custom" || (entry as CustomEntry).customType !== SPOTLIGHT_ENTRY.session) continue;
		const data = (entry as CustomEntry<Partial<SpotlightSessionEntry>>).data;
		return { ...data, tools: Array.isArray(data?.tools) ? data.tools : undefined };
	}
	return undefined;
}
