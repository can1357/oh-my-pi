/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The `/omfg` sheet: a complaint turned into a TTSR rule. The head names the
 * complaint (a spinner while work runs), then the current status, the
 * candidate rule as it streams in (or the error), and the footer: escape
 * cancels while working and dismisses once it ended (saved elsewhere, not
 * saved, cancelled or failed).
 *
 * {@link OmfgPanelState} holds what the controller drives.
 */
import { type JSXNode, signal, untrack } from "@oh-my-pi/pi-tui";
import type { TspSpan, TspTone } from "@oh-my-pi/pi-wire";
import { sanitizeDisplayText } from "../../../extensibility/inventory/display-text";
import "../../styles/panels/omfg";
import { Hints } from "./common";
import { matchesAppInterrupt } from "../../../config/keybindings/matchers";
import { interruptKbd } from "../../keys/hints";

/** What the controller is doing. */
export type OmfgWork = "generating" | "validating" | "confirming" | "saving";

/** How the run ended. */
export type OmfgEnd = "rejected" | "aborted" | "error";

export class OmfgPanelState {
	readonly work = signal<OmfgWork>("generating");
	readonly message = signal("Generating TTSR rule…");
	/** The candidate rule: streamed draft text, or the rule set whole. */
	readonly candidate = signal("");
	readonly end = signal<OmfgEnd | undefined>(undefined);
	readonly error = signal("");
	#closed = false;

	appendDraft(delta: string): void {
		if (!this.#closed && delta) this.candidate.set(this.candidate() + delta);
	}
	setRule(rule: string): void {
		if (!this.#closed) this.candidate.set(rule);
	}
	setStatus(work: OmfgWork, message: string): void {
		if (this.#closed) return;
		this.work.set(work);
		this.message.set(message);
		this.end.set(undefined);
	}
	markRejected(): void {
		this.#finish("rejected", "Rule was not saved.");
	}
	markAborted(): void {
		this.#finish("aborted", "Cancelled.");
	}
	markError(error: string): void {
		if (this.#closed) return;
		this.error.set(error);
		this.#finish("error", "Could not create rule.");
	}
	/** Freeze the sheet: later updates are ignored. */
	close(): void {
		this.#closed = true;
	}
	#finish(end: OmfgEnd, message: string): void {
		if (this.#closed) return;
		this.message.set(message);
		this.end.set(end);
	}
}

const ENDINGS: Readonly<Record<OmfgEnd, { readonly tone: TspTone; readonly status: TspSpan }>> = {
	rejected: { tone: "warning", status: { s: "warning", t: "⚠ Not saved" } },
	aborted: { tone: "warning", status: { s: "warning", t: "⚠ Cancelled" } },
	error: { tone: "error", status: { s: "error", t: "✘ Error" } },
};

export interface OmfgPanelProps {
	readonly complaint: string;
	readonly state: OmfgPanelState;
	/** Escape while working. */
	onCancel?(): void;
	/** Escape once ended. */
	onDismiss?(): void;
}

export function OmfgPanel(props: OmfgPanelProps): JSXNode {
	const { state } = props;
	const complaint = sanitizeDisplayText(props.complaint);
	const ending = () => {
		const end = state.end();
		return end ? ENDINGS[end] : undefined;
	};
	return (
		<col
			role="omp.overlay.omfg"
			gap="sm"
			tone={() => ending()?.tone}
			term={{ title: `/omfg${complaint.trim() ? ` ${complaint.replace(/\s+/g, " ").trim()}` : ""}` }}
			onKey={key => {
				if (!matchesAppInterrupt(key)) return false;
				if (untrack(state.end)) props.onDismiss?.();
				else props.onCancel?.();
				return true;
			}}
		>
			<row role="omp.sheet.head" align="center" gap="sm">
				{() => !state.end() && <spinner />}
				<text lines={1} truncate="end" spans={[{ s: "accent", t: "/omfg" }, { t: ` ${complaint}` }]} />
			</row>
			<text wrap="word" spans={() => [{ s: "muted", t: sanitizeDisplayText(state.message()) }]} />
			{() => {
				if (state.end() === "error") {
					return <text wrap="word" spans={[{ s: "error", t: sanitizeDisplayText(state.error()).trim() }]} />;
				}
				const candidate = sanitizeDisplayText(state.candidate()).trim();
				if (!candidate) return <text spans={[{ s: "dim", t: "⏳ Waiting for candidate rule…" }]} />;
				return <md text={candidate} stream={!state.end() && state.work() === "generating"} />;
			}}
			{() => {
				const end = ending();
				if (!end) return <Hints hints={[{ keys: interruptKbd(), label: "cancel /omfg" }]} />;
				return (
					<row align="center" gap="md" wrap>
						<text spans={[end.status]} />
						<Hints hints={[{ keys: interruptKbd(), label: "dismiss" }]} />
					</row>
				);
			}}
		</col>
	);
}
