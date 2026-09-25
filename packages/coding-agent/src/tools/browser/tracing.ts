import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Snowflake } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { CDPSession, Page } from "puppeteer-core";
import { resolveToCwd } from "../path-utils";

/** Options for starting a Chromium performance trace. */
export interface BrowserTraceStartOptions {
	/** Include screenshots in the trace. */
	screenshots?: boolean;
	/** Override the Chromium trace category list. */
	categories?: string[];
}

/** Options for saving a completed Chromium performance trace. */
export interface BrowserTraceStopOptions {
	/** Absolute or cwd-relative destination path. */
	path?: string;
}

/** Options for saving a completed Chromium CPU profile. */
export interface BrowserProfileStopOptions {
	/** Absolute or cwd-relative destination path. */
	path?: string;
}

/** Browser page metrics augmented with navigation-relative lifecycle durations. */
export interface BrowserMetrics {
	/** Named Chromium or lifecycle metric. */
	[name: string]: number;
	/** Milliseconds from navigation start through DOMContentLoaded. */
	domContentLoaded: number;
	/** Milliseconds from navigation start through load. */
	load: number;
}

interface NavigationTiming {
	/** Navigation epoch in milliseconds. */
	navigationStart: number;
	/** DOMContentLoaded epoch in milliseconds. */
	domContentLoadedEventEnd: number;
	/** Load-event epoch in milliseconds. */
	loadEventEnd: number;
}

function outputPath(requested: string | undefined, cwd: string, extension: string): string {
	if (requested) return resolveToCwd(requested, cwd);
	return path.join(os.tmpdir(), `omp-browser-${Snowflake.next()}.${extension}`);
}

/** Stateful trace and CPU-profile controller for one Puppeteer page. */
export class BrowserTracingController {
	readonly #page: Page;
	#traceActive = false;
	#profileSession?: CDPSession;

	constructor(page: Page) {
		this.#page = page;
	}

	/** Start Chromium tracing for this page's browser connection. */
	async traceStart(options: BrowserTraceStartOptions = {}): Promise<void> {
		if (this.#traceActive) throw new ToolError("tab.traceStart() cannot start while a trace is already active");
		await this.#page.tracing.start({ screenshots: options.screenshots, categories: options.categories });
		this.#traceActive = true;
	}

	/** Stop Chromium tracing, save its JSON, and return the absolute path. */
	async traceStop(cwd: string, options: BrowserTraceStopOptions = {}): Promise<string> {
		if (!this.#traceActive) throw new ToolError("tab.traceStop() requires an active trace");
		const destination = outputPath(options.path, cwd, "json");
		await fs.promises.mkdir(path.dirname(destination), { recursive: true });
		try {
			const trace = await this.#page.tracing.stop();
			if (!trace) throw new ToolError("Chromium tracing stopped without producing trace data");
			await Bun.write(destination, trace);
			return destination;
		} finally {
			this.#traceActive = false;
		}
	}

	/** Start a Chromium DevTools CPU profile for the page. */
	async profileStart(): Promise<void> {
		if (this.#profileSession)
			throw new ToolError("tab.profileStart() cannot start while a profile is already active");
		const session = await this.#page.createCDPSession();
		try {
			await session.send("Profiler.enable");
			await session.send("Profiler.start");
			this.#profileSession = session;
		} catch (error) {
			await session.detach().catch(() => undefined);
			throw error;
		}
	}

	/** Stop the active CPU profile, save it, and return the absolute path. */
	async profileStop(cwd: string, options: BrowserProfileStopOptions = {}): Promise<string> {
		const session = this.#profileSession;
		if (!session) throw new ToolError("tab.profileStop() requires an active profile");
		this.#profileSession = undefined;
		const destination = outputPath(options.path, cwd, "cpuprofile");
		await fs.promises.mkdir(path.dirname(destination), { recursive: true });
		try {
			const { profile } = await session.send("Profiler.stop");
			await Bun.write(destination, JSON.stringify(profile));
			return destination;
		} finally {
			await session.send("Profiler.disable").catch(() => undefined);
			await session.detach().catch(() => undefined);
		}
	}

	/** Return Puppeteer metrics plus navigation-relative DOMContentLoaded and load durations. */
	async metrics(): Promise<BrowserMetrics> {
		const [pageMetrics, timing] = await Promise.all([
			this.#page.metrics(),
			this.#page.evaluate(() => {
				const values = (globalThis as unknown as { performance: { timing: NavigationTiming } }).performance.timing;
				return {
					navigationStart: values.navigationStart,
					domContentLoadedEventEnd: values.domContentLoadedEventEnd,
					loadEventEnd: values.loadEventEnd,
				};
			}),
		]);
		const metrics: Record<string, number> = {};
		for (const name in pageMetrics) {
			const value = pageMetrics[name as keyof typeof pageMetrics];
			if (typeof value === "number") metrics[name] = value;
		}
		const navigationStart = timing.navigationStart;
		return {
			...metrics,
			domContentLoaded:
				navigationStart > 0 && timing.domContentLoadedEventEnd > 0
					? timing.domContentLoadedEventEnd - navigationStart
					: 0,
			load: navigationStart > 0 && timing.loadEventEnd > 0 ? timing.loadEventEnd - navigationStart : 0,
		};
	}

	/** Stop and discard active trace/profile state during tab teardown. */
	async dispose(): Promise<void> {
		if (this.#traceActive) {
			this.#traceActive = false;
			await this.#page.tracing.stop().catch(() => undefined);
		}
		const session = this.#profileSession;
		this.#profileSession = undefined;
		if (session) {
			await session.send("Profiler.stop").catch(() => undefined);
			await session.send("Profiler.disable").catch(() => undefined);
			await session.detach().catch(() => undefined);
		}
	}
}
