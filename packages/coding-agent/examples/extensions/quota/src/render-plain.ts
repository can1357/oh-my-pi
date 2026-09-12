// Plain text renderer for /quota snapshot and headless fallback mode.
// Zero external dependencies.

import { formatPercent } from "./format";
import type { QuotaAccountGroup, QuotaDashboardModel, QuotaProviderGroup, QuotaWindowRow } from "./hierarchy";

function renderPlainRow(row: QuotaWindowRow): string {
	if (row.health.status === "neutral") {
		return `${row.label.padEnd(16)} ${row.usedText ?? ""}`;
	}
	if (row.health.status === "unknown") {
		return `${row.label.padEnd(16)} ············   ?   unknown`;
	}
	const pctStr = row.remainingFraction !== undefined ? formatPercent(row.remainingFraction).padStart(4) : "  0%";
	const resetStr = row.resetCountdown ? ` ↻${row.resetCountdown}` : "";
	return `${row.label.padEnd(16)} ${pctStr} ${row.health.symbol}${resetStr}`;
}

function renderPlainAccount(account: QuotaAccountGroup): string[] {
	const lines: string[] = [];

	let header = account.isActive ? `● ${account.label}   ACTIVE` : account.label;
	if (account.planBadge) {
		header += `   ${account.planBadge}`;
	}
	lines.push(`  ${header}`);

	if (account.cleanOrgName) {
		lines.push(`    ${account.cleanOrgName}`);
	}

	if (account.noLimits) {
		lines.push("    no limits reported");
		return lines;
	}

	for (const pool of account.pools) {
		if (pool.label !== undefined) {
			lines.push(`    ${pool.label}`);
			for (const row of pool.rows) {
				lines.push(`      ${renderPlainRow(row)}`);
			}
		} else {
			for (const row of pool.rows) {
				lines.push(`    ${renderPlainRow(row)}`);
			}
		}
	}

	if (account.savedResets) {
		const { count, detailLines } = account.savedResets;
		lines.push(`    ✦ ${count} saved rate-limit reset${count === 1 ? "" : "s"} available`);
		for (const detail of detailLines) {
			lines.push(`        ${detail}`);
		}
	}

	return lines;
}

function renderPlainProvider(provider: QuotaProviderGroup): string[] {
	const lines: string[] = [provider.label];
	for (const account of provider.accounts) {
		lines.push(...renderPlainAccount(account));
	}
	return lines;
}

export function renderQuotaSnapshot(model: QuotaDashboardModel): string {
	const lines: string[] = ["Quota", ""];
	for (let i = 0; i < model.providers.length; i++) {
		if (i > 0) lines.push("");
		lines.push(...renderPlainProvider(model.providers[i]!));
	}
	return lines.join("\n");
}
