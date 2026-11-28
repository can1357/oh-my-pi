/** Fallback renderer for tools without a dedicated view. */
import { stringifyJsonIteratively } from "@oh-my-pi/pi-utils/json";
import { nestsDeeperThan } from "@oh-my-pi/pi-utils/nested-walk";
import type { ReactNode } from "react";
import { Output, ResultImages, ResultText } from "./parts";
import type { ToolRenderer, ToolRenderProps } from "./types";
import { argsDigest, DEEP_ARGS_LEVELS } from "./util";

/** Characters of arguments nested past {@link DEEP_ARGS_LEVELS} levels the card shows, on one line. */
const DEEP_ARGS_CHARS = 2_000;

function Summary({ args }: ToolRenderProps): ReactNode {
	return <span>{argsDigest(args)}</span>;
}

/** `args` as the card shows them: indented JSON, or for arguments nested past {@link DEEP_ARGS_LEVELS} levels the start of their one-line JSON. */
function argsText(args: unknown): string {
	if (nestsDeeperThan(args, DEEP_ARGS_LEVELS)) {
		const head = stringifyJsonIteratively(args, { limit: DEEP_ARGS_CHARS }) ?? "";
		return head.length > DEEP_ARGS_CHARS ? `${head.slice(0, DEEP_ARGS_CHARS)}…` : head;
	}
	try {
		return JSON.stringify(args, null, 2) ?? "";
	} catch {
		return String(args);
	}
}

function Body({ args, result }: ToolRenderProps): ReactNode {
	const argText = argsText(args);
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
