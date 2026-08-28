import { useEffect, useMemo, useState } from "react";

export interface PaletteAction {
	id: string;
	label: string;
	hint?: string;
	run(): void;
}

/**
 * Cmd+K palette over the app's own actions.
 *
 * Deliberately separate from the composer's slash menu: that one lists omp's 79
 * agent commands and sends them to the model, this one drives the app itself
 * (open settings, toggle the panel, abort). Merging them would make it unclear
 * which side of the process a given entry acts on.
 */
export function CommandPalette({
	actions,
	open,
	onClose,
}: {
	actions: readonly PaletteAction[];
	open: boolean;
	onClose(): void;
}) {
	const [query, setQuery] = useState("");
	const [highlight, setHighlight] = useState(0);

	useEffect(() => {
		if (open) {
			setQuery("");
			setHighlight(0);
		}
	}, [open]);

	const matches = useMemo(() => {
		const needle = query.trim().toLowerCase();
		if (!needle) return actions;
		return actions.filter(action => action.label.toLowerCase().includes(needle));
	}, [actions, query]);

	if (!open) return null;

	return (
		<div
			className="omp-backdrop"
			role="dialog"
			aria-modal="true"
			aria-label="Command palette"
			onClick={onClose}
			onKeyDown={event => {
				// Claim the key, or the window listener in session.tsx aborts the
				// running turn as well as closing this.
				if (event.key !== "Escape") return;
				event.preventDefault();
				onClose();
			}}
		>
			<div className="omp-modal omp-palette" onClick={event => event.stopPropagation()}>
				<input
					className="omp-input"
					autoFocus
					placeholder="Type a command…"
					value={query}
					onChange={event => {
						setQuery(event.target.value);
						setHighlight(0);
					}}
					onKeyDown={event => {
						if (event.key === "Escape") {
							event.preventDefault();
							return onClose();
						}
						if (event.key === "ArrowDown") {
							event.preventDefault();
							setHighlight(index => (index + 1) % Math.max(matches.length, 1));
						}
						if (event.key === "ArrowUp") {
							event.preventDefault();
							setHighlight(index => (index - 1 + matches.length) % Math.max(matches.length, 1));
						}
						if (event.key === "Enter" && matches[highlight]) {
							event.preventDefault();
							matches[highlight].run();
							onClose();
						}
					}}
				/>

				<div className="omp-palette__list">
					{matches.length === 0 ? (
						<div className="omp-empty" style={{ height: "auto", padding: 16 }}>
							Nothing matches.
						</div>
					) : null}
					{matches.map((action, index) => (
						<button
							className="omp-slash__item"
							data-active={index === highlight || undefined}
							key={action.id}
							type="button"
							onMouseEnter={() => setHighlight(index)}
							onClick={() => {
								action.run();
								onClose();
							}}
						>
							<span>{action.label}</span>
							{action.hint ? <span className="omp-slash__desc">{action.hint}</span> : null}
						</button>
					))}
				</div>
			</div>
		</div>
	);
}
