/** @jsxImportSource @oh-my-pi/pi-tui */
import { describe, expect, test } from "bun:test";
import type { AssistantMessage, ImageContent } from "@oh-my-pi/pi-ai";
import { type Signal, signal, type UiNode } from "@oh-my-pi/pi-tui";
import { paintNode, staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import type { TurnUsageSummary } from "../../../../src/modes/view-model/overlays/usage-row";
import type { CacheInvalidation } from "../../../../src/session/transcript/cache-invalidation-marker";
import type { ServedModelMismatch } from "../../../../src/session/transcript/served-model-marker";
import { AssistantMessageBlock } from "../../../../src/ui/transcript/messages/assistant-message";
import { screenSuite, single } from "./harness";

/** The 1×1 PNG the capture used (`"1x1 png"` in the inputs). */
export const PNG_1X1 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

type Content = AssistantMessage["content"][number];

interface AssistantInputs {
	content: Content[];
	stopReason?: "error" | "aborted";
	errorMessage?: string;
	message?: null;
	hideThinkingBlock?: boolean;
	cacheInvalidation?: CacheInvalidation;
	servedModelMismatch?: ServedModelMismatch;
	turnUsage?: TurnUsageSummary;
	toolResultImages?: Record<string, ImageContent[]>;
	linkTargets?: Record<string, string>;
}

const TS = 1_700_000_000_000;

/** The marker steps' fixed inputs (cases that only list them in their stages). */
const MARKERS = {
	cacheInvalidation: { reprocessedTokens: 50000 },
	servedModelMismatch: { requested: "a", served: "b", provider: "p" },
	turnUsage: { elapsedMs: 12400, input: 19000, output: 500, cost: 0 },
};

function assistant(content: Content[], out: number, extra: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content,
		usage: {
			input: 10,
			output: out,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 10 + out,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		provider: "p",
		model: "m",
		api: "x",
		timestamp: TS,
		...extra,
	} as AssistantMessage;
}

function withPng(content: Content[]): Content[] {
	return content.map(block =>
		block.type === "image" && block.data === "1x1 png" ? { ...block, data: PNG_1X1 } : block,
	);
}

/** The first `fraction` of every text and thinking block (the capture's streaming steps). */
function prefixed(content: Content[], fraction: number): Content[] {
	const cut = (text: string) => text.slice(0, Math.floor(text.length * fraction));
	return content.map(block =>
		block.type === "text"
			? { ...block, text: cut(block.text) }
			: block.type === "thinking"
				? { ...block, thinking: cut(block.thinking) }
				: block,
	);
}

/** Cases built with no message: they stream or reply in their stages. */
const STARTS_EMPTY: Record<string, true> = {
	"streaming thinking and text then markers": true,
	"streaming with thinking hidden": true,
	"reaction emoji reply": true,
	"empty pending": true,
};

screenSuite("assistant-message", (corpusCase, env) => {
	(env.reduceMotion as Signal<boolean>).set(true);
	const inputs = corpusCase.inputs as AssistantInputs;
	const content = withPng(inputs.content ?? []);
	const extra: Partial<AssistantMessage> = {
		...(inputs.stopReason ? { stopReason: inputs.stopReason } : {}),
		...(inputs.errorMessage ? { errorMessage: inputs.errorMessage } : {}),
	};
	const message = signal<AssistantMessage | undefined>(
		STARTS_EMPTY[corpusCase.case] ? undefined : assistant(content, 0, extra),
	);
	const transient = signal(false);
	const finalized = signal(false);
	const hideThinking = signal(inputs.hideThinkingBlock === true);
	const expandThinking = signal(false);
	const showImages = signal(true);
	const showToolResultImages = signal(true);
	const toolResultImages = signal<ReadonlyMap<string, readonly ImageContent[]>>(new Map());
	const linkTargets = signal<ReadonlyMap<string, string>>(new Map());
	const errorExpanded = signal(false);
	const errorPinned = signal(false);
	const cacheInvalidation = signal<CacheInvalidation | undefined>(undefined);
	const servedModelMismatch = signal<ServedModelMismatch | undefined>(undefined);
	const turnUsage = signal<TurnUsageSummary | undefined>(undefined);
	const rewound = signal(false);
	const node = single(
		<AssistantMessageBlock
			model={{
				message,
				transient,
				finalized,
				hideThinking,
				expandThinking,
				showImages,
				showToolResultImages,
				toolResultImages,
				linkTargets,
				errorExpanded,
				errorPinned,
				cacheInvalidation,
				servedModelMismatch,
				turnUsage,
				rewound,
				now: () => 0,
			}}
		/>,
	);
	return {
		node,
		apply(label) {
			const streaming = /^streaming (\d+)%$/.exec(label);
			if (streaming) {
				const fraction = Number(streaming[1]) / 100;
				message.set(assistant(prefixed(content, fraction), Math.round(fraction * 100)));
				transient.set(true);
				return;
			}
			switch (label) {
				case "final message":
					message.set(assistant(content, 120));
					transient.set(false);
					return;
				case "finalized":
					finalized.set(true);
					return;
				case "thinking hidden":
					return hideThinking.set(true);
				case "thinking shown":
					return hideThinking.set(false);
				case "thinking expanded":
					return expandThinking.set(true);
				case "cache-miss marker":
					return cacheInvalidation.set(inputs.cacheInvalidation ?? MARKERS.cacheInvalidation);
				case "served-model marker":
					return servedModelMismatch.set(inputs.servedModelMismatch ?? MARKERS.servedModelMismatch);
				case "turn usage":
					return turnUsage.set({ ...MARKERS.turnUsage, ...inputs.turnUsage });
				case "rewound":
					return rewound.set(true);
				case "markers cleared":
					cacheInvalidation.set(undefined);
					servedModelMismatch.set(undefined);
					return;
				case "tool result image":
					return toolResultImages.set(
						new Map(
							Object.entries(inputs.toolResultImages ?? {}).map(([id, images]) => [
								id,
								withPng(images) as ImageContent[],
							]),
						),
					);
				case "tool images hidden":
					return showToolResultImages.set(false);
				case "images hidden":
					return showImages.set(false);
				case "images shown":
					return showImages.set(true);
				case "expanded":
					return errorExpanded.set(true);
				case "pinned":
					return errorPinned.set(true);
				case "collapsed while pinned":
					return errorExpanded.set(false);
				case "unpinned":
					return errorPinned.set(false);
				case "retry recovery attempt 2":
					return message.set({
						...message()!,
						retryRecovery: { attempt: 2 } as AssistantMessage["retryRecovery"],
					});
				case "reply":
					return message.set(assistant(content, 0));
				case "link targets resolved":
					return linkTargets.set(new Map(Object.entries(inputs.linkTargets ?? {})));
				default:
					throw new Error(`unknown stage ${label}`);
			}
		},
	};
});

describe("assistant message tone", () => {
	test("a toned reply (/live's spoken one) draws its prose in the tone, natively and in the terminal", () => {
		const theme = loadThemeSync("dark");
		const env = staticEnvironment(theme, { now: TS });
		const accentOpen = theme.fg("accent", "\0").split("\0")[0]!;
		const reply = (tone?: "accent") =>
			single(
				<AssistantMessageBlock
					model={{
						message: assistant([{ type: "text", text: "Spoken reply" }], 2),
						finalized: true,
						...(tone ? { tone } : {}),
						now: () => 0,
					}}
				/>,
			);
		const toned = reply("accent");
		const plain = reply();

		const prose = (node: UiNode) => node.children().find(child => child.kind === "md")!;
		expect((prose(toned).props() as { tone?: string }).tone).toBe("accent");
		expect((prose(plain).props() as { tone?: string }).tone).toBeUndefined();

		const row = (node: UiNode) => paintNode(env, node, 40).rows.find(line => line.includes("Spoken"))!;
		expect(stripEscapes(row(toned))).toBe(stripEscapes(row(plain)));
		expect(row(toned)).toContain(accentOpen);
		expect(row(plain)).not.toContain(accentOpen);
	});
});
