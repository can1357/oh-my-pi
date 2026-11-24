/** Serializable annotations retained by the plan-review owner between overlays. */
export interface PlanReviewAnnotationState {
	annotations: Array<{
		section: {
			index: number;
			title: string;
			/** Heading ancestry from the document root, when emitted by this overlay. */
			path?: string[];
			/** Hash of the section source, used to reject ambiguous moved headings. */
			contentHash?: string;
		};
		/** A quote's `at` is the offset of its first char in the section's source. */
		target:
			| { kind: "section" }
			| { kind: "line"; row: number; context: string; contextTruncated?: boolean }
			| { kind: "quote"; quote: string; at: number };
		note: string;
	}>;
}

/** One approval choice of the review. */
export interface PlanReviewOverlayChoice {
	/** What `onPick` reports. */
	readonly id: string;
	readonly label: string;
	/** The native approve menu row's second line (falls back to {@link meta}). */
	readonly detail?: string;
	/** Short dim text after the label in the option list (a context size); the menu row's detail without `detail`. */
	readonly meta?: string;
	/** Why it can't be chosen now: the option dims and is skipped. */
	readonly disabled?: string;
}
