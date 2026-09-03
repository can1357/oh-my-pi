/**
 * Owns the `/cleanse` overlay lifecycle: mounts the {@link CleansePanelComponent}
 * above the editor, drives the shared cleanse core against it, and maps Esc to
 * cancel-then-dismiss (mirroring the `/omfg` panel).
 */
import { runCleanse } from "../../cleanse";
import type { CleanseCheckerDescriptor } from "../../cleanse/checkers";
import type { CleanseTargetChoice } from "../../cleanse/types";
import { CleansePanelComponent } from "../components/cleanse-panel";
import type { InteractiveModeContext } from "../types";

interface CleanseRun {
	panel: CleansePanelComponent;
	abortController: AbortController;
	settled: boolean;
}

interface ParsedCleanseArgs {
	request?: string;
	all: boolean;
	includeTests: boolean;
	maxAgents?: number;
	model?: string;
	error?: string;
}

const CLEANSE_USAGE = "Usage: /cleanse [request] [--all] [--tests] [-n <agents>] [-m <model>]";
const CUSTOM_REQUEST_OPTION = "Describe what to fix…";

export class CleanseCommandController {
	#active: CleanseRun | undefined;

	constructor(private readonly ctx: InteractiveModeContext) {}

	hasActiveRun(): boolean {
		return this.#active !== undefined;
	}

	/** Esc while running cancels the run; Esc on a settled panel dismisses it. */
	handleEscape(): boolean {
		const run = this.#active;
		if (!run) return false;
		if (!run.settled && !run.abortController.signal.aborted) {
			run.abortController.abort(new Error("Cleanse interrupted"));
			return true;
		}
		this.#close(run);
		return true;
	}

	dispose(): void {
		const run = this.#active;
		if (!run) return;
		run.abortController.abort(new Error("Cleanse interrupted"));
		this.#close(run);
	}

	async start(args: string): Promise<void> {
		if (this.#active) {
			this.ctx.showStatus("A /cleanse run is already active — Esc cancels it.");
			return;
		}
		const parsed = parseCleanseArgs(args);
		if (parsed.error) {
			this.ctx.showStatus(parsed.error);
			return;
		}
		const run: CleanseRun = {
			panel: new CleansePanelComponent({ request: parsed.request, tui: this.ctx.ui }),
			abortController: new AbortController(),
			settled: false,
		};
		this.#active = run;
		this.ctx.cleanseContainer.clear();
		this.ctx.cleanseContainer.addChild(run.panel);
		this.ctx.ui.requestRender();
		await this.#run(run, parsed);
	}

	async #run(run: CleanseRun, options: ParsedCleanseArgs): Promise<void> {
		try {
			const result = await runCleanse(
				{
					request: options.request,
					all: options.all,
					includeTests: options.includeTests,
					maxAgents: options.maxAgents,
					model: options.model,
				},
				{
					board: run.panel,
					print: text => run.panel.log(text),
					printError: text => run.panel.logError(text),
					pickTarget: checkers => this.#pickTarget(checkers),
					promptRequest: () => this.#promptRequest(),
				},
				run.abortController.signal,
			);
			if (this.#active !== run) return;
			run.panel.finish(result.status);
			// A picker-level cancel settles without any output worth keeping.
			if (result.status === "cancelled" && result.report.checks.length === 0) this.#close(run);
		} catch (error) {
			if (this.#active !== run) return;
			run.panel.markError(error instanceof Error ? error.message : String(error));
		} finally {
			if (this.#active === run) run.settled = true;
		}
	}

	async #pickTarget(checkers: readonly CleanseCheckerDescriptor[]): Promise<CleanseTargetChoice> {
		const allOption = `Run all ${checkers.length} discovered checker${checkers.length === 1 ? "" : "s"}`;
		const labels = checkers.map(checker => `${checker.label} — ${checker.command}`);
		const choice = await this.ctx.showHookSelector("Select what to cleanse", [
			allOption,
			...labels,
			CUSTOM_REQUEST_OPTION,
		]);
		if (choice === undefined) return { kind: "cancel" };
		if (choice === allOption) return { kind: "all" };
		if (choice === CUSTOM_REQUEST_OPTION) {
			const request = await this.#promptRequest();
			return request === null ? { kind: "cancel" } : { kind: "request", request };
		}
		const checker = checkers[labels.indexOf(choice)];
		return checker ? { kind: "checker", id: checker.id } : { kind: "cancel" };
	}

	async #promptRequest(): Promise<string | null> {
		const answer = await this.ctx.showHookInput("Describe what to detect and fix", 'e.g. "ts errors"');
		const trimmed = answer?.trim();
		return trimmed ? trimmed : null;
	}

	#close(run: CleanseRun): void {
		if (this.#active !== run) return;
		this.#active = undefined;
		run.panel.dispose();
		this.ctx.cleanseContainer.clear();
		this.ctx.ui.requestRender();
	}
}

/** Parse `/cleanse` arguments; flag names mirror the `omp cleanse` CLI. */
function parseCleanseArgs(args: string): ParsedCleanseArgs {
	const tokens = args.split(/\s+/).filter(Boolean);
	const requestParts: string[] = [];
	const parsed: ParsedCleanseArgs = { all: false, includeTests: false };
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i] ?? "";
		if (token === "--all" || token === "-a") {
			parsed.all = true;
		} else if (token === "--tests" || token === "-t") {
			parsed.includeTests = true;
		} else if (token === "--agents" || token === "-n") {
			const value = Number(tokens[++i]);
			if (!Number.isInteger(value) || value <= 0) return { ...parsed, error: CLEANSE_USAGE };
			parsed.maxAgents = value;
		} else if (token === "--model" || token === "-m") {
			const value = tokens[++i];
			if (!value) return { ...parsed, error: CLEANSE_USAGE };
			parsed.model = value;
		} else if (token.startsWith("-") && token.length > 1 && !/^-\d/.test(token)) {
			return { ...parsed, error: CLEANSE_USAGE };
		} else {
			requestParts.push(token);
		}
	}
	parsed.request = requestParts.join(" ") || undefined;
	return parsed;
}
