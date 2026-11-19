/** Fallback renderer for tools without a dedicated view. */
import type { ReactNode } from "react";
import { Output, ResultImages, ResultText } from "./parts";
import type { ToolRenderer, ToolRenderProps } from "./types";
import { argsDigest } from "./util";

function Summary({ args }: ToolRenderProps): ReactNode {
	return <span>{argsDigest(args)}</span>;
}

function Body({ args, result }: ToolRenderProps): ReactNode {
	let argText = "";
	try {
		argText = JSON.stringify(args, null, 2) ?? "";
	} catch {
		argText = String(args);
	}
	return (
		<>
			{argText && argText !== "{}" && (
				<Output text={argText} lang="json" variant="code" maxLines={12} title="args" />
			)}
			<ResultImages result={result} />
			<ResultText result={result} maxLines={10} />
		</>
	);
}

export const genericRenderer: ToolRenderer = { Summary, Body };
