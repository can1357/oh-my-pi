import { ArrowDown, ArrowUp } from "lucide-react";
import { Fragment, type ReactNode, useMemo, useState } from "react";
import { EmptyState } from "./States";

export interface Column<T> {
	key: string;
	header: ReactNode;
	render: (row: T) => ReactNode;
	/** Sort key; the column header becomes clickable when present. */
	sort?: (row: T) => number | string;
	align?: "left" | "right" | "center";
	width?: number | string;
	/** Allow the cell to wrap (cells are single-line by default). */
	wrap?: boolean;
	/** Header tooltip. */
	title?: string;
}

export type SortDir = "asc" | "desc";

export interface TableProps<T> {
	columns: readonly Column<T>[];
	rows: readonly T[];
	rowKey: (row: T) => string | number;
	onRowClick?: (row: T) => void;
	selectedKey?: string | number | null;
	/** Initial sort; numeric columns usually start `desc`. */
	initialSort?: { key: string; dir: SortDir };
	/** Show the first `limit` rows; "Show more" reveals `limit` × 4 more at a time (rendering stays cheap for huge tables). */
	limit?: number;
	dense?: boolean;
	empty?: ReactNode;
	/** Detail row rendered below a row (return `null` for collapsed rows). */
	expanded?: (row: T) => ReactNode | null;
}

/** Sortable data table. Clicking a sorted header flips its direction. */
export function Table<T>({
	columns,
	rows,
	rowKey,
	onRowClick,
	selectedKey,
	initialSort,
	limit,
	dense,
	empty,
	expanded,
}: TableProps<T>) {
	const [sort, setSort] = useState(initialSort ?? null);
	const [shown, setShown] = useState(limit ?? Number.POSITIVE_INFINITY);

	const sorted = useMemo(() => {
		const column = sort ? columns.find(c => c.key === sort.key) : undefined;
		if (!sort || !column?.sort) return rows;
		const valueOf = column.sort;
		const dir = sort.dir === "asc" ? 1 : -1;
		return [...rows].sort((a, b) => {
			const va = valueOf(a);
			const vb = valueOf(b);
			if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
			return String(va).localeCompare(String(vb)) * dir;
		});
	}, [rows, columns, sort]);

	if (rows.length === 0) return <>{empty ?? <EmptyState />}</>;

	const visible = sorted.length > shown ? sorted.slice(0, shown) : sorted;

	const toggleSort = (column: Column<T>) => {
		if (!column.sort) return;
		setSort(prev =>
			prev?.key === column.key
				? { key: column.key, dir: prev.dir === "asc" ? "desc" : "asc" }
				: { key: column.key, dir: column.align === "right" ? "desc" : "asc" },
		);
	};

	return (
		<>
			<div className="table-wrap">
				<table className="table" data-dense={dense ?? false}>
					<thead>
						<tr>
							{columns.map(column => {
								const sorted = sort?.key === column.key ? sort.dir : undefined;
								return (
									<th
										key={column.key}
										data-align={column.align ?? "left"}
										data-sortable={column.sort !== undefined}
										data-sorted={sorted}
										style={column.width !== undefined ? { width: column.width } : undefined}
										title={column.title}
										onClick={() => toggleSort(column)}
										aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : undefined}
									>
										{column.header}
										{sorted && (
											<span className="sort-arrow">
												{sorted === "asc" ? <ArrowUp size={11} /> : <ArrowDown size={11} />}
											</span>
										)}
									</th>
								);
							})}
						</tr>
					</thead>
					<tbody>
						{visible.map(row => {
							const key = rowKey(row);
							const detail = expanded?.(row) ?? null;
							return (
								<Fragment key={key}>
									<tr
										data-clickable={onRowClick !== undefined}
										data-selected={selectedKey === key}
										onClick={onRowClick ? () => onRowClick(row) : undefined}
										onKeyDown={
											onRowClick
												? e => {
														if (e.key === "Enter" || e.key === " ") {
															e.preventDefault();
															onRowClick(row);
														}
													}
												: undefined
										}
										tabIndex={onRowClick ? 0 : undefined}
									>
										{columns.map(column => (
											<td
												key={column.key}
												data-align={column.align ?? "left"}
												data-wrap={column.wrap ?? false}
											>
												{column.render(row)}
											</td>
										))}
									</tr>
									{detail !== null && (
										<tr>
											<td colSpan={columns.length} data-wrap="true" style={{ padding: 0 }}>
												{detail}
											</td>
										</tr>
									)}
								</Fragment>
							);
						})}
					</tbody>
				</table>
			</div>
			{limit !== undefined && sorted.length > limit && (
				<div className="table-more">
					<span className="micro">
						{visible.length.toLocaleString()} of {sorted.length.toLocaleString()}
					</span>
					{sorted.length > shown && (
						<button
							type="button"
							className="btn"
							data-size="sm"
							data-variant="ghost"
							onClick={() => setShown(n => n + limit * 4)}
						>
							Show more
						</button>
					)}
					{shown > limit && (
						<button
							type="button"
							className="btn"
							data-size="sm"
							data-variant="ghost"
							onClick={() => setShown(limit)}
						>
							Show fewer
						</button>
					)}
				</div>
			)}
		</>
	);
}

/** Right-aligned value with a proportional bar, for ranked numeric columns. */
export function MeterCell({
	value,
	max,
	display,
	color,
}: {
	value: number;
	max: number;
	display: ReactNode;
	color?: string;
}) {
	const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
	return (
		<div className="meter-cell">
			<span className="num">{display}</span>
			<div className="meter">
				<div className="meter-fill" style={{ width: `${pct}%`, background: color }} />
			</div>
		</div>
	);
}

/** Two-line cell: primary label and a dim secondary line. */
export function LabelCell({
	primary,
	secondary,
	lead,
}: {
	primary: ReactNode;
	secondary?: ReactNode;
	lead?: ReactNode;
}) {
	return (
		<div className="row" style={{ gap: 10 }}>
			{lead}
			<div className="stack" style={{ gap: 0 }}>
				<span className="cell-primary truncate">{primary}</span>
				{secondary !== undefined && <span className="cell-secondary truncate">{secondary}</span>}
			</div>
		</div>
	);
}
