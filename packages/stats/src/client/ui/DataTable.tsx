import type React from "react";

export interface DataTableColumn<T> {
	key: string;
	header: React.ReactNode;
	render?: (item: T) => React.ReactNode;
	className?: string;
	numeric?: boolean;
}

export interface DataTableProps<T> {
	columns: DataTableColumn<T>[];
	data: T[];
	keyExtractor: (item: T) => string | number;
	onRowClick?: (item: T) => void;
	renderMobileCard?: (item: T, onClick?: () => void) => React.ReactNode;
	emptyText?: string;
}

export function DataTable<T>({
	columns,
	data,
	keyExtractor,
	onRowClick,
	renderMobileCard,
	emptyText = "No data available",
}: DataTableProps<T>) {
	const handleKeyDown = (e: React.KeyboardEvent<HTMLTableRowElement>, item: T) => {
		if (onRowClick && (e.key === "Enter" || e.key === " ")) {
			e.preventDefault();
			onRowClick(item);
		}
	};

	if (data.length === 0) {
		return <div className="stats-table-empty">{emptyText}</div>;
	}

	return (
		<div className="stats-table-wrapper">
			{/* Mobile layout */}
			{renderMobileCard && (
				<div className="stats-table-mobile-only">
					<div className="stats-table-mobile-list">
						{data.map(item => {
							const key = String(keyExtractor(item));
							const onClick = onRowClick ? () => onRowClick(item) : undefined;
							return (
								<div key={key} className="stats-table-mobile-card-wrapper">
									{renderMobileCard(item, onClick)}
								</div>
							);
						})}
					</div>
				</div>
			)}

			{/* Desktop layout */}
			<div className={renderMobileCard ? "stats-table-desktop-only" : "stats-table-container"}>
				<table className="stats-table">
					<thead>
						<tr>
							{columns.map(col => {
								const headerClasses = [
									"stats-table-th",
									col.numeric ? "stats-text-right" : "stats-text-left",
									col.className || "",
								]
									.filter(Boolean)
									.join(" ");

								return (
									<th key={col.key} className={headerClasses}>
										{col.header}
									</th>
								);
							})}
						</tr>
					</thead>
					<tbody>
						{data.map(item => {
							const key = String(keyExtractor(item));
							const isClickable = typeof onRowClick === "function";
							const rowClasses = ["stats-table-tr", isClickable ? "stats-table-tr-clickable" : ""]
								.filter(Boolean)
								.join(" ");

							return (
								<tr
									key={key}
									className={rowClasses}
									onClick={isClickable ? () => onRowClick!(item) : undefined}
									onKeyDown={isClickable ? e => handleKeyDown(e, item) : undefined}
									tabIndex={isClickable ? 0 : undefined}
									role={isClickable ? "button" : undefined}
								>
									{columns.map(col => {
										const cellClasses = [
											"stats-table-td",
											col.numeric ? "stats-text-right" : "stats-text-left",
											col.className || "",
										]
											.filter(Boolean)
											.join(" ");

										return (
											<td key={col.key} className={cellClasses}>
												{col.render
													? col.render(item)
													: ((item as Record<string, unknown>)[col.key] as React.ReactNode)}
											</td>
										);
									})}
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>
		</div>
	);
}
