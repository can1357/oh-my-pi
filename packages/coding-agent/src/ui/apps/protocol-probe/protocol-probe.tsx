/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * `/debug protocols`: one sample of every special terminal protocol (SGR
 * styling, OSC 8 links, OSC 66 text sizing, inline graphics, the desktop
 * notification) with whether the terminal supports it.
 *
 * The terminal frames the panel between two rules and draws the underline
 * and 24-bit sweep of the styling sample (see the `omp.app.probe` look).
 */
import { type JSXNode, nativeRendering } from "@oh-my-pi/pi-tui";
import { registerBlob } from "@oh-my-pi/pi-tui/native/blobs";
import { textSized } from "@oh-my-pi/pi-tui/text/osc";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import type { SampleImage } from "../../../modes/view-model/apps/debug/protocol-probe";
import "../../styles/apps/protocol-probe/look";
import { imageLinkTarget } from "../../transcript/image-links";
import { openableImage } from "../../transcript/messages/image";

/** Cells of the truecolor sweep in the styling sample. */
export const TRUECOLOR_CELLS = 32;

const REPO_URL = "https://github.com/can1357/oh-my-pi";
const SIZED_SAMPLE = "Aa Bb 123";

/** What the terminal supports, as the driver probed it. */
export interface ProbeCapabilities {
	readonly hyperlinks: boolean;
	readonly textSizing: boolean;
	readonly trueColor: boolean;
	/** Inline image protocol, or null when images fall back to text. */
	readonly images: "kitty" | "iterm2" | "sixel" | null;
	/** How desktop notifications are delivered. */
	readonly notify?: "osc99" | "osc9" | "bel";
}

export interface ProtocolProbeProps {
	readonly image: SampleImage;
	readonly capabilities: ProbeCapabilities;
	/** The notification was not sent (`PI_NOTIFICATIONS=off`). */
	readonly notificationSuppressed: boolean;
	/** Tern opens a blob copy of the sample image from its menu (the hyperlink policy is not `off`). */
	readonly linkImage?: boolean;
}

const IMAGE_LABELS = { kitty: "Kitty graphics", iterm2: "iTerm2 inline images", sixel: "Sixel" } as const;
const NOTIFY_LABELS = { osc99: "OSC 99 (kitty)", osc9: "OSC 9 (iTerm2/WezTerm)", bel: "BEL" } as const;

const support = (on: boolean): TspSpan => (on ? { s: "success", t: "supported" } : { s: "muted", t: "unsupported" });

/** The OSC 66 samples, each followed by the blank rows its scaled glyphs cover. */
function sizedSamples(): string {
	const theme = currentTheme();
	const lines: string[] = [];
	for (const scale of [2, 3] as const) {
		lines.push(`  ${theme.fg("accent", textSized(`${SIZED_SAMPLE} (${scale}x)`, { scale }))}`);
		for (let blank = 1; blank < scale; blank++) lines.push("");
	}
	return lines.join("\n");
}

export function ProtocolProbe(props: ProtocolProbeProps): JSXNode {
	const caps = props.capabilities;
	const image = props.image;
	const blob = registerBlob(Buffer.from(image.base64, "base64"), image.mimeType);
	const alt = `[Image: [${image.mimeType}] ${image.dimensions.widthPx}x${image.dimensions.heightPx}]`;
	const link = (): { href?: string; actions?: { menu: string[] } } =>
		props.linkImage && nativeRendering() ? openableImage(imageLinkTarget(blob)) : {};
	const styling: TspSpan[] = [
		{ s: "muted", t: "Styling (SGR)" },
		{ t: "\n  " },
		{ s: "strong", t: "bold" },
		{ t: "  " },
		{ s: "em", t: "italic" },
		{ t: "  underline  " },
		{ s: "del", t: "strike" },
		{ t: "  " },
		{ s: "mark", t: " inverse " },
		{ t: "  " },
		{ s: "dim", t: "dim" },
		{ t: "\n  " },
		{ s: "accent", t: "accent" },
		{ t: "  " },
		{ s: "success", t: "success" },
		{ t: "  " },
		{ s: "warning", t: "warning" },
		{ t: "  " },
		{ s: "error", t: "error" },
		{ t: `\n  truecolor: ${" ".repeat(TRUECOLOR_CELLS)} (` },
		{ s: "muted", t: `24-bit ${caps.trueColor ? "on" : "off"}` },
		{ t: ")" },
	];
	return (
		<col term={{ role: "omp.app.probe" }}>
			<col hidden />
			<text wrap="word" spans={[{ s: "accent strong", t: "Terminal Protocol Test" }]} />
			<text wrap="word" spans={styling} term={{ sample: true }} />
			<spacer size="sm" />
			<text
				wrap="word"
				spans={[
					{ s: "muted", t: "Hyperlinks (OSC 8)" },
					{ t: " — " },
					support(caps.hyperlinks),
					{ t: "\n  " },
					{ t: "omp repo", href: REPO_URL },
				]}
			/>
			<spacer size="sm" />
			<text
				wrap="word"
				spans={[{ s: "muted", t: "Text sizing (OSC 66)" }, { t: " — " }, support(caps.textSizing)]}
			/>
			{caps.textSizing ? (
				<ansi text={sizedSamples()} />
			) : (
				<text
					wrap="word"
					spans={[{ s: "dim", t: "  (enable via the tui.textSizing setting on a Kitty terminal)" }]}
				/>
			)}
			<spacer size="sm" />
			<text
				wrap="word"
				spans={[
					{ s: "muted", t: "Graphics" },
					{ t: " — " },
					{ s: "dim", t: caps.images ? IMAGE_LABELS[caps.images] : "none — text fallback" },
				]}
			/>
			<image
				blob={blob}
				alt={alt}
				w={image.dimensions.widthPx}
				h={image.dimensions.heightPx}
				max={{ w: "20ch", h: "16lines" }}
				href={() => link().href}
				actions={() => link().actions}
			/>
			<spacer size="sm" />
			<text
				wrap="word"
				spans={[
					{ s: "muted", t: "Notification" },
					{ t: " (" },
					{ s: "dim", t: NOTIFY_LABELS[caps.notify ?? "bel"] },
					{ t: ") — " },
					props.notificationSuppressed
						? { s: "warning", t: "suppressed (PI_NOTIFICATIONS)" }
						: { s: "success", t: "sent — check your desktop / titlebar" },
				]}
			/>
			<col hidden />
		</col>
	);
}
