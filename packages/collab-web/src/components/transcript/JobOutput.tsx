import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { isRecord } from "../../tool-render/util";
import type { AsyncJobResult } from "./agent-notices";
import { Markdown } from "./Markdown";
import "./report.css";

/** Keep field order and values intact; only turn identifier-style keys into readable labels. */
function fieldLabel(key: string): string {
	const label = key
		.replace(/([a-z\d])([A-Z])/g, "$1 $2")
		.replace(/[_-]+/g, " ")
		.trim();
	return label ? label[0].toUpperCase() + label.slice(1) : '""';
}

/** JSON structure as a report, not an inferred summary: no fields or falsy values are discarded. */
function ReportValue({ value }: { value: unknown }): ReactNode {
	if (Array.isArray(value)) {
		if (value.length === 0) return <span className="tr-report-empty">Empty list</span>;
		return (
			<ul className="tr-report-list">
				{value.map((item, index) => (
					<li key={index}>
						<ReportValue value={item} />
					</li>
				))}
			</ul>
		);
	}
	if (isRecord(value)) {
		const fields = Object.entries(value);
		if (fields.length === 0) return <span className="tr-report-empty">Empty object</span>;
		return (
			<dl className="tr-report-fields">
				{fields.map(([key, item]) => (
					<div key={key} className="tr-report-field">
						<dt title={key}>{fieldLabel(key)}</dt>
						<dd>
							<ReportValue value={item} />
						</dd>
					</div>
				))}
			</dl>
		);
	}
	if (typeof value === "string" && value !== "") {
		return <div className="tr-report-text">{value}</div>;
	}
	return <code className="tr-report-scalar">{value === null ? "null" : value === "" ? '""' : String(value)}</code>;
}

/** Structured subagent results default to a readable report; the JSON view preserves the complete payload. */
export function JobOutput({ job }: { job: AsyncJobResult }): ReactNode {
	const [raw, setRaw] = useState(false);
	const output = useMemo(() => {
		if (job.data !== undefined) return { structured: true, value: job.data };
		const text = job.output.trim();
		if (text.startsWith("{") || text.startsWith("[")) {
			try {
				const value: unknown = JSON.parse(text);
				return { structured: true, value };
			} catch {
				// Truncated JSON and ordinary prose stay available as text.
			}
		}
		return { structured: false, value: text };
	}, [job.data, job.output]);
	const json = useMemo(() => (raw && output.structured ? JSON.stringify(output.value, null, 2) : ""), [raw, output]);

	if (!output.structured) return job.output.trim() ? <Markdown text={job.output.trim()} /> : null;
	return (
		<div className="tr-report">
			<div className="tr-report-toolbar" role="group" aria-label="Result view">
				<button type="button" aria-pressed={!raw} onClick={() => setRaw(false)}>
					Report
				</button>
				<button type="button" aria-pressed={raw} onClick={() => setRaw(true)}>
					JSON
				</button>
			</div>
			{raw ? (
				<pre className="tr-report-json">
					<code>{json}</code>
				</pre>
			) : (
				<div className="tr-report-content">
					<ReportValue value={output.value} />
				</div>
			)}
		</div>
	);
}
