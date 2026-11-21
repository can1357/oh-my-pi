import type { Size, TeachCommand, TeachEvent, TeachStep, WorkerContext } from "../messages";

// Chrome allows two captureVisibleTab calls per second.
const CAPTURE_INTERVAL_MS = 510;

interface Recording {
	tabId: number;
	url: string;
	viewport: Size;
	steps: TeachStep[];
	installation: Promise<void>;
	captures: Promise<void>;
	stop?: Promise<TeachStep[]>;
	lastCaptureAt: number;
}

async function startRecorder(tabId: number): Promise<void> {
	const [main] = await chrome.scripting.executeScript({
		target: { tabId },
		files: ["recorder.js"],
		injectImmediately: true,
	});
	if (!main) throw new Error("Could not start Teach in this tab");
	const command: TeachCommand = { omp: "teach", op: "start" };
	const started: unknown = await chrome.tabs.sendMessage(tabId, command, { documentId: main.documentId });
	if (started !== true) throw new Error("Teach recorder did not start");
}

/** Install one tab's Teach recorder and append ordered screenshot-enriched steps until stopped. */
export function installTeach(ctx: WorkerContext): void {
	let recording: Recording | undefined;

	function append(state: Recording, step: TeachStep): void {
		state.steps.push(step);
		state.captures = state.captures.then(async () => {
			try {
				if (step.kind === "navigate") {
					const current = await ctx.tabContext(state.tabId);
					if (current.url === step.url) {
						step.title = current.title;
						if (current.viewport) step.viewport = current.viewport;
					}
				}
				const wait = state.lastCaptureAt + CAPTURE_INTERVAL_MS - Date.now();
				if (wait > 0) {
					const timer = Promise.withResolvers<void>();
					setTimeout(timer.resolve, wait);
					await timer.promise;
				}
				const tab = await chrome.tabs.get(state.tabId);
				if (tab.active) {
					state.lastCaptureAt = Date.now();
					const screenshot = await ctx.captureVisible(tab.windowId);
					if ((await chrome.tabs.get(state.tabId)).active) step.screenshot = screenshot.image;
				}
			} catch {
				// Tab closure and pages Chrome will not capture must not discard the action itself.
			}
			ctx.emit({ event: "teachStep", step });
		});
	}

	ctx.handle("teachStart", async ({ tabId }) => {
		if (recording) throw new Error("A Teach recording is already running");
		const state: Recording = {
			tabId,
			url: "",
			viewport: { width: 0, height: 0 },
			steps: [],
			lastCaptureAt: 0,
			installation: Promise.resolve(),
			captures: Promise.resolve(),
		};
		recording = state;
		ctx.setBusy("teach", true);
		state.installation = (async () => {
			const tab = await chrome.tabs.get(tabId);
			state.url ||= tab.url ?? "";
			state.viewport = { width: tab.width ?? 0, height: tab.height ?? 0 };
			await startRecorder(tabId);
		})();
		try {
			await state.installation;
		} catch (error) {
			if (recording === state) {
				recording = undefined;
				ctx.setBusy("teach", false);
			}
			throw error;
		}
	});

	ctx.handle("teachStop", async () => {
		const state = recording;
		if (!state) return [];
		state.stop ??= (async () => {
			await state.installation.catch(() => undefined);
			// Keep receiving until the recorder has flushed its pending keystrokes.
			const command: TeachCommand = { omp: "teach", op: "stop" };
			await chrome.tabs.sendMessage(state.tabId, command, { frameId: 0 }).catch(() => undefined);
			try {
				await state.captures;
				return state.steps;
			} finally {
				if (recording === state) {
					recording = undefined;
					ctx.setBusy("teach", false);
				}
			}
		})();
		return state.stop;
	});

	chrome.runtime.onMessage.addListener((message: TeachEvent, sender) => {
		const state = recording;
		if (message?.omp !== "teach-step" || !state || sender.tab?.id !== state.tabId || sender.frameId !== 0) return;
		state.viewport = message.step.viewport;
		append(state, message.step);
	});

	chrome.tabs.onRemoved.addListener(tabId => {
		// The recording cannot receive any further actions, but Done can still use its captured steps.
		if (recording?.tabId === tabId) ctx.setBusy("teach", false);
	});

	chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
		const state = recording;
		if (!state || state.stop || tabId !== state.tabId) return;
		if (change.url !== undefined && change.url !== state.url) {
			state.url = change.url;
			append(state, {
				kind: "navigate", url: change.url, title: tab.title ?? "", at: Date.now(),
				viewport: { width: tab.width ?? state.viewport.width, height: tab.height ?? state.viewport.height },
			});
		}
		if (change.url !== undefined || change.status === "complete") {
			state.installation = state.installation.catch(() => undefined).then(() => {
				if (!state.stop && recording === state) return startRecorder(tabId);
			}).catch(() => undefined);
		}
	});
}
