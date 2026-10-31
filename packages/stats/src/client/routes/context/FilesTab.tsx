import { useMemo, useState } from "react";
import { formatBytes, formatCompact, formatTimestamp } from "../../data/formatters";
import { Card, type Column, SearchInput, Table } from "../../ui";
import type { ContextFileActivity, ContextTimeline } from "../../types";
import { ContextFileActivityBar } from "./ContextFileActivityBar";
import { sortFiles } from "./view-models";

function basename(path: string): { parent: string; name: string } {
	const cut = path.lastIndexOf("/");
	return cut < 0 ? { parent: "", name: path } : { parent: path.slice(0, cut + 1), name: path.slice(cut + 1) };
}

export function FilesTab({
	timeline,
	onOpenTrace,
}: {
	timeline: ContextTimeline;
	onOpenTrace: (file: string) => void;
}) {
	const [filter, setFilter] = useState("");
	const files = useMemo(
		() => sortFiles(timeline.files).filter(file => file.path.toLowerCase().includes(filter.trim().toLowerCase())),
		[timeline.files, filter],
	);
	const maxTotal = useMemo(
		() =>
			timeline.files.reduce((max, file) => Math.max(max, file.reads + file.writes + file.edits + file.searches), 0),
		[timeline.files],
	);
	const columns = useMemo<Column<ContextFileActivity>[]>(
		() => [
			{
				key: "path",
				header: "Path",
				width: "34%",
				render: file => {
					const parts = basename(file.path);
					return (
						<span className="context-file-path mono" title={file.path}>
							<span className="context-file-parent">{parts.parent}</span>
							<strong className="context-file-name">{parts.name}</strong>
						</span>
					);
				},
				sort: file => file.path,
			},
			{
				key: "activity",
				header: "Activity",
				width: 160,
				render: file => <ContextFileActivityBar file={file} maxTotal={maxTotal} />,
				sort: file => file.reads + file.writes + file.edits + file.searches,
			},
			{
				key: "ops",
				header: "R W E S",
				width: 140,
				render: file => (
					<span
						className="context-file-counts num"
						aria-label={`${file.reads} reads, ${file.writes} writes, ${file.edits} edits, ${file.searches} searches`}
					>
						<span>{file.reads}</span>
						<span>{file.writes}</span>
						<span>{file.edits}</span>
						<span>{file.searches}</span>
					</span>
				),
				sort: file => file.reads + file.writes + file.edits + file.searches,
			},
			{
				key: "lines",
				header: "Lines",
				align: "right",
				render: file => (
					<span className="num">{formatCompact(file.linesRead + file.linesAdded + file.linesRemoved)}</span>
				),
				sort: file => file.linesRead + file.linesAdded + file.linesRemoved,
			},
			{
				key: "bytes",
				header: "Bytes",
				align: "right",
				render: file => <span className="num">{formatBytes(file.bytesRead + file.bytesWritten)}</span>,
				sort: file => file.bytesRead + file.bytesWritten,
			},
			{
				key: "last",
				header: "Last",
				align: "right",
				render: file => <span className="micro">{formatTimestamp(file.lastTimestamp)}</span>,
				sort: file => file.lastTimestamp,
			},
			{
				key: "open",
				header: "",
				width: 36,
				render: file => (
					<button
						type="button"
						className="context-file-open"
						aria-label={`Open trace for ${file.path}`}
						title="Open session trace"
						onClick={event => {
							event.stopPropagation();
							onOpenTrace(file.path);
						}}
						onKeyDown={event => {
							if (event.key === "Enter" || event.key === " ") event.stopPropagation();
						}}
					>
						↗
					</button>
				),
			},
		],
		[maxTotal, onOpenTrace],
	);
	return (
		<Card
			title="Files"
			description={
				timeline.incompleteFileCalls
					? `Aggregate activity; open trace for operation-level detail. ${timeline.incompleteFileCalls} incomplete file calls.`
					: "Aggregate activity; open trace for operation-level detail."
			}
			actions={
				<div className="context-files-actions">
					<span className="context-file-legend" aria-label="Operation colors">
						<span className="read">reads</span>
						<span className="write">writes</span>
						<span className="edit">edits</span>
						<span className="search">searches</span>
					</span>
					<SearchInput value={filter} onChange={setFilter} placeholder="Filter files" width={220} />
				</div>
			}
		>
			<div className="context-files-table">
				<Table
					columns={columns}
					rows={files}
					rowKey={file => file.path}
					onRowClick={file => onOpenTrace(file.path)}
					initialSort={{ key: "last", dir: "desc" }}
					limit={50}
					empty={<p className="dim">No file activity recorded.</p>}
				/>
			</div>
		</Card>
	);
}
