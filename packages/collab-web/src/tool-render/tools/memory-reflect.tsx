/**
 * `reflect` — ask the long-term memory backend a question; the answer comes
 * back as plain result text (details are always empty).
 */
import type { ReactNode } from "react";
import { Note, Output, ResultText } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { normalizeWs, resultTextOf, str, truncate } from "../util";

function Summary({ args }: ToolRenderProps): ReactNode {
	const query = str(args.query);
	return <span>{query ? truncate(normalizeWs(query), 96) : ""}</span>;
}

function Body({ args, result }: ToolRenderProps): ReactNode {
	const query = str(args.query) ?? "";
	const context = str(args.context) ?? "";
	const failedSilently = result?.isError === true && !resultTextOf(result);
	return (
		<>
			{query && <Output text={query} title="query" maxLines={4} />}
			{context && <Output text={context} title="context" maxLines={6} />}
			{failedSilently ? <Note tone="err">Reflect failed</Note> : <ResultText result={result} maxLines={12} />}
		</>
	);
}

export const reflectRenderer: ToolRenderer = { Summary, Body };
