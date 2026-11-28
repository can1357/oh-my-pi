/** @jsxImportSource @oh-my-pi/pi-tui */
import { describe, expect, test } from "bun:test";
import type { AssistantMessage, ImageContent } from "@oh-my-pi/pi-ai";
import { isSettled, signal, type UiNode } from "@oh-my-pi/pi-tui";
import { TerminalImages } from "@oh-my-pi/pi-tui/driver/images/store";
import { driverImages } from "@oh-my-pi/pi-tui/term/backend";
import { paintNode, staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import type { TurnUsageSummary } from "../../../../src/modes/view-model/overlays/usage-row";
import type { CacheInvalidation } from "../../../../src/session/transcript/cache-invalidation-marker";
import type { ServedModelMismatch } from "../../../../src/session/transcript/served-model-marker";
import { Transcript } from "../../../../src/ui/shell/transcript";
import { figureWorkSettled } from "../../../../src/ui/transcript/figures/svg";
import { AssistantMessageBlock, type ToolResultMedia } from "../../../../src/ui/transcript/messages/assistant-message";
import { KITTY } from "../figures/harness";
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
	env.setReduceMotion(true);
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
	const toolResultMedia = signal<ReadonlyMap<string, ToolResultMedia>>(new Map());
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
				toolResultMedia,
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
					return toolResultMedia.set(
						new Map(
							Object.entries(inputs.toolResultImages ?? {}).map(([id, images]) => [
								id,
								{ images: withPng(images) as ImageContent[] },
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

test("a recovered turn shows a compact model and error reason without terminal formatting", () => {
	const message = assistant([], 0, {
		stopReason: "error",
		errorMessage: `503 \x1b[31mupstream\x1b[0m\r\n\tunavailable: ${"provider diagnostic ".repeat(8)}`,
		retryRecovery: {
			kind: "auto-retry",
			status: "recovered",
			attempt: 2,
			recoveredAt: new Date(TS).toISOString(),
			recovery: "model",
			note: "switched model; retried",
			supersededBy: { timestamp: TS + 1, provider: "anthropic", model: "claude-sonnet-4-5" },
		},
	});
	const transcript = new Transcript();
	const block = transcript.append(() => <AssistantMessageBlock model={{ message, finalized: true }} />);
	try {
		const { rows } = paintNode(staticEnvironment(loadThemeSync("dark")), block.node, 100);
		const row = rows.find(line => line.includes("503"));
		expect(row && stripEscapes(row).trim()).toMatch(
			/^503 upstream unavailable: .*… — recovered on anthropic\/claude-sonnet-4-5$/,
		);
		expect(row).not.toContain("\x1b[31m");
	} finally {
		transcript.clear();
	}
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

function sixelEnvironment() {
	const caps = signal({ ...KITTY, images: "sixel" } satisfies typeof KITTY);
	const images = new TerminalImages({ capabilities: caps });
	return {
		env: staticEnvironment(loadThemeSync("dark"), { images: driverImages(images, caps), hyperlinks: true }),
		images,
	};
}

test("a finished assistant SVG fence draws inline on SIXEL, not as XML", async () => {
	const { env, images } = sixelEnvironment();
	const transcript = new Transcript();
	const finalized = signal(false);
	const renderSvg = signal(true);
	const text = "Before\n\n```svg\n<svg viewBox='0 0 80 32'><rect width='80' height='32'/></svg>\n```\n\nAfter";
	const message = assistant([{ type: "text", text }], 2);
	const block = transcript.append(() => (
		<AssistantMessageBlock model={{ message, transient: true, finalized, renderSvg }} />
	));
	const paint = () => paintNode(env, block.node, 80);
	try {
		const streaming = paint();
		// The visible code is replaced at completion, so it cannot already be in scrollback.
		expect(streaming.rows.join("\n")).toContain("viewBox");
		expect(streaming.rows.slice(0, streaming.stable ?? 0).join("\n")).not.toContain("viewBox");
		finalized.set(true);
		transcript.settle(block);
		expect(isSettled(block.node)).toBe(false);
		await figureWorkSettled();
		expect(isSettled(block.node)).toBe(true);
		paint();
		await images.whenEncoded();
		const rows = paint().rows.join("\n");
		expect(rows).not.toContain("viewBox");
		expect(rows).toMatch(/Before[\s\S]*\x1bP[\d;]*q[\s\S]*After/);

		renderSvg.set(false);
		expect(paint().rows.join("\n")).toContain("viewBox");
	} finally {
		transcript.clear();
	}
});

test("assistant embeds draw their image and page still, but do not load when images are turned off", async () => {
	const { env, images } = sixelEnvironment();
	const transcript = new Transcript();
	const showImages = signal(false);
	const capture = Promise.withResolvers<Uint8Array>();
	const calls: string[] = [];
	const png = Buffer.from(PNG_1X1, "base64");
	const text = [
		"Before",
		`<img src="data:image/png;base64,${PNG_1X1}" alt="Image fixture">`,
		"",
		'<iframe src="page.html" title="Page fixture"></iframe>',
		"",
		"After",
	].join("\n");
	const message = assistant([{ type: "text", text }], 2);
	const block = transcript.append(() => (
		<AssistantMessageBlock
			model={{
				message,
				finalized: true,
				showImages,
				renderEmbeds: true,
				embedHost: {
					cwd: () => import.meta.dir,
					capturePage: url => {
						calls.push(url);
						return capture.promise;
					},
				},
			}}
		/>
	));
	const paint = () => paintNode(env, block.node, 80).rows.join("\n");
	try {
		expect(paint()).toMatch(/Image fixture[\s\S]*Page fixture/);
		expect(calls).toEqual([]);
		showImages.set(true);
		paint();
		transcript.settle(block);
		expect(isSettled(block.node)).toBe(false);
		expect(calls).toEqual([new URL("page.html", import.meta.url).href]);
		capture.resolve(png);
		await figureWorkSettled();
		expect(isSettled(block.node)).toBe(true);
		paint();
		await images.whenEncoded();
		const rows = paint();
		expect(rows.match(/\x1bP[\d;]*q/g)).toHaveLength(2);
		expect(rows).toMatch(/Before[\s\S]*Page fixture[\s\S]*\[Visit\][\s\S]*After/);
	} finally {
		capture.resolve(png);
		transcript.clear();
	}
});

test("embeds at a reply's edges keep their image rows in the transcript block", async () => {
	const { env, images } = sixelEnvironment();
	const transcript = new Transcript();
	const img = (alt: string) => `<img src="data:image/png;base64,${PNG_1X1}" alt="${alt}">`;
	const text = [img("Lead"), "", "Between", "", img("Tail")].join("\n");
	const block = transcript.append(() => (
		<AssistantMessageBlock
			model={{ message: assistant([{ type: "text", text }], 2), finalized: true, renderEmbeds: true }}
		/>
	));
	const paint = () => paintNode(env, block.node, 80).rows.join("\n");
	try {
		paint();
		transcript.settle(block);
		await figureWorkSettled();
		paint();
		await images.whenEncoded();
		expect(paint()).toMatch(/^\x1bP[\d;]*q[^\n]*\n\n[^\n]*Between[^\n]*\n\n\x1bP[\d;]*q[^\n]*$/);
	} finally {
		transcript.clear();
	}
});

test("an embedded picture taller than the figure room is fitted within its rows, following the room", async () => {
	const tall = await new Bun.Image(Buffer.from(PNG_1X1, "base64")).resize(16, 320).png().toBase64();
	const { env, images } = sixelEnvironment();
	const transcript = new Transcript();
	const figureRows = signal(5);
	const text = `<img src="data:image/png;base64,${tall}" alt="Tall">`;
	const block = transcript.append(() => (
		<AssistantMessageBlock
			model={{ message: assistant([{ type: "text", text }], 2), finalized: true, renderEmbeds: true, figureRows }}
		/>
	));
	const paint = () => paintNode(env, block.node, 80).rows.join("\n");
	try {
		paint();
		transcript.settle(block);
		await figureWorkSettled();
		paint();
		await images.whenEncoded();
		// 16×320 px is 20 rows of 8×16 cells at its natural size.
		expect(paint()).toMatch(/^\x1b7\x1b\[4A\x1bP[\d;]*q/m);
		figureRows.set(10);
		paint();
		await images.whenEncoded();
		expect(paint()).toMatch(/^\x1b7\x1b\[9A\x1bP[\d;]*q/m);
	} finally {
		transcript.clear();
	}
});

test("a leading assistant image keeps all its rows while encoding and after drawing", async () => {
	const data = await new Bun.Image(Buffer.from(PNG_1X1, "base64")).resize(48, 48).png().toBase64();
	const { env, images } = sixelEnvironment();
	const transcript = new Transcript();
	const message = assistant([{ type: "image", mimeType: "image/png", data }], 2);
	const block = transcript.append(() => <AssistantMessageBlock model={{ message, finalized: true }} />);
	try {
		expect(paintNode(env, block.node, 80).rows).toHaveLength(3);
		await images.whenEncoded();
		const { rows } = paintNode(env, block.node, 80);
		expect(rows).toHaveLength(3);
		expect(rows[2]).toMatch(/\x1b7\x1b\[2A\x1bP[\d;]*q/);
	} finally {
		transcript.clear();
	}
});
