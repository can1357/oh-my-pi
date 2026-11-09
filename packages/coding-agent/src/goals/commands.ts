export type GoalSubcommand = "set" | "show" | "pause" | "resume" | "drop" | "budget";

const GOAL_SUBCOMMANDS: Record<GoalSubcommand, true> = {
	set: true,
	show: true,
	pause: true,
	resume: true,
	drop: true,
	budget: true,
};

export function parseGoalSubcommand(args: string): {
	sub: GoalSubcommand | undefined;
	rest: string;
} {
	const trimmed = args.trim();
	if (!trimmed) return { sub: undefined, rest: "" };
	const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
	if (!match) return { sub: undefined, rest: trimmed };
	const first = match[1].toLowerCase();
	if (Object.hasOwn(GOAL_SUBCOMMANDS, first)) {
		return { sub: first as GoalSubcommand, rest: match[2]?.trim() ?? "" };
	}
	return { sub: undefined, rest: trimmed };
}

export function parseGoalBudget(raw: string): number | undefined {
	const trimmed = raw.trim();
	if (trimmed.toLowerCase() === "off") return undefined;
	if (/^\d+$/.test(trimmed)) {
		const budget = Number(trimmed);
		if (Number.isInteger(budget) && budget > 0) return budget;
	}
	throw new Error("Usage: /goal budget <positive integer|off>");
}
