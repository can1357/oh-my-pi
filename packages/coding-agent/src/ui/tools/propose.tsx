/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Propose and Report Tool Issue: one head line (`Propose Ship the plan`)
 * and the result's text under it (muted, or the error).
 *
 * Terminal look: `propose` (`src/ui/styles/tools/propose.ts`).
 */
import type { TspSpan } from "@oh-my-pi/pi-wire";
import type { ToolPresenter, ToolView } from "./contract";
import { resultText } from "./default";
import { registerToolPresenter } from "./registry";

/** A labelled one-line presenter reading its subject from `field`. */
export function labelPresenter(title: string, field: string): ToolPresenter<Record<string, unknown>> {
	const label = (args: Record<string, unknown>): TspSpan[] => {
		const subject = typeof args[field] === "string" ? (args[field] as string).split("\n")[0]!.trim() : "";
		const spans: TspSpan[] = [{ s: "toolTitle strong", t: title }];
		if (subject) spans.push({ t: " " }, { s: "muted", t: subject });
		return spans;
	};
	return {
		inline: true,
		merge: true,
		call: args => ({ label: label(args), term: { look: "propose" } }),
		result(result, _state, args): ToolView {
			const text = resultText(result);
			const view: ToolView = {
				label: label(args ?? {}),
				term: { look: "propose" },
			};
			if (result.isError)
				return {
					...view,
					tone: "error",
					body: <text spans={[{ s: "error", t: text }]} wrap="word" />,
				};
			if (!text) return view;
			return {
				...view,
				body: <text spans={[{ s: "muted", t: text }]} wrap="word" />,
			};
		},
	};
}

export const proposePresenter = labelPresenter("Propose", "title");
export const reportIssuePresenter = labelPresenter("Report Tool Issue", "report");

registerToolPresenter("propose", proposePresenter);
registerToolPresenter("report_issue", reportIssuePresenter);
