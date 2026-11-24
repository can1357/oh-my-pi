/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Resolve and Reject: settle a pending proposed action.
 *
 * The call reads `Resolve apply  proposed → resolved` with the reason under
 * it; the result names the outcome (`Accept:`, `Discard:`, `Failed:`), the
 * action's summary and its source tool, toned success/warning/error, with
 * the reason (or "No reason provided") as the body.
 *
 * Terminal look: `resolve` (`src/ui/styles/tools/resolve.ts`).
 */
import type { TspSpan, TspTone } from "@oh-my-pi/pi-wire";
import { replaceTabs } from "@oh-my-pi/pi-tui/text/width";
import type { ToolPresenter, ToolView } from "./contract";
import { registerToolPresenter } from "./registry";

export interface ResolveArgs {
	readonly action?: "apply" | "discard";
	readonly reason?: string;
}

export interface ResolveDetails {
	readonly action?: "apply" | "discard";
	readonly reason?: string;
	/** `tool: summary` of the pending action. */
	readonly label?: string;
}

function cleanReason(reason: unknown): string {
	return typeof reason === "string" ? replaceTabs(reason).trim() : "";
}

function resolvePresenter(defaultAction: "apply" | "discard"): ToolPresenter<ResolveArgs, ResolveDetails> {
	return {
		inline: true,
		merge: true,
		call(args) {
			const action = args.action ?? defaultAction;
			const reason = cleanReason(args.reason);
			const apply = action === "apply";
			return {
				label: [
					{ s: "toolTitle strong", t: "Resolve" },
					{ t: " " },
					{ s: "muted", t: action },
					{ t: " " },
					{
						s: apply ? "success" : "warning",
						t: apply ? "proposed → resolved" : "proposed → rejected",
					},
				],
				body: reason ? <text spans={[{ s: "muted", t: reason }]} wrap="word" lines={1} /> : undefined,
				term: { look: "resolve" },
			};
		},
		result(result): ToolView {
			const details = result.details;
			const action = details?.action ?? "apply";
			// A failed discard still reads as a discard; only a failed apply is "Failed".
			const verb = action === "apply" ? (result.isError ? "Failed:" : "Accept:") : "Discard:";
			const tone: TspTone = result.isError ? "error" : action === "apply" ? "success" : "warning";
			const raw = details?.label ?? "pending action";
			const cut = raw.indexOf(": ");
			const tool = cut > 0 ? raw.slice(0, cut) : undefined;
			const summary = (cut > 0 ? raw.slice(cut + 2) : raw).trim();
			const label: TspSpan[] = [{ s: `strong ${tone}`, t: verb }, { t: " " }, { t: summary }];
			if (tool) label.push({ t: " " }, { s: "strong muted", t: `[${tool}]` });
			const reason = cleanReason(details?.reason) || "No reason provided";
			return {
				label,
				tone,
				body: <text spans={[{ s: "muted", t: reason }]} wrap="word" />,
				term: { look: "resolve" },
			};
		},
	};
}

export const resolveToolPresenter = resolvePresenter("apply");
export const rejectToolPresenter = resolvePresenter("discard");

registerToolPresenter("resolve", resolveToolPresenter);
registerToolPresenter("reject", rejectToolPresenter);
