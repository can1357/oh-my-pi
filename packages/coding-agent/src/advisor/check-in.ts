import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import checkInDescription from "../prompts/advisor/check-in-tool.md" with { type: "text" };

export const ADVISOR_DEFAULT_MAX_CHECK_IN_TURNS = 5;

const checkInSchema = type({
	afterTurns: type("number").describe(
		"How many primary turn completions to wait before the next advisor review. 1 means the next turn.",
	),
	"reason?": type("string").describe("Short reason to keep moving before the next review."),
});

export type AdvisorCheckInParams = typeof checkInSchema.infer;

export interface AdvisorCheckInReceipt {
	afterTurns: number;
	nextTurn: number;
	reason?: string;
}

export function normalizeAdvisorCheckInTurns(
	afterTurns: number,
	maxTurns = ADVISOR_DEFAULT_MAX_CHECK_IN_TURNS,
): number | undefined {
	if (!Number.isFinite(afterTurns) || afterTurns < 1) return undefined;
	if (!Number.isFinite(maxTurns) || maxTurns < 1) return undefined;
	return Math.min(Math.trunc(afterTurns), Math.max(1, Math.trunc(maxTurns)));
}

export function scheduleAdvisorCheckIn(
	reviewTurn: number,
	afterTurns: number,
	maxTurns = ADVISOR_DEFAULT_MAX_CHECK_IN_TURNS,
): number | undefined {
	if (!Number.isFinite(reviewTurn) || reviewTurn < 0) return undefined;
	const normalized = normalizeAdvisorCheckInTurns(afterTurns, maxTurns);
	return normalized === undefined ? undefined : Math.trunc(reviewTurn) + normalized;
}

export function isAdvisorCheckInDue(completedTurn: number, nextTurn: number | undefined): boolean {
	if (nextTurn === undefined || !Number.isFinite(nextTurn)) return true;
	return completedTurn >= nextTurn;
}

export interface AdvisorCheckInDetails {
	accepted: boolean;
	afterTurns?: number;
	nextTurn?: number;
	reason?: string;
}

export class AdvisorCheckInTool implements AgentTool<typeof checkInSchema, AdvisorCheckInDetails> {
	readonly name = "check_in";
	readonly label = "Schedule Advisor Check-In";
	readonly description = checkInDescription;
	readonly parameters = checkInSchema;
	readonly #onCheckIn: (afterTurns: number, reason?: string) => AdvisorCheckInReceipt;
	readonly #maxTurns: number;
	#scheduled = false;

	constructor(
		onCheckIn: (afterTurns: number, reason?: string) => AdvisorCheckInReceipt,
		maxTurns = ADVISOR_DEFAULT_MAX_CHECK_IN_TURNS,
	) {
		this.#onCheckIn = onCheckIn;
		this.#maxTurns = maxTurns;
	}

	beginUpdate(): void {
		this.#scheduled = false;
	}

	async execute(
		_toolCallId: string,
		args: AdvisorCheckInParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<AdvisorCheckInDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<AdvisorCheckInDetails>> {
		if (this.#scheduled) {
			return this.#result("Already scheduled for this review; keeping the first decision.", { accepted: false });
		}

		const afterTurns = normalizeAdvisorCheckInTurns(args.afterTurns, this.#maxTurns);
		if (afterTurns === undefined) {
			return this.#result("Rejected: afterTurns must be a positive finite number.", { accepted: false });
		}

		const reason = args.reason?.trim() || undefined;
		const receipt = this.#onCheckIn(afterTurns, reason);
		this.#scheduled = true;
		return this.#result(`Scheduled the next review after ${receipt.afterTurns} primary turn(s).`, {
			accepted: true,
			afterTurns: receipt.afterTurns,
			nextTurn: receipt.nextTurn,
			reason: receipt.reason,
		});
	}

	#result(text: string, details: AdvisorCheckInDetails): AgentToolResult<AdvisorCheckInDetails> {
		return {
			content: [{ type: "text", text }],
			details,
			useless: true,
		};
	}
}
