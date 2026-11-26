/**
 * The annotation review's terminal look: the whole review drawn as one box
 * by {@link AnnotationReviewModel.frame} (the file rail beside the lines,
 * the actions, the hints, the note editor or chooser).
 */
import { type Block, defineRolePainter } from "@oh-my-pi/pi-tui/term/paint";
import type { AnnotationReviewModel } from "../../overlays/panels/annotation-review-model";
import { termOf } from "./common";

defineRolePainter("col", "omp.annotationReview", (node, cx): Block => {
	const review = termOf<{ review: AnnotationReviewModel }>(node).review;
	if (!review || cx.width <= 0) return { rows: [] };
	review.rev();
	return { rows: review.frame(cx.width, cx.theme).rows };
});
