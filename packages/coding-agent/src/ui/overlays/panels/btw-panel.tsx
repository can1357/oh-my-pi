/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The `/btw` side-answer sheet: the question as its head (a spinner while
 * the answer streams or branches), the answer (its `<inject>` block apart
 * when the panel can inject), and a footer of status and key hints.
 *
 * {@link BtwPanelState} holds what the controller drives (answer deltas,
 * completion, copy, inject, branch, cancel, error). Capability checks
 * (`canFollowUp`, `canBranch`, `canInject`) are asked whenever the state
 * changes, not continuously.
 */
import { type JSXNode, type Signal, signal, untrack } from "@oh-my-pi/pi-tui";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import { BtwAnswerBody, flatError } from "./btw-answer";
import { Hints, type KeyHint } from "./common";
import { matchesAppInterrupt } from "../../../config/keybindings/matchers";
import { interruptKbd } from "../../keys/hints";

/** Where the side answer stands. */
export type BtwPanelStatus = "streaming" | "complete" | "branching" | "aborted" | "error";

/** The panel's live state, driven by the btw controller. */
export class BtwPanelState {
	readonly answer = signal("");
	readonly status = signal<BtwPanelStatus>("streaming");
	readonly error = signal<string | undefined>(undefined);
	readonly copied = signal(false);
	readonly injected = signal(false);
	/** The topic heading (`/sitrep …`); defaults to `/btw <question>`. */
	readonly title: Signal<string | undefined>;
	#closed = false;

	constructor(title?: string) {
		this.title = signal(title);
	}

	appendText(delta: string): void {
		if (this.#closed) return;
		this.answer.set(this.answer() + delta);
		this.copied.set(false);
	}
	setAnswer(text: string): void {
		if (this.#closed) return;
		this.answer.set(text);
	}
	markComplete(): void {
		if (!this.#closed) this.status.set("complete");
	}
	markCopied(): void {
		if (!this.#closed) this.copied.set(true);
	}
	setInjected(injected: boolean): void {
		if (!this.#closed) this.injected.set(injected);
	}
	markBranching(): void {
		if (!this.#closed) this.status.set("branching");
	}
	markAborted(): void {
		if (!this.#closed) this.status.set("aborted");
	}
	markError(message: string): void {
		if (this.#closed) return;
		this.error.set(message);
		this.status.set("error");
	}
	/** Freeze the panel: later updates are ignored. */
	close(): void {
		this.#closed = true;
	}
}

export interface BtwPanelProps {
	readonly question: string;
	readonly state: BtwPanelState;
	canFollowUp(): boolean;
	/** Absent: branching is always offered. */
	canBranch?(): boolean;
	/** Absent: the panel never shows `<inject>` blocks apart. */
	canInject?(): boolean;
	onCancel?(): void;
	onClose?(): void;
	onCopy?(): void;
	onBranch?(): void;
	onInject?(): void;
	onFollowUp?(): void;
}

/** What the footer says beside its hints. */
interface Footer {
	readonly status?: TspSpan;
	readonly hints: readonly KeyHint[];
	/** Replaces status and hints (branching). */
	readonly note?: TspSpan;
}

function footerOf(props: BtwPanelProps): Footer {
	const { state } = props;
	const status = state.status();
	const copied = state.copied();
	const hasText = state.answer().trim() !== "";
	return untrack(() => {
		switch (status) {
			case "streaming":
				return { hints: [{ keys: interruptKbd(), label: "to cancel" }] };
			case "branching":
				return { hints: [], note: { s: "muted", t: "⏳ Branching to chat…" } };
			case "aborted":
				return { status: { s: "warning", t: "⚠ Cancelled" }, hints: [{ keys: interruptKbd(), label: "to close" }] };
			case "error":
				return { status: { s: "error", t: "✘ Error" }, hints: [{ keys: interruptKbd(), label: "to close" }] };
		}
		if (!hasText) return { hints: [{ keys: interruptKbd(), label: "to close" }] };
		const hints: KeyHint[] = [];
		if (props.canInject?.()) hints.push({ keys: ["alt", "i"], label: "to inject" });
		hints.push({ keys: ["c"], label: copied ? "to copy again" : "to copy" });
		if (props.canBranch?.() ?? true) hints.push({ keys: ["b"], label: "to branch" });
		if (props.canFollowUp()) hints.push({ keys: ["f"], label: "to follow up" });
		hints.push({ keys: interruptKbd(), label: "to close" });
		return copied ? { status: { s: "success", t: "✓ Copied to clipboard" }, hints } : { hints };
	});
}

/** The head's spans: a `/command` title splits into its accented command and the rest. */
function headSpans(title: string | undefined, question: string): TspSpan[] {
	if (title === undefined) return [{ s: "accent", t: "/btw" }, { t: ` ${question}` }];
	const space = title.indexOf(" ");
	if (space === -1) return [{ s: "accent", t: title }];
	return [{ s: "accent", t: title.slice(0, space) }, { t: title.slice(space) }];
}

export function BtwPanel(props: BtwPanelProps): JSXNode {
	const { state } = props;
	// The native head keeps the title the panel opened with.
	const head = headSpans(untrack(state.title), props.question);
	const busy = () => state.status() === "streaming" || state.status() === "branching";
	const tone = () => (state.status() === "aborted" ? "warning" : state.status() === "error" ? "error" : undefined);
	const footer = () => footerOf(props);
	const body = (): JSXNode => {
		const status = state.status();
		const answer = state.answer();
		if (status === "error") {
			const message = flatError(state.error());
			return <text wrap="word" spans={[{ s: "error", t: message }]} />;
		}
		if (answer.trim() === "") {
			const text = status === "streaming" ? "⏳ Waiting for response…" : "No text returned.";
			return <text spans={[{ s: "dim", t: text }]} />;
		}
		const inject = props.canInject ? (state.injected() ? "sent" : "pending") : undefined;
		return <BtwAnswerBody answer={answer} inject={inject} stream={status === "streaming"} />;
	};
	return (
		<col
			role="omp.overlay.btw"
			gap="sm"
			tone={tone}
			term={() => {
				const title = state.title();
				// Only the default title carries the copy badge.
				const copied = title === undefined && state.copied() && state.status() === "complete";
				return { title: title ?? `/btw ${props.question}`, copied };
			}}
			onKey={key => {
				const status = untrack(state.status);
				if (matchesAppInterrupt(key)) {
					if (status === "streaming") props.onCancel?.();
					else props.onClose?.();
					return true;
				}
				switch (key.id) {
					case "c":
						if (status !== "complete") return false;
						props.onCopy?.();
						return true;
					case "b":
						if (status !== "complete") return false;
						props.onBranch?.();
						return true;
					case "f":
						if (status !== "complete") return false;
						props.onFollowUp?.();
						return true;
					case "alt+i":
						if (status !== "complete") return false;
						props.onInject?.();
						return true;
				}
				return false;
			}}
		>
			<row role="omp.sheet.head" align="center" gap="sm">
				{() => busy() && <spinner />}
				<text lines={1} truncate="end" spans={head} />
			</row>
			{body}
			{() => {
				const { status, hints, note } = footer();
				if (note) return <text spans={[note]} />;
				if (!status) return <Hints hints={hints} />;
				return (
					<row align="center" gap="md" wrap>
						<text spans={[status]} />
						<Hints hints={hints} />
					</row>
				);
			}}
		</col>
	);
}
