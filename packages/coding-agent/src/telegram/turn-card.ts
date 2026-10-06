/**
 * The tool-step card: one Telegram message per turn that shows the tool steps
 * (and the todo plan) while the turn runs, carrying a stop button the operator
 * can press, then settles into the final card with the button removed.
 *
 * The card is created by the first tool call — a turn without tools never
 * posts one — and republishes at most once every two seconds, remembering the
 * newest state so the throttled publish cannot be lost.
 */
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { logger, sleepLong } from "@oh-my-pi/pi-utils";
import {
	activityMarkdown,
	planTasks,
	toolStep,
	type ActivityState,
	type ActivityStatus,
	type ActivityStep,
	type PlanTask,
	type ToolStep,
} from "./activity";
import { NO_KEYBOARD } from "./dialog-keys";
import { errorText } from "./text";
import type { Clock, TelegramDelivery, TelegramInlineKeyboardMarkup } from "./types";

/** Callback data of the card's stop button; the router aborts the topic's turn. */
export const TURN_STOP_CALLBACK = "turn:stop";

const STOP_KEYBOARD: TelegramInlineKeyboardMarkup = {
	inlineKeyboard: [[{ text: "⏹ Stop", callbackData: TURN_STOP_CALLBACK }]],
};
const CARD_PAUSE_MS = 2_000;

/** How a card settles. */
export interface CardFinish {
	status?: Exclude<ActivityStatus, "running">;
	error?: string | null;
	contextPercent?: number | null;
}

/** One tool call as the conveyor sees it; `intent` is absent when the tool reported none. */
export interface TurnToolCall {
	callId: string | null;
	toolName: string;
	args: unknown;
	intent?: string;
}

/** The end of one tool call, matched to its start by `callId`. */
export interface TurnToolEnd {
	callId: string | null;
	ok: boolean;
}

export interface TurnCard {
	begin(): void;
	tool(step: TurnToolCall): Promise<void>;
	toolEnd(step: TurnToolEnd): Promise<void>;
	setPlan(phases: readonly TodoPhase[] | null): Promise<void>;
	notice(line: { icon: string | null; label: string }): Promise<void>;
	usage(step: { tokens: number | null; cost: number | null } | null): void;
	finish(options?: CardFinish): Promise<boolean>;
}

export interface TurnCardOptions {
	deliver: TelegramDelivery;
	chatId: number;
	threadId: number;
	clock: Clock;
	/** Overridable for tests; defaults to `sleepLong`. */
	sleep?(ms: number, signal: AbortSignal): Promise<void>;
}

export function createTurnCard(options: TurnCardOptions): TurnCard {
	const { deliver, chatId, threadId, clock } = options;
	const sleep = options.sleep ?? sleepLong;
	let steps: ActivityStep[] = [];
	let plan: PlanTask[] = [];
	let cardId: number | null = null;
	let startedAt: number | null = null;
	let cost: number | null = null;
	let lastAt: number | null = null;
	let timer: AbortController | null = null;
	let chain: Promise<void> = Promise.resolve();

	const serial = (run: () => Promise<void>): Promise<void> => {
		const next = chain.then(run, run).catch(error => {
			logger.warn("telegram: turn card render failed", { threadId, error: errorText(error) });
		});
		chain = next;
		return next;
	};

	async function place(markdown: string, replyMarkup: TelegramInlineKeyboardMarkup | null): Promise<void> {
		try {
			if (cardId === null) {
				const ids = await deliver.send({ chatId, threadId, markdown, replyMarkup });
				cardId = ids[0] ?? null;
				if (cardId === null) logger.debug("telegram: turn card not placed", { threadId });
				return;
			}
			await deliver.edit({ chatId, threadId, messageId: cardId, markdown, replyMarkup });
		} catch (error) {
			logger.warn("telegram: turn card publish failed", { threadId, error: errorText(error) });
		}
	}

	function state(
		status: ActivityStatus,
		error: string | null = null,
		contextPercent: number | null = null,
	): ActivityState {
		return { status, startedAt, now: clock.now(), steps, plan, cost, contextPercent, error };
	}

	function findStep(callId: string | null): ToolStep | null {
		for (let index = steps.length - 1; index >= 0; index -= 1) {
			const step = steps[index];
			if (step.kind === "tool" && step.callId === callId && step.status === "running") return step;
		}
		return null;
	}

	function cancelScheduled(): void {
		if (timer === null) return;
		timer.abort();
		timer = null;
	}

	function publishNow(): Promise<void> {
		lastAt = clock.now();
		return serial(() => place(activityMarkdown(state("running")), STOP_KEYBOARD));
	}

	function publish(): Promise<void> {
		const wait = lastAt === null ? 0 : CARD_PAUSE_MS - (clock.now() - lastAt);
		if (cardId === null || wait <= 0) return publishNow();
		if (timer === null) {
			const controller = new AbortController();
			timer = controller;
			void sleep(wait, controller.signal).then(
				() => {
					if (controller.signal.aborted) return;
					timer = null;
					void publishNow();
				},
				() => {},
			);
		}
		return Promise.resolve();
	}

	return {
		begin() {
			cancelScheduled();
			steps = [];
			plan = [];
			cardId = null;
			cost = null;
			startedAt = clock.now();
			lastAt = null;
		},
		async tool(step) {
			const built = toolStep({ toolName: step.toolName, args: step.args, intent: step.intent, at: clock.now() });
			steps.push({ ...built, callId: step.callId });
			await publish();
		},
		async toolEnd(step) {
			const found = findStep(step.callId);
			if (found === null) return;
			found.status = step.ok ? "ok" : "error";
			found.endedAt = clock.now();
			await publish();
		},
		async setPlan(phases) {
			plan = planTasks(phases);
			await publish();
		},
		async notice(line) {
			steps.push({ kind: "notice", icon: line.icon, label: line.label });
			await publish();
		},
		usage(step) {
			if (step === null || step.cost === null || !Number.isFinite(step.cost)) return;
			cost = (cost ?? 0) + step.cost;
		},
		async finish(options = {}) {
			cancelScheduled();
			const id = cardId;
			if (id === null) return false;
			const markdown = activityMarkdown(
				state(options.status ?? "done", options.error ?? null, options.contextPercent ?? null),
			);
			await serial(() => place(markdown, NO_KEYBOARD));
			return true;
		},
	};
}
