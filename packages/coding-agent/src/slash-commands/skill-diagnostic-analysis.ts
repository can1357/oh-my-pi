import * as fs from "node:fs/promises";
import { Text } from "@oh-my-pi/pi-tui";
import { sanitizeDisplaySingleLine } from "@oh-my-pi/pi-tui/overlays/extensions/display-text";
import {
	analyzeResources,
	formatResourceAnalysis,
	resolveResourceAnalysisModel,
} from "../extensibility/resource-analysis";
import { describeRequest, SEND_DISCLOSURE } from "../extensibility/resource-consent";
import { excludeReviewedResources } from "../extensibility/resource-decisions";
import { type ResourceCandidate, snapshotResource } from "../extensibility/resource-snapshot";
import type { SkillDiagnostic } from "../extensibility/skills";
import type { InteractiveModeContext } from "../modes/types";

/** Only reached by an explicit diagnostics analysis request, never by startup rendering. */
export async function runSkillDiagnosticAnalysis(ctx: InteractiveModeContext, requestedName?: string): Promise<void> {
	const session = ctx.session;
	const sessionId = session.sessionId;
	const settings = ctx.settings;
	const sessionChanged = (): boolean => ctx.session !== session || session.sessionId !== sessionId;
	const groups = session.skillDiagnostics.filter(group => group.skills.length + group.duplicates.length > 1);
	if (groups.length === 0) {
		ctx.showStatus("No competing skill copies to analyze. Normal discovery and resolution are unchanged.");
		return;
	}
	let group: SkillDiagnostic | undefined;
	if (requestedName) {
		group = groups.find(candidate => candidate.name === requestedName);
		if (!group) throw new Error(`No diagnostic group named ${sanitizeDisplaySingleLine(requestedName)}`);
	} else {
		const selected = await ctx.showHookSelector(
			"Choose skill copies to analyze",
			groups.map(candidate => ({ value: candidate.name, label: sanitizeDisplaySingleLine(candidate.name) })),
		);
		if (selected === undefined) return;
		group = groups.find(candidate => candidate.name === selected);
		if (!group) return;
	}
	const candidates: ResourceCandidate[] = [];
	const seen = new Set<string>();
	for (const skill of [...group.skills, ...group.duplicates.map(duplicate => duplicate.skill)]) {
		const root = await fs.realpath(skill.baseDir);
		if (seen.has(root)) continue;
		seen.add(root);
		const entrypoint = await fs.realpath(skill.filePath);
		candidates.push({
			id: `skill-${candidates.length + 1}`,
			label: skill.name,
			kind: "skill",
			root,
			entrypoint,
		});
	}
	if (candidates.length < 2) {
		ctx.showStatus("These entries refer to the same resource directory; no semantic comparison is needed.");
		return;
	}
	const snapshots = await Promise.all(candidates.map(candidate => snapshotResource(candidate)));
	// Count, size cap and partial coverage are settled here, before the first prompt: a request the
	// analyzer would refuse is never offered, and nothing is billed for it.
	const summary = describeRequest(snapshots);
	const selected = resolveResourceAnalysisModel(session.modelRegistry, settings);
	const target = `${selected.model.provider}/${selected.model.id}`;
	const consent = await ctx.showHookConfirm(
		"Analyze skill copies with AI?",
		`Send these skill copies to ${target}?\n\n${summary}\n\n${SEND_DISCLOSURE}\nNo provenance is established, and nothing is hidden without another confirmation.`,
	);
	if (!consent) {
		ctx.showStatus("Cancelled; nothing was sent.");
		return;
	}
	if (sessionChanged()) throw new Error("Session changed; request analysis again in the current session");
	ctx.showStatus("Analyzing skill relationships and trade-offs…", { dim: true });
	const effort = selected.thinkingLevel ? `:${selected.thinkingLevel}` : "";
	const analysis = await analyzeResources(snapshots, session.modelRegistry, settings, {
		modelSelector: `${selected.model.provider}/${selected.model.id}${effort}`,
	});
	if (sessionChanged()) throw new Error("Session changed; analysis was not applied");
	const report = formatResourceAnalysis(snapshots, analysis);
	ctx.showCommandReport({ title: "AI Skill Analysis — Advisory", body: new Text(report, 0, 0) });
	ctx.showStatus("Analysis complete. No recommendation has been applied.");
	const preferredId = analysis.recommendation.preferredId;
	if (analysis.recommendation.action !== "prefer" || preferredId === undefined) return;
	const preferred = snapshots.find(snapshot => snapshot.candidate.id === preferredId);
	if (!preferred) throw new Error("Analysis recommendation names an unreviewed skill");
	const hidden = snapshots.filter(snapshot => snapshot.candidate.id !== preferredId);
	const apply = await ctx.showHookConfirm(
		"Apply this advisory recommendation?",
		`${report}\n\nKeep: ${sanitizeDisplaySingleLine(preferred.candidate.root)}\nHide in OMP: ${hidden.map(snapshot => sanitizeDisplaySingleLine(snapshot.candidate.root)).join(", ")}\n\nThis is your decision, not verified provenance. Files remain installed for other harnesses. Changed contents will invalidate the exclusion. Restore copies with: omp config reset diagnostics.resourceExclusions`,
	);
	if (!apply) return;
	if (sessionChanged()) throw new Error("Session changed; no decision was saved");
	await excludeReviewedResources(snapshots, preferredId, settings);
	await ctx.refreshSkillState();
	ctx.showStatus("Saved the confirmed content-bound skill choice. Other harness installations are unchanged.");
}
