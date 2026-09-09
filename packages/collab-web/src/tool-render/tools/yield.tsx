/** `yield` — structured data handed back by a subagent at the end of its run. */
import type { ReactNode } from "react";
import { Output, ResultText } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { argsDigest } from "../util";

function Summary({ args }: ToolRenderProps): ReactNode {
	return <span>{argsDigest(args.data ?? args)}</span>;
}

function Body({ args, result }: ToolRenderProps): ReactNode {
	let dataText = "";
	if (args.data !== undefined) {
		try {
			dataText = JSON.stringify(args.data, null, 2) ?? "";
		} catch {
			dataText = String(args.data);
		}
	}
	return (
		<>
			{dataText && <Output text={dataText} lang="json" variant="code" maxLines={12} />}
			<ResultText result={result} maxLines={6} />
		</>
	);
}

export const yieldRenderer: ToolRenderer = { Summary, Body };
