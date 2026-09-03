import { formatBytes } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import {
	DEFAULT_TINY_TITLE_LOCAL_MODEL_KEY,
	getTinyLocalModelSpec,
	isTinyLocalModelKey,
	TINY_LOCAL_MODELS,
	type TinyLocalModelKey,
} from "../tiny/models";
import { shutdownTinyTitleClient, tinyTitleClient } from "../tiny/title-client";
import type { TinyTitleProgressEvent } from "../tiny/title-protocol";

export type TinyModelsAction = "download" | "list";

export interface TinyModelsCommandArgs {
	action: TinyModelsAction;
	model?: string;
	flags: {
		json?: boolean;
	};
}

interface ProgressReporter {
	onProgress(event: TinyTitleProgressEvent): void;
	finish(ok: boolean): void;
}

interface DownloadResult {
	model: TinyLocalModelKey;
	ok: boolean;
	error?: string;
}

function writeLine(text = ""): void {
	process.stdout.write(`${text}\n`);
}

const ACTIONABLE_DOWNLOAD_ERROR_LINE = /PI_TINY_|CUDA|cuDNN|cudnn|libcudnn|tiny-title-runtime|onnxruntime-node/i;

function downloadErrorSummary(error: string | undefined): string | undefined {
	const lines =
		error
			?.split(/\r?\n/)
			.map(line => line.trim().replace(/^Error:\s*/, ""))
			.filter(line => line.length > 0) ?? [];
	const first = lines[0];
	if (!first) return undefined;
	const details = lines.slice(1).filter(line => ACTIONABLE_DOWNLOAD_ERROR_LINE.test(line));
	if (details.length === 0) return first;
	return [first, ...details].join("\n");
}

export function resolveModels(model: string | undefined): TinyLocalModelKey[] {
	if (!model) return [DEFAULT_TINY_TITLE_LOCAL_MODEL_KEY];
	// `all` is a prefetch convenience: skip models that fail before load (unsupported
	// runtime), so the bulk download stays green when every *usable* model succeeds.
	if (model === "all")
		return TINY_LOCAL_MODELS.filter(spec => !("unsupportedReason" in spec) || !spec.unsupportedReason).map(
			spec => spec.key,
		);
	if (!isTinyLocalModelKey(model)) {
		const values = TINY_LOCAL_MODELS.map(spec => spec.key).join(", ");
		throw new Error(`Unknown tiny local model: ${model}. Expected one of: ${values}, all`);
	}
	return [model];
}

function listModels(json: boolean | undefined): void {
	if (json) {
		writeLine(JSON.stringify({ models: TINY_LOCAL_MODELS }));
		return;
	}
	writeLine(chalk.bold("Tiny local models"));
	for (const spec of TINY_LOCAL_MODELS) {
		const defaultMark = spec.key === DEFAULT_TINY_TITLE_LOCAL_MODEL_KEY ? chalk.cyan(" default") : "";
		writeLine(`${chalk.cyan(spec.key)}${defaultMark}`);
		writeLine(`  ${spec.label} — ${spec.description}`);
	}
}

function makeProgressReporter(modelKey: TinyLocalModelKey, json: boolean | undefined): ProgressReporter {
	if (json || !process.stdout.isTTY) {
		return { onProgress: () => undefined, finish: () => undefined };
	}
	const label = getTinyLocalModelSpec(modelKey)?.label ?? modelKey;
	let lastWidth = 0;
	let lastProgress = -1;
	const render = (event: TinyTitleProgressEvent): void => {
		const progress = event.progress ?? lastProgress;
		if (progress >= 0 && progress < lastProgress + 1 && event.status !== "ready") return;
		if (progress >= 0) lastProgress = progress;
		const ratio = progress >= 0 ? Math.max(0, Math.min(1, progress / 100)) : 0;
		const barWidth = 30;
		const filled = Math.round(ratio * barWidth);
		const bar = `${"█".repeat(filled)}${"░".repeat(barWidth - filled)}`;
		const pct = progress >= 0 ? `${Math.floor(progress).toString().padStart(3, " ")}%` : " --%";
		const bytes = event.loaded && event.total ? ` ${formatBytes(event.loaded)}/${formatBytes(event.total)}` : "";
		const file = event.file ? ` ${event.file.split("/").at(-1) ?? event.file}` : "";
		const statusLabel = event.status === "ready" ? "Ready" : "Downloading";
		const line = `${chalk.cyan(statusLabel)} ${label} [${bar}] ${pct}${bytes}${file}`;
		process.stdout.write(`\r${line.padEnd(lastWidth)}`);
		lastWidth = line.length;
	};
	return {
		onProgress(event) {
			if (event.modelKey !== modelKey) return;
			render(event);
		},
		finish(ok) {
			const suffix = ok ? chalk.green("done") : chalk.red("failed");
			process.stdout.write(`\r${`${label}: ${suffix}`.padEnd(lastWidth)}\n`);
		},
	};
}

async function downloadOne(modelKey: TinyLocalModelKey, json: boolean | undefined): Promise<DownloadResult> {
	const label = getTinyLocalModelSpec(modelKey)?.label ?? modelKey;
	if (!json && !process.stdout.isTTY) writeLine(`Downloading ${label} (${modelKey})...`);
	const progress = makeProgressReporter(modelKey, json);
	const result = await tinyTitleClient.downloadModel(modelKey, { onProgress: progress.onProgress });
	progress.finish(result.ok);
	const error = downloadErrorSummary(result.error);
	if (!json && !process.stdout.isTTY) {
		writeLine(result.ok ? `Downloaded ${label}.` : `Failed to download ${label}${error ? `: ${error}` : ""}.`);
	} else if (!json && !result.ok && error) {
		writeLine(`${label} failed: ${error}`);
	}
	return result.error ? { model: modelKey, ok: result.ok, error: result.error } : { model: modelKey, ok: result.ok };
}

export async function runTinyModelsCommand(command: TinyModelsCommandArgs): Promise<void> {
	if (command.action === "list") {
		listModels(command.flags.json);
		return;
	}

	const models = resolveModels(command.model);
	const results: DownloadResult[] = [];
	try {
		for (const model of models) {
			results.push(await downloadOne(model, command.flags.json));
		}
	} finally {
		await shutdownTinyTitleClient();
	}

	if (command.flags.json) {
		writeLine(JSON.stringify({ results }));
	}
	if (results.some(result => !result.ok)) {
		throw new Error("One or more tiny title models failed to download");
	}
}
