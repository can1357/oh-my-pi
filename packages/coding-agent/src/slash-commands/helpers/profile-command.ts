/**
 * Shared model-role profile activation logic for the `/profile` slash command
 * and the profile picker. Lives in its own module (not builtin-modes.ts) so
 * importing it never triggers the builtin slash-command registry's module
 * cycle during initialization.
 */
import type { Settings } from "../../config/settings";

/** Parsed `/profile <subcommand> ...` management request. */
export type ProfileMutation =
	| { op: "list" }
	| { op: "show"; name: string }
	| { op: "create"; name: string; roles: Record<string, string>; description?: string; scope: "global" | "project" }
	| { op: "set-role"; name: string; role: string; selector: string | null; scope: "global" | "project" }
	| { op: "set-description"; name: string; description: string; scope: "global" | "project" }
	| { op: "delete"; name: string; scope: "global" | "project" };

/**
 * Parse free-form `/profile` arguments into a structured mutation. A bare
 * word returns the string itself (a direct activation request handled by the
 * existing activateProfile path). Returns a usage error object when the text
 * does not match a known operation shape.
 */
export function parseProfileMutation(args: string): ProfileMutation | { error: string } | string {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) return { op: "list" };
	const [head, ...rest] = parts;
	switch (head) {
		case "list":
			return { op: "list" };
		case "show":
			return rest.length === 1 ? { op: "show", name: rest[0] } : usageError("show <name>");
		case "create": {
			// create <name> [--project] [--description <text...>] --role <role>=<selector>...
			// The description consumes free tokens until the next flag, so it may
			// appear anywhere and contain spaces.
			let name: string | undefined;
			let description: string | undefined;
			let scope: "global" | "project" = "global";
			const roles: Record<string, string> = {};
			for (let i = 0; i < rest.length; i++) {
				const arg = rest[i];
				if (arg === "--project") scope = "project";
				else if (arg === "--role") {
					const pair = rest[++i] ?? "";
					const eq = pair.indexOf("=");
					if (eq <= 0) return usageError("create <name> --role <role>=<model-selector>");
					roles[pair.slice(0, eq)] = pair.slice(eq + 1);
				} else if (arg === "--description") {
					i++;
					const words: string[] = [];
					while (i < rest.length && rest[i] !== "--role" && rest[i] !== "--project") {
						words.push(rest[i++]);
					}
					i--; // step back: the outer loop re-examines the terminating flag
					if (words.length > 0) description = words.join(" ");
				} else if (name === undefined) name = arg;
				else return usageError("create <name> [--project] --role <role>=<selector> [...] [--description <text>]");
			}
			if (!name || Object.keys(roles).length === 0) {
				return usageError("create <name> [--project] --role <role>=<selector> [...] [--description <text>]");
			}
			return { op: "create", name, roles, description, scope };
		}
		case "set-role": {
			// set-role <name> <role>=<selector|null> [--project]
			const scope = rest.includes("--project") ? "project" : "global";
			const positional = rest.filter(entry => entry !== "--project");
			if (positional.length !== 2) return usageError("set-role <name> <role>=<selector|null> [--project]");
			const [profileName, pair] = positional;
			const eq = pair.indexOf("=");
			if (eq <= 0) return usageError("set-role <name> <role>=<selector|null> [--project]");
			const role = pair.slice(0, eq);
			const rawSelector = pair.slice(eq + 1);
			const selector = rawSelector === "null" ? null : rawSelector;
			return { op: "set-role", name: profileName, role, selector, scope };
		}
		case "set-description": {
			const scope = rest.includes("--project") ? "project" : "global";
			const positional = rest.filter(entry => entry !== "--project");
			if (positional.length < 2) return usageError("set-description <name> <text...> [--project]");
			return { op: "set-description", name: positional[0], description: positional.slice(1).join(" "), scope };
		}
		case "delete": {
			const scope = rest.includes("--project") ? "project" : "global";
			const positional = rest.filter(entry => entry !== "--project");
			return positional.length === 1
				? { op: "delete", name: positional[0], scope }
				: usageError("delete <name> [--project]");
		}
		default:
			// Direct activation is exactly `/profile <name>` — one token. Any
			// trailing argument is a typo or unsupported flag, not part of a
			// profile name, and must not silently activate.
			return rest.length === 0 ? head : usageError("<name>");
	}
}

function usageError(signature: string): { error: string } {
	return { error: `Usage: /profile ${signature}` };
}

/**
 * Execute a parsed profile mutation through the Settings profile API and
 * flush persistence. Returns a user-facing status message, or an error
 * string prefixed with "Unknown profile"/"Invalid"/"Usage:" on failure.
 */
export async function runProfileMutation(settings: Settings, mutation: ProfileMutation): Promise<string> {
	switch (mutation.op) {
		case "list": {
			const snapshot = settings.describeProfiles();
			const names = Object.keys(snapshot.profiles).sort();
			if (names.length === 0) return "No profiles configured.";
			const lines = names.map(name => {
				const profile = snapshot.profiles[name];
				const activeMark = snapshot.active === name ? " ●" : "";
				const desc = profile.description ?? "";
				const scopeTag =
					profile.definedIn.length > 1
						? ` (${profile.definedIn.join("+")})`
						: ` (${profile.definedIn[0] ?? "global"})`;
				return `${name}${activeMark}${scopeTag}${desc ? ` — ${desc}` : ""}`;
			});
			return `Profiles${snapshot.active ? ` (active: ${snapshot.active})` : ""}:\n${lines.map(line => `  ${line}`).join("\n")}`;
		}
		case "show": {
			const definition = settings.getProfile(mutation.name);
			if (definition === undefined) return unknownProfile(mutation.name);
			const snapshot = settings.describeProfiles();
			const info = snapshot.profiles[mutation.name];
			const lines = [
				`Profile ${mutation.name}${snapshot.active === mutation.name ? " (active)" : ""}`,
				`Scope: ${info?.definedIn.join(", ") ?? "unknown"}`,
			];
			if (definition.description) lines.push(`Description: ${definition.description}`);
			const roles = definition.modelRoles ?? {};
			const roleNames = Object.keys(roles);
			lines.push(roleNames.length > 0 ? "Model roles:" : "Model roles: (none)");
			for (const role of roleNames.sort()) lines.push(`  ${role}: ${roles[role]}`);
			return lines.join("\n");
		}
		case "create": {
			try {
				await settings.setProfile(mutation.scope, mutation.name, {
					description: mutation.description,
					modelRoles: mutation.roles,
				});
			} catch (error) {
				return mutationError(error);
			}
			return `Profile ${mutation.name} created in ${mutation.scope} config with ${Object.keys(mutation.roles).length} role(s).`;
		}
		case "set-role": {
			if (settings.getProfile(mutation.name) === undefined) return unknownProfile(mutation.name);
			try {
				await settings.setProfile(mutation.scope, mutation.name, {
					modelRoles: { [mutation.role]: mutation.selector as string },
				});
			} catch (error) {
				return mutationError(error);
			}
			return mutation.selector === null
				? `Role ${mutation.role} removed from profile ${mutation.name}.`
				: `Profile ${mutation.name}.${mutation.role} = ${mutation.selector}.`;
		}
		case "set-description": {
			if (settings.getProfile(mutation.name) === undefined) return unknownProfile(mutation.name);
			try {
				await settings.setProfile(mutation.scope, mutation.name, { description: mutation.description });
			} catch (error) {
				return mutationError(error);
			}
			return `Description of profile ${mutation.name} updated.`;
		}
		case "delete": {
			try {
				await settings.removeProfile(mutation.scope, mutation.name);
			} catch (error) {
				return mutationError(error);
			}
			return `Profile ${mutation.name} deleted from ${mutation.scope} config.`;
		}
	}
}

function unknownProfile(name: string): string {
	return `Unknown profile: ${name}`;
}

function mutationError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Profile activation shared by `/profile` and the profile picker.
 *
 * Interactive selection is a RUNTIME override (`settings.override`), not a
 * persisted write: it outranks any global/project `activeProfile` for this
 * session and never rewrites either config file. `off` (or "") clears the
 * runtime selection so lower persistent layers become effective again.
 * Persistent selection is the explicit `setActiveProfile("global"|"project")`
 * API. Returns a user-facing status message, or an error string prefixed
 * with "Unknown profile" when the profile does not exist.
 */
export function activateProfile(settings: Settings, name: string): string {
	const trimmed = name.trim();
	if (trimmed === "" || trimmed === "off") {
		const wasActive = settings.getActiveProfile() !== "";
		settings.override("activeProfile", "");
		return wasActive ? "Profile disabled — normal model-role configuration restored." : "No active profile.";
	}
	if (settings.getProfile(trimmed) === undefined) {
		return `Unknown profile: ${trimmed}. Configure profiles in settings (activeProfile/profiles).`;
	}
	const previous = settings.getActiveProfile();
	settings.override("activeProfile", trimmed);
	return previous === trimmed ? `Profile ${trimmed} is already active.` : `Profile ${trimmed} active.`;
}

/** Roster shown by the bare `/profile` selector: every configured profile plus "off". */
export function profilePickerEntries(
	settings: Settings,
): { name: string; description?: string; definedIn: Array<"global" | "project" | "overlay"> }[] {
	const snapshot = settings.describeProfiles();
	const entries: { name: string; description?: string; definedIn: Array<"global" | "project" | "overlay"> }[] = [];
	for (const name of Object.keys(snapshot.profiles)) {
		const info = snapshot.profiles[name];
		const roles = info?.modelRoles;
		const roleCount = roles ? Object.keys(roles).length : 0;
		entries.push({
			name,
			description:
				typeof info?.description === "string" && info.description !== ""
					? info.description
					: roleCount > 0
						? `${roleCount} model role${roleCount === 1 ? "" : "s"}`
						: undefined,
			definedIn: [...(info?.definedIn ?? [])],
		});
	}
	entries.sort((a, b) => a.name.localeCompare(b.name));
	entries.push({ name: "off", description: "Disable the active profile", definedIn: [] });
	return entries;
}
