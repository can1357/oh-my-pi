import { useEffect, useMemo, useState } from "react";
import type { TimeRange } from "../types";
import { routes } from "./routes";

interface CommandPaletteProps {
	open: boolean;
	onClose: () => void;
	onNavigate: (section: string, range?: TimeRange) => void;
}

const RANGES: TimeRange[] = ["today", "1h", "24h", "7d", "30d", "90d", "all"];

export function CommandPalette({ open, onClose, onNavigate }: CommandPaletteProps) {
	const [query, setQuery] = useState("");
	const [activeIdx, setActiveIdx] = useState(0);

	const items = useMemo(() => {
		const q = query.trim().toLowerCase();
		const base: { label: string; action: () => void; hint?: string }[] = [];
		for (const r of routes) base.push({ label: `Go to ${r.label}`, hint: r.id, action: () => onNavigate(r.id) });
		for (const r of RANGES) base.push({ label: `Set range ${r}`, hint: "range", action: () => onNavigate("", r) });
		base.push({
			label: "Toggle density",
			hint: "view",
			action: () => {
				const cur = document.documentElement.dataset.density;
				const next = cur === "compact" ? "comfortable" : "compact";
				document.documentElement.dataset.density = next;
				try {
					localStorage.setItem("omp-stats:density", next);
				} catch {}
			},
		});
		if (!q) return base.slice(0, 8);
		return base.filter(it => it.label.toLowerCase().includes(q) || it.hint?.includes(q)).slice(0, 8);
	}, [query, onNavigate]);

	useEffect(() => {
		setActiveIdx(0);
	}, [query]);
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setActiveIdx(i => Math.min(i + 1, items.length - 1));
			}
			if (e.key === "ArrowUp") {
				e.preventDefault();
				setActiveIdx(i => Math.max(i - 1, 0));
			}
			if (e.key === "Enter") {
				e.preventDefault();
				items[activeIdx]?.action();
				onClose();
			}
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open, items, activeIdx, onClose]);

	if (!open) return null;
	return (
		<div className="omp-palette-overlay" onClick={onClose} role="presentation">
			<div
				className="omp-palette"
				onClick={e => e.stopPropagation()}
				role="dialog"
				aria-modal="true"
				aria-label="Command palette"
			>
				<input
					className="omp-palette-input"
					autoFocus
					placeholder="Type a command — try “models”, “today”, “density”"
					value={query}
					onChange={e => setQuery(e.target.value)}
				/>
				<div className="omp-palette-list">
					{items.map((it, idx) => (
						<div
							key={it.label}
							className="omp-palette-item"
							data-active={idx === activeIdx ? "true" : "false"}
							onClick={() => {
								it.action();
								onClose();
							}}
						>
							<span>{it.label}</span>
							{it.hint && <span className="omp-palette-kbd">{it.hint}</span>}
						</div>
					))}
					{items.length === 0 && (
						<div style={{ padding: "12px 10px", color: "var(--muted)", fontSize: 12 }}>No matches</div>
					)}
				</div>
			</div>
		</div>
	);
}
