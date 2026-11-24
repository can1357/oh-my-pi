/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Yield (Submit Result): the submitted data instead of the model-facing
 * acknowledgement. The head names the sections or workpool item it fills
 * and the data's size; the body is the error, the data (JSON tree or
 * Markdown) and, for a settled call without data, where the result comes from.
 *
 * Terminal look: `yield` (`src/ui/styles/tools/yield.ts`).
 */
import type { JSXNode } from "@oh-my-pi/pi-tui";
import type { ToolPresenter, ToolResult, ToolView } from "./contract";
import { countText, ErrorText, NoteText } from "./agent-common";
import { resultText } from "./default";
import { registerToolPresenter } from "./registry";

const TITLE = "Submit Result";
/** Levels of the data tree open natively. */
const OPEN_DEPTH = 5;

export interface YieldArgs {
	readonly type?: string | readonly string[] | null;
	readonly data?: unknown;
	readonly error?: string | null;
	/** 1-based workpool item number. */
	readonly key?: number;
}

export interface YieldDetails {
	readonly type?: string | readonly string[];
	readonly data?: unknown;
	readonly status?: string;
	readonly error?: string;
	readonly schemaOverridden?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sizeMeta(data: unknown): string | undefined {
	if (Array.isArray(data)) return countText(data.length, "item");
	if (isRecord(data)) return countText(Object.keys(data).length, "field");
	return undefined;
}

function dataNode(data: unknown): JSXNode {
	if (data === undefined) return undefined;
	if (typeof data === "string")
		return data.trim() ? <md text={data} stream={false} /> : <NoteText message="(empty)" />;
	return <json open={OPEN_DEPTH} value={data} />;
}

function present(args: YieldArgs | undefined, result: ToolResult<YieldDetails> | undefined): ToolView {
	const details = result?.isError ? undefined : result?.details;
	const type = details?.type ?? args?.type ?? undefined;
	const incremental = Array.isArray(type) && type.length > 0;
	const data = details?.data !== undefined ? details.data : (args?.data ?? undefined);
	let error = args?.error || undefined;
	if (result?.isError) error = resultText(result) || `${TITLE} failed`;
	else if (result && details?.status === "aborted") error = details.error || resultText(result) || "Aborted";
	const settled = result !== undefined;
	const target =
		typeof args?.key === "number" ? `item ${args.key}` : incremental ? (type as string[]).join(", ") : undefined;
	const size = sizeMeta(data);
	const note =
		settled && error === undefined && data === undefined
			? incremental
				? "Takes the last message as this section"
				: "Ends with the sections submitted earlier, or the last message"
			: undefined;
	return {
		head: {
			title: TITLE,
			target,
			targetKind: target ? "text" : undefined,
			meta: size ? [size] : undefined,
			badges: details?.schemaOverridden ? [{ text: "schema overridden", tone: "warning" }] : undefined,
		},
		tone: settled && error !== undefined ? "error" : undefined,
		body: [
			error !== undefined ? <ErrorText message={error} /> : undefined,
			dataNode(data),
			note ? <NoteText message={note} token="dim" /> : undefined,
		],
	};
}

export const yieldPresenter: ToolPresenter<YieldArgs, YieldDetails> = {
	merge: true,
	call: args => present(args, undefined),
	result: (result, _state, args) => present(args, result),
};

registerToolPresenter("yield", yieldPresenter);
