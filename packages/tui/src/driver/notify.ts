/**
 * Desktop notifications through the terminal.
 *
 * The emulator's in-band sequence ({@link NotifyProtocol}: BEL, OSC 9 or
 * Kitty's OSC 99) is offered to the multiplexers that would swallow it first
 * (`mux/notify.ts`), then written. Where the emulator only rings the bell, a
 * Linux desktop session also gets a D-Bus toast (`desktop-notify.ts`).
 *
 * `PI_NOTIFICATIONS=off|0|false` suppresses every notification, and nothing
 * is sent while the terminal is headless (tests, non-interactive runs).
 */
import { isTerminalHeadless } from "@oh-my-pi/pi-utils/env";
import type { NotifyProtocol } from "./caps/identity";
import { sendDesktopNotification, shouldDeliverDesktopNotification } from "./desktop-notify";
import type { Env } from "./mux/detect";
import { routeMultiplexerNotification } from "./mux/notify";

/**
 * A structured notification. OSC 99 carries every field once the terminal
 * confirmed rich support; every other path collapses it to a single
 * `title: body` line.
 */
export interface TerminalNotification {
	title?: string;
	body?: string;
	id?: string;
	type?: string | string[];
	urgency?: "low" | "normal" | "critical";
	iconName?: string;
	sound?: "silent" | "system" | "info" | "warning" | "error" | "question";
	actions?: "focus" | "report" | "focus-report" | "none";
	expiresMs?: number;
}

/** Where a notification goes: the terminal's protocol and the ordered output path. */
export interface NotificationTarget {
	readonly protocol: NotifyProtocol;
	/** The terminal confirmed structured OSC 99 (see `TerminalIdentity.richNotifications`). */
	readonly rich: boolean;
	/** Environment the multiplexer routing reads (session markers are checked at send time). */
	readonly env: Env;
	write(data: string): void;
}

/** Whether `PI_NOTIFICATIONS` turns notifications off. */
export function isNotificationSuppressed(env: Env): boolean {
	const value = env.PI_NOTIFICATIONS;
	return value === "off" || value === "0" || value === "false";
}

const PROTOCOL_PREFIX: Readonly<Record<Exclude<NotifyProtocol, "bell">, string>> = {
	osc9: "\x1b]9;",
	osc99: "\x1b]99;;",
};

/** `message` as the terminal's notification sequence. */
export function formatNotification(
	message: string | TerminalNotification,
	protocol: NotifyProtocol,
	rich: boolean,
): string {
	if (protocol === "bell") return "\x07";
	if (typeof message === "string") return `${PROTOCOL_PREFIX[protocol]}${message}\x1b\\`;
	if (protocol === "osc99" && rich) return formatOsc99(message);
	const line =
		message.title && message.body ? `${message.title}: ${message.body}` : (message.title ?? message.body ?? "");
	return `${PROTOCOL_PREFIX[protocol]}${line}\x1b\\`;
}

/**
 * Deliver `message`: a multiplexer notifier when one owns the session, else the
 * terminal sequence (plus a D-Bus toast behind a bare BEL on a Linux desktop).
 */
export function sendNotification(message: string | TerminalNotification, target: NotificationTarget): void {
	if (isNotificationSuppressed(target.env) || isTerminalHeadless()) return;
	const sequence = formatNotification(message, target.protocol, target.rich);
	const bell = target.protocol === "bell";
	const routed = routeMultiplexerNotification({
		message,
		env: target.env,
		sequence: bell ? null : sequence,
		write: data => target.write(data),
	});
	if (routed) return;
	target.write(sequence);
	// BEL surfaces no toast on VTE-family terminals, Alacritty or bare xterm; the bell still
	// rings for tmux monitor-bell, X11 urgency hints and audible bells.
	if (bell && shouldDeliverDesktopNotification(target.env)) sendDesktopNotification(message);
}

// ── OSC 99 ────────────────────────────────────────────────────────────────

// C0/C1 controls cannot ride in an OSC payload as text; such payloads go base64.
const OSC99_UNSAFE = /[\x00-\x1f\x7f\x80-\x9f]/u;
const OSC99_MAX_PAYLOAD_BYTES = 2048;
const OSC99_APP_NAME = "omp";
// Kitty matches notification ids across its whole process, so ids carry a
// per-process prefix: two omp sessions in one kitty must not replace each other's.
const OSC99_ID_PREFIX = `omp-${crypto.randomUUID().slice(0, 8)}`;
let nextOsc99Id = 1;

function base64(value: string): string {
	return Buffer.from(value, "utf8").toString("base64");
}

function osc99Id(id: string | undefined): string {
	const safe = id?.replace(/[^a-zA-Z0-9_+\-.]/gu, "") ?? "";
	return safe && safe !== "0" ? safe : `${OSC99_ID_PREFIX}-${nextOsc99Id++}`;
}

/** `payload` split at code-point boundaries into chunks of at most the OSC 99 byte limit. */
function chunkUtf8(payload: string): string[] {
	if (payload === "") return [""];
	const chunks: string[] = [];
	let start = 0;
	let index = 0;
	let bytes = 0;
	for (const char of payload) {
		const size = Buffer.byteLength(char, "utf8");
		if (bytes > 0 && bytes + size > OSC99_MAX_PAYLOAD_BYTES) {
			chunks.push(payload.slice(start, index));
			start = index;
			bytes = 0;
		}
		bytes += size;
		index += char.length;
	}
	chunks.push(payload.slice(start));
	return chunks;
}

function osc99Chunk(meta: readonly string[], payload: string): string {
	if (OSC99_UNSAFE.test(payload)) return `\x1b]99;${[...meta, "e=1"].join(":")};${base64(payload)}\x1b\\`;
	return `\x1b]99;${meta.join(":")};${payload}\x1b\\`;
}

/** Every chunk but the last carries `d=0` (not done); `hold` keeps the last one open too. */
function osc99Payload(meta: readonly string[], payload: string, hold: boolean): string {
	const chunks = chunkUtf8(payload);
	let out = "";
	for (let i = 0; i < chunks.length; i++) {
		const open = hold || i < chunks.length - 1;
		out += osc99Chunk(open ? [...meta, "d=0"] : meta, chunks[i]!);
	}
	return out;
}

const OSC99_URGENCY: Readonly<Record<NonNullable<TerminalNotification["urgency"]>, string>> = {
	low: "0",
	normal: "1",
	critical: "2",
};

const OSC99_ACTIONS: Readonly<Record<NonNullable<TerminalNotification["actions"]>, string>> = {
	focus: "focus",
	report: "report",
	"focus-report": "focus,report",
	none: "-focus",
};

/**
 * A structured notification as OSC 99 title and body payloads sharing one id;
 * the final title or body chunk displays it. Application name, types, icon
 * and sound are base64-encoded.
 */
function formatOsc99(n: TerminalNotification): string {
	const id = osc99Id(n.id);
	const meta = [`i=${id}`, `f=${base64(OSC99_APP_NAME)}`];
	if (n.actions) meta.push(`a=${OSC99_ACTIONS[n.actions]}`);
	if (n.urgency) meta.push(`u=${OSC99_URGENCY[n.urgency]}`);
	for (const type of n.type === undefined ? [] : [n.type].flat()) meta.push(`t=${base64(type)}`);
	if (n.iconName) meta.push(`n=${base64(n.iconName)}`);
	if (n.sound) meta.push(`s=${base64(n.sound)}`);
	if (n.expiresMs !== undefined && Number.isFinite(n.expiresMs)) {
		meta.push(`w=${Math.max(-1, Math.trunc(n.expiresMs))}`);
	}
	const title = n.title ?? n.body ?? "";
	const body = n.title ? n.body : undefined;
	if (body) return osc99Payload(meta, title, true) + osc99Payload([`i=${id}`, "p=body"], body, false);
	return osc99Payload(meta, title, false);
}
