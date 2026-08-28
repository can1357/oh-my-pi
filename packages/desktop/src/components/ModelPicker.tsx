import { useCallback, useEffect, useRef, useState } from "react";
import type { RpcBridge } from "../rpc/bridge";
import type { RpcSessionState } from "../rpc/protocol";
import { thinkingLevels } from "../rpc/thinking";
import { useEscape } from "../shell/useEscape";

/**
 * Model and thinking-level selector.
 *
 * Both apply to the live session: `set_model` and `set_thinking_level` are real
 * RPC commands, so a change takes effect on the next turn without a restart.
 * The model list is fetched lazily — `get_available_models` walks the catalog
 * and there is no reason to pay for it until someone opens the menu.
 */
export function ModelPicker({ bridge, state }: { bridge: RpcBridge; state: RpcSessionState | null }) {
	const [open, setOpen] = useState(false);
	const [models, setModels] = useState<Array<{ provider: string; id: string }> | null>(null);
	/*
	 * Kept apart from `models`, because a failure is not an empty catalog. Writing
	 * `[]` into `models` made the load effect skip forever — it fires only while
	 * `models` is null — so one refusal while the sidecar was starting or
	 * suspended left the picker saying "Nothing matches" until the component
	 * remounted, and reopening it never tried again.
	 */
	const [failed, setFailed] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [query, setQuery] = useState("");
	const root = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open || models) return;
		let cancelled = false;
		setFailed(null);
		void bridge
			.getAvailableModels()
			.then(list => {
				if (!cancelled) setModels(list);
			})
			.catch((cause: unknown) => {
				// Left null on purpose: the next open retries.
				if (!cancelled) setFailed(cause instanceof Error ? cause.message : String(cause));
			});
		return () => {
			cancelled = true;
		};
	}, [bridge, models, open]);

	// Click-outside and Escape both close it; a menu that traps focus for a
	// one-click choice is worse than one that does not.
	useEffect(() => {
		if (!open) return;
		const onDown = (event: MouseEvent) => {
			if (!root.current?.contains(event.target as Node)) setOpen(false);
		};
		document.addEventListener("mousedown", onDown);
		return () => document.removeEventListener("mousedown", onDown);
	}, [open]);

	useEscape(
		useCallback(
			(event: KeyboardEvent) => {
				if (!open) return;
				// Same reason as the palette: closing a menu should not abort a turn.
				event.preventDefault();
				setOpen(false);
			},
			[open],
		),
	);

	const choose = useCallback(
		async (provider: string, id: string) => {
			setBusy(true);
			try {
				await bridge.setModel(provider, id);
				await bridge.getState().catch(() => {});
				setOpen(false);
			} catch (cause) {
				/*
				 * The menu stays open on the old model, which is honest but mute —
				 * and the rejection was otherwise unhandled, which in dev is an
				 * overlay and in a packaged webview is nothing at all.
				 */
				bridge.reportError(cause);
			} finally {
				setBusy(false);
			}
		},
		[bridge],
	);

	const setThinking = useCallback(
		async (level: string) => {
			setBusy(true);
			try {
				await bridge.setThinkingLevel(level);
				await bridge.getState().catch(() => {});
			} catch (cause) {
				bridge.reportError(cause);
			} finally {
				setBusy(false);
			}
		},
		[bridge],
	);

	const levels = thinkingLevels(state?.model);

	const needle = query.trim().toLowerCase();
	const visible = (models ?? []).filter(
		model => !needle || `${model.provider}/${model.id}`.toLowerCase().includes(needle),
	);

	return (
		<div className="omp-picker" ref={root}>
			<button
				className="omp-picker__trigger"
				type="button"
				disabled={busy}
				onClick={() => setOpen(value => !value)}
				title="Change model or thinking level"
			>
				{state?.model?.id ?? "no model"}
				{state?.thinkingLevel && state.thinkingLevel !== "off" ? ` · ${state.thinkingLevel}` : ""}
			</button>

			{open ? (
				<div className="omp-picker__menu">
					<div className="omp-picker__section">
						<span className="omp-picker__label">Thinking</span>
						{levels.length > 0 ? (
							<div className="omp-picker__levels">
								{levels.map(level => (
									<button
										key={level}
										type="button"
										className="omp-picker__level"
										aria-pressed={state?.thinkingLevel === level}
										disabled={busy}
										onClick={() => void setThinking(level)}
									>
										{level}
									</button>
								))}
							</div>
						) : (
							<p className="omp-picker__note">
								{state?.model ? "This model does not reason." : "Waiting for the session's model."}
							</p>
						)}
					</div>

					<input
						className="omp-filter"
						placeholder="Filter models…"
						value={query}
						onChange={event => setQuery(event.target.value)}
					/>

					<div className="omp-picker__list">
						{models === null ? <div className="omp-picker__empty">Loading…</div> : null}
						{failed !== null ? (
							<div className="omp-picker__empty">Could not read the model list: {failed}</div>
						) : null}
						{failed === null && models !== null && visible.length === 0 ? (
							<div className="omp-picker__empty">Nothing matches.</div>
						) : null}
						{visible.slice(0, 100).map(model => (
							<button
								className="omp-slash__item"
								key={`${model.provider}/${model.id}`}
								type="button"
								// Provider and id together: the bundled catalog exposes the same
								// id through more than one provider, and `set_model` and the
								// session state both identify a model by the pair — so matching
								// on the id alone lit every one of them.
								data-active={
									(model.id === state?.model?.id && model.provider === state?.model?.provider) || undefined
								}
								disabled={busy}
								onClick={() => void choose(model.provider, model.id)}
							>
								<span className="omp-slash__name">{model.id}</span>
								<span className="omp-slash__desc">{model.provider}</span>
							</button>
						))}
					</div>
				</div>
			) : null}
		</div>
	);
}
