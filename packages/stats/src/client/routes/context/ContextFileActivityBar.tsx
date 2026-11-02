import type { ContextFileActivity } from "../../types";

const SEGMENTS = [
	{ key: "reads", label: "reads", className: "read" },
	{ key: "writes", label: "writes", className: "write" },
	{ key: "edits", label: "edits", className: "edit" },
	{ key: "searches", label: "searches", className: "search" },
] as const;

/** Normalized read/write/edit/search bar for one aggregate file row. */
export function ContextFileActivityBar({ file, maxTotal }: { file: ContextFileActivity; maxTotal: number }) {
	const total = file.reads + file.writes + file.edits + file.searches;
	const scale = maxTotal > 0 ? 100 / maxTotal : 0;
	const label = SEGMENTS.map(segment => `${file[segment.key]} ${segment.label}`).join(", ");
	return (
		<span className="context-file-activity" role="img" aria-label={label} title={label} data-empty={total === 0}>
			{SEGMENTS.map(segment => {
				const value = file[segment.key];
				return value > 0 ? (
					<span
						key={segment.key}
						className={`context-file-activity-segment ${segment.className}`}
						style={{ width: `${value * scale}%` }}
					/>
				) : null;
			})}
		</span>
	);
}
