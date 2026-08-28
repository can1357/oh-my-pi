import type { AgentMessage, AgentTurnEndContext } from "@oh-my-pi/pi-agent-core";
import type { UserMessage } from "@oh-my-pi/pi-ai";
import { ToolCallLoopGuard } from "@oh-my-pi/pi-ai/utils/tool-call-loop-guard";
import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import { renderToolCallLoopRedirect } from "../session/tool-call-loop-redirect";

/** Capabilities the advisor loop guard borrows from its agent. */
export interface AdvisorLoopGuardHost {
	settings: Settings;
	/** Advisor name, for log attribution only. */
	name: string;
	/** The advisor agent's live context array. */
	liveMessages(): AgentMessage[];
	/** Appends to the advisor agent's live context. */
	appendMessage(message: AgentMessage): void;
	/** Stops the current advisor update after it ignores one corrective. */
	abort(reason: Error): void;
}

/**
 * Bounds repeated identical tool calls inside an advisor's own `Agent` loop.
 *
 * Advisors drive a private loop that never passes through the primary session's
 * `LoopGuards`, so a model reissuing one failing call had no bound at all:
 * `AdvisorRuntime` counts whole-turn provider failures, which a turn that
 * *succeeds* while burning dozens of identical failing tool calls never trips.
 * Reuses the primary's `model.toolCallLoopGuard.*` settings and corrective so
 * one knob governs both loops (issue #9491).
 */
export class AdvisorLoopGuard {
	readonly #host: AdvisorLoopGuardHost;
	#guard: ToolCallLoopGuard | undefined;
	#guardSettingsKey: string | undefined;
	#redirectIssued = false;

	constructor(host: AdvisorLoopGuardHost) {
		this.#host = host;
	}

	/** Clear detector and escalation state at an advisor update/context boundary. */
	reset(): void {
		this.#guard = undefined;
		this.#guardSettingsKey = undefined;
		this.#redirectIssued = false;
	}
	/** Records one completed advisor turn and injects a redirect when calls repeat. */
	recordTurn(messages: AgentMessage[], context: AgentTurnEndContext | undefined): void {
		if (context?.message.role !== "assistant") return;
		const detection = this.#activeGuard()?.recordTurn({
			message: context.message,
			toolResults: context.toolResults,
		});
		if (!detection) return;
		if (this.#redirectIssued) {
			logger.warn("advisor ignored tool-call loop redirect; aborting update", {
				advisor: this.#host.name,
				toolName: detection.toolName,
				count: detection.count,
			});
			this.#host.abort(new Error(`Advisor repeated ${detection.toolName} after a loop redirect`));
			this.reset();
			return;
		}
		logger.warn("advisor tool-call loop detected", {
			advisor: this.#host.name,
			toolName: detection.toolName,
			count: detection.count,
		});
		this.#redirectIssued = true;
		// Re-arm after the first corrective. If it is ignored, the same bound
		// trips again and hard-stops this update instead of running forever.
		this.#guard = undefined;
		this.#guardSettingsKey = undefined;
		// A `user` message, not the primary's custom one: the advisor agent runs
		// the default LLM converter, which keeps only LLM-native roles — a custom
		// message would be dropped before the request and correct nothing.
		const redirect: UserMessage = {
			role: "user",
			content: [{ type: "text", text: renderToolCallLoopRedirect(detection) }],
			synthetic: true,
			attribution: "agent",
			timestamp: Date.now(),
		};
		messages.push(redirect);
		// The loop hands over its live array; a caller passing a detached snapshot
		// still needs the corrective in the context the next request reads.
		if (this.#host.liveMessages() !== messages) this.#host.appendMessage(redirect);
	}

	#activeGuard(): ToolCallLoopGuard | undefined {
		if (this.#host.settings.get("model.toolCallLoopGuard.enabled") !== true) {
			this.reset();
			return undefined;
		}
		const threshold = this.#host.settings.get("model.toolCallLoopGuard.threshold");
		const exemptTools = this.#host.settings
			.get("model.toolCallLoopGuard.exemptTools")
			.filter((tool): tool is string => typeof tool === "string" && tool.length > 0);
		const settingsKey = `${threshold}:${JSON.stringify(exemptTools)}`;
		if (!this.#guard || this.#guardSettingsKey !== settingsKey) {
			this.#guard = new ToolCallLoopGuard({ threshold, exemptTools });
			this.#guardSettingsKey = settingsKey;
		}
		return this.#guard;
	}
}
