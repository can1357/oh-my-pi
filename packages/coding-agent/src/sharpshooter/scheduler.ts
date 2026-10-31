import { logger } from "@oh-my-pi/pi-utils";

import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import { runSharpshooterConsolidation } from "./consolidate";
import { readSharpshooterState, sharpshooterBankDir } from "./paths";
import { sharpshooterQueueDepth } from "./queue";

import { cfgSharpshooterIntervalMinutes } from "./settings";

const SCHEDULER_TICK_MS = 60_000;

interface SchedulerEntry {
	timer: NodeJS.Timeout;
	refCount: number;
	/** Aborted when the last session using this bank lets go: a consolidation in flight stops with it. */
	abort: AbortController;
}

const schedulers = new Map<string, SchedulerEntry>();

export function startSharpshooterScheduler(options: {
	agentDir: string;
	cwd: string;
	settings: Settings;
	modelRegistry: ModelRegistry;
	sessionId: string;
}): () => void {
	const bankDir = sharpshooterBankDir(options.agentDir, options.cwd);
	const existing = schedulers.get(bankDir);
	if (existing) {
		existing.refCount += 1;
		return createDisposer(bankDir, existing);
	}

	const abort = new AbortController();
	const tick = async (): Promise<void> => {
		try {
			const [depth, state] = await Promise.all([
				sharpshooterQueueDepth(options.agentDir, options.cwd),
				readSharpshooterState(options.agentDir, options.cwd),
			]);
			const intervalMinutes = cfgSharpshooterIntervalMinutes.get(options.settings);
			const due = Date.now() - state.lastConsolidatedAt >= intervalMinutes * 60_000;
			if (abort.signal.aborted || (depth === 0 && !due)) return;
			// model-request: session — the scheduler's signal: each session using the bank holds the scheduler until it
			// begins disposing, and the last to let go aborts a consolidation in flight.
			await runSharpshooterConsolidation({ ...options, signal: abort.signal });
		} catch (error) {
			logger.debug("sharpshooter scheduler tick failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	};
	const timer = setInterval(() => void tick(), SCHEDULER_TICK_MS);
	timer.unref();
	const entry: SchedulerEntry = { timer, refCount: 1, abort };
	schedulers.set(bankDir, entry);
	void tick();
	return createDisposer(bankDir, entry);
}

function createDisposer(bankDir: string, entry: SchedulerEntry): () => void {
	let disposed = false;
	return () => {
		if (disposed) return;
		disposed = true;
		const current = schedulers.get(bankDir);
		if (current !== entry) return;
		current.refCount -= 1;
		if (current.refCount > 0) return;
		clearInterval(current.timer);
		current.abort.abort();
		schedulers.delete(bankDir);
	};
}
