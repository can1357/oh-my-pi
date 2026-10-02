import * as fs from "node:fs";
import * as path from "node:path";
import { isEnoent, isEnotdir } from "@oh-my-pi/pi-utils";
import { CliUsageError } from "@oh-my-pi/pi-utils/cli";
import { Settings } from "../config/settings";
import type { EffectiveExtensionRoots } from "../capability/types";
import { initializeWithSettings } from "../discovery";
import { cfgDisabledExtensions, cfgExtensions, cfgSkills, type SkillsSettings } from "../extensibility/settings";
import { loadSkills, type SkillWarning } from "../extensibility/skills";

/** Public skill listing entry: the fields a machine consumer may rely on. */
export interface SkillSummary {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	source: string;
	hide: boolean;
}

export interface SkillsCommandResult {
	skills: SkillSummary[];
	warnings: SkillWarning[];
}

/**
 * Discover skills for a directory exactly as a session would and report them.
 * Internal skill metadata (`_source`, `containRoot`) is deliberately omitted
 * from the result shape.
 */
export async function runSkillsCommand(
	options: {
		cwd?: string;
		skillsSettings?: Partial<SkillsSettings>;
	} = {},
): Promise<SkillsCommandResult> {
	const cwd = options.cwd ?? process.cwd();
	let skillsSettings: Partial<SkillsSettings>;
	let disabledExtensions: string[];
	let extensionRoots: EffectiveExtensionRoots;
	if (options.skillsSettings) {
		// Test seam: fully isolated from ambient configuration.
		skillsSettings = options.skillsSettings;
		disabledExtensions = [];
		extensionRoots = { explicit: [], mode: "merge", configured: [], configuredLevel: "user" };
	} else {
		const settings = await Settings.init({ cwd });
		initializeWithSettings(settings);
		skillsSettings = cfgSkills.get(settings);
		disabledExtensions = [...cfgDisabledExtensions.get(settings)];
		extensionRoots = {
			explicit: [],
			mode: "merge",
			configured: cfgExtensions.get(settings),
			configuredLevel: settings.extensionsSourceLevel(),
		};
	}
	if (skillsSettings.customDirectories?.length) {
		// Relative entries are config-relative to the inspected directory, not
		// to wherever the command happens to run.
		skillsSettings = {
			...skillsSettings,
			customDirectories: skillsSettings.customDirectories.map(dir =>
				path.isAbsolute(dir) ? dir : path.resolve(cwd, dir),
			),
		};
	}
	const { skills, warnings } = await loadSkills({
		...skillsSettings,
		cwd,
		disabledExtensions,
		extensionRoots,
	});
	return {
		skills: skills.map(skill => ({
			name: skill.name,
			description: skill.description,
			filePath: skill.filePath,
			baseDir: skill.baseDir,
			source: skill.source,
			hide: skill.hide === true,
		})),
		warnings,
	};
}

/** Control characters (including newlines and tabs) are escaped so skill
 * metadata cannot inject terminal output lines; `--json` consumers get the
 * raw values. */
function toTerminalSafe(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f]/g, ch => `\\x${ch.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

/**
 * `omp skill list [dir] [--json]`: report the skills a session in `dir` would
 * resolve. Terminal output is one `name<TAB>description` row per skill on
 * stdout, with notices and warnings on stderr; `--json` emits the full result
 * including discovery warnings.
 */
export async function handleSkillList(args: string[], cwd: string, json: boolean): Promise<number> {
	if (args.length > 1) throw new CliUsageError("usage: omp skill list [dir] [--json]");
	const target = args[0] ? path.resolve(cwd, args[0]) : cwd;
	let isDirectory = false;
	try {
		isDirectory = (await fs.promises.stat(target)).isDirectory();
	} catch (error) {
		if (!isEnoent(error) && !isEnotdir(error)) throw error;
	}
	if (!isDirectory) throw new CliUsageError(`Not a directory: ${target}`);
	const result = await runSkillsCommand({ cwd: target });
	if (json) {
		process.stdout.write(`${JSON.stringify(result)}\n`);
		return 0;
	}
	for (const skill of result.skills) {
		process.stdout.write(`${toTerminalSafe(skill.name)}\t${toTerminalSafe(skill.description)}\n`);
	}
	if (result.skills.length === 0) process.stderr.write("No skills discovered.\n");
	for (const warning of result.warnings) {
		process.stderr.write(`warning: ${toTerminalSafe(warning.message)}\n`);
	}
	return 0;
}
