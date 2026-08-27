import type { ToolAttachment, ToolOutcome, ToolPresentationEvent } from "@oh-my-pi/pi-agent-core/presentation";
import { nonZeroExitCode, streamId, ToolPresentationStream } from "@oh-my-pi/pi-agent-core/presentation";
import { type EvalResult, knownResultText } from "../../../presentation/known-tool-result";
import type { PresentationOutputMeta } from "../../../presentation/schemas/output-meta";

/**
 * Typed compatibility adapter for the built-in EvalTool proxy executor.
 *
 * Proxy results deliberately remain at the legacy snapshot boundary, so this
 * class is the only place their strict parsed result becomes presentation
 * events. It never compares successive snapshots or parses rendered output:
 * every snapshot is an explicit legacy delivery, in producer order.
 */
export class LegacyEvalPresentation {
	readonly #events: ToolPresentationEvent[] = [];
	readonly #stream: ToolPresentationStream;
	readonly #formatOutputNotice: (meta: PresentationOutputMeta | undefined) => string;

	constructor(toolCallId: string, formatOutputNotice: (meta: PresentationOutputMeta | undefined) => string) {
		this.#stream = new ToolPresentationStream(streamId(toolCallId), event => this.#events.push(event));
		this.#formatOutputNotice = formatOutputNotice;
	}

	/** Convert one legacy progress snapshot without inferring an overlap with prior snapshots. */
	update(result: EvalResult): readonly ToolPresentationEvent[] {
		return this.#capture(() => this.#publish(result));
	}

	/** Convert the final legacy result and the one typed settlement it owns. */
	settle(result: EvalResult, resultIsError: boolean): readonly ToolPresentationEvent[] {
		return this.#capture(() => {
			this.#publish(result);
			this.#events.push({ type: "settled", outcome: legacyEvalOutcome(result, resultIsError) });
		});
	}

	#capture(action: () => void): readonly ToolPresentationEvent[] {
		const start = this.#events.length;
		action();
		return this.#events.slice(start);
	}

	#publish(result: EvalResult): void {
		const text = knownResultText(result);
		if (text.length > 0) this.#stream.appendTerminal(text);
		for (const notice of legacyEvalNotices(result, this.#formatOutputNotice)) {
			this.#stream.fact({ kind: "notice", text: notice });
		}
		for (const attachment of legacyEvalAttachments(result)) this.#stream.attachment(attachment);
	}
}

function legacyEvalNotices(
	result: EvalResult,
	formatOutputNotice: (meta: PresentationOutputMeta | undefined) => string,
): readonly string[] {
	const notices = [
		...(result.details.notice === undefined ? [] : [result.details.notice]),
		...(result.details.notices ?? []),
		...outputMetaNotice(result.details.meta, formatOutputNotice),
	];
	return notices.filter(notice => notice.length > 0);
}

/** Format parsed metadata directly; no display string is ever parsed back. */
function outputMetaNotice(
	meta: PresentationOutputMeta | undefined,
	formatOutputNotice: (meta: PresentationOutputMeta | undefined) => string,
): readonly string[] {
	if (meta === undefined) return [];
	const notice = formatOutputNotice(meta);
	return notice.length === 0 ? [] : [notice.trim()];
}

function legacyEvalAttachments(result: EvalResult): readonly ToolAttachment[] {
	const images = [
		...result.content.filter(
			(content): content is Extract<EvalResult["content"][number], { type: "image" }> => content.type === "image",
		),
		...(result.details.images ?? []),
	];
	const seen = new Set<string>();
	const attachments: ToolAttachment[] = [];
	for (const image of images) {
		const key = `${image.mimeType}\u0000${image.data}`;
		if (seen.has(key)) continue;
		seen.add(key);
		attachments.push({ kind: "image", data: image.data, mimeType: image.mimeType });
	}
	return attachments;
}

function legacyEvalOutcome(result: EvalResult, resultIsError: boolean): ToolOutcome {
	const termination = result.details.termination;
	if (termination !== undefined) {
		switch (termination.kind) {
			case "timed_out":
				return {
					kind: "failed",
					failure: { reason: "process", message: "Command timed out" },
					process: { kind: "timed_out", timeoutMs: termination.timeoutMs },
				};
			case "interrupted":
				return { kind: "interrupted", reason: "Command aborted" };
			default: {
				const exhaustive: never = termination;
				throw new Error(`Unhandled eval termination: ${JSON.stringify(exhaustive)}`);
			}
		}
	}
	const exitCode = result.details.cells?.at(-1)?.exitCode;
	if (exitCode !== undefined && exitCode !== 0) {
		return {
			kind: "failed",
			failure: { reason: "process", message: `Command exited with code ${exitCode}` },
			process: { kind: "exited", code: nonZeroExitCode(exitCode) },
		};
	}
	if (resultIsError || result.isError || result.details.isError === true) {
		return { kind: "failed", failure: { reason: "tool_reported", message: "Command failed" } };
	}
	return { kind: "succeeded", process: { kind: "exited", code: 0 } };
}
