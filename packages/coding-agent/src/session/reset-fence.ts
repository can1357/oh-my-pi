/**
 * Cross-process fence around spending one upstream account's saved reset.
 * A session's automatic executor and `omp usage reset` take the same lock file
 * beside the agent database and leave a marker in it, so another process on
 * that database neither spends while an attempt is in flight nor right after one.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDbPath, isEnoent, withFileLock } from "@oh-my-pi/pi-utils";
import type { ResetCreditAccountStatus, ResetCreditRedeemOutcome } from "./auth-storage";
import { ATTEMPT_COOLDOWN_MS } from "./codex-auto-reset";

/** An account's last recorded attempt: `pending` (sent, unconfirmed) or `reset`, and when it started. */
export interface ResetMarker {
	state: string;
	atMs: number;
}

/** Records `pending` around one consume, then `reset`, or clears the marker when nothing was spent. */
export type MarkedRedeem = (
	redeem: () => Promise<ResetCreditRedeemOutcome>,
) => Promise<{ outcome: ResetCreditRedeemOutcome; attemptedAt: number }>;

/** Lock file for one `resetAccountLockKey`, beside the agent database unless `root` replaces it. */
export function resetLockPath(lockKey: string, root = getAgentDbPath()): string {
	return `${root}.reset-${Bun.hash(lockKey).toString(16)}`;
}

export async function readResetMarker(lockPath: string): Promise<ResetMarker> {
	let text: string;
	try {
		text = await Bun.file(lockPath).text();
	} catch (error) {
		if (!isEnoent(error)) throw error;
		text = "";
	}
	const [state, timestamp] = text.split(":");
	return { state, atMs: Number(timestamp) };
}

/**
 * Hold the account's lock, then run `onRecent` when another attempt started
 * within `ATTEMPT_COOLDOWN_MS`, or `spend` otherwise. Both run under the lock.
 */
export async function withResetFence<T>(
	lockPath: string,
	onRecent: (marker: ResetMarker) => Promise<T>,
	spend: (redeem: MarkedRedeem) => Promise<T>,
): Promise<T> {
	await fs.mkdir(path.dirname(lockPath), { recursive: true });
	return withFileLock(
		lockPath,
		async () => {
			const marker = await readResetMarker(lockPath);
			if (Date.now() - marker.atMs < ATTEMPT_COOLDOWN_MS) return onRecent(marker);
			return spend(async redeem => {
				const attemptedAt = Date.now();
				await Bun.write(lockPath, `pending:${attemptedAt}`);
				const outcome = await redeem();
				if (outcome.code === "reset") {
					await Bun.write(lockPath, `reset:${attemptedAt}`);
				} else if (outcome.code === "no_credit" || outcome.code === "nothing_to_reset") {
					await Bun.write(lockPath, "");
				}
				return { outcome, attemptedAt };
			});
		},
		{ retries: 300, retryDelayMs: 100 },
	);
}

/**
 * Codex's live balance for one credential, re-read under the fence. `spent`
 * means it fell below the `expected` count the spend was decided on.
 */
export function checkCodexBalance(
	statuses: readonly ResetCreditAccountStatus[],
	credentialId: number,
	expected: number | undefined,
): "spent" | "credit_list_failed" | "no_credit" | undefined {
	const live = statuses.find(status => status.credentialId === credentialId && !status.error);
	if (!live) return "credit_list_failed";
	if (expected !== undefined && live.availableCount < expected) return "spent";
	if (live.availableCount < 1) return "no_credit";
	return undefined;
}
