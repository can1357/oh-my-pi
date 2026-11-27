/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The working row: what the agent is doing while a turn runs, in the dock's
 * `status` slot.
 *
 * - Natively (role `omp.working`): a `starburst` spinner (a countdown ring
 *   while a retry waits), the elapsed time, a `·`, the label shimmering, a
 *   spacer, an indeterminate bar while compacting, and the stop control
 *   (`kbd` + Stop/Cancel) whose click sends `interrupt`.
 * - In a text terminal (`src/ui/styles/dock/working.ts`): a blank row, then
 *   the interrupt key where a spinner would stand (the status line already
 *   spins) and the label shimmering; maintenance runs (compaction, a retry
 *   countdown) show a spinner and a muted line ending in `(⎋ to cancel)`. A
 *   right-docked trailer (tok/s, a title) follows when there is room.
 *
 * A function label is live: it is re-read on every terminal frame and once a
 * second natively, and kept to its first line.
 */
import {
	type Accessor,
	computed,
	type JSXNode,
	onCleanup,
	type Reactive,
	read,
	signal,
	untrack,
} from "@oh-my-pi/pi-tui";
import { formatDuration } from "@oh-my-pi/pi-utils";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import "../styles/dock";
import type { WorkingTerm } from "../styles/dock/working";
import { kbdKeys } from "@oh-my-pi/pi-tui/theme/keys";
import { formatTooltipKey } from "../keys/hints";

/** A maintenance run in the working row's place: a retry waiting out its delay, or context compaction. */
export type WorkingVariant =
	| {
			readonly kind: "retry";
			readonly attempt: number;
			readonly max: number;
			/** The wait before the attempt, in ms, counted from the row's `startedAt`. */
			readonly delayMs: number;
			/** Why the last attempt failed (one line), if known. */
			readonly reason?: string;
	  }
	| { readonly kind: "compaction" };

/** The session accent the label shimmers in (hex colors). */
export interface WorkingAccent {
	readonly main: string;
	readonly dim: string;
}

/** The label's look: animated sweep, scanner, or none (`display.shimmer`). */
export type WorkingShimmer = "classic" | "kitt" | "disabled";

/** What the working row shows. */
export interface WorkingSpec {
	/** The intent (`Working…`), or a live label re-read per frame; compaction's label (`Compacting context…`). Ignored for a retry, which names its attempt. */
	readonly label: string | (() => string);
	/** Epoch ms the work started: the elapsed origin and the retry countdown's start. */
	readonly startedAt: number;
	readonly variant?: WorkingVariant;
	/** Key that interrupts (`escape`); undefined hides the stop control and the cancel hint. */
	readonly interruptKey?: string;
	/** The session accent; an accessor follows a rename or an accent toggle mid-run. */
	readonly accent?: Reactive<WorkingAccent | undefined>;
	/** Default `classic`. */
	readonly shimmer?: WorkingShimmer;
	/** Right-docked trailer, already styled: the tok/s reading, a title. */
	readonly trailer?: () => string | undefined;
}

export interface WorkingRowProps {
	readonly spec: WorkingSpec;
	/** A click on the stop control (natively) — the interrupt key's handler. */
	readonly onInterrupt?: () => void;
	/** Wall clock (ms); the native elapsed age and countdown read it. */
	readonly now?: () => number;
	readonly nodeKey?: string;
}

/** Native label palette: the default sweep, or the session accent's. */
const DEFAULT_PALETTE = { low: "dim", mid: "muted", high: "accent" } as const;
const ACCENT_PALETTE = { low: "dim", mid: "accent", high: "accent" } as const;
/** Native repaint cadence of a retry ring and of a live label. */
const NATIVE_TICK_MS = 500;
const LIVE_LABEL_MS = 1000;

/** The first line of a label. */
function oneRow(text: string): string {
	const end = text.indexOf("\n");
	return end < 0 ? text : text.slice(0, end);
}

/** The intent the native row shows. */
export function workingLabel(spec: WorkingSpec): string {
	const variant = spec.variant;
	if (variant?.kind === "retry") {
		const attempt = `Retrying · attempt ${variant.attempt} of ${variant.max}`;
		return variant.reason ? `${attempt} · ${variant.reason}` : attempt;
	}
	return oneRow(typeof spec.label === "function" ? spec.label() : spec.label);
}

/** The line a text terminal shows at wall time `now`. */
export function workingMessage(spec: WorkingSpec, now: number, keyLabel: (key: string) => string): string {
	const variant = spec.variant;
	const cancel = spec.interruptKey === undefined ? "" : ` (${keyLabel(spec.interruptKey)} to cancel)`;
	if (variant?.kind === "retry") {
		const remaining = Math.max(0, variant.delayMs - (now - spec.startedAt));
		const wait = `Retrying (${variant.attempt}/${variant.max}) in ${formatDuration(remaining)}`;
		return `${variant.reason ? `${wait} · ${variant.reason}` : `${wait}…`}${cancel}`;
	}
	const label = oneRow(typeof spec.label === "function" ? spec.label() : spec.label);
	return variant?.kind === "compaction" ? `${label}${cancel}` : label;
}

/** See the module docs. */
export function WorkingRow(props: WorkingRowProps): JSXNode {
	const spec = props.spec;
	const now = props.now ?? Date.now;
	const variant = spec.variant;
	const shimmer = spec.shimmer ?? "classic";
	// Natively the terminal clocks spinner, elapsed and shimmer; omp only moves a retry ring and a live label.
	const tick = signal(0);
	const live = typeof spec.label === "function";
	if (live || variant?.kind === "retry") {
		const timer = setInterval(() => tick.set(tick.peek() + 1), live ? LIVE_LABEL_MS : NATIVE_TICK_MS);
		timer.unref?.();
		onCleanup(() => clearInterval(timer));
	}
	const label = computed(() => {
		tick();
		return workingLabel(spec);
	});
	const age = Math.max(0, untrack(now) - spec.startedAt);
	const countdown: Accessor<number> = computed(() => {
		tick();
		if (variant?.kind !== "retry" || variant.delayMs <= 0) return 0;
		const remaining = Math.max(0, variant.delayMs - (untrack(now) - spec.startedAt));
		return Math.round((remaining / variant.delayMs) * 100) / 100;
	});
	const accent = computed(() => read(spec.accent));
	const palette = computed(() => (accent() ? ACCENT_PALETTE : DEFAULT_PALETTE));
	const spans = (): TspSpan[] => (label() === "" ? [] : [{ t: label(), s: palette().mid }]);
	const verb = variant?.kind === "retry" ? "Cancel" : "Stop";
	const term = (): WorkingTerm => ({
		look: variant ? "maintenance" : "working",
		key: spec.interruptKey,
		tone: variant?.kind === "retry" ? "warning" : "accent",
		message: (time, keyLabel) => workingMessage(spec, time, keyLabel),
		live,
		...(variant?.kind === "retry" ? { countdown: true } : {}),
		...(variant || shimmer === "disabled" ? {} : { shimmer }),
		...(accent() ? { accent: accent() } : {}),
		...(spec.trailer ? { trailer: spec.trailer } : {}),
	});
	return (
		<row
			key={props.nodeKey}
			role="omp.working"
			align="center"
			gap="sm"
			term={term}
			onAction={act => {
				if (act === "interrupt") props.onInterrupt?.();
			}}
		>
			{variant?.kind === "retry" ? (
				<meter key="countdown" value={countdown} style="ring" size="sm" />
			) : (
				<spinner key="spinner" style="starburst" tone="accent" />
			)}
			<elapsed key="elapsed" age={age} format="short" />
			<text key="sep" text="·" role="omp.working.sep" />
			{shimmer === "disabled" ? (
				<text key="label" spans={spans} role="omp.working.label" />
			) : (
				<shimmer key="label" spans={spans} mode={shimmer} palette={palette} role="omp.working.label" />
			)}
			<row key="fill" grow={1} />
			{variant?.kind === "compaction" && <progress key="progress" value={null} />}
			{spec.interruptKey !== undefined && (
				<row
					key="stop"
					role="omp.working.stop"
					gap="xs"
					align="center"
					title={`${verb}  ${formatTooltipKey(spec.interruptKey)}`}
					actions={{ click: "interrupt" }}
				>
					<kbd keys={kbdKeys(spec.interruptKey)} />
					<text text={verb} />
				</row>
			)}
		</row>
	);
}

/** The idle row offering to retry a turn that died on a tool call (`F5 to retry`). */
export function RetryHint(props: { readonly retryKey: string; readonly nodeKey?: string }): JSXNode {
	return (
		<row key={props.nodeKey} role="omp.hint.retry" gap="sm" align="center" term={{ key: props.retryKey }}>
			<icon name="loop" tone="muted" />
			<kbd key="key" keys={kbdKeys(props.retryKey)} />
			<text spans={[{ t: "to retry", s: "muted" }]} />
		</row>
	);
}
