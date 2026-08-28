import { Markdown } from "@oh-my-pi/collab-web/src/components/transcript/Markdown";
import { useCallback, useEffect, useState } from "react";
import type { RpcBridge } from "../rpc/bridge";
import type { ExtensionUiRequestFrame } from "../rpc/protocol";
import { useEscape } from "../shell/useEscape";

/**
 * Renders the blocking half of the Extension UI sub-protocol.
 *
 * Only `confirm`, `select`, `input` and `editor` reach here — the bridge routes
 * `open_url` to the system browser and drops the fire-and-forget methods
 * (`setWidget`, `setStatus`, `notify`, …), which was verified safe: an
 * unanswered `setWidget` did not wedge the server.
 *
 * Note that with omp's default `yolo` approval mode this dialog rarely fires;
 * it takes a non-yolo mode, an explicit per-tool `prompt` policy, or a provider
 * safety check.
 */
export function ApprovalDialog({ request, bridge }: { request: ExtensionUiRequestFrame; bridge: RpcBridge }) {
	const [draft, setDraft] = useState(request.prefill ?? "");

	/*
	 * A fresh request must not inherit the previous one's draft — but an `editor`
	 * request arrives carrying the document it wants edited (`/review`'s custom
	 * mode sends "Review the following:\n\n"), so the reset seeds from `prefill`
	 * rather than blanking. Blanking made Submit answer "" over the caller's text.
	 *
	 * `request.id` stays in the deps because two consecutive requests can carry the
	 * same prefill (both absent, say), and typing still must not cross between them.
	 */
	useEffect(() => setDraft(request.prefill ?? ""), [request.id, request.prefill]);

	/*
	 * Numbers pick, arrows walk. The rows print the same number, so the two never
	 * disagree — and a list of repository paths is something you answer with one
	 * key rather than by aiming at it.
	 */
	useEffect(() => {
		if (request.method !== "select") return;
		const options = request.options ?? [];
		const onKey = (event: KeyboardEvent) => {
			if (event.metaKey || event.ctrlKey || event.altKey) return;
			if (event.key >= "1" && event.key <= "9") {
				const option = options[Number(event.key) - 1];
				if (!option) return;
				event.preventDefault();
				bridge.answerUi({ id: request.id, value: option });
				return;
			}
			if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
			const rows = [...document.querySelectorAll<HTMLButtonElement>(".omp-option")];
			if (rows.length === 0) return;
			event.preventDefault();
			const current = rows.indexOf(document.activeElement as HTMLButtonElement);
			const step = event.key === "ArrowDown" ? 1 : -1;
			// Wrapping: reaching the last item from the top is one press, not four.
			rows[(current + step + rows.length) % rows.length]?.focus();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [bridge, request.id, request.method, request.options]);

	// The server resolves to a default when its own timeout fires — but it emits
	// no `cancel` when it does, so the bridge runs that same deadline and
	// withdraws the request. Escape only communicates intent, it does not race it.
	useEscape(
		useCallback(
			(event: KeyboardEvent) => {
				// Claiming the key matters even though session.tsx already stands
				// down for `pendingUi`: it is what stops any other Escape consumer
				// added later from acting on the same press.
				event.preventDefault();
				bridge.answerUi({ id: request.id, cancelled: true });
			},
			[bridge, request.id],
		),
	);

	const title = request.title ?? defaultTitle(request.method);

	/*
	 * A plan review carries the plan. The server marks it with `planFilePath`,
	 * which is also what says the message is markdown — an `ask` sends prose, and
	 * running that through a markdown renderer would reinterpret its punctuation.
	 */
	const plan = request.planFilePath ? request.message : undefined;

	return (
		<div className="omp-backdrop" role="dialog" aria-modal="true" aria-label={title}>
			{/* A document needs a settled size; a list of choices only needs room. */}
			<div
				className={`omp-modal${plan ? " omp-modal--document" : request.method === "select" ? " omp-modal--wide" : ""}`}
			>
				<h2 className="omp-modal__title">{title}</h2>

				{/*
				 * The plan comes before the choices, because that is the order it is
				 * read in: what you are approving, then what you can do about it.
				 * `Markdown` emits its own `.tr-md`; this div is only the scroller.
				 */}
				{plan ? (
					<div className="omp-modal__plan">
						<Markdown text={plan} />
					</div>
				) : request.message ? (
					<p className="omp-modal__message">{request.message}</p>
				) : null}

				{request.method === "select" ? (
					/*
					 * Rows, not buttons. These were `data-component="button"`, which is
					 * built for a short action: it centres its content and sets
					 * `white-space: nowrap`, so a choice carrying a sentence of detail came
					 * out centred and ran straight out of the dialog. A choice is a line of
					 * reading — left aligned, and it wraps.
					 */
					<div className="omp-modal__options" role="listbox" aria-label={title}>
						{(request.options ?? []).map((option, index) => (
							<button
								className="omp-option"
								key={option}
								type="button"
								role="option"
								aria-selected={false}
								// The first is reachable with Enter alone, the rest by their number
								// or by arrowing. A blocking dialog that needs the mouse interrupts
								// you twice.
								autoFocus={index === 0}
								onClick={() => bridge.answerUi({ id: request.id, value: option })}
							>
								<span className="omp-option__key" aria-hidden="true">
									{index < 9 ? index + 1 : "·"}
								</span>
								<span className="omp-option__text">
									<span className="omp-option__label">{option}</span>
									{request.optionDetails?.[index]?.description ? (
										<span className="omp-option__desc">{request.optionDetails[index].description}</span>
									) : null}
								</span>
							</button>
						))}
					</div>
				) : null}

				{request.method === "input" || request.method === "editor" ? (
					<textarea
						className="omp-input"
						autoFocus
						rows={request.method === "editor" ? 8 : 2}
						placeholder={request.placeholder}
						value={draft}
						onChange={event => setDraft(event.target.value)}
						onKeyDown={event => {
							if (event.key === "Enter" && !event.shiftKey && request.method === "input") {
								event.preventDefault();
								bridge.answerUi({ id: request.id, value: draft });
							}
						}}
					/>
				) : null}

				{/*
				 * Says the shortcut out loud. The numbers on the rows are only useful
				 * to someone who knows they are keys and not decoration.
				 */}
				{request.method === "select" && (request.options?.length ?? 0) > 0 ? (
					<p className="omp-modal__hint">
						{`1–${Math.min(9, request.options?.length ?? 0)} to pick · ↑↓ to move · esc to cancel`}
					</p>
				) : null}

				<div className="omp-modal__actions">
					<button
						type="button"
						data-component="button"
						data-size="normal"
						data-variant="ghost"
						onClick={() => bridge.answerUi({ id: request.id, cancelled: true })}
					>
						Cancel
					</button>

					{request.method === "confirm" ? (
						<>
							<button
								type="button"
								data-component="button"
								data-size="normal"
								data-variant="ghost"
								onClick={() => bridge.answerUi({ id: request.id, confirmed: false })}
							>
								No
							</button>
							<button
								type="button"
								data-component="button"
								data-size="normal"
								data-variant="primary"
								onClick={() => bridge.answerUi({ id: request.id, confirmed: true })}
							>
								Yes
							</button>
						</>
					) : null}

					{request.method === "input" || request.method === "editor" ? (
						<button
							type="button"
							data-component="button"
							data-size="normal"
							data-variant="primary"
							onClick={() => bridge.answerUi({ id: request.id, value: draft })}
						>
							Submit
						</button>
					) : null}
				</div>
			</div>
		</div>
	);
}

function defaultTitle(method: string): string {
	switch (method) {
		case "confirm":
			return "Confirm";
		case "select":
			return "Choose an option";
		case "editor":
			return "Edit";
		default:
			return "Input";
	}
}
