import { renderAsciiBar } from "@oh-my-pi/pi-tui/chrome/format";
import type { Theme } from "@oh-my-pi/pi-tui/theme";
import { renderContextUsage } from "@oh-my-pi/pi-tui/status-line/context-usage";
import { formatNumber } from "@oh-my-pi/pi-utils";
import type { ContextBreakdown } from "@oh-my-pi/pi-tui/status-line/context-usage";
import type { ContextFlowSnapshot, ContextFlowNode, ContextFlowNodeStatus, WiringStatus } from "./types";

export type ContextExplorerView = "window" | "flow" | "offload" | "economics";

const VIEW_ORDER: ContextExplorerView[] = ["window", "flow", "offload", "economics"];

export function cycleContextExplorerView(current: ContextExplorerView, delta: number): ContextExplorerView {
	const idx = VIEW_ORDER.indexOf(current);
	const next = (idx + delta + VIEW_ORDER.length) % VIEW_ORDER.length;
	return VIEW_ORDER[next]!;
}

export function formatBytes(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

function wiringLabel(status: WiringStatus | undefined): string {
	switch (status) {
		case "hot_path":
			return "HOT";
		case "conditional":
			return "COND";
		case "shadow":
			return "SHADOW";
		case "experiment_only":
			return "EXPERIMENT";
		case "present_not_wired":
			return "NOT WIRED";
		case "stale":
			return "STALE";
		default:
			return "UNKNOWN";
	}
}

function statusGlyph(status: ContextFlowNodeStatus): string {
	switch (status) {
		case "running":
			return "◉";
		case "complete":
			return "✓";
		case "failed":
			return "✗";
		case "skipped":
			return "⊘";
		case "pending":
			return "○";
		case "not_wired":
			return "—";
		default:
			return "·";
	}
}

function formatFlowNode(node: ContextFlowNode, depth = 0): string[] {
	const prefix = depth === 0 ? "●" : "├─";
	const indent = depth > 0 ? "│  ".repeat(depth - 1) : "";
	const dur =
		node.status === "running"
			? "running"
			: node.durationMs !== undefined
				? `${node.durationMs.toFixed(1)}ms`
				: node.status === "not_wired"
					? "NOT WIRED"
					: "";
	const io =
		node.inputTokens !== undefined || node.outputTokens !== undefined
			? `${formatNumber(node.inputTokens ?? 0)}→${formatNumber(node.outputTokens ?? 0)}t`
			: node.inputBytes !== undefined
				? `${formatBytes(node.inputBytes)} externalized`
				: "";
	const provider = node.provider && node.model ? `${node.provider}/${node.model}` : node.model ?? node.provider;
	const lines = [
		`${indent}${prefix} ${statusGlyph(node.status)} ${node.component}`.padEnd(28) +
			[dur, io, node.grantCount !== undefined ? `${node.grantCount} grants` : ""].filter(Boolean).join("  "),
	];
	if (provider) lines.push(`${indent}│    └─ ${provider}`);
	if (node.decision) lines.push(`${indent}│    └─ ${node.decision}`);
	if (node.reason && node.status === "skipped") lines.push(`${indent}│    └─ ${node.reason}`);
	if (node.visibility !== "root") lines.push(`${indent}│    (${node.visibility})`);
	return lines;
}

export function renderContextExplorerView(
	view: ContextExplorerView,
	breakdown: ContextBreakdown,
	flow: ContextFlowSnapshot,
): string {
	switch (view) {
		case "window":
			return renderWindowView(breakdown);
		case "flow":
			return renderFlowView(flow);
		case "offload":
			return renderOffloadView(flow);
		case "economics":
			return renderEconomicsView(flow);
	}
}

export function renderFullContextExplorer(breakdown: ContextBreakdown, flow: ContextFlowSnapshot): string {
	const parts = VIEW_ORDER.map(view => renderContextExplorerView(view, breakdown, flow));
	return parts.join("\n\n" + "═".repeat(40) + "\n\n");
}

function renderWindowView(breakdown: ContextBreakdown): string {
	if (breakdown.contextWindow <= 0) return "Context window unavailable (no model).";
	const usedPct = ((breakdown.usedTokens / breakdown.contextWindow) * 100).toFixed(1);
	const lines = [
		`WINDOW — root context only`,
		`Context  ${formatNumber(breakdown.usedTokens)} / ${formatNumber(breakdown.contextWindow)}   ${usedPct}%`,
		"",
		renderAsciiBar(breakdown.usedTokens / breakdown.contextWindow, 32),
		"",
	];
	for (const cat of breakdown.categories) {
		if (cat.tokens === 0) continue;
		lines.push(`${cat.label.padEnd(18)} ${formatNumber(cat.tokens)}`);
	}
	lines.push("─".repeat(28));
	if (breakdown.autoCompactBufferTokens > 0) {
		lines.push(`${"Auto-compact buffer".padEnd(18)} ${formatNumber(breakdown.autoCompactBufferTokens)}`);
	}
	if (breakdown.freeTokens > 0) {
		lines.push(`${"Free".padEnd(18)} ${formatNumber(breakdown.freeTokens)}`);
	}
	return lines.join("\n");
}

function renderFlowView(flow: ContextFlowSnapshot): string {
	const lines = [`FLOW — turn ${flow.turn}`, ""];
	const turnNodes = flow.nodes.filter(n => n.turn === flow.turn);
	if (turnNodes.length === 0) {
		lines.push("(no instrumented stages this turn yet)");
	} else {
		const roots = turnNodes.filter(n => !n.parentId);
		const children = new Map<string, ContextFlowNode[]>();
		for (const node of turnNodes) {
			if (!node.parentId) continue;
			const bucket = children.get(node.parentId) ?? [];
			bucket.push(node);
			children.set(node.parentId, bucket);
		}
		const renderNode = (node: ContextFlowNode, depth = 0): void => {
			lines.push(...formatFlowNode(node, depth));
			for (const child of children.get(node.id) ?? []) renderNode(child, depth + 1);
		};
		for (const root of roots) renderNode(root, 0);
	}
	lines.push("");
	lines.push("Research stack (static wiring):");
	for (const [name, status] of Object.entries(flow.wiring)) {
		if (name.startsWith("omp.")) continue;
		lines.push(`  ${name.padEnd(16)} ${wiringLabel(status)}`);
	}
	return lines.join("\n");
}

function renderOffloadView(flow: ContextFlowSnapshot): string {
	const o = flow.offload;
	const lines = [
		"OFFLOAD — external / addressable (not in root window %)",
		"",
		`RLM stored (external)     ${formatBytes(o.externalBytes)}`,
		`Granted to workers        ${o.grantedTokens ? `${formatNumber(o.grantedTokens)} t (est.)` : "—"}`,
		`Reintroduced to root      ${formatNumber(o.reintroducedTokens)} t`,
		"",
		"Semantic / SLM layer:",
		`  NanoJev                  ${wiringLabel(flow.wiring.nanojev)}`,
		`  OpenJev                  ${wiringLabel(flow.wiring.openjev)}`,
		`  TypeSafe Jev             ${wiringLabel(flow.wiring["typesafe.jev"])}`,
		"",
		"Neural classifiers:",
		`  fly                      ${wiringLabel(flow.wiring["fly.classifier"])}`,
		`  mushroom                 ${wiringLabel(flow.wiring["mushroom.classifier"])}`,
		"",
		`  z0int                    ${wiringLabel(flow.wiring.z0int)}`,
		`  Kerdoios                 ${wiringLabel(flow.wiring.kerdoios)}`,
	];
	if (!o.active) lines.push("", "(no offload activity this session)");
	return lines.join("\n");
}

function renderEconomicsView(flow: ContextFlowSnapshot): string {
	const e = flow.economics;
	if (!e.tokenomicsEnabled) {
		return "ECONOMICS — Tokenomics disabled (set OMP_TOKENOMICS≠0)";
	}
	const lines = [
		"ECONOMICS — from Tokenomics summarizeTrace (in-memory)",
		"",
		`Root model tokens         ${formatNumber(e.rootTokens)}`,
		`Worker tokens             ${formatNumber(e.workerTokens)}`,
		`Subagent tokens           ${formatNumber(e.subagentTokens)}`,
		`Cached tokens             ${formatNumber(e.cachedTokens)}`,
		`Unattributed              ${formatNumber(e.unattributedTokens)}`,
		`Total incremental         ${formatNumber(e.totalIncrementalTokens)}`,
		"",
		`Cost (USD)                $${e.costUsd.toFixed(4)}`,
	];
	if (e.reconciliationDelta !== undefined) {
		lines.push(`Reconciliation Δ          ${e.reconciliationDelta}`);
	}
	if (e.coverage !== undefined) {
		lines.push(`Accounting coverage       ${(e.coverage * 100).toFixed(1)}%`);
	}
	lines.push("", "Unverified turns are not labeled successful.");
	return lines.join("\n");
}

export function contextExplorerTitle(view: ContextExplorerView): string {
	switch (view) {
		case "window":
			return "Context Explorer — WINDOW";
		case "flow":
			return "Context Explorer — FLOW";
		case "offload":
			return "Context Explorer — OFFLOAD";
		case "economics":
			return "Context Explorer — ECONOMICS";
	}
}

const TURN_FLOW_ORDER = [
	"omp.user",
	"omp.rlm.search",
	"omp.rlm.grants",
	"omp.rlm.groq_codec",
	"omp.rlm.worker",
	"omp.root",
] as const;

function flowStepLabel(component: string): string {
	switch (component) {
		case "omp.user":
			return "prompt";
		case "omp.rlm.search":
			return "RLM search";
		case "omp.rlm.grants":
			return "grants";
		case "omp.rlm.groq_codec":
			return "Groq codec";
		case "omp.rlm.worker":
			return "worker";
		case "omp.root":
			return "root model";
		default:
			return component.replace(/^omp\./, "");
	}
}

function formatTokenShort(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

function formatTokenCount(n: number): string {
	return `${formatTokenShort(n)} t`;
}

function estimateTokensFromBytes(bytes: number): number {
	return Math.max(0, Math.round(bytes / 4));
}

function bestTurnNode(flow: ContextFlowSnapshot, component: string): ContextFlowNode | undefined {
	const nodes = flow.nodes.filter(
		n => n.turn === flow.turn && n.component === component && n.status !== "not_wired",
	);
	if (nodes.length === 0) return undefined;
	return nodes.reduce((best, node) => (node.status === "running" ? node : best));
}

function collectTurnNodes(flow: ContextFlowSnapshot): Map<string, ContextFlowNode> {
	const byComponent = new Map<string, ContextFlowNode>();
	for (const key of TURN_FLOW_ORDER) {
		const node = bestTurnNode(flow, key);
		if (node) byComponent.set(key, node);
	}
	if (byComponent.has("omp.rlm.groq_codec")) byComponent.delete("omp.rlm.worker");
	return byComponent;
}

function formatStepMeta(node: ContextFlowNode, flow: ContextFlowSnapshot): string | undefined {
	const parts: string[] = [];
	if (node.durationMs !== undefined && node.status !== "running" && node.durationMs > 0) {
		if (node.durationMs >= 1000) parts.push(`${(node.durationMs / 1000).toFixed(1)}s`);
		else parts.push(`${node.durationMs.toFixed(0)}ms`);
	}
	if (flow.economics.tokenomicsEnabled && node.component === "omp.root" && flow.economics.costUsd > 0) {
		parts.push(`$${flow.economics.costUsd.toFixed(4)}`);
	}
	return parts.length > 0 ? parts.join(" · ") : undefined;
}

function formatTurnStepIo(node: ContextFlowNode, flow: ContextFlowSnapshot): string {
	if (node.component === "omp.root") {
		if (node.inputTokens !== undefined && node.outputTokens !== undefined) {
			return `${formatTokenShort(node.inputTokens)} → ${formatTokenShort(node.outputTokens)} t`;
		}
		const rein = flow.offload.reintroducedTokens;
		if (rein > 0) return `+${formatTokenShort(rein)} t`;
		return "";
	}
	if (node.inputTokens !== undefined && node.outputTokens !== undefined) {
		return `${formatTokenShort(node.inputTokens)} → ${formatTokenShort(node.outputTokens)} t`;
	}
	if (node.inputBytes !== undefined && node.outputTokens !== undefined) {
		return `${formatBytes(node.inputBytes)} → ${formatTokenShort(node.outputTokens)} t`;
	}
	if (node.inputBytes !== undefined) return `${formatBytes(node.inputBytes)} external`;
	if (node.inputTokens !== undefined) return `${formatTokenShort(node.inputTokens)} t`;
	if (node.outputTokens !== undefined) return `→ ${formatTokenShort(node.outputTokens)} t`;
	return "";
}

function padDetail(label: string, detail: string, width = 20): string {
	if (!detail) return label;
	const padded = label.length >= width ? `${label} ` : label.padEnd(width);
	return `${padded}${detail}`;
}

/** Original Context Usage grid — root window only. */
export function renderContextWindow(breakdown: ContextBreakdown, theme: Theme): string {
	return renderContextUsage(breakdown, theme);
}

/** Context savings from mechanisms that actually ran (no wiring inventory). */
export function renderContextSavings(flow: ContextFlowSnapshot, breakdown?: ContextBreakdown): string | undefined {
	const sections: string[] = [];
	const o = flow.offload;
	const externalT = estimateTokensFromBytes(o.externalBytes);
	const grantedT = o.grantedTokens ?? 0;
	const reintroT = o.reintroducedTokens;
	const rlmNodes = flow.nodes.some(
		n => n.turn === flow.turn && n.component.startsWith("omp.rlm.") && n.status !== "not_wired",
	);
	const rlmActive = o.active || rlmNodes;

	if (rlmActive && (externalT > 0 || grantedT > 0 || reintroT > 0)) {
		const keptOut = Math.max(0, externalT - reintroT);
		const lines = ["RLM"];
		if (externalT > 0) lines.push(`  Externalized`.padEnd(24) + formatTokenCount(externalT));
		if (grantedT > 0) lines.push(`  Granted to workers`.padEnd(24) + formatTokenCount(grantedT));
		if (reintroT > 0) lines.push(`  Reintroduced`.padEnd(24) + formatTokenCount(reintroT));
		if (keptOut > 0) lines.push(`  Kept out of root`.padEnd(24) + `≈${formatTokenCount(keptOut)}`);
		const pipeline: string[] = [];
		if (externalT > 0) pipeline.push(formatTokenShort(externalT));
		if (grantedT > 0) pipeline.push(formatTokenShort(grantedT));
		if (reintroT > 0) pipeline.push(formatTokenShort(reintroT));
		if (pipeline.length >= 2) lines.push(`  Pipeline`.padEnd(24) + `${pipeline.join(" → ")} t`);
		sections.push(lines.join("\n"));
	}

	const codecNode = bestTurnNode(flow, "omp.rlm.groq_codec");
	if (codecNode && codecNode.status !== "skipped") {
		const inT = codecNode.inputTokens ?? estimateTokensFromBytes(codecNode.inputBytes ?? 0);
		const outT = codecNode.outputTokens ?? 0;
		if (inT > 0 || outT > 0) {
			const lines = ["Groq codec"];
			if (inT > 0) lines.push(`  Input`.padEnd(24) + formatTokenCount(inT));
			if (outT > 0) lines.push(`  Output`.padEnd(24) + formatTokenCount(outT));
			if (inT > 0 && outT > 0) {
				lines.push(`  Compression`.padEnd(24) + `${(inT / outT).toFixed(1)}×`);
				const avoided = inT - outT;
				if (avoided > 0) lines.push(`  Root context avoided`.padEnd(24) + `≈${formatTokenCount(avoided)}`);
			}
			if (codecNode.durationMs !== undefined) {
				lines.push(`  Latency`.padEnd(24) + `${codecNode.durationMs.toFixed(0)} ms`);
			}
			sections.push(lines.join("\n"));
		}
	}

	const snap = breakdown?.snapcompact;
	if (snap && snap.savedTokens > 0) {
		const lines = ["Snapcompact"];
		lines.push(`  Wire savings`.padEnd(24) + `≈${formatTokenCount(snap.savedTokens)}`);
		if (snap.toolResults?.swapped) {
			lines.push(
				`  Tool results`.padEnd(24) +
					`${snap.toolResults.swapped} imaged → ≈${formatTokenCount(snap.toolResults.savedTokens)}`,
			);
		}
		sections.push(lines.join("\n"));
	}

	if (sections.length === 0) return undefined;
	return sections.join("\n\n");
}

/** Vertical pipeline for the current turn (participating stages only). */
export function renderCurrentTurnFlow(flow: ContextFlowSnapshot, maxWidth?: number): string | undefined {
	const byComponent = collectTurnNodes(flow);
	if (byComponent.size <= 1) return undefined;

	const ordered = TURN_FLOW_ORDER.filter(key => byComponent.has(key));
	if (ordered.length <= 1) return undefined;

	const lines: string[] = [];
	for (let i = 0; i < ordered.length; i++) {
		const key = ordered[i]!;
		const node = byComponent.get(key)!;
		const label = `${flowStepLabel(key)} ${statusGlyph(node.status)}`;
		const detail = formatTurnStepIo(node, flow);
		const meta = formatStepMeta(node, flow);
		let row = padDetail(label, [detail, meta].filter(Boolean).join("  "));
		if (maxWidth !== undefined && maxWidth > 0 && row.length > maxWidth) {
			row = `${row.slice(0, Math.max(0, maxWidth - 1))}…`;
		}
		lines.push(row);
		if (i < ordered.length - 1) lines.push("  ↓");
	}
	return lines.join("\n");
}

function renderSessionEconomics(flow: ContextFlowSnapshot): string | undefined {
	const e = flow.economics;
	if (!e.tokenomicsEnabled || e.totalIncrementalTokens <= 0) return undefined;
	const parts = [
		`root ${formatTokenShort(e.rootTokens)}`,
		e.workerTokens > 0 ? `worker ${formatTokenShort(e.workerTokens)}` : undefined,
		e.costUsd > 0 ? `$${e.costUsd.toFixed(4)}` : undefined,
	].filter(Boolean);
	return `Session economics  ${parts.join(" · ")}`;
}

/** Unified /context page: root window + savings + current-turn flow. */
export function renderContextUsagePage(
	breakdown: ContextBreakdown,
	theme: Theme,
	flow?: ContextFlowSnapshot,
	options?: { maxWidth?: number },
): string {
	const window = renderContextWindow(breakdown, theme);
	if (!flow) return window;

	const savings = renderContextSavings(flow, breakdown);
	const turnFlow = renderCurrentTurnFlow(flow, options?.maxWidth);
	const economics = renderSessionEconomics(flow);
	const sections = [window];

	if (savings) {
		sections.push("", theme.fg("accent", "Context savings"), "", savings);
	}
	if (turnFlow) {
		sections.push("", theme.fg("accent", "Current turn"), "", turnFlow);
	}
	if (economics) {
		sections.push("", theme.fg("dim", economics));
	}

	if (sections.length === 1) return window;
	return sections.join("\n");
}

// Legacy aliases — prefer renderContextUsagePage.
export const renderCompactContextUsage = renderContextUsagePage;
export function renderCompactOffloadLine(): string | undefined {
	return undefined;
}
export function renderCompactFlowBreadcrumb(): string | undefined {
	return undefined;
}
export function renderCompactContextAugmentation(): string[] {
	return [];
}
