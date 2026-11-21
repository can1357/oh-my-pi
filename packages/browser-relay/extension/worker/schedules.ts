import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import type { PromptParams, SetModelParams } from "../../../coding-agent/src/modes/rpc/wire/rpc-wire.generated";
import {
	type PanelSettings,
	type RpcSessionInfo,
	type Schedule,
	SETTINGS_KEY,
	type Shortcut,
	SHORTCUTS_KEY,
	type WorkerContext,
} from "../messages";
import { composePrompt, tabContextBlock, tabViewport } from "../panel/tab-context";
import { enqueueGroupOp, groupPanelTabs } from "./groups";

const ALARM_PREFIX = "omp-shortcut:";
const NOTICE_PREFIX = "omp-shortcut-result:";

function wallTime(year: number, month: number, day: number, hour: number, minute: number): number {
	// Use the earlier instant on a fold, and shift forward by the gap on a skipped wall time.
	if (year < 0 || year >= 100) return +new Date(year, month, day, hour, minute);
	const date = new Date(year + 400, month, day, hour, minute);
	date.setFullYear(date.getFullYear() - 400);
	return +date;
}

function monthLength(year: number, month: number): number {
	const end = new Date(0);
	end.setUTCFullYear(year, month + 1, 0);
	return end.getUTCDate();
}

/** Find the first occurrence strictly after `after` in the browser's local calendar. */
export function nextRunAt(schedule: Schedule, after: number): number | undefined {
	if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time) || !Number.isFinite(after)) return undefined;
	const hour = Number(schedule.time.slice(0, 2));
	const minute = Number(schedule.time.slice(3));
	const now = new Date(after);
	const year = now.getFullYear();
	const month = now.getMonth();
	const day = now.getDate();
	const at = (y: number, m: number, d: number) => wallTime(y, m, d, hour, minute);
	const clamped = (y: number, m: number, d: number) => at(y, m, Math.min(d, monthLength(y, m)));

	switch (schedule.kind) {
		case "once": {
			if (!/^\d{4,}-\d{2}-\d{2}$/.test(schedule.date)) return undefined;
			const y = Number(schedule.date.slice(0, -6));
			const m = Number(schedule.date.slice(-5, -3)) - 1;
			const d = Number(schedule.date.slice(-2));
			if (y < 1 || m < 0 || m > 11 || d < 1 || d > monthLength(y, m)) return undefined;
			const runAt = at(y, m, d);
			return runAt > after ? runAt : undefined;
		}
		case "daily": {
			const today = at(year, month, day);
			return today > after ? today : at(year, month, day + 1);
		}
		case "weekly": {
			const daysAhead = (schedule.weekday - now.getDay() + 7) % 7;
			const target = at(year, month, day + daysAhead);
			return target > after ? target : at(year, month, day + daysAhead + 7);
		}
		case "monthly": {
			const target = clamped(year, month, schedule.day);
			return target > after ? target : clamped(year, month + 1, schedule.day);
		}
		case "yearly": {
			const targetMonth = schedule.month - 1;
			const target = clamped(year, targetMonth, schedule.day);
			return target > after ? target : clamped(year + 1, targetMonth, schedule.day);
		}
	}
}

/** Collapse any number of missed ticks into one due run and advance directly past `now`. */
export function planSchedule(schedule: Schedule, now: number, storedAt?: number): { due: boolean; nextAt?: number } {
	return { due: storedAt !== undefined && storedAt <= now, nextAt: nextRunAt(schedule, now) };
}

function recurrence(schedule: Schedule | undefined): string | undefined {
	if (!schedule) return undefined;
	const time = `${schedule.kind}:${schedule.time}`;
	switch (schedule.kind) {
		case "once":
			return `${time}:${schedule.date}`;
		case "daily":
			return time;
		case "weekly":
			return `${time}:${schedule.weekday}`;
		case "monthly":
			return `${time}:${schedule.day}`;
		case "yearly":
			return `${time}:${schedule.month}:${schedule.day}`;
	}
}

async function readShortcuts(): Promise<Shortcut[]> {
	const { [SHORTCUTS_KEY]: shortcuts = [] }: Record<string, Shortcut[]> = await chrome.storage.local.get(SHORTCUTS_KEY);
	return shortcuts;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

type ScheduledCommand = (({ type: "prompt" } & PromptParams) | ({ type: "set_model" } & SetModelParams)) & {
	id: string;
};

function command(ctx: WorkerContext, key: string, cmd: ScheduledCommand): Promise<void> {
	const result = Promise.withResolvers<void>();
	const unsubscribe = ctx.onRpcLine((sessionKey, line) => {
		if (sessionKey !== key || (!line.includes(cmd.id) && !line.includes('"rpc_exit"'))) return;
		let frame: unknown;
		try {
			frame = JSON.parse(line);
		} catch {
			return;
		}
		if (!isRecord(frame)) return;
		if (frame.type === "rpc_exit") {
			const stderr = typeof frame.stderr === "string" ? frame.stderr.trim() : "";
			result.reject(new Error(stderr || "omp exited before the shortcut finished"));
			return;
		}
		if (frame.id !== cmd.id) return;
		if (frame.type === "response" && frame.command === cmd.type) {
			if (frame.success === false) {
				result.reject(new Error(typeof frame.error === "string" ? frame.error : `${cmd.type} failed`));
			} else if (cmd.type === "set_model" || (isRecord(frame.data) && frame.data.agentInvoked === false)) {
				result.resolve();
			}
		} else if (frame.type === "prompt_result" && cmd.type === "prompt") {
			if (frame.status === "completed") result.resolve();
			else if (frame.status === "aborted") result.reject(new Error("Shortcut was stopped"));
			else {
				const detail =
					isRecord(frame.error) && typeof frame.error.message === "string" ? frame.error.message : "Prompt failed";
				result.reject(new Error(detail));
			}
		}
	});
	try {
		ctx.sendRpc(key, JSON.stringify(cmd));
	} catch (error) {
		unsubscribe();
		throw error;
	}
	return result.promise.finally(unsubscribe);
}

/** Install per-shortcut alarms, worker-owned RPC runs, and run-result notifications. */
export function installSchedules(ctx: WorkerContext): void {
	let storageTail = Promise.resolve();
	function serialize<T>(job: () => Promise<T>): Promise<T> {
		const result = storageTail.then(job);
		storageTail = result.then(() => undefined, () => undefined);
		return result;
	}

	async function complete(shortcut: Shortcut, startedAt: number, tab: chrome.tabs.Tab | undefined, failure?: string) {
		try {
			if (tab?.id !== undefined) await ctx.setActivity(tab.id, { state: "idle" });
		} finally {
			await Promise.all([
				serialize(async () => {
					const shortcuts = await readShortcuts();
					const current = shortcuts.find(item => item.id === shortcut.id);
					if (!current || (current.lastRunAt ?? 0) > startedAt) return;
					current.lastRunAt = startedAt;
					if (failure === undefined) delete current.lastRunError;
					else current.lastRunError = failure;
					await chrome.storage.local.set({ [SHORTCUTS_KEY]: shortcuts });
				}),
				chrome.notifications.create(`${NOTICE_PREFIX}${tab?.id ?? "none"}:${crypto.randomUUID()}`, {
					type: "basic",
					iconUrl: "icons/omp-128.png",
					title: failure === undefined ? `omp · /${shortcut.name} finished` : `omp · /${shortcut.name} failed`,
					message: failure === undefined ? "Click to open the session." : failure.slice(0, 250),
				}),
			]);
		}
	}

	function report(error: unknown): void {
		// Browser diagnostics are isolated from the CLI's stdout protocol.
		console.error("omp shortcut:", error);
	}

	async function run(shortcut: Shortcut): Promise<RpcSessionInfo> {
		const startedAt = Date.now();
		let tab: chrome.tabs.Tab | undefined;
		try {
			const { [SETTINGS_KEY]: settings }: Record<string, PanelSettings | undefined> = await chrome.storage.local.get(SETTINGS_KEY);
			const startUrl = shortcut.startUrl || "about:blank";
			tab = await chrome.tabs.create({ url: startUrl, active: false });
			const tabId = tab.id;
			if (tabId === undefined) throw new Error("Chrome did not assign the shortcut tab an id");
			await enqueueGroupOp(() => groupPanelTabs([tabId], `omp · ${shortcut.name}`));
			const context = await ctx.tabContext(tabId);
			if (!context.targetId) throw new Error("Chrome has not initialized the omp tab target");
			if (!context.url || context.url === "about:blank") context.url = tab.pendingUrl || startUrl;
			const block = tabContextBlock(context, await tabViewport(context));
			const message = composePrompt([block], shortcut.prompt);
			const session = await ctx.openRpcSession({
				cwd: shortcut.cwd ?? settings?.defaultCwd ?? "~",
				title: shortcut.name,
				tabIds: [tabId],
			});
			if (shortcut.model) {
				const slash = shortcut.model.indexOf("/");
				if (slash < 1 || slash === shortcut.model.length - 1) throw new Error("Shortcut model must be provider/id");
				await command(ctx, session.sessionKey, {
					type: "set_model",
					id: crypto.randomUUID(),
					provider: shortcut.model.slice(0, slash),
					modelId: shortcut.model.slice(slash + 1),
				});
			}
			await ctx.setActivity(tabId, { state: "working", session: session.sessionKey, canStop: true });
			void command(ctx, session.sessionKey, { type: "prompt", id: crypto.randomUUID(), message })
				.then(
					() => complete(shortcut, startedAt, tab),
					error => complete(shortcut, startedAt, tab, errorMessage(error)),
				)
				.catch(report);
			ctx.emit({ event: "scheduledRun", shortcutId: shortcut.id, session });
			return session;
		} catch (error) {
			await complete(shortcut, startedAt, tab, errorMessage(error)).catch(report);
			throw error;
		}
	}

	function reconcile(edited: ReadonlySet<string> = new Set()): void {
		void serialize(async () => {
			const shortcuts = await readShortcuts();
			const now = Date.now();
			const due: Shortcut[] = [];
			const desired = new Map<string, number>();
			let changed = false;
			for (const shortcut of shortcuts) {
				const last = edited.has(shortcut.id) ? undefined : shortcut.nextRunAt;
				const plan = shortcut.schedule ? planSchedule(shortcut.schedule, now, last) : undefined;
				if (plan?.due) due.push(shortcut);
				const next = plan?.nextAt;
				if (next !== undefined) desired.set(`${ALARM_PREFIX}${shortcut.id}`, next);
				if (shortcut.nextRunAt === next) continue;
				changed = true;
				if (next === undefined) delete shortcut.nextRunAt;
				else shortcut.nextRunAt = next;
			}
			// Claim an overdue occurrence before starting its RPC session; subsequent wakes cannot duplicate it.
			if (changed) await chrome.storage.local.set({ [SHORTCUTS_KEY]: shortcuts });
			for (const shortcut of due) void run(shortcut).catch(report);
			const alarms = await chrome.alarms.getAll();
			for (const alarm of alarms) {
				if (!alarm.name.startsWith(ALARM_PREFIX)) continue;
				const when = desired.get(alarm.name);
				if (when === undefined) await chrome.alarms.clear(alarm.name);
				else if (when === alarm.scheduledTime) desired.delete(alarm.name);
			}
			for (const [name, when] of desired) await chrome.alarms.create(name, { when });
		}).catch(report);
	}

	ctx.handle("runShortcut", async ({ shortcutId }) => {
		const shortcut = (await readShortcuts()).find(item => item.id === shortcutId);
		if (!shortcut) throw new Error("Shortcut not found");
		return run(shortcut);
	});
	chrome.alarms.onAlarm.addListener(alarm => {
		if (alarm.name.startsWith(ALARM_PREFIX)) reconcile();
	});
	chrome.runtime.onStartup.addListener(() => reconcile());
	chrome.storage.local.onChanged.addListener(changes => {
		const change = changes[SHORTCUTS_KEY];
		if (!change) return;
		const before: Shortcut[] = Array.isArray(change.oldValue) ? change.oldValue : [];
		const after: Shortcut[] = Array.isArray(change.newValue) ? change.newValue : [];
		const previous = new Map(before.map(shortcut => [shortcut.id, recurrence(shortcut.schedule)]));
		const edited = new Set(
			after.filter(shortcut => recurrence(shortcut.schedule) !== previous.get(shortcut.id)).map(shortcut => shortcut.id),
		);
		if (edited.size || before.length !== after.length) reconcile(edited);
	});
	chrome.notifications.onClicked.addListener(id => {
		if (!id.startsWith(NOTICE_PREFIX)) return;
		const tabId = Number(id.slice(NOTICE_PREFIX.length).split(":", 1)[0]);
		if (Number.isInteger(tabId)) {
			const selected = chrome.tabs.update(tabId, { active: true });
			// Invoke open directly in the gesture handler, before awaiting tab/window focus.
			void chrome.sidePanel.open({ tabId }).catch(report);
			void selected
				.then(tab => (tab ? chrome.windows.update(tab.windowId, { focused: true }) : undefined))
				.catch(report);
		}
		void chrome.notifications.clear(id);
	});
	reconcile();
}
