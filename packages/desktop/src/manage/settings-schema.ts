/**
 * The curated slice of omp's configuration that a desktop app should expose.
 *
 * `omp config list --json` reports **477 keys**. Rendering all of them would be
 * a worse settings.json, so this picks the ones that change how the app behaves
 * day to day and leaves the rest to the file.
 *
 * Enum options are declared here because the CLI does not report them: an enum
 * entry carries only `{ value, type: "enum", description }`, with no list of
 * allowed values. Where a key's options are unknown, it is rendered as free
 * text rather than a guessed dropdown.
 */

export interface SettingField {
	key: string;
	label: string;
	/** Options for enum keys; the CLI cannot tell us these. */
	options?: Array<{ value: string; label: string; hint?: string }>;
}

export interface SettingGroup {
	title: string;
	description?: string;
	fields: SettingField[];
}

export const SETTING_GROUPS: SettingGroup[] = [
	{
		title: "Approvals",
		description: "omp ships with yolo, which auto-approves reads, writes and shell commands without asking.",
		fields: [
			{
				key: "tools.approvalMode",
				label: "Approval mode",
				options: [
					{ value: "always-ask", label: "Always ask", hint: "Auto-approves reads only" },
					{ value: "write", label: "Write", hint: "Prompts before running commands" },
					{ value: "yolo", label: "Yolo", hint: "Approves everything (omp default)" },
				],
			},
		],
	},
	{
		title: "Model",
		fields: [
			{ key: "modelRoleStorage", label: "Where role assignments are saved" },
			{ key: "model.loopGuard.enabled", label: "Detect reasoning loops" },
			{ key: "model.toolCallLoopGuard.enabled", label: "Detect repeated tool calls" },
		],
	},
	{
		title: "Memory",
		fields: [
			{
				key: "memory.backend",
				label: "Backend",
				options: [
					{ value: "off", label: "Off" },
					{ value: "local", label: "Local summary pipeline" },
					{ value: "mnemopi", label: "Mnemopi (SQLite)" },
					{ value: "hindsight", label: "Hindsight (remote)" },
				],
			},
		],
	},
	{
		title: "Session",
		fields: [
			{ key: "autoResume", label: "Resume the most recent session automatically" },
			{ key: "advisor.enabled", label: "Pair an advisor model that reviews each turn" },
			{ key: "prewalk.enabled", label: "Prewalk the workspace on start" },
		],
	},
	{
		title: "System",
		fields: [
			{ key: "git.enabled", label: "Git integration" },
			{ key: "shellPath", label: "Shell used for the bash tool" },
			{
				key: "power.sleepPrevention",
				label: "Prevent sleep while working",
				/*
				 * All four, in the agent's own order — `idle` is the default, and
				 * leaving it out made the picker show "Off" for a machine that was in
				 * fact preventing idle sleep. The levels are cumulative, so the labels
				 * say what each one adds rather than naming a subsystem.
				 */
				options: [
					{ value: "off", label: "Off" },
					{ value: "idle", label: "Prevent idle sleep" },
					{ value: "display", label: "Prevent display sleep" },
					{ value: "system", label: "Prevent system sleep" },
				],
			},
		],
	},
];

/** Every key the settings screen touches, for a single filtered read. */
export const CURATED_KEYS: readonly string[] = SETTING_GROUPS.flatMap(group => group.fields.map(field => field.key));
