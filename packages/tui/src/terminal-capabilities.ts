import {
	detectTerminalProfile,
	isTerminalBackgroundQueryTrusted,
	sendTerminalNotification,
	type TerminalNotification,
	type TerminalProfile,
} from "@oh-my-pi/pi-natives";
import { isBunTestRuntime, isTerminalHeadless } from "@oh-my-pi/pi-utils/env";
import { writeTerminalSequence } from "./active-terminal";
import { detectTerminalBackground } from "./theme/theme";
import type { HangulCompatibilityJamoWidth } from "./utils";

/** Last valid OSC 11 background, packed as 0xRRGGBB. */
let terminalBackgroundColor: number | undefined;

/**
 * Trusted terminal background when reported; otherwise black for detected dark
 * appearance or white for detected light appearance, using theme auto-detection.
 */
export function getTerminalBackgroundColor(): number {
	if (isTerminalBackgroundQueryTrusted(Bun.env, process.platform) && terminalBackgroundColor !== undefined) {
		return terminalBackgroundColor;
	}
	return detectTerminalBackground() === "light" ? 0xffffff : 0x000000;
}

/** Store an OSC 11 background, or reset to appearance detection (also for tests). */
export function setTerminalBackgroundColor(color: number | undefined): void {
	terminalBackgroundColor = color;
}

export enum ImageProtocol {
	Kitty = "\x1b_G",
	Iterm2 = "\x1b]1337;File=",
	Sixel = "\x1bPq",
}

/** Terminal identity the native profile detected. */
export type TerminalId = TerminalProfile["id"];

/** How the terminal surfaces a notification. */
export type NotifyProtocol = TerminalProfile["notifyProtocol"];

/** Terminal multiplexers the native profile recognizes. */
export type TerminalMultiplexer = NonNullable<TerminalProfile["multiplexer"]>;

const IMAGE_PROTOCOLS = {
	kitty: ImageProtocol.Kitty,
	iterm2: ImageProtocol.Iterm2,
	sixel: ImageProtocol.Sixel,
} as const;

/** The engine's name for `protocol`, or `undefined` when images are off. */
export function engineImageProtocol(protocol: ImageProtocol | null): keyof typeof IMAGE_PROTOCOLS | undefined {
	switch (protocol) {
		case ImageProtocol.Kitty:
			return "kitty";
		case ImageProtocol.Iterm2:
			return "iterm2";
		case ImageProtocol.Sixel:
			return "sixel";
		case null:
			return undefined;
	}
}

const IMAGE_MARKER_SCAN_LIMIT = 512;
const SIXEL_MARKER_SCAN_LIMIT = 128;
/** Kitty Unicode placeholder (U+10EEEE), the cell of a virtual placement grid. */
const KITTY_PLACEHOLDER = "\u{10eeee}";
const KITTY_PLACEHOLDER_HIGH_SURROGATE = KITTY_PLACEHOLDER.charCodeAt(0);
const KITTY_PLACEHOLDER_LOW_SURROGATE = KITTY_PLACEHOLDER.charCodeAt(1);

/**
 * Plain-data snapshot of the native terminal profile (`detectTerminalProfile`),
 * read per render. Detection and policy live in the native profile; the
 * runtime-resolved capabilities below are written only by the setters in this
 * module (probe results, settings, tests).
 */
export class TerminalInfo {
	readonly id: TerminalId;
	/** Inline image protocol in use; runtime probes may adopt one. */
	imageProtocol: ImageProtocol | null;
	/** `PI_FORCE_IMAGE_PROTOCOL` pins the image protocol (its `off` switch included). */
	readonly imageProtocolForced: boolean;
	readonly trueColor: boolean;
	/** Whether OSC 8 hyperlinks are enabled. */
	hyperlinks: boolean;
	notifyProtocol: NotifyProtocol;
	/** Kitty-style DECCARA rectangular-SGR background fills. */
	deccara: boolean;
	supportsScreenToScrollback: boolean;
	/** Renders the Kitty OSC 66 text-sizing protocol (scaled spans). Kitty only. */
	readonly supportsTextSizing: boolean;
	/** Whether OSC 66 text sizing is currently enabled; hosts opt in separately. */
	textSizing = false;
	/**
	 * Hangul Compatibility Jamo (U+3131..=U+318E) cell width. Ghostty and Orca follow
	 * UAX#11 (2 cells); Warp paints 1; "platform" keeps the OS default
	 * (macOS narrow, otherwise UAX#11).
	 */
	readonly hangulJamoWidth: HangulCompatibilityJamoWidth;
	/** Whether the terminal implements colon-subparameter styled underlines (curly + colored). */
	styledUnderlines: boolean;
	/** Kitty images display through Unicode placeholders (`U=1` + U+10EEEE) instead of direct placement. */
	kittyUnicodePlaceholders: boolean;
	/**
	 * Whether the terminal answered the Glyph Protocol support query with a
	 * `glyf`-capable reply and the bundled icons have been registered. Probe-
	 * driven: false until {@link ProcessTerminal} resolves it.
	 */
	glyphProtocol = false;
	/** The process runs in an SSH session. */
	readonly ssh: boolean;
	/** The multiplexer hosting the process, if any. */
	readonly multiplexer: TerminalMultiplexer | undefined;
	/** The hosting multiplexer owns the screen grid. */
	readonly insideMultiplexer: boolean;
	/** Inside a tmux session: sequences for the outer terminal need the passthrough envelope. */
	readonly tmux: boolean;

	constructor(profile: TerminalProfile) {
		this.id = profile.id;
		this.imageProtocol = profile.imageProtocol ? IMAGE_PROTOCOLS[profile.imageProtocol] : null;
		this.imageProtocolForced = profile.imageProtocolForced;
		this.trueColor = profile.trueColor;
		this.hyperlinks = profile.hyperlinks;
		this.notifyProtocol = profile.notifyProtocol;
		this.deccara = profile.deccara;
		this.supportsScreenToScrollback = profile.supportsScreenToScrollback;
		this.supportsTextSizing = profile.supportsTextSizing;
		this.hangulJamoWidth =
			profile.hangulJamoWidth === 1 || profile.hangulJamoWidth === 2 ? profile.hangulJamoWidth : "platform";
		this.styledUnderlines = profile.styledUnderlines;
		this.kittyUnicodePlaceholders = profile.kittyUnicodePlaceholders;
		this.ssh = profile.ssh;
		this.multiplexer = profile.multiplexer;
		this.insideMultiplexer = profile.insideMultiplexer;
		this.tmux = profile.tmux;
	}

	/**
	 * Whether an image marker begins at `start`. Kept as the shared primitive
	 * for both standalone image checks and the renderer's combined ANSI/width
	 * scan, so their protocol windows and sixel grammar cannot drift.
	 */
	hasImageMarkerAt(line: string, start: number): boolean {
		const protocol = this.imageProtocol;
		if (!protocol) return false;
		if (protocol === ImageProtocol.Sixel) {
			const limit = Math.min(line.length, SIXEL_MARKER_SCAN_LIMIT);
			if (start + 3 > limit || line.charCodeAt(start) !== 0x1b || line.charCodeAt(start + 1) !== 0x50) {
				return false;
			}
			let i = start + 2;
			while (i < limit) {
				const code = line.charCodeAt(i);
				if ((code >= 0x30 && code <= 0x39) || code === 0x3b) {
					i++;
					continue;
				}
				break;
			}
			return i < limit && line.charCodeAt(i) === 0x71;
		}

		const limit = Math.min(line.length, IMAGE_MARKER_SCAN_LIMIT);
		let protocolMatches = start + protocol.length <= limit;
		for (let offset = 0; protocolMatches && offset < protocol.length; offset++) {
			protocolMatches = line.charCodeAt(start + offset) === protocol.charCodeAt(offset);
		}
		return (
			protocolMatches ||
			(start + 2 <= limit &&
				line.charCodeAt(start) === KITTY_PLACEHOLDER_HIGH_SURROGATE &&
				line.charCodeAt(start + 1) === KITTY_PLACEHOLDER_LOW_SURROGATE)
		);
	}

	isImageLine(line: string): boolean {
		if (!this.imageProtocol) return false;
		const limit = Math.min(
			line.length,
			this.imageProtocol === ImageProtocol.Sixel ? SIXEL_MARKER_SCAN_LIMIT : IMAGE_MARKER_SCAN_LIMIT,
		);
		for (let i = 0; i < limit; i++) {
			const code = line.charCodeAt(i);
			if (code !== 0x1b && code !== KITTY_PLACEHOLDER_HIGH_SURROGATE) continue;
			if (this.hasImageMarkerAt(line, i)) return true;
		}
		return false;
	}

	/**
	 * Deliver a notification. The native side formats it, routes it through the
	 * hosting multiplexers' notifiers, and fans a BEL out to D-Bus; the sequence
	 * it returns goes out through the active terminal so it cannot split a frame.
	 */
	sendNotification(message: string | TerminalNotification): void {
		const sequence = sendTerminalNotification(message, {
			protocol: this.notifyProtocol,
			osc99Confirmed: osc99CapabilitiesConfirmed,
			headless: isTerminalHeadless(),
			env: Bun.env,
			platform: process.platform,
		});
		if (sequence) writeTerminalSequence(sequence);
	}
}

/**
 * Whether the terminal confirmed OSC 99 desktop-notification support via the
 * `p=?` query probe. Until confirmed, structured notifications collapse to a
 * single message line.
 */
let osc99CapabilitiesConfirmed = false;

/** Record the OSC 99 capability-probe result (called by ProcessTerminal). */
export function setOsc99Supported(supported: boolean): void {
	osc99CapabilitiesConfirmed = supported;
}

/** True when OSC 99 structured notifications have been confirmed available. */
export function isOsc99Supported(): boolean {
	return osc99CapabilitiesConfirmed;
}

/** The process-wide terminal snapshot, filled from the native profile at startup. */
export const TERMINAL = new TerminalInfo(
	detectTerminalProfile(Bun.env, {
		testRuntime: isBunTestRuntime(),
		stdoutTty: process.stdout.isTTY === true,
		platform: process.platform,
	}),
);

/**
 * Override terminal image protocol at runtime after capability probes complete.
 */
export function setTerminalImageProtocol(imageProtocol: ImageProtocol | null): void {
	TERMINAL.imageProtocol = imageProtocol;
}

/**
 * Override DECCARA rectangular-SGR capability at runtime. Used by tests to
 * exercise the optimizer and fallback paths deterministically — the default is
 * resolved once at import and force-disabled under the test runtime.
 */
export function setTerminalDeccara(enabled: boolean): void {
	TERMINAL.deccara = enabled;
}

/** Record the Glyph Protocol probe result (called by ProcessTerminal). */
export function setTerminalGlyphProtocol(supported: boolean): void {
	TERMINAL.glyphProtocol = supported;
}

/** Override screen-to-scrollback clear support for targeted renderer tests. */
export function setTerminalScreenToScrollback(enabled: boolean): void {
	TERMINAL.supportsScreenToScrollback = enabled;
}

/**
 * Enable/disable OSC 66 text-sizing at runtime. The coding-agent calls this from
 * the `tui.textSizing` setting (gated on the terminal's static `supportsTextSizing`
 * capability); tests flip it directly to exercise the scaled-heading path.
 */
export function setTerminalTextSizing(enabled: boolean): void {
	TERMINAL.textSizing = enabled;
}

/**
 * Override OSC 8 hyperlink capability at runtime. The coding-agent calls this
 * from the `tui.hyperlinks` setting so its resolved policy (`off`/`auto`/`always`)
 * drives every renderer that gates on {@link TERMINAL}`.hyperlinks` — notably the
 * Markdown component's `[text](url)`/bare-URL links — consistently with the
 * path/resource links that already consult the setting directly. Tests flip it
 * to exercise the OSC 8 and plain-text paths deterministically.
 */
export function setTerminalHyperlinks(enabled: boolean): void {
	TERMINAL.hyperlinks = enabled;
}
