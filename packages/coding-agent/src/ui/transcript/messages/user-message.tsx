/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The user's turn: a head-less user-toned card holding the prompt as
 * Markdown under its attached images.
 *
 * - Composer tokens stay chips (`📷 #1`, `⬢ model`, `✦ skill`): `md` marks
 *   natively, composer colors in the terminal.
 * - With a host that handles transcript actions, a quiet tools row offers
 *   Copy and Edit (and the time sent); a phone's long press lists the
 *   turn's actions.
 * - The live-steering marker and the agent's reaction are badges at the
 *   bottom-right natively; the terminal draws them in the bubble's top
 *   padding row (`*` left, the emoji right).
 * - Synthetic (agent-attributed) input is muted and flat.
 *
 * Terminal look: `omp.user` (`src/ui/styles/messages/user.ts`).
 */
import { For, type JSXNode, type Reactive, read, Show } from "@oh-my-pi/pi-tui";
import { formatBytes } from "@oh-my-pi/pi-utils";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import { type GlowingKeyword, magicKeywordLetters } from "../../composer/magic-keywords";
import { cardExpansion } from "../expansion";
import { chipMarks, chipText, termChips } from "./chips";
import { ImageNode, type ImagePart } from "./image";
import { turnHoldEntries } from "./turn-actions";

/** What a user bubble shows. */
export interface UserMessageModel {
	readonly text: string;
	/** Attached images in chip order (`#1` first); only `image/*` ones show as thumbnails. */
	readonly images?: readonly ImagePart[];
	/** Files of the attachments by chip number − 1 (chips and thumbnails open them). */
	readonly imageLinks?: readonly (string | undefined)[];
	/** Whether thumbnails link to their files (the host's link policy). */
	readonly linkImages?: Reactive<boolean>;
	/** Agent-attributed input: muted, flat prose, no controls. */
	readonly synthetic?: boolean;
	/** Delivered into the response that was streaming. */
	readonly liveSteered?: boolean;
	/** SKILL.md path of a registered skill, by name; other skill-glyph prose stays plain. */
	readonly skillPath?: (name: string) => string | undefined;
	/** Magic keywords that glow in the prompt (the enabled ones); none when absent. */
	readonly magicKeywords?: Reactive<readonly GlowingKeyword[]>;
	/** When the message was sent (ms). */
	readonly timestamp?: number;
	/** The terminal's clock (`hour12`); the locale default when undefined. */
	readonly hour12?: Reactive<boolean | undefined>;
	/** The agent's emoji reaction to this prompt. */
	readonly reaction?: Reactive<string | undefined>;
	/** Whether a host handles transcript actions (controls are only shown when one does). */
	readonly actions?: Reactive<boolean>;
	/** Mark the bubble as a shell prompt zone (OSC 133) in the terminal. */
	readonly promptZones?: Reactive<boolean>;
	/** Copy (`copy-message`), Edit & resend (`edit-turn`) and turn hold-menu actions. */
	readonly onAction?: (act: string) => void;
}

function timeOf(at: number, hour12: boolean | undefined): { short: string; full: string } {
	const date = new Date(at);
	return {
		short: date.toLocaleTimeString([], {
			hour: "2-digit",
			minute: "2-digit",
			hour12,
		}),
		full: date.toLocaleString([], { hour12 }),
	};
}

/** The tools row: Copy, Edit & resend (rewinds to before the prompt and puts it in the composer) and the time sent. */
function UserTools(props: { model: UserMessageModel }): JSXNode {
	const { model } = props;
	return (
		<row key="tools" gap="xs" align="center" role="omp.user.tools">
			<icon
				key="copy"
				name="copy"
				role="omp.user.tool"
				title="Copy message"
				aria="Copy message"
				actions={{ click: "copy-message" }}
			/>
			<icon
				key="edit"
				name="edit"
				role="omp.user.tool"
				title="Edit & resend: rewind to before this message and put it in the composer"
				aria="Edit & resend"
				actions={{ click: "edit-turn" }}
			/>
			{model.timestamp !== undefined && [
				<text key="dot" text="·" />,
				<text
					role="omp.user.time"
					spans={() => [
						{
							t: timeOf(model.timestamp!, read(model.hour12)).short,
							s: "dim mono",
						},
					]}
					title={() => timeOf(model.timestamp!, read(model.hour12)).full}
				/>,
			]}
		</row>
	);
}

/** The first Markdown heading's text, else `Synthetic input`. */
function syntheticLabel(text: string): string {
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		const heading = /^#{1,6}\s+(.*)$/.exec(line);
		return heading?.[1]?.trim() || "Synthetic input";
	}
	return "Synthetic input";
}

/** `<label> · <size> · <n> lines` of a synthetic input. */
export function syntheticSummary(text: string): string {
	const lines = text === "" ? 0 : text.split("\n").length;
	return `${syntheticLabel(text)} · ${formatBytes(Buffer.byteLength(text, "utf-8"))} · ${lines} line${lines === 1 ? "" : "s"}`;
}

/**
 * A collapsed synthetic (agent-attributed) input in a replayed transcript,
 * such as the advisor's `Session update` dumps: a muted collapsible card
 * whose head is a one-line summary; the (possibly huge) body is only built
 * while expanded.
 */
export function SyntheticMessage(props: {
	text: string;
	imageLinks?: readonly (string | undefined)[];
	expanded: Reactive<boolean>;
	onToggle?: (expanded: boolean) => void;
}): JSXNode {
	const { expanded, toggle } = cardExpansion(props.expanded, props.onToggle);
	const display = chipText(props.text, { imageLinks: props.imageLinks });
	const term = {
		synthetic: true,
		display: display.text,
		chips: termChips(display.chips),
	};
	return (
		<card
			role="omp.user.synthetic"
			tone="muted"
			head={[{ t: syntheticSummary(props.text), s: "dim" }]}
			collapsible
			collapsed={() => !expanded()}
			onToggle={toggle}
		>
			<Show when={expanded}>{() => <md text={props.text} term={term} />}</Show>
		</card>
	);
}

/** A user prompt bubble. */
export function UserMessage(props: { model: UserMessageModel }): JSXNode {
	const { model } = props;
	const synthetic = model.synthetic === true;
	const display = chipText(model.text, {
		imageLinks: model.imageLinks,
		skillPath: model.skillPath,
	});
	const chipSpans = synthetic ? [] : chipMarks(display.chips);
	const chips = termChips(display.chips);
	const keywords = (): readonly GlowingKeyword[] => (synthetic ? [] : (read(model.magicKeywords) ?? []));
	// Natively a glowing keyword is the accent with the shimmer effect; the terminal sweeps its gradient.
	const marks = (): TspSpan[] | undefined => {
		const words = keywords().filter(keyword => magicKeywordLetters(display.text, [keyword]).length > 0);
		const spans = [
			...chipSpans,
			...words.map((keyword): TspSpan => ({ t: keyword.word, s: "accent", fx: "shimmer" })),
		];
		return spans.length > 0 ? spans : undefined;
	};
	const actions = (): boolean => !synthetic && read(model.actions) === true;
	const thumbs = synthetic
		? []
		: (model.images ?? []).flatMap((image, i) => (image.mimeType.startsWith("image/") ? [{ image, i }] : []));
	const badges = (): { text: string; steered: boolean }[] => {
		const out: { text: string; steered: boolean }[] = [];
		if (model.liveSteered) out.push({ text: "steered", steered: true });
		const reaction = read(model.reaction);
		if (reaction !== undefined) out.push({ text: reaction, steered: false });
		return out;
	};
	return (
		<card
			role={synthetic ? "omp.user.synthetic" : "omp.user"}
			tone={synthetic ? "muted" : "user"}
			actions={() =>
				actions() && model.timestamp !== undefined
					? {
							hold: turnHoldEntries("user", {
								id: "copy-message",
								label: "Copy message",
								icon: "copy",
							}),
						}
					: undefined
			}
			term={() => ({
				zones: read(model.promptZones) !== false,
				steered: model.liveSteered === true,
				reaction: read(model.reaction),
			})}
			onAction={act => model.onAction?.(act)}
		>
			<Show when={actions}>
				<UserTools model={model} />
			</Show>
			{thumbs.length > 0 && (
				<row gap="sm" wrap align="start" role="omp.user.images">
					{thumbs.map(({ image, i }) => (
						<ImageNode
							image={image}
							nodeKey={`#${i + 1}`}
							alt={`#${i + 1}`}
							title={`#${i + 1}`}
							path={() => (read(model.linkImages) === true ? model.imageLinks?.[i] : undefined)}
						/>
					))}
				</row>
			)}
			<md text={display.text} marks={marks} term={() => ({ chips, synthetic, keywords: keywords() })} />
			<Show when={() => badges().length > 0}>
				<row key="badges" gap="xs" justify="end" role="omp.user.badges">
					<For each={badges}>
						{badge =>
							badge.steered ? (
								<badge text="steered" tone="accent" title="Delivered into the response that was streaming" />
							) : (
								<badge text={badge.text} role="omp.reaction" />
							)
						}
					</For>
				</row>
			</Show>
		</card>
	);
}
