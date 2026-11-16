/**
 * Habitual argument aliases for the Antigravity CLI host path. Schema
 * validation stays the authority: a rename happens only when one schema
 * property and one input key identify the same parameter, so a call that still
 * violates the schema reaches the existing diagnostic path unchanged.
 */
import { isRecord } from "@oh-my-pi/pi-utils";

const ALIAS_GROUPS: readonly (readonly string[])[] = [
	["file_path", "path", "absolute_path", "AbsolutePath", "target_file", "TargetFile"],
	["command", "command_line", "CommandLine"],
	["cwd", "working_directory", "working_dir", "Cwd"],
	["description", "Description"],
];

/** One argument key moved to the name the tool schema declares. */
export interface RenamedArgument {
	from: string;
	to: string;
}

/** Arguments to validate and forward; a non-object input is returned as-is. */
export interface NormalizedToolArguments {
	arguments: unknown;
	renamed: RenamedArgument[];
}

function schemaProperties(schema: unknown): Record<string, unknown> {
	if (!isRecord(schema)) return {};
	const properties = schema.properties;
	return isRecord(properties) ? properties : {};
}

/**
 * Renames unambiguous alias arguments to the schema's declared name. Every
 * other shape — a missing or non-object schema, non-object arguments, an
 * already-present target, two candidates on either side, or a non-string
 * target or value — returns the original arguments untouched.
 */
export function normalizeToolArguments(schema: unknown, args: unknown): NormalizedToolArguments {
	if (!isRecord(args)) return { arguments: args, renamed: [] };
	const properties = schemaProperties(schema);
	const output: Record<string, unknown> = { ...args };
	const renamed: RenamedArgument[] = [];
	for (const group of ALIAS_GROUPS) {
		const targets = group.filter(key => Object.hasOwn(properties, key));
		if (targets.length !== 1) continue;
		const target = targets[0];
		if (Object.hasOwn(output, target)) continue;
		const sources = group.filter(key => key !== target && Object.hasOwn(output, key));
		if (sources.length !== 1) continue;
		const source = sources[0];
		const declared = properties[target];
		if (!isRecord(declared) || declared.type !== "string" || typeof output[source] !== "string") continue;
		output[target] = output[source];
		delete output[source];
		renamed.push({ from: source, to: target });
	}
	return { arguments: output, renamed };
}
