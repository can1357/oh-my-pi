/** @jsxImportSource @oh-my-pi/pi-tui */
import {
	type Accessor,
	computed,
	effect,
	onCleanup,
	signal,
	type TranscriptScroller,
	type UiNode,
	untrack,
} from "@oh-my-pi/pi-tui";
import type { FramePresentation } from "@oh-my-pi/pi-tui/term/backend";
import { keyHintSpans } from "../../ui/keys/hints";
import { applyEdit, type LineValue } from "../../ui/overlays/panels/common";
import type { InteractiveModeContext } from "../types";

/** Find in the rendered transcript without replacing it or editing the composer's draft. */
export function showTranscriptFind(
	ctx: Pick<InteractiveModeContext, "shell" | "showEditorAreaDialog">,
	scroller: TranscriptScroller,
	presentation: Accessor<FramePresentation>,
): void {
	const { shell } = ctx;
	const ready = signal(false);
	let field!: UiNode;
	const dialog = ctx.showEditorAreaDialog(() => {
		const line = signal<LineValue>({ text: "", cursor: 0 });
		const query = computed(() => line().text);
		const notice = signal("");
		let revision = 0;
		let needsFrame = true;
		const clear = (): void => {
			++revision;
			scroller.clearFind();
			notice.set("");
		};
		onCleanup(clear);
		const find = async (text: string, direction: -1 | 1): Promise<void> => {
			const request = ++revision;
			notice.set("Searching…");
			try {
				// A newly mounted dock changes the window height. Under a fullscreen sheet there was no
				// transcript window at all. Use the first actual transcript frame in either case.
				if (needsFrame) {
					await shell.nextFrame();
					if (request !== revision) return;
					needsFrame = false;
				}
				const found = await scroller.findText(text, direction);
				if (request === revision) notice.set(found ? "" : "No matches");
			} catch {
				if (request === revision) notice.set("Could not search the transcript");
			}
		};
		effect(() => {
			if (!ready()) return;
			const focused = shell.focused();
			// A sheet temporarily borrows focus. A dock prompt taking it needs the real composer back.
			// A sheet removes itself before restoring focus. React to the focus handoff, not that gap.
			const displaced = focused !== field && !untrack(shell.overlays.open);
			if (presentation() !== "fullscreen" || shell.native() || displaced) untrack(() => dialog.close());
		});
		effect(() => {
			// A layer covering the transcript must not receive a late jump. Resume its query when uncovered.
			const covered = shell.overlays.open();
			if (covered) needsFrame = true;
			const text = covered ? "" : query();
			untrack(() => {
				if (text) void find(text, 1);
				else if (revision !== 0) clear();
			});
		});
		return (
			<col
				key="transcript-find"
				onKey={key => {
					if (key.kind === "release" || shell.overlays.open()) return false;
					if (key.id === "escape") dialog.close();
					else if (key.id === "enter" || key.id === "shift+enter") {
						const text = query();
						if (text) void find(text, key.id === "enter" ? 1 : -1);
					} else return false;
					return true;
				}}
			>
				<row align="center" gap="sm">
					<text spans={[{ s: "accent", t: "Find in transcript" }]} wrap="none" />
					<input
						key="query"
						aria="Find in transcript"
						grow={1}
						basis={1}
						shrink={0}
						sendable={false}
						ref={node => {
							field = node;
						}}
						text={query}
						cursor={() => line().cursor}
						onEdit={edit => {
							const next = applyEdit(line.peek(), edit);
							if (next) line.set(next);
						}}
					/>
				</row>
				<text
					wrap="word"
					spans={() => [
						...(notice() ? [{ s: "muted", t: `${notice()}  ` }] : []),
						...keyHintSpans("enter", "next"),
						{ t: "  " },
						...keyHintSpans("shift+enter", "previous"),
						{ t: "  " },
						...keyHintSpans("escape", "close"),
					]}
				/>
			</col>
		);
	});
	// A closing sheet may explicitly focus home: return to the input widget, not its parent column.
	shell.setHome(field);
	ready.set(true);
}
