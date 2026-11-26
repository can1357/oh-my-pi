/**
 * The plan review's terminal look: the whole review drawn as one fullscreen
 * box by {@link PlanReviewModel.frame} (the plan scrolled beside its
 * Contents, the options, the hints or the note editor), and its pointer:
 * the wheel scrolls, motion lights an option, a click runs an option, jumps
 * to a Contents entry or focuses the plan.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { type Block, defineRolePainter } from "@oh-my-pi/pi-tui/term/paint";
import { defineRoleWidget } from "@oh-my-pi/pi-tui/term/widgets";
import type { PlanReviewModel } from "../../overlays/panels/plan-review-model";
import { termOf } from "./common";

const ROLE = "omp.planReview";

function reviewOf(node: UiNode): PlanReviewModel | undefined {
	return termOf<{ review: PlanReviewModel }>(node).review;
}

defineRolePainter("col", ROLE, (node, cx): Block => {
	const review = reviewOf(node);
	if (!review || cx.width <= 0) return { rows: [] };
	review.rev();
	const frame = review.frame(cx.width, cx.height ?? review.terminal.size().rows, cx.theme);
	return { rows: frame.rows, hits: [{ row: 0, col: 0, width: cx.width, height: frame.rows.length, node }] };
});

defineRoleWidget("col", ROLE, {
	mouse(node, mouse, at, _cx, hit) {
		const review = reviewOf(node);
		if (!review) return false;
		const frame = review.frame(hit.width, hit.height, review.terminal.theme());
		return review.mouse(frame, mouse, at.row, at.col);
	},
});
