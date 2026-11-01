import { type OverlayOptions, truncateToWidth } from "@oh-my-pi/pi-tui";
import {
	sanitizeDisplayText,
	sanitizeDisplaySingleLine as line,
} from "@oh-my-pi/pi-tui/overlays/extensions/display-text";
import type {
	SkillDiagnosticAnalysisRecord,
	SkillDiagnosticController,
} from "../extensibility/skill-diagnostic-controller";
import { INCOMPLETE_COVERAGE_DISCLOSURE } from "../extensibility/resource-consent";
import {
	SkillDiagnosticsPanel,
	type SkillDiagnosticsPanelNotice,
	type SkillDiagnosticsPanelResult,
} from "../modes/components/skill-diagnostics-panel";
import type { InteractiveModeContext } from "../modes/types";
import { errorMessage } from "./helpers/parse";

/** Same fullscreen modal the other hubs use. Mouse reporting stays off so paths can be selected and copied. */
const PANEL_OVERLAY: OverlayOptions = {
	anchor: "bottom-center",
	width: "100%",
	maxHeight: "100%",
	margin: 0,
	fullscreen: true,
	mouseTracking: false,
};

const SESSION_CHANGED = "Session changed; request analysis again in the current session";

/** Last row selected per session controller, so closing and reopening the panel keeps its place. */
const lastSelected = new WeakMap<SkillDiagnosticController, string>();

/**
 * `/skills diagnostics`: show the panel over the session's shared controller. The panel cannot bill or write,
 * so Enter and A close it with a typed result; this loop asks the native consent dialogs, calls the
 * controller, and reopens the panel on the same row with the outcome. Records, progress and results stay in
 * the controller, so a reopened panel (or an RPC client) sees the same state.
 */
export async function runSkillDiagnosticsPanel(ctx: InteractiveModeContext): Promise<void> {
	const session = ctx.session;
	const controller = session.skillDiagnosticController;
	let notice: SkillDiagnosticsPanelNotice | undefined;
	for (;;) {
		const shown = notice;
		const result = await ctx.showHookCustom<SkillDiagnosticsPanelResult>(
			(tui, _theme, _keybindings, done) =>
				new SkillDiagnosticsPanel(tui, controller, {
					initialName: lastSelected.get(controller),
					notice: shown,
					done,
				}),
			{ overlay: true, overlayOptions: PANEL_OVERLAY },
		);
		if (result.selected !== undefined) lastSelected.set(controller, result.selected);
		if (result.action === "close") return;
		try {
			notice =
				result.action === "analyze"
					? await requestAnalysis(ctx, controller, result.selected, result.prepared)
					: await applyRecommendation(ctx, controller, result.record);
		} catch (error) {
			notice = { tone: "error", text: errorMessage(error) };
		}
		if (ctx.session !== session) {
			ctx.showStatus("Session changed; reopen /skills diagnostics for the current session.");
			return;
		}
	}
}

/** Enter: reuse or prepare a plan (nothing billable), ask consent with the exact disclosure, only then start. */
async function requestAnalysis(
	ctx: InteractiveModeContext,
	controller: SkillDiagnosticController,
	name: string,
	prepared: SkillDiagnosticAnalysisRecord | undefined,
): Promise<SkillDiagnosticsPanelNotice> {
	const session = ctx.session;
	const sessionId = session.sessionId;
	const record = prepared ?? (await controller.prepare(name));
	if (record.status !== "prepared") {
		return {
			tone: "info",
			text:
				record.status === "running"
					? "An analysis is already running for this skill."
					: `This skill's analysis is ${record.status}; nothing new was started.`,
		};
	}
	const consent = await ctx.showHookConfirm("Analyze skill copies with AI?", consentMessage(record));
	if (ctx.session !== session || session.sessionId !== sessionId) throw new Error(SESSION_CHANGED);
	if (!consent) {
		controller.cancel(record.id);
		return { tone: "info", text: "Cancelled; nothing was sent." };
	}
	controller.start(record.id, true);
	return {
		tone: "info",
		text: "Analyzing… the result stays in this panel when it finishes. Nothing is applied automatically.",
	};
}

/** A on a completed recommendation: a second, model-independent confirmation, then the controller applies it. */
async function applyRecommendation(
	ctx: InteractiveModeContext,
	controller: SkillDiagnosticController,
	record: SkillDiagnosticAnalysisRecord,
): Promise<SkillDiagnosticsPanelNotice> {
	const session = ctx.session;
	const sessionId = session.sessionId;
	const confirmed = await ctx.showHookConfirm("Apply this advisory recommendation?", applyMessage(record));
	if (ctx.session !== session || session.sessionId !== sessionId) {
		throw new Error("Session changed; no decision was saved");
	}
	if (!confirmed) return { tone: "info", text: "Nothing applied; every copy stays active." };
	await controller.apply(record.id, true);
	return {
		tone: "success",
		text: "Saved the confirmed content-bound skill choice. Other harness installations are unchanged.",
	};
}

/** What will leave the machine: exact model, every location, size, coverage and the standing disclosure. */
function consentMessage(record: SkillDiagnosticAnalysisRecord): string {
	const lines = [
		`Send these skill copies to ${line(record.model)}?`,
		"",
		...record.candidates.map(candidate => {
			const partial = candidate.complete ? "" : `, PARTIAL: ${candidate.omissions.length} omission(s)`;
			return `  ${line(candidate.root)} (${candidate.files} file${candidate.files === 1 ? "" : "s"}${partial})`;
		}),
		`Resource data: ${(record.bytes / 1024).toFixed(1)} KiB, plus prompt framing.`,
	];
	if (record.candidates.some(candidate => !candidate.complete)) {
		lines.push(INCOMPLETE_COVERAGE_DISCLOSURE);
	}
	lines.push(
		"",
		sanitizeDisplayText(record.disclosure),
		"No provenance is established, and nothing is hidden without another confirmation.",
	);
	return lines.join("\n");
}

/** Effects come from the controller's own records; the model's reason is quoted as unverified advice. */
function applyMessage(record: SkillDiagnosticAnalysisRecord): string {
	const preferredId = record.result?.recommendation.preferredId;
	const roots = (keep: boolean): string =>
		record.candidates
			.filter(candidate => (candidate.id === preferredId) === keep)
			.map(candidate => line(candidate.root))
			.join(", ");
	return [
		`Keep: ${roots(true)}`,
		`Hide in OMP: ${roots(false)}`,
		"",
		`Model's advisory reason (not verified): ${truncateToWidth(line(record.result?.recommendation.reason ?? ""), 300)}`,
		"",
		"This is your decision, not verified provenance. Files remain installed for other harnesses. Changed contents will invalidate the exclusion. Restore copies with: omp config reset diagnostics.resourceExclusions",
	].join("\n");
}
