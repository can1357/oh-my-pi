import { createShellRenderer, type BashToolDetails, type ShellIdentity } from "./bash";

export interface PowerShellRenderArgs {
	command?: string;
	host?: "session" | "ephemeral" | "new-session";
	edition?: "pwsh" | "powershell";
}

export interface PowerShellToolDetails extends BashToolDetails {
	host?: "session" | "ephemeral" | "new-session";
	pid?: number;
	execId?: number;
	hadErrors?: boolean;
}

/**
 * The two editions run in independent pooled hosts and can be used side by
 * side in one session, so each card names its edition and wears that
 * edition's logo color (theme tokens `toolPowerShell` / `toolWindowsPowerShell`).
 * The call's own `edition` wins; a call that omitted it is known from the
 * result. Before then, `pwsh` is assumed, which is the stock default.
 */
const EDITIONS = {
	pwsh: { title: "PowerShell", identity: { icon: "tool.pwsh", color: "toolPowerShell" } },
	powershell: { title: "Windows PowerShell", identity: { icon: "tool.powershell", color: "toolWindowsPowerShell" } },
} as const satisfies Record<string, { title: string; identity: ShellIdentity }>;

function editionOf(args: PowerShellRenderArgs | undefined, details: BashToolDetails | undefined) {
	return EDITIONS[args?.edition ?? details?.edition ?? "pwsh"];
}

export const powershellToolRenderer = createShellRenderer<PowerShellRenderArgs>({
	resolveTitle: (args, _options, details) => {
		const { title } = editionOf(args, details);
		return args?.host && args.host !== "session" ? `${title} · ${args.host}` : title;
	},
	resolveCommand: args => args?.command,
	commandLanguage: "powershell",
	commandPrefix: "PS>",
	resolveIdentity: (args, details) => editionOf(args, details).identity,
});
