import { errorMessage, pluralize } from "@oh-my-pi/pi-utils";
import {
	deleteManagedSkill,
	getManagedSkillsDir,
	listManagedSkills,
	type ManagedSkillEntry,
} from "../autolearn/managed-skills";
import type { InteractiveModeContext } from "../modes/types";
import { SkillshareClient } from "../skillshare/client";
import {
	formatInstalledSkills,
	formatScriptApproval,
	formatSkillChanges,
	formatSkillSearch,
	installSkillPackages,
	listInstalledSkills,
	type SkillChange,
	type SkillInstallHooks,
	updateSkillPackages,
} from "../skillshare/installer";
import { shortenPath } from "../utils/render-utils";
import { clearSubmittedText } from "./helpers/draft";
import { parseSubcommand } from "./helpers/parse";
import type { SlashCommandSpec } from "./types";

const USAGE = [
	"Skill registry (skills.omp.sh) commands:",
	"  /skills search <query>                        Search the registry",
	"  /skills install <@scope/name[@range]>… [-g]   Install into this project (-g: user-global)",
	"  /skills installed                             List installed registry skills",
	"  /skills update [@scope/name…] [-g]            Update within the ranges in skills.json",
	"",
	"Learned (auto-learn managed) skills:",
	"  /skills learned                               Review learned skills and their provenance",
	"  /skills forget <name>                         Delete a learned skill",
].join("\n");

/** Render the `/skills learned` review listing: each managed skill with its provenance. */
export function formatManagedSkills(entries: readonly ManagedSkillEntry[]): string {
	const root = shortenPath(getManagedSkillsDir());
	if (entries.length === 0) return `No learned skills in ${root}.`;
	const lines = [`Learned skills (${root}):`];
	for (const entry of entries) {
		lines.push(`  ${entry.name} — ${entry.description || "(no description)"}`);
		const provenance = entry.provenance;
		if (!provenance) {
			lines.push("    no provenance recorded");
			continue;
		}
		const details = [`updated ${provenance.updated.slice(0, 10)} via ${provenance.generator}`];
		if (provenance.created) details.push(`created ${provenance.created.slice(0, 10)}`);
		details.push(`${provenance.sessions.length} ${pluralize("session", provenance.sessions.length)}`);
		lines.push(`    ${details.join(" · ")}`);
		if (provenance.projects.length > 0) {
			lines.push(`    projects: ${provenance.projects.map(project => shortenPath(project)).join(", ")}`);
		}
		const latestSession = provenance.sessions.at(-1);
		if (latestSession) lines.push(`    latest session: ${latestSession}`);
	}
	return lines.join("\n");
}

/** Split `<name…> [--global|-g]`; unknown flags are errors. */
function parseTargets(rest: string): { names: string[]; global: boolean } | { error: string } {
	const names: string[] = [];
	let global = false;
	for (const token of rest.split(/\s+/)) {
		if (!token) continue;
		if (token === "--global" || token === "-g") global = true;
		else if (token.startsWith("-")) return { error: `Unknown option: ${token}\n\n${USAGE}` };
		else names.push(token);
	}
	return { names, global };
}

async function withClient<T>(run: (client: SkillshareClient) => Promise<T>): Promise<T> {
	const client = await SkillshareClient.create();
	try {
		return await run(client);
	} finally {
		client.close();
	}
}

function tuiHooks(ctx: InteractiveModeContext): SkillInstallHooks {
	return {
		warn: message => ctx.showWarning(message),
		confirmScripts: request => ctx.showHookConfirm("Install skill with scripts?", formatScriptApproval(request)),
	};
}

async function reportChanges(ctx: InteractiveModeContext, changes: SkillChange[]): Promise<void> {
	if (changes.length === 0) {
		ctx.showStatus("Registry skills are already up to date.");
		return;
	}
	await ctx.refreshSkillState();
	ctx.showStatus(formatSkillChanges(changes));
}

export const BUILTIN_SKILLS_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "skills",
		icon: "skill",
		description: "Search, install, and update registry skills; review learned skills",
		subcommands: [
			{ name: "search", description: "Search the skill registry", usage: "<query>" },
			{ name: "install", description: "Install registry skills", usage: "<@scope/name[@range]>… [--global]" },
			{ name: "installed", description: "List installed registry skills" },
			{
				name: "update",
				description: "Update registry skills within their ranges",
				usage: "[@scope/name…] [--global]",
			},
			{ name: "learned", description: "Review learned (auto-learn) skills and their provenance" },
			{ name: "forget", description: "Delete a learned skill", usage: "<name>" },
		],
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const { ctx } = runtime;
			clearSubmittedText(runtime);
			const { verb, rest } = parseSubcommand(command.args);
			const cwd = ctx.sessionManager.getCwd();
			try {
				switch (verb) {
					case "search": {
						if (!rest) {
							ctx.showError("Usage: /skills search <query>");
							return;
						}
						const response = await withClient(client => client.search(rest));
						ctx.showStatus(formatSkillSearch(response));
						return;
					}
					case "install": {
						const targets = parseTargets(rest);
						if ("error" in targets) {
							ctx.showError(targets.error);
							return;
						}
						if (targets.names.length === 0) {
							ctx.showError("Usage: /skills install <@scope/name[@range]>… [--global]");
							return;
						}
						ctx.showStatus(`Installing ${targets.names.join(", ")}…`, { dim: true });
						const changes = await withClient(client =>
							installSkillPackages(
								client,
								{ specs: targets.names, global: targets.global, yes: false, cwd },
								tuiHooks(ctx),
							),
						);
						await reportChanges(ctx, changes);
						return;
					}
					case "installed": {
						ctx.showStatus(formatInstalledSkills(await listInstalledSkills(cwd)));
						return;
					}
					case "update": {
						const targets = parseTargets(rest);
						if ("error" in targets) {
							ctx.showError(targets.error);
							return;
						}
						ctx.showStatus("Checking the registry for updates…", { dim: true });
						const changes = await withClient(client =>
							updateSkillPackages(client, { names: targets.names, global: targets.global, cwd }, tuiHooks(ctx)),
						);
						await reportChanges(ctx, changes);
						return;
					}
					case "learned": {
						ctx.showStatus(formatManagedSkills(await listManagedSkills()));
						return;
					}
					case "forget": {
						if (!rest || /\s/.test(rest)) {
							ctx.showError("Usage: /skills forget <name>");
							return;
						}
						await deleteManagedSkill(rest);
						await ctx.refreshSkillState();
						ctx.showStatus(`Forgot learned skill "${rest}".`);
						return;
					}
					case "":
					case "help":
						ctx.showStatus(USAGE);
						return;
					default:
						ctx.showError(`Unknown /skills subcommand: ${verb}\n\n${USAGE}`);
						return;
				}
			} catch (error) {
				ctx.showError(`Skills: ${errorMessage(error)}`);
			}
		},
	},
];
