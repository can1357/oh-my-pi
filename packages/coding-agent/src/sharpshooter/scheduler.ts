import { logger } from "@oh-my-pi/pi-utils";

import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import { runSharpshooterConsolidation } from "./consolidate";
import { readSharpshooterState, sharpshooterBankDir } from "./paths";
import { sharpshooterQueueDepth } from "./queue";

const DEFAULT_INTERVAL_MINUTES = 5;
const SCHEDULER_TICK_MS = 60_000;

interface SchedulerEntry {
	timer: NodeJS.Timeout;
	refCount: number;
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

	const tick = async (): Promise<void> => {
		try {
			const [depth, state] = await Promise.all([
				sharpshooterQueueDepth(options.agentDir, options.cwd),
				readSharpshooterState(options.agentDir, options.cwd),
			]);
			const intervalMinutes = options.settings.get("sharpshooter.intervalMinutes") ?? DEFAULT_INTERVAL_MINUTES;
			const due = Date.now() - state.lastConsolidatedAt >= intervalMinutes * 60_000;
			if (depth === 0 && !due) return;
			await runSharpshooterConsolidation(options);
		} catch (error) {
			logger.debug("sharpshooter scheduler tick failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	};
	const timer = setInterval(() => void tick(), SCHEDULER_TICK_MS);
	timer.unref();
	const entry: SchedulerEntry = { timer, refCount: 1 };
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
		schedulers.delete(bankDir);
	};
}
