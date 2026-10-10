import type {
	AnnotationDelivery,
	AnnotationDiffNote,
	AnnotationDiffSource,
	AnnotationResult,
	AnnotationSource,
	AnnotationTextNote,
	AnnotationTextSource,
	ExtensionAnnotationsAPI,
	ExtensionContext,
} from "../../../../extensibility/extensions/types";
import type { SendUserMessageOptions } from "../../../../session/agent-session";
import { splitTextLines } from "@oh-my-pi/pi-tui/overlays/annotation-overlay";
import type {
	CodeReviewAnnotation,
	TextReviewAnnotation,
	TextReviewSource,
} from "@oh-my-pi/pi-tui/overlays/annotation-types";
import { fetchPrReviewTarget, parseReviewPrRef } from "../review";
import { assertReviewablePatchSize, buildCodeReviewFeedback } from "../review/prompt";
import {
	createResolvedReviewTarget,
	getReviewTargetIssue,
	type ResolvedReviewTarget,
	readUncommittedReviewTarget,
} from "../review/target";
import { promptTextReviewSource, readFileTextReviewSource } from "./direct-source";
import { showCodeReviewOverlay, showTextReviewOverlay } from "./fullscreen";
import { buildTextReviewPrompt } from "./text-review";
import { latestAssistantTextReviewSource } from "./text-source";

/** The slice of an extension context the annotation API reads. */
export type AnnotationContext = Pick<ExtensionContext, "ui" | "mode" | "hasUI" | "cwd" | "sessionManager" | "isIdle">;

async function resolveTextSource(ctx: AnnotationContext, source: AnnotationTextSource): Promise<TextReviewSource> {
	const sessionId = ctx.sessionManager.getSessionId();
	switch (source.kind) {
		case "text":
			if (source.text.length === 0) throw new Error("Annotation text source is empty.");
			return promptTextReviewSource(source.text, sessionId, source.label);
		case "file":
			return readFileTextReviewSource(source.path, ctx.sessionManager.getCwd?.() ?? ctx.cwd, sessionId);
		case "last": {
			const latest = latestAssistantTextReviewSource(ctx.sessionManager.getBranch(), sessionId);
			if (!latest) throw new Error("No non-empty assistant reply is available on the active session branch.");
			return latest;
		}
	}
}

async function resolveDiffTarget(ctx: AnnotationContext, source: AnnotationDiffSource): Promise<ResolvedReviewTarget> {
	const cwd = ctx.sessionManager.getCwd?.() ?? ctx.cwd;
	let target: ResolvedReviewTarget;
	switch (source.kind) {
		case "diff":
			target = createResolvedReviewTarget(
				"patch",
				source.label ?? "Reviewing a supplied diff",
				source.diff,
				"The supplied diff is empty",
			);
			break;
		case "uncommitted":
			target = await readUncommittedReviewTarget(cwd);
			break;
		case "pr": {
			const ref = parseReviewPrRef(source.ref);
			if (!ref) throw new Error(`Not a GitHub pull request reference: ${source.ref}`);
			target = await fetchPrReviewTarget(cwd, ref);
			break;
		}
	}
	const issue = getReviewTargetIssue(target);
	if (issue) throw new Error(issue);
	return target;
}

function matchTextNotes(source: TextReviewSource, notes: readonly AnnotationTextNote[]): TextReviewAnnotation[] {
	const lines = splitTextLines(source.text);
	return notes.map((entry, index) => {
		const note = entry.note.trim();
		if (!note) throw new Error(`Annotation ${index + 1} has an empty note.`);
		if (entry.line === undefined) return { scope: "text", note };
		if (!Number.isInteger(entry.line) || entry.line < 1 || entry.line > lines.length) {
			throw new Error(
				`Annotation ${index + 1}: line ${entry.line} is outside ${source.label} (lines 1-${lines.length}).`,
			);
		}
		const quote = lines[entry.line - 1]!;
		if (entry.quote !== undefined && entry.quote !== quote) {
			throw new Error(
				`Annotation ${index + 1}: line ${entry.line} of ${source.label} no longer matches its quote (expected ${JSON.stringify(entry.quote)}, found ${JSON.stringify(quote)}).`,
			);
		}
		return { scope: "line", line: entry.line, quote, note };
	});
}

function matchDiffNotes(target: ResolvedReviewTarget, notes: readonly AnnotationDiffNote[]): CodeReviewAnnotation[] {
	return notes.map((entry, index) => {
		const label = `Annotation ${index + 1}`;
		const note = entry.note.trim();
		if (!note) throw new Error(`${label} has an empty note.`);
		const occurrence = entry.occurrence ?? 1;
		const atOccurrence = target.snapshot.files.filter(candidate => candidate.occurrence === occurrence);
		// `occurrence` counts per `path`, so an exact path wins before a rename's old/new name can capture the note.
		const file =
			atOccurrence.find(candidate => candidate.path === entry.path) ??
			atOccurrence.find(candidate => candidate.oldPath === entry.path || candidate.newPath === entry.path);
		if (!file) {
			const excluded = target.snapshot.excluded.find(candidate => candidate.path === entry.path);
			throw new Error(
				excluded
					? `${label}: ${entry.path} is excluded from review (${excluded.reason}).`
					: `${label}: ${entry.path} (occurrence ${occurrence}) is not in the diff.`,
			);
		}
		const common = {
			path: file.path,
			...(file.oldPath === undefined ? {} : { oldPath: file.oldPath }),
			...(file.newPath === undefined ? {} : { newPath: file.newPath }),
			occurrence: file.occurrence,
			note,
		};
		if (entry.line === undefined) return { ...common, scope: "file" };
		const side = entry.side ?? "new";
		const row = file.rows.find(
			candidate =>
				candidate.kind !== "hunk" &&
				candidate.kind !== "no-newline" &&
				(side === "new" ? candidate.newLine : candidate.oldLine) === entry.line,
		);
		if (!row || row.kind === "hunk" || row.kind === "no-newline") {
			throw new Error(`${label}: ${side} line ${entry.line} of ${file.path} is not in the diff.`);
		}
		if (entry.rawLine !== undefined && entry.rawLine !== row.raw) {
			throw new Error(
				`${label}: ${side} line ${entry.line} of ${file.path} no longer matches its rawLine (expected ${JSON.stringify(entry.rawLine)}, found ${JSON.stringify(row.raw)}).`,
			);
		}
		return {
			...common,
			scope: "line",
			hunkHeader: row.hunkHeader,
			...(row.oldLine === undefined ? {} : { oldLine: row.oldLine }),
			...(row.newLine === undefined ? {} : { newLine: row.newLine }),
			rawLine: row.raw,
		};
	});
}

function deliver(
	ctx: AnnotationContext,
	sendUserMessage: (text: string, options?: SendUserMessageOptions) => void,
	text: string | undefined,
	review: boolean,
	requested: AnnotationDelivery = "auto",
): AnnotationResult["delivered"] {
	if (text === undefined || requested === "none") return "none";
	const tuiEditor = ctx.mode === "tui" && ctx.hasUI && ctx.ui.supportsEditor === true;
	const channel = requested === "auto" ? (review || !tuiEditor ? "send" : "paste") : requested;
	if (channel === "send") {
		// Queue behind a running turn instead of steering into it.
		sendUserMessage(text, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
		return "send";
	}
	if (!ctx.hasUI || ctx.ui.supportsEditor !== true) {
		throw new Error(
			`Cannot paste annotation feedback without an editor (mode "${ctx.mode}"); deliver with "send" or "none".`,
		);
	}
	ctx.ui.pasteToEditor(text);
	return "paste";
}

function isTextRequest<T extends { source: AnnotationSource }>(
	request: T,
): request is Extract<T, { source: AnnotationTextSource }> {
	return request.source.kind === "text" || request.source.kind === "file" || request.source.kind === "last";
}

/**
 * Bind `/annotate` to a context. `getContext` is read per call so a context built after the
 * API (the runner's per-invocation context) still supplies its live cwd and UI.
 */
export function createAnnotationsAPI(
	getContext: () => AnnotationContext,
	sendUserMessage: (text: string, options?: SendUserMessageOptions) => void,
): ExtensionAnnotationsAPI {
	return {
		async submit(request) {
			const ctx = getContext();
			if (isTextRequest(request)) {
				const source = await resolveTextSource(ctx, request.source);
				const annotations = matchTextNotes(source, request.notes);
				const text = buildTextReviewPrompt(source, annotations);
				return {
					kind: "text",
					text,
					delivered: deliver(ctx, sendUserMessage, text, false, request.deliver),
					review: false,
					annotations,
				};
			}
			const target = await resolveDiffTarget(ctx, request.source);
			const annotations = matchDiffNotes(target, request.notes);
			const review = request.review === true;
			const text = buildCodeReviewFeedback(target, annotations, review, request.focus);
			return {
				kind: "diff",
				text,
				delivered: deliver(ctx, sendUserMessage, text, review, request.deliver),
				review,
				annotations,
			};
		},
		async open(request) {
			const ctx = getContext();
			if (ctx.mode !== "tui") {
				throw new Error(`The annotation overlay needs the interactive TUI (mode "${ctx.mode}"); use submit.`);
			}
			if (isTextRequest(request)) {
				let source = await resolveTextSource(ctx, request.source);
				const result = await showTextReviewOverlay(ctx, source);
				if (!result) return undefined;
				if (result.editedText !== undefined) source = { ...source, text: result.editedText };
				const text = buildTextReviewPrompt(source, result.annotations);
				return {
					kind: "text",
					text,
					delivered: deliver(ctx, sendUserMessage, text, false, request.deliver),
					review: false,
					annotations: result.annotations,
					...(result.editedText === undefined ? {} : { editedText: result.editedText }),
				};
			}
			const target = await resolveDiffTarget(ctx, request.source);
			// The overlay defaults to a review request; reject before the operator writes notes it would drop.
			assertReviewablePatchSize(target);
			const result = await showCodeReviewOverlay(ctx, target);
			if (!result) return undefined;
			const review = result.action === "review";
			const text = buildCodeReviewFeedback(target, result.annotations, review, request.focus);
			return {
				kind: "diff",
				text,
				delivered: deliver(ctx, sendUserMessage, text, review, request.deliver),
				review,
				annotations: result.annotations,
			};
		},
	};
}
