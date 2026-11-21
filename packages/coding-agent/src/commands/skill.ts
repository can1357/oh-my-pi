/**
 * Install, publish, and manage skills on a Skillshare registry (skills.omp.sh).
 */
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import type { SkillSearchSort } from "@oh-my-pi/pi-wire/skillshare";
import { skillHelp as commandHelp } from "../cli/command-help";
import { runSkillCommand, SKILL_ACTIONS, SKILL_USAGE, type SkillAction } from "../cli/skill-cli";

export default class Skill extends Command {
	static description = commandHelp.description;
	static aliases = ["skills"];

	static args = {
		action: Args.string({ description: "Skill action", required: false, options: SKILL_ACTIONS }),
		targets: Args.string({
			description: "Specs, names, directories, or action arguments",
			required: false,
			multiple: true,
		}),
	};

	static flags = {
		global: Flags.boolean({ char: "g", description: "Use the user-global skills.json (install/update/uninstall)" }),
		yes: Flags.boolean({ char: "y", description: "Install or update skills that ship scripts without asking" }),
		json: Flags.boolean({ description: "Output JSON (search, info, token, list)" }),
		sort: Flags.string({ description: "Search order", options: ["relevance", "downloads", "recent"] }),
		scope: Flags.string({ description: "Publishing scope (default: your Stencil username)" }),
		tag: Flags.string({ description: "Dist-tag for the published version" }),
		"dry-run": Flags.boolean({ description: "Pack and validate without publishing" }),
		"allow-secrets": Flags.boolean({ description: "Publish even when credential-shaped strings are found" }),
		registry: Flags.string({ description: "Registry base URL (overrides skills.registryUrl)" }),
		undo: Flags.boolean({ description: "Reverse a yank or deprecation" }),
		package: Flags.string({ description: "Restrict a new token to a package (repeatable)", multiple: true }),
		expires: Flags.integer({ description: "Token lifetime in days" }),
	};

	static examples = [
		"omp skill install @alice/pdf-tools",
		"omp skill install -g @alice/pdf-tools@^1.2",
		'omp skill search "pdf" --sort downloads',
		"omp skill version minor && omp skill publish",
		"omp skill publish ./skills/pdf-tools --dry-run",
		"omp skill tag @alice/pdf-tools@2.0.0-beta.1 next",
		'omp skill deprecate @alice/pdf-tools@"<1.0.0" "use 1.x"',
		"omp skill token create ci --package @alice/pdf-tools --expires 90",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Skill);
		if (!args.action) {
			process.stdout.write(SKILL_USAGE);
			return;
		}
		const exitCode = await runSkillCommand({
			action: args.action as SkillAction,
			args: args.targets ?? [],
			cwd: process.cwd(),
			flags: {
				tag: flags.tag,
				dryRun: flags["dry-run"],
				allowSecrets: flags["allow-secrets"],
				registry: flags.registry,
				scope: flags.scope,
				undo: flags.undo,
				global: flags.global,
				yes: flags.yes,
				json: flags.json,
				sort: flags.sort as SkillSearchSort | undefined,
				package: flags.package,
				expires: flags.expires,
			},
		});
		if (exitCode !== 0) process.exitCode = exitCode;
	}
}
