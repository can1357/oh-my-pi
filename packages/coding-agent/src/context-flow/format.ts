import { renderAsciiBar } from "@oh-my-pi/pi-tui/chrome/format";
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
