/** `retain` — store facts in long-term memory (one bullet per stored item). */
import type { ReactNode } from "react";
import { Badge, InvalidArg, ResultText, Row } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { detailsRecord, isRecord, normalizeWs, num, replaceTabs, resultTextOf, str, truncate } from "../util";

interface RetainItem {
	content: string;
	context: string | null;
}

/** Narrow `args.items`; null = present but malformed, [] = absent/empty. */
function retainItems(args: Record<string, unknown>): RetainItem[] | null {
	const raw = args.items;
	if (raw === undefined) return [];
	if (!Array.isArray(raw)) return null;
	const items: RetainItem[] = [];
	for (const entry of raw) {
		if (!isRecord(entry)) continue;
		const content = replaceTabs((str(entry.content) ?? "").trim());
		if (!content) continue;
		items.push({ content, context: str(entry.context) });
	}
	return items;
}

function Summary({ args, result }: ToolRenderProps): ReactNode {
	const items = retainItems(args);
	if (items === null) return <InvalidArg what="items" />;
	const count = num(detailsRecord(result)?.count) ?? items.length;
	const first = items[0] ? truncate(normalizeWs(items[0].content), 80) : "";
	return (
		<>
			<Badge tone="accent">{count === 1 ? "1 memory" : `${count} memories`}</Badge>
			{first && <span className="tv-trunc">{first}</span>}
		</>
	);
}

function Body({ args, result }: ToolRenderProps): ReactNode {
	const items = retainItems(args);
	const count = num(detailsRecord(result)?.count);
	// The tool's own "N memories stored/queued." line; trailing period dropped
	// so it reads as a status chip.
	let confirmation: string | null = null;
	if (result && result.isError !== true) {
		const text = resultTextOf(result).trim().replace(/\.$/, "");
		confirmation = text || (count !== null ? `${count === 1 ? "1 memory" : `${count} memories`} retained` : null);
	}
	return (
		<>
			{items === null ? (
				<InvalidArg what="items" />
			) : (
				items.length > 0 && (
					<div className="tv-list">
						{items.map((item, i) => (
							<Row key={i}>
								{item.content}
								{item.context && <span className="tv-faint"> — {item.context}</span>}
							</Row>
						))}
					</div>
				)
			)}
			{confirmation ? (
				<div>
					<Badge tone="ok">{confirmation}</Badge>
				</div>
			) : (
				<ResultText result={result} maxLines={6} />
			)}
		</>
	);
}

export const retainRenderer: ToolRenderer = { Summary, Body };
