import type { CustomCommandContext } from "../../../../extensibility/custom-commands/types";
import { resolveReadPath } from "../../../../tools/path-utils";
import type { TextReviewSource } from "@oh-my-pi/pi-tui/overlays/annotation-types";

/** Read one regular text file without trimming or otherwise rewriting its bytes. */
export async function acquireFileTextReviewSource(
	ctx: CustomCommandContext,
	inputPath: string,
): Promise<TextReviewSource | undefined> {
	const filePath = inputPath.trim();
	if (!filePath) {
		ctx.ui.notify("Enter a file path to annotate.", "warning");
		return undefined;
	}

	const resolvedPath = resolveReadPath(filePath, ctx.sessionManager.getCwd?.() ?? ctx.cwd);
	const file = Bun.file(resolvedPath);
	try {
		const stat = await file.stat();
		if (!stat.isFile()) {
			ctx.ui.notify(`Cannot annotate "${filePath}": it is not a regular file.`, "error");
			return undefined;
		}
		const text = await file.text();
		return {
			id: `file:${resolvedPath}`,
			kind: "file",
			label: filePath,
			text,
			provenance: { kind: "file", path: resolvedPath },
			sessionId: ctx.sessionManager.getSessionId(),
		};
	} catch (error) {
		const detail = error instanceof Error && error.message ? error.message : String(error);
		ctx.ui.notify(`Unable to read annotation file "${filePath}": ${detail}`, "error");
		return undefined;
	}
}

/** Create a prompt-backed source while preserving the supplied text exactly. */
export function createPromptTextReviewSource(ctx: CustomCommandContext, text: string): TextReviewSource | undefined {
	if (text.length === 0) {
		ctx.ui.notify("Enter text to annotate.", "warning");
		return undefined;
	}
	return {
		id: "prompt",
		kind: "prompt",
		label: "Text prompt",
		text,
		provenance: { kind: "prompt" },
		sessionId: ctx.sessionManager.getSessionId(),
	};
}
