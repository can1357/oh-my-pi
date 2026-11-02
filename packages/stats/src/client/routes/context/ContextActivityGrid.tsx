import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { formatCompact } from "../../data/formatters";
import type { ContextOverview } from "../../types";
import type { ContextActivityCell } from "./view-models";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function level(value: number, max: number): number {
	return value <= 0 || max <= 0 ? 0 : Math.min(4, Math.ceil((value / max) * 4));
}

function rowLabel(cell: ContextActivityCell, daily: boolean): string {
	const date = new Date(cell.start);
	return daily
		? date.toLocaleDateString(undefined, { month: "short", day: "numeric" })
		: date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function ContextActivityGrid({
	overview,
	cells,
	metric,
	selectedKey,
	onSelect,
}: {
	overview: ContextOverview;
	cells: readonly ContextActivityCell[];
	metric: "requests" | "promptTokens";
	selectedKey: string | null;
	onSelect: (cell: ContextActivityCell) => void;
}) {
	const refs = useRef(new Map<string, HTMLButtonElement>());
	const gridRef = useRef<HTMLDivElement | null>(null);
	const lastFocusCell = useRef<ContextActivityCell | undefined>(undefined);
	// Capture ownership during render: by the time the effect runs after a range
	// change, React has already removed the previously focused button.
	const focusWasInside = useRef(false);
	if (typeof document !== "undefined") {
		focusWasInside.current = gridRef.current?.contains(document.activeElement) ?? false;
	}
	const [focusKey, setFocusKey] = useState<string | null>(cells[0]?.key ?? null);
	const daily = overview.range === "30d" || overview.range === "90d";
	const oneHour = overview.range === "1h";
	const max = Math.max(1, ...cells.map(cell => cell[metric]));
	const tabbableKey = cells.some(cell => cell.key === focusKey) ? focusKey : cells[0]?.key;

	useEffect(() => {
		if (cells.length === 0) {
			setFocusKey(null);
			return;
		}
		if (focusKey && cells.some(cell => cell.key === focusKey)) return;
		const previous = lastFocusCell.current;
		const next =
			(previous && cells.find(cell => previous.start >= cell.start && previous.start < cell.end)) ?? cells[0]!;
		setFocusKey(next.key);
		if (focusWasInside.current) requestAnimationFrame(() => refs.current.get(next.key)?.focus());
	}, [cells, focusKey]);

	const rows = useMemo(() => {
		const map = new Map<number, ContextActivityCell[]>();
		for (const cell of cells) {
			const row = map.get(cell.row) ?? [];
			row.push(cell);
			map.set(cell.row, row);
		}
		return [...map.entries()].sort((a, b) => a[0] - b[0]);
	}, [cells]);

	const focusCell = (target: ContextActivityCell | undefined) => {
		if (!target) return;
		setFocusKey(target.key);
		refs.current.get(target.key)?.focus();
	};

	const move = (cell: ContextActivityCell, deltaRow: number, deltaCol: number) => {
		const target = cells.find(
			candidate => candidate.row === cell.row + deltaRow && candidate.col === cell.col + deltaCol,
		);
		focusCell(target);
	};

	const onKeyDown = (cell: ContextActivityCell, event: KeyboardEvent<HTMLButtonElement>) => {
		if (event.key === "ArrowLeft") {
			event.preventDefault();
			move(cell, 0, -1);
		} else if (event.key === "ArrowRight") {
			event.preventDefault();
			move(cell, 0, 1);
		} else if (event.key === "ArrowUp") {
			event.preventDefault();
			move(cell, -1, 0);
		} else if (event.key === "ArrowDown") {
			event.preventDefault();
			move(cell, 1, 0);
		} else if (event.key === "Home" || event.key === "End") {
			event.preventDefault();
			if (event.ctrlKey || event.metaKey) {
				focusCell(event.key === "Home" ? cells[0] : cells.at(-1));
			} else {
				const row = cells.filter(candidate => candidate.row === cell.row);
				focusCell(event.key === "Home" ? row.at(0) : row.at(-1));
			}
		} else if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			onSelect(cell);
		}
	};

	if (oneHour) {
		const cell = cells[0];
		return cell ? (
			<div className="context-activity-single" role="grid" aria-label="One-hour activity">
				<button
					type="button"
					role="gridcell"
					className="context-activity-cell context-activity-single-cell"
					data-level={level(cell[metric], max)}
					data-selected={selectedKey === cell.key}
					aria-selected={selectedKey === cell.key}
					aria-label={`${cell.label}: ${formatCompact(cell[metric])} ${metric}`}
					onClick={() => onSelect(cell)}
				>
					<span>{formatCompact(cell[metric])}</span>
					<small>{metric === "requests" ? "requests" : "prompt tokens"} · 1h</small>
				</button>
			</div>
		) : null;
	}

	return (
		<div className="context-activity" data-daily={daily}>
			{daily && (
				<div className="context-activity-weekdays" aria-hidden="true">
					<span />
					{WEEKDAYS.map(day => (
						<span key={day}>{day}</span>
					))}
				</div>
			)}
			<div className="context-activity-grid" role="grid" aria-label={`${metric} activity`} ref={gridRef}>
				{rows.map(([rowIndex, rowCells]) => {
					const padded = daily
						? Array.from({ length: 7 }, (_, col) => rowCells.find(cell => cell.col === col))
						: rowCells;
					return (
						<div className="context-activity-row" role="row" key={rowIndex}>
							<span className="context-activity-rowlabel" role="rowheader">
								{rowCells[0] ? rowLabel(rowCells[0], daily) : ""}
							</span>
							{padded.map((cell, col) =>
								cell ? (
									<button
										key={cell.key}
										ref={element => {
											if (element) refs.current.set(cell.key, element);
											else refs.current.delete(cell.key);
										}}
										type="button"
										role="gridcell"
										className="context-activity-cell"
										data-level={level(cell[metric], max)}
										data-partial={cell.partial}
										data-selected={selectedKey === cell.key}
										aria-selected={selectedKey === cell.key}
										aria-label={`${cell.label}: ${formatCompact(cell[metric])} ${metric}${cell.partial ? ", partial" : ""}`}
										tabIndex={cell.key === tabbableKey ? 0 : -1}
										onFocus={() => {
											lastFocusCell.current = cell;
											setFocusKey(cell.key);
										}}
										onKeyDown={event => onKeyDown(cell, event)}
										onClick={() => onSelect(cell)}
									/>
								) : (
									<span
										key={`blank-${rowIndex}-${col}`}
										className="context-activity-blank"
										aria-hidden="true"
									/>
								),
							)}
						</div>
					);
				})}
			</div>
			<div className="context-activity-legend" aria-hidden="true">
				<span>Less</span>
				{[0, 1, 2, 3, 4].map(value => (
					<i key={value} data-level={value} />
				))}
				<span>More</span>
			</div>
		</div>
	);
}
