/**
 * `omp plugin doctor --analyze <a> <b> [--model <selector>] [--yes] [--apply]`.
 *
 * Explicit, read-only AI comparison of two extension resources (an installed plugin, or an extension
 * file or directory):
 * - never runs from plain `doctor`, `doctor --fix`, startup, or any background path;
 * - `--yes` only consents to sending the reviewed files to the model — it can never apply anything;
 * - `--apply` additionally needs a separate confirmation on a real terminal, hides the non-preferred
 *   copy in omp only (fingerprint-bound, nothing is uninstalled or edited), and is refused up front,
 *   before any model call, unless stdin, stdout and stderr are all terminals (the report and both
 *   prompts must be visible); a request nobody can consent to is refused just as early.
 */
import * as fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { getAgentDir, getProjectDir, pathIsWithin } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { sanitizeDisplaySingleLine } from "@oh-my-pi/pi-tui/overlays/extensions/display-text";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { SOURCE_PATHS } from "../discovery/helpers";
import { describeRequest, SEND_DISCLOSURE } from "../extensibility/resource-consent";
import type { PluginManager } from "../extensibility/plugins";
import { getEnabledPlugins } from "../extensibility/plugins/loader";
import type { MarketplaceManager } from "../extensibility/plugins/marketplace/index.js";
import {
	analyzeResources,
	formatResourceAnalysis,
	resolveResourceAnalysisModel,
} from "../extensibility/resource-analysis";
import { snapshotResource } from "../extensibility/resource-snapshot";
import { excludeReviewedResources } from "../extensibility/resource-decisions";
import { cfgExtensions } from "../extensibility/settings";
import { discoverAuthStorage } from "../sdk";
import { expandTilde } from "../tools/path-utils";
import type { AuthStorage } from "../session/auth-storage";
import type { PluginCommandArgs } from "./plugin-cli";

export type PluginDoctorFlags = Pick<PluginCommandArgs["flags"], "json" | "model" | "yes" | "apply">;

/** Settings plus a lazily built model registry; `close` releases credential storage. */
export interface PluginDoctorRuntime {
	settings: Settings;
	/** Built on first use: refreshing catalogs is only worth it once a model call is likely. */
	modelRegistry(): Promise<ModelRegistry>;
	close(): void;
}

/** Terminal and runtime seams; tests replace them, production uses {@link defaultPluginDoctorIo}. */
export interface PluginDoctorIo {
	/** True only when stdin, stdout and stderr are all terminals: the report (stdout) and prompts (stderr) must be visible. */
	isInteractive(): boolean;
	/** Ask a yes/no question on the terminal; anything but an explicit yes is no. */
	confirm(question: string): Promise<boolean>;
	openRuntime(cwd: string): Promise<PluginDoctorRuntime>;
}

export const defaultPluginDoctorIo: PluginDoctorIo = {
	isInteractive: () => process.stdin.isTTY === true && process.stdout.isTTY === true && process.stderr.isTTY === true,
	async confirm(question) {
		const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
		try {
			return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
		} finally {
			rl.close();
		}
	},
	async openRuntime(cwd) {
		const settings = await Settings.init({ cwd });
		let authStorage: AuthStorage | undefined;
		let registry: Promise<ModelRegistry> | undefined;
		return {
			settings,
			modelRegistry: () => {
				registry ??= (async () => {
					authStorage = await discoverAuthStorage(undefined, { settings });
					const modelRegistry = new ModelRegistry(authStorage, undefined, { settings });
					// Offline: choosing a model must not reach the network before the user has consented.
					await modelRegistry.refresh("offline");
					return modelRegistry;
				})();
				return registry;
			},
			close: () => authStorage?.close(),
		};
	},
};

/** A file or directory omp may load, with every spelling users can select it by. */
export interface PluginRootChoice {
	/** Canonical real path of the one extension (a package directory or a single file); the identity used for decisions. */
	root: string;
	names: Set<string>;
	details: string[];
}

/** Real path of an existing file or directory (extensions may be either), else null. */
async function realResource(target: string): Promise<string | null> {
	try {
		const real = await fs.realpath(target);
		const stat = await fs.stat(real);
		return stat.isDirectory() || stat.isFile() ? real : null;
	} catch {
		return null;
	}
}

const SCRIPT_FILE = /\.[cm]?[jt]sx?$/i;

/** Spellings a user can type for a path: its entry name, and a script file's name without the extension. */
function pathNames(entry: string): string[] {
	const base = path.basename(entry);
	return [base, base.replace(SCRIPT_FILE, "")];
}

/**
 * Every extension omp can load from this install and project: npm/link and project plugins,
 * marketplace installs, configured `extensions:` entries and each entry of the native extension
 * directories (one choice per file or package, never the directory itself). Names are selectors
 * only; two spellings of one real path are one root.
 */
export async function listPluginRootChoices(
	manager: Pick<PluginManager, "list">,
	marketplace: Pick<MarketplaceManager, "listInstalledPlugins">,
	settings: Settings,
	cwd: string,
): Promise<PluginRootChoice[]> {
	const found: Array<{ dir: string; names: string[]; detail: string }> = [];
	for (const plugin of await manager.list()) {
		found.push({ dir: plugin.path, names: [plugin.name], detail: `npm/link ${plugin.name}@${plugin.version}` });
	}
	for (const plugin of await getEnabledPlugins(cwd)) {
		found.push({
			dir: plugin.path,
			names: [plugin.name],
			detail: `npm/link ${plugin.name}@${plugin.version} (${plugin.scope})`,
		});
	}
	for (const summary of await marketplace.listInstalledPlugins()) {
		for (const entry of summary.entries) {
			const bare = summary.id.slice(0, Math.max(summary.id.lastIndexOf("@"), 0)) || summary.id;
			found.push({
				dir: entry.installPath,
				names: [summary.id, bare],
				detail: `marketplace ${summary.id} ${entry.version} (${summary.scope})`,
			});
		}
	}
	const home = os.homedir();
	for (const raw of cfgExtensions.get(settings)) {
		const dir = path.resolve(cwd, expandTilde(raw, home));
		found.push({ dir, names: [raw, ...pathNames(dir)], detail: `configured extension ${raw}` });
	}
	for (const extensionsDir of [
		path.join(cwd, SOURCE_PATHS.native.projectDir, "extensions"),
		path.join(getAgentDir(), "extensions"),
	]) {
		let entries: Dirent[] = [];
		try {
			entries = await fs.readdir(extensionsDir, { withFileTypes: true });
		} catch {
			// no native extensions directory here
		}
		for (const entry of entries) {
			// Packages are directories (or links to them); a plain file only counts when it is a script omp loads.
			if (
				entry.name.startsWith(".") ||
				!(entry.isDirectory() || entry.isSymbolicLink() || SCRIPT_FILE.test(entry.name))
			)
				continue;
			found.push({
				dir: path.join(extensionsDir, entry.name),
				names: pathNames(entry.name),
				detail: `native extension ${entry.name}`,
			});
		}
	}

	const byRoot = new Map<string, PluginRootChoice>();
	for (const { dir, names, detail } of found) {
		const root = await realResource(dir);
		if (root === null) continue;
		const choice = byRoot.get(root) ?? { root, names: new Set<string>(), details: [] };
		for (const name of names) choice.names.add(name);
		if (!choice.details.includes(detail)) choice.details.push(detail);
		byRoot.set(root, choice);
	}
	return [...byRoot.values()];
}

interface ResolvedRoot {
	root: string;
	label: string;
	known: boolean;
}

/**
 * Resolve one selector to one real extension: a name must match exactly one known root, a path must
 * name an existing file or directory. A decision hides everything beneath its root, so a selection
 * must be one whole extension, never a place that holds several or a part of one: the home directory
 * (and its parents, including the filesystem root), any directory containing other known extensions
 * (such as a whole `extensions/` directory) and any file or folder inside a known extension (hiding
 * only its entrypoint would leave the rest of the package loading) are refused.
 */
async function resolveSelector(
	selector: string,
	choices: readonly PluginRootChoice[],
	cwd: string,
): Promise<ResolvedRoot> {
	const shown = sanitizeDisplaySingleLine(selector);
	const named = choices.filter(choice => choice.names.has(selector));
	if (named.length > 1) {
		throw new Error(
			`"${shown}" matches ${named.length} different extensions; pass the exact path instead:\n${named
				.map(
					choice =>
						`  ${sanitizeDisplaySingleLine(choice.root)} (${choice.details.map(sanitizeDisplaySingleLine).join("; ")})`,
				)
				.join("\n")}`,
		);
	}
	let root = named.length === 1 ? named[0].root : null;
	if (root === null) {
		const looksLikePath = /[\\/]/.test(selector) || selector.startsWith(".") || selector.startsWith("~");
		root = looksLikePath ? await realResource(path.resolve(cwd, expandTilde(selector))) : null;
	}
	if (root === null) {
		throw new Error(
			`"${shown}" is not an installed plugin name or an existing extension file or directory (see \`omp plugin list\`)`,
		);
	}
	const home = await realResource(os.homedir());
	if (home !== null && pathIsWithin(root, home)) {
		throw new Error(`"${shown}" is the home directory or one of its parents, not an extension`);
	}
	const owner = choices.find(choice => choice.root !== root && pathIsWithin(choice.root, root));
	if (owner) {
		const ownerRoot = sanitizeDisplaySingleLine(owner.root);
		throw new Error(
			`"${shown}" is inside the extension ${ownerRoot}, which omp loads as a whole; hiding only part of it would leave the rest loaded. Select ${ownerRoot} itself`,
		);
	}
	const nested = choices.filter(choice => choice.root !== root && pathIsWithin(root, choice.root));
	if (nested.length > 0) {
		const sample = nested.slice(0, 3).map(choice => sanitizeDisplaySingleLine(choice.root));
		throw new Error(
			`"${shown}" contains other extensions (${sample.join(", ")}${nested.length > 3 ? ", …" : ""}); name one extension, not a directory that holds several`,
		);
	}
	return { root, label: selector, known: choices.some(choice => choice.root === root) };
}

export interface PluginDoctorAnalysisRequest {
	manager: Pick<PluginManager, "list">;
	marketplace: Pick<MarketplaceManager, "listInstalledPlugins">;
	/** Names or paths the user explicitly selected; exactly two are analyzed. */
	selectors: readonly string[];
	flags: PluginDoctorFlags;
	io: PluginDoctorIo;
	cwd?: string;
}

/** Run the explicit analysis flow; returns the process exit code (nothing here calls `process.exit`). */
export async function runPluginDoctorAnalysis(request: PluginDoctorAnalysisRequest): Promise<number> {
	const { selectors, flags, io, manager, marketplace } = request;
	const cwd = request.cwd ?? getProjectDir();
	const say = (line = ""): void => (flags.json ? console.error(line) : console.log(line));
	const fail = (message: string): number => {
		console.error(chalk.red(message));
		return 1;
	};

	// Refuse what nobody could consent to or confirm before touching settings, credentials, catalogs or files.
	const interactive = io.isInteractive();
	if (!flags.yes && !interactive) {
		return fail(
			"Analysis sends extension files to a model and may incur charges. Re-run with --yes to consent, or from a terminal to be asked.",
		);
	}
	if (flags.apply && !interactive) {
		return fail(
			"--apply needs a terminal (stdin, stdout and stderr) to show the report and ask for confirmation; --yes never applies changes. Nothing was sent or changed.",
		);
	}
	if (flags.apply && flags.json) return fail("--apply asks for confirmation on the terminal; omit --json.");

	let runtime: PluginDoctorRuntime | undefined;
	try {
		runtime = await io.openRuntime(cwd);
		const { settings } = runtime;
		const choices = await listPluginRootChoices(manager, marketplace, settings, cwd);

		if (selectors.length !== 2) {
			const lines = [
				`--analyze compares exactly two extensions you name; got ${selectors.length}.`,
				`Usage: omp plugin doctor --analyze <plugin-a> <plugin-b> [--model <selector>]  (an installed name, or a path to an extension file or directory)`,
				choices.length === 0
					? "No installed or configured plugin roots were found."
					: `Choose from:\n${choices
							.map(
								choice =>
									`  ${[...choice.names].map(sanitizeDisplaySingleLine).join(" | ")}  ${sanitizeDisplaySingleLine(choice.root)}`,
							)
							.join("\n")}`,
			];
			return fail(lines.join("\n"));
		}

		const resolved: ResolvedRoot[] = [];
		for (const selector of selectors) resolved.push(await resolveSelector(selector, choices, cwd));
		if (resolved[0].root === resolved[1].root) {
			return fail("Both selections are the same path; there is nothing to compare.");
		}
		if (pathIsWithin(resolved[0].root, resolved[1].root) || pathIsWithin(resolved[1].root, resolved[0].root)) {
			return fail(
				"One selection lies inside the other; hiding the outer one would also hide the inner one. Select two separate extensions.",
			);
		}

		const snapshots = await Promise.all(
			resolved.map((entry, index) =>
				snapshotResource({ id: `extension-${index + 1}`, label: entry.label, kind: "extension", root: entry.root }),
			),
		);
		// Size cap, count and partial coverage are settled here, before any prompt, catalog or model call.
		const summary = describeRequest(snapshots);
		if (flags.apply && snapshots.some(snapshot => !snapshot.complete)) {
			return fail(
				`--apply cannot hide an extension that was only partly read, and a partial analysis would be paid for in vain. Run without --apply for an advisory report.\n${summary}`,
			);
		}

		const modelRegistry = await runtime.modelRegistry();
		const selected = resolveResourceAnalysisModel(modelRegistry, settings, flags.model);
		const { model } = selected;
		// Hand the backend exactly what the consent prompt names, so a registry change between
		// resolution and the call can never swap in another model (same rule as /skills analysis).
		const modelSelector = `${model.provider}/${model.id}${selected.thinkingLevel ? `:${selected.thinkingLevel}` : ""}`;
		const target = `${model.provider}/${model.id}`;
		const unknownNote = resolved.some(entry => !entry.known)
			? "Note: a selected directory is not a currently discovered omp plugin root.\n"
			: "";

		if (flags.yes) {
			say(`Sending to ${target} (consent given with --yes):`);
			say(summary);
		} else {
			const consent = await io.confirm(
				`Send these extension files to ${target}?\n${SEND_DISCLOSURE}\n${summary}\n${unknownNote}`,
			);
			if (!consent) {
				say("Cancelled; nothing was sent.");
				return 0;
			}
		}

		const analysis = await analyzeResources(snapshots, modelRegistry, settings, { modelSelector });
		const report = formatResourceAnalysis(snapshots, analysis);
		const preferredId = analysis.recommendation.preferredId;
		const preferred =
			analysis.recommendation.action === "prefer" && snapshots.every(snapshot => snapshot.complete)
				? snapshots.find(snapshot => snapshot.candidate.id === preferredId)
				: undefined;

		if (flags.json) {
			console.log(
				JSON.stringify(
					{
						model: target,
						candidates: snapshots.map(snapshot => ({
							id: snapshot.candidate.id,
							label: snapshot.candidate.label,
							root: snapshot.candidate.root,
							fingerprint: snapshot.fingerprint,
							complete: snapshot.complete,
							files: snapshot.files.length,
							omissions: snapshot.omissions,
						})),
						analysis,
						applied: false,
					},
					null,
					2,
				),
			);
			return 0;
		}

		console.log(chalk.bold("AI Plugin Analysis — Advisory\n"));
		console.log(report);
		console.log(
			chalk.dim(
				"\nAdvisory only: this is a model's reading of the files, not verified provenance. Nothing was changed.",
			),
		);

		if (!flags.apply) {
			if (preferred) {
				console.log(
					chalk.dim(
						"To hide the non-preferred copy in omp, re-run with --apply (asks for a separate confirmation).",
					),
				);
			}
			return 0;
		}
		if (!preferred) {
			console.log(
				"No copy can be hidden on this evidence (no complete 'prefer' recommendation); nothing was changed.",
			);
			return 0;
		}
		const hidden = snapshots.filter(snapshot => snapshot.candidate.id !== preferred.candidate.id);
		const apply = await io.confirm(
			`Hide ${hidden.map(snapshot => sanitizeDisplaySingleLine(snapshot.candidate.root)).join(", ")} in omp and keep ${sanitizeDisplaySingleLine(preferred.candidate.root)}? This is your decision, not the model's. Files stay installed and other tools are unaffected; any change to either copy cancels the decision.`,
		);
		if (!apply) {
			say("Nothing was changed.");
			return 0;
		}
		await excludeReviewedResources(snapshots, preferred.candidate.id, settings);
		console.log(
			chalk.green(
				`Hidden in omp: ${hidden.map(snapshot => sanitizeDisplaySingleLine(snapshot.candidate.root)).join(", ")}`,
			),
		);
		console.log(
			"Restart running omp sessions to unload extensions, hooks and MCP servers they already loaded; new sessions skip the hidden copy. Nothing was uninstalled or edited.",
		);
		console.log(chalk.dim("Restore with: omp config reset diagnostics.resourceExclusions"));
		return 0;
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error));
	} finally {
		runtime?.close();
	}
}
