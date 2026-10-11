import type { CustomCommandContext } from "../../../../extensibility/custom-commands/types";
import { resolveReadPath } from "../../../../tools/path-utils";
import type { TextReviewSource } from "@oh-my-pi/pi-tui/overlays/annotation-types";

/**
 * Read one regular text file without trimming or otherwise rewriting its bytes.
 * Throws when the path is blank, missing, or not a regular file.
 */
export async function readFileTextReviewSource(
	inputPath: string,
	cwd: string,
	sessionId: string,
): Promise<TextReviewSource> {
	const filePath = inputPath.trim();
	if (!filePath) throw new Error("Enter a file path to annotate.");
	const resolvedPath = resolveReadPath(filePath, cwd);
	const file = Bun.file(resolvedPath);
	const readFailure = (error: unknown) => {
		const detail = error instanceof Error && error.message ? error.message : String(error);
		return new Error(`Unable to read annotation file "${filePath}": ${detail}`);
	};
	let isFile: boolean;
	try {
		isFile = (await file.stat()).isFile();
	} catch (error) {
		throw readFailure(error);
	}
	if (!isFile) throw new Error(`Cannot annotate "${filePath}": it is not a regular file.`);
	let text: string;
	try {
		text = await file.text();
	} catch (error) {
		throw readFailure(error);
	}
	return {
		id: `file:${resolvedPath}`,
		kind: "file",
		label: filePath,
		text,
		provenance: { kind: "file", path: resolvedPath },
		sessionId,
	};
}

/** Interactive wrapper: reports read failures as notifications instead of throwing. */
export async function acquireFileTextReviewSource(
	ctx: CustomCommandContext,
	inputPath: string,
): Promise<TextReviewSource | undefined> {
	try {
		return await readFileTextReviewSource(
			inputPath,
			ctx.sessionManager.getCwd?.() ?? ctx.cwd,
			ctx.sessionManager.getSessionId(),
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(message, inputPath.trim() ? "error" : "warning");
		return undefined;
	}
}

/** Build a prompt-backed source, preserving the supplied text exactly. */
export function promptTextReviewSource(text: string, sessionId: string, label = "Text prompt"): TextReviewSource {
	return { id: "prompt", kind: "prompt", label, text, provenance: { kind: "prompt" }, sessionId };
}

/** Create a prompt-backed source while preserving the supplied text exactly. */
export function createPromptTextReviewSource(ctx: CustomCommandContext, text: string): TextReviewSource | undefined {
	if (text.length === 0) {
		ctx.ui.notify("Enter text to annotate.", "warning");
		return undefined;
	}
	return promptTextReviewSource(text, ctx.sessionManager.getSessionId());
}
