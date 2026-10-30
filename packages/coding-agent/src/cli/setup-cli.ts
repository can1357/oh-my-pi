/**
 * Setup CLI command handler.
 *
 * Handles `omp setup` for onboarding and `omp setup <component>` for optional dependencies.
 */
import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n";
import * as path from "node:path";
import { APP_NAME, getProjectDir, getPythonEnvDir } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { formatKeyHint } from "@oh-my-pi/pi-tui/key-hint-format";
import { Settings } from "../config/settings";
import { ModelRegistry } from "../config/model-registry";
import { resolveRoleChain } from "../config/model-resolver";
import { roleCandidatePool } from "../config/model-roles";
import { checkPythonKernelAvailability } from "../eval/py/kernel";
import { discoverAuthStorage } from "../sdk";
import { theme } from "@oh-my-pi/pi-tui/theme";
import { downloadSttModel, isSttModelCached } from "../stt/downloader";
import { isSttModelKey, STT_MODEL_OPTIONS } from "../stt/models";
import { downloadTtsModel, isTtsLocalModelKey, isTtsModelCached, TTS_LOCAL_MODELS } from "../tts";
import { selectSetupModel } from "@oh-my-pi/pi-tui/apps/setup-model-picker";

import { cfgPythonInterpreter } from "../eval/settings";

export type SetupComponent = "python" | "speech";

export interface SetupCommandArgs {
	component: SetupComponent;
	flags: {
		json?: boolean;
		check?: boolean;
	};
}

const VALID_COMPONENTS: SetupComponent[] = ["python", "speech"];

const MANAGED_PYTHON_ENV = getPythonEnvDir();

/**
 * Parse setup subcommand arguments.
 * Returns undefined if not a setup command.
 */
export function parseSetupArgs(args: string[]): SetupCommandArgs | undefined {
	if (args.length === 0 || args[0] !== "setup") {
		return undefined;
	}

	if (args.length < 2) {
		console.error(chalk.red(__ompTranslate("Usage: {0} setup <component>", `${APP_NAME}`)));
		console.error(`Valid components: ${VALID_COMPONENTS.join(", ")}`);
		process.exit(1);
	}

	const component = args[1];
	if (!VALID_COMPONENTS.includes(component as SetupComponent)) {
		console.error(chalk.red(__ompTranslate("Unknown component: {0}", `${component}`)));
		console.error(`Valid components: ${VALID_COMPONENTS.join(", ")}`);
		process.exit(1);
	}

	const flags: SetupCommandArgs["flags"] = {};
	for (let i = 2; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--json") {
			flags.json = true;
		} else if (arg === "--check" || arg === "-c") {
			flags.check = true;
		}
	}

	return {
		component: component as SetupComponent,
		flags,
	};
}

export interface PythonCheckResult {
	available: boolean;
	pythonPath?: string;
	usingManagedEnv?: boolean;
	managedEnvPath?: string;
}

function managedPythonPath(): string {
	return process.platform === "win32"
		? path.join(MANAGED_PYTHON_ENV, "Scripts", "python.exe")
		: path.join(MANAGED_PYTHON_ENV, "bin", "python");
}

/**
 * Check Python environment and kernel dependencies.
 */
export async function checkPythonSetup(cwd: string, interpreter?: string): Promise<PythonCheckResult> {
	const availability = await checkPythonKernelAvailability(cwd, interpreter, { forceProbe: true });
	return {
		available: availability.ok,
		pythonPath: availability.pythonPath,
		usingManagedEnv: availability.pythonPath === managedPythonPath(),
		managedEnvPath: MANAGED_PYTHON_ENV,
	};
}

/**
 * Install Python packages using uv (preferred) or pip.
 */
// Python installation helper removed: the subprocess runner has no Python
// package dependencies beyond a working interpreter. `omp setup python --check`
// remains as a probe; users install optional libs (pandas, matplotlib, ...)
// directly via pip or the in-process `%pip` magic.

/**
 * Run the setup command.
 */
export async function runSetupCommand(cmd: SetupCommandArgs): Promise<void> {
	switch (cmd.component) {
		case "python":
			await handlePythonSetup(cmd.flags);
			break;
		case "speech":
			await handleSpeechSetup(cmd.flags);
			break;
	}
}

async function handlePythonSetup(flags: { json?: boolean; check?: boolean }): Promise<void> {
	const cwd = getProjectDir();
	const projectSettings = await Settings.init({ cwd });
	const interpreter = cfgPythonInterpreter.get(projectSettings)?.trim() || undefined;
	const check = await checkPythonSetup(cwd, interpreter);

	if (flags.json) {
		console.log(JSON.stringify(check, null, 2));
		if (!check.available) process.exit(1);
		return;
	}

	if (!check.pythonPath) {
		console.error(chalk.red(__ompTranslate("{0} Python not found", `${theme.status.error}`)));
		console.error(chalk.dim(__ompTranslate("Install Python 3.8+ or set python.interpreter to its executable path")));
		process.exit(1);
	}

	console.log(chalk.dim(`Python: ${check.pythonPath}`));
	if (check.usingManagedEnv) {
		console.log(chalk.dim(__ompTranslate("Using managed environment: {0}", `${check.managedEnvPath}`)));
	}

	if (check.available) {
		console.log(chalk.green(__ompTranslate("\n{0} Python execution is ready", `${theme.status.success}`)));
		return;
	}

	console.error(chalk.red(__ompTranslate("\n{0} Python interpreter reported failure", `${theme.status.error}`)));
	process.exit(1);
}

/**
 * One installable speech dependency. `isReady`/`status` are read-only probes;
 * `pick` (optional) lets an interactive user choose + persist a model; `ensure`
 * performs the download, streaming a normalized progress event.
 */
interface SpeechComponent {
	name: string;
	isReady(): Promise<boolean>;
	status(): Promise<string>;
	pick?(): Promise<boolean>;
	ensure(onProgress: (progress: { stage: string; percent?: number }) => void): Promise<void>;
}

function resolveLocalSpeechModelId(role: "speech" | "dictation", settings: Settings, registry: ModelRegistry): string {
	const candidate = resolveRoleChain(role, settings, roleCandidatePool(role, settings, registry)).find(
		entry => entry.model.provider === "local",
	);
	if (!candidate) throw new Error(__ompTranslate("No local model is available for the {0} role.", `${role}`));
	return candidate.model.id;
}

function buildSpeechComponents(settings: Settings, registry: ModelRegistry): SpeechComponent[] {
	const localRoleModelIds = (role: "speech" | "dictation") =>
		new Set(
			roleCandidatePool(role, settings, registry)
				.filter(model => model.provider === "local")
				.map(model => model.id),
		);
	const sttOptions = STT_MODEL_OPTIONS.filter(option => localRoleModelIds("dictation").has(option.value));
	const ttsOptions = TTS_LOCAL_MODELS.filter(model => localRoleModelIds("speech").has(model.key)).map(
		({ key, label, description }) => ({ value: key, label, description }),
	);

	return [
		{
			name: "Speech-to-Text model",
			isReady: () => isSttModelCached(resolveLocalSpeechModelId("dictation", settings, registry)),
			status: async () => {
				const key = resolveLocalSpeechModelId("dictation", settings, registry);
				return (await isSttModelCached(key)) ? key : __ompTranslate("{0} — not downloaded", `${key}`);
			},
			pick: async () => {
				const current = resolveLocalSpeechModelId("dictation", settings, registry);
				const chosen = await selectSetupModel(__ompTranslate("Speech-to-Text model"), sttOptions, current);
				if (chosen === null) return false;
				if (isSttModelKey(chosen)) {
					settings.setModelRole("dictation", `local/${chosen}`);
					await settings.flush();
				}
				return true;
			},
			ensure: onProgress =>
				downloadSttModel(resolveLocalSpeechModelId("dictation", settings, registry), progress =>
					onProgress({
						stage: __ompTranslate("Downloading {0} model", `${progress.label}`),
						percent: progress.percent,
					}),
				),
		},
		{
			name: "Text-to-Speech model",
			isReady: () => isTtsModelCached(resolveLocalSpeechModelId("speech", settings, registry)),
			status: async () => {
				const key = resolveLocalSpeechModelId("speech", settings, registry);
				return (await isTtsModelCached(key)) ? key : __ompTranslate("{0} — model/runtime not installed", `${key}`);
			},
			pick: async () => {
				const current = resolveLocalSpeechModelId("speech", settings, registry);
				const chosen = await selectSetupModel(__ompTranslate("Text-to-Speech model"), ttsOptions, current);
				if (chosen === null) return false;
				if (isTtsLocalModelKey(chosen)) {
					settings.setModelRole("speech", `local/${chosen}`);
					await settings.flush();
				}
				return true;
			},
			ensure: async onProgress => {
				const ok = await downloadTtsModel(resolveLocalSpeechModelId("speech", settings, registry), progress =>
					onProgress({ stage: progress.stage, percent: progress.percent }),
				);
				if (!ok) throw new Error(__ompTranslate("Failed to download the local text-to-speech model."));
			},
		},
	];
}

/**
 * Unified `omp setup speech` flow. Drives every {@link SpeechComponent} through
 * one path: report (`--json`/`--check`) or install (interactive pick + ensure
 * with single-line progress; non-TTY skips pickers and installs configured
 * values).
 */
async function handleSpeechSetup(flags: { json?: boolean; check?: boolean }): Promise<void> {
	const settings = await Settings.init({ cwd: getProjectDir() });
	const authStorage = await discoverAuthStorage(undefined, { settings });
	const registry = new ModelRegistry(authStorage, undefined, { settings });
	const components = buildSpeechComponents(settings, registry);

	if (flags.json) {
		const report: Record<string, { ready: boolean; status: string }> = {};
		let allReady = true;
		for (const component of components) {
			const ready = await component.isReady();
			if (!ready) allReady = false;
			report[component.name] = { ready, status: await component.status() };
		}
		console.log(JSON.stringify(report, null, 2));
		if (!allReady) process.exit(1);
		return;
	}

	if (flags.check) {
		console.log(chalk.bold(__ompTranslate("Speech dependencies:")));
		let allReady = true;
		for (const component of components) {
			const ready = await component.isReady();
			if (!ready) allReady = false;
			const mark = ready ? chalk.green(__ompTranslate("[ok]")) : chalk.yellow(__ompTranslate("[missing]"));
			console.log(`  ${mark} ${component.name}: ${await component.status()}`);
		}
		if (!allReady) process.exit(1);
		return;
	}

	const interactive = Boolean(process.stdout.isTTY);
	for (const component of components) {
		if (interactive && component.pick) {
			await component.pick();
		}
		if (await component.isReady()) {
			console.log(chalk.green(`${theme.status.success} ${component.name} ready`));
			continue;
		}
		console.log(chalk.dim(`Preparing ${component.name}...`));
		try {
			await component.ensure(progress => {
				const percent = typeof progress.percent === "number" ? ` (${progress.percent}%)` : "";
				process.stdout.write(`\r${chalk.dim(`${progress.stage}${percent}`)}\x1b[K`);
			});
			process.stdout.write("\n");
		} catch (err) {
			process.stdout.write("\n");
			const msg = err instanceof Error ? err.message : `Failed to set up ${component.name}`;
			console.error(chalk.red(`${theme.status.error} ${msg}`));
			process.exit(1);
		}
	}

	console.log(chalk.green(__ompTranslate("\n{0} Speech is ready", `${theme.status.success}`)));
	console.log(
		chalk.dim(
			__ompTranslate(
				"Enable speech-to-text via stt.enabled, then hold {0} by default to talk (remap or disable it with app.stt.pushToTalk, or bind app.stt.toggle separately); enable the speech-generation tool via speechgen.enabled; speak replies aloud via speech.enabled.",
				`${formatKeyHint("space")}`,
			),
		),
	);
}

/**
 * Print setup command help.
 */
export function printSetupHelp(): void {
	console.log(
		__ompTranslate(
			"{0} - Run onboarding or install dependencies for optional features\n\n{1}\n  {2} setup                     Run the onboarding wizard\n  {3} setup <component> [options]\n\n{4}\n  python    Verify a Python 3 interpreter is reachable for code execution\n  speech    Pick and download speech-to-text and text-to-speech models\n\n{5}\n  -c, --check   Check if dependencies are installed without installing\n  --json        Output status as JSON\n\n{6}\n  {7} setup                  Run the onboarding wizard\n  {8} setup python           Check Python execution dependencies\n  {9} setup speech           Pick and download the STT and TTS models\n  {10} setup speech --check   Check if speech dependencies are available\n  {11} setup python --check   Check if Python execution is available\n",
			`${chalk.bold(`${APP_NAME} setup`)}`,
			`${chalk.bold(__ompTranslate("Usage:"))}`,
			`${APP_NAME}`,
			`${APP_NAME}`,
			`${chalk.bold(__ompTranslate("Components:"))}`,
			`${chalk.bold(__ompTranslate("Options:"))}`,
			`${chalk.bold(__ompTranslate("Examples:\u0004help.command.examples"))}`,
			`${APP_NAME}`,
			`${APP_NAME}`,
			`${APP_NAME}`,
			`${APP_NAME}`,
			`${APP_NAME}`,
		),
	);
}
