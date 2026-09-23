export type ReviewSourceRowKind = "context" | "added" | "removed";

export interface ReviewSourceRow {
	kind: ReviewSourceRowKind;
	raw: string;
	content: string;
	oldLine?: number;
	newLine?: number;
	hunkHeader: string;
}

export type ReviewDiffRow =
	| ReviewSourceRow
	| { kind: "hunk"; raw: string; hunkHeader: string }
	| { kind: "no-newline"; raw: string; hunkHeader: string };

export interface ReviewDiffFile {
	path: string;
	oldPath?: string;
	newPath?: string;
	occurrence: number;
	rawDiff: string;
	rows: ReviewDiffRow[];
	linesAdded: number;
	linesRemoved: number;
	isBinary: boolean;
}

export interface CodeReviewAnnotationBase {
	path: string;
	oldPath?: string;
	newPath?: string;
	occurrence: number;
	note: string;
}

export type CodeReviewAnnotation =
	| (CodeReviewAnnotationBase & {
			scope: "file";
	  })
	| (CodeReviewAnnotationBase & {
			scope: "line";
			hunkHeader: string;
			oldLine?: number;
			newLine?: number;
			rawLine: string;
	  });

export interface CodeReviewOverlayResult {
	action: "review" | "paste";
	annotations: CodeReviewAnnotation[];
}

export type TextReviewSourceProvenance =
	| { kind: "latest-assistant"; entryId: string }
	| { kind: "session"; entryId: string }
	| { kind: "file"; path: string }
	| { kind: "prompt" };

export interface TextReviewSource {
	/** Identifies the source within this annotation run. */
	id: string;
	kind: "message" | "code" | "quote" | "command" | "file" | "prompt";
	label: string;
	text: string;
	/** Identifies the active session entry that supplied this source, when applicable. */
	provenance?: TextReviewSourceProvenance;
	sessionId?: string;
}

export type TextReviewAnnotation =
	| { scope: "text"; note: string }
	| { scope: "line"; line: number; quote: string; note: string };

export interface TextReviewOverlayResult {
	action: "paste";
	annotations: TextReviewAnnotation[];
}
