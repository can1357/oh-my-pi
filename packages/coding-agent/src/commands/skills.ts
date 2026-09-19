import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings } from "../config/settings";
import type { EffectiveExtensionRoots } from "../capability/types";
import type { SkillsSettings } from "../config/settings-schema";
import { initializeWithSettings } from "../discovery";
import { loadSkills, type SkillWarning } from "../extensibility/skills";
import { CliUsageError } from "../cli/usage-error";
import { skillsHelp as commandHelp } from "../cli/command-help";

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
		skillsSettings = settings.getGroup("skills");
		disabledExtensions = settings.get("disabledExtensions") ?? [];
		extensionRoots = {
			explicit: [],
			mode: "merge",
			configured: settings.get("extensions") ?? [],
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

export default class Skills extends Command {
	static description = commandHelp.description;
	static args = {
		cwd: Args.string({
			description: "Directory to discover skills for (default: the working directory)",
			required: false,
		}),
	};
	static flags = {
		json: Flags.boolean({
			description: "Print machine-readable JSON (skills with discovery metadata and warnings)",
			default: false,
		}),
	};

	static examples = ["omp skills", "omp skills /path/to/project", "omp skills --json"];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Skills);
		const cwd = args.cwd ?? process.cwd();
		if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
			throw new CliUsageError(`Not a directory: ${cwd}`);
		}
		const result = await runSkillsCommand({ cwd });
		if (flags.json) {
			console.log(JSON.stringify(result));
			return;
		}
		for (const skill of result.skills) {
			console.log(`${toTerminalSafe(skill.name)}\t${toTerminalSafe(skill.description)}`);
		}
		if (result.skills.length === 0) console.log("No skills discovered.");
		for (const warning of result.warnings) {
			console.log(`warning: ${toTerminalSafe(warning.message)}`);
		}
	}
}
