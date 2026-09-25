import { createShellRenderer, type BashToolDetails } from "./bash";

export interface PowerShellRenderArgs {
	command?: string;
	host?: "session" | "ephemeral" | "new-session";
}

export interface PowerShellToolDetails extends BashToolDetails {
	host?: "session" | "ephemeral" | "new-session";
	pid?: number;
	execId?: number;
	hadErrors?: boolean;
}

export const powershellToolRenderer = createShellRenderer<PowerShellRenderArgs>({
	resolveTitle: args => (args?.host && args.host !== "session" ? `PowerShell · ${args.host}` : "PowerShell"),
	resolveCommand: args => args?.command,
	commandLanguage: "powershell",
	commandPrefix: "PS>",
});
