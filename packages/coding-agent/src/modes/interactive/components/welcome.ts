import { type Component, visibleWidth } from "@oh-my-pi/pi-tui";
import { APP_NAME } from "../../../config.js";
import { theme } from "../theme/theme.js";

export interface RecentSession {
	name: string;
	timeAgo: string;
}

export interface LspServerInfo {
	name: string;
	status: "ready" | "error" | "connecting";
	fileTypes: string[];
}

/**
 * Premium welcome screen with block-based Pi logo and two-column layout.
 */
export class WelcomeComponent implements Component {
	private version: string;
	private modelName: string;
	private providerName: string;
	private recentSessions: RecentSession[];
	private lspServers: LspServerInfo[];

	constructor(
		version: string,
		modelName: string,
		providerName: string,
		recentSessions: RecentSession[] = [],
		lspServers: LspServerInfo[] = [],
	) {
		this.version = version;
		this.modelName = modelName;
		this.providerName = providerName;
		this.recentSessions = recentSessions;
		this.lspServers = lspServers;
	}

	invalidate(): void {}

	setModel(modelName: string, providerName: string): void {
		this.modelName = modelName;
		this.providerName = providerName;
	}

	setRecentSessions(sessions: RecentSession[]): void {
		this.recentSessions = sessions;
	}

	setLspServers(servers: LspServerInfo[]): void {
		this.lspServers = servers;
	}

	render(termWidth: number): string[] {
		// Box dimensions - responsive with min/max
		const minWidth = 80;
		const maxWidth = 100;
		const boxWidth = Math.max(minWidth, Math.min(termWidth - 2, maxWidth));
		const leftCol = 26;
		const rightCol = boxWidth - leftCol - 3; // 3 = │ + │ + │

		// Block-based Pi logo (gradient: magenta → cyan)
		// biome-ignore format: preserve ASCII art layout
		const piLogo = ["▀████████████▀", " ╘███    ███  ", "  ███    ███  ", "  ███    ███  ", " ▄███▄  ▄███▄ "];

		// Apply gradient to logo
		const logoColored = piLogo.map((line) => this.gradientLine(line));

		// Left column - centered content
		const leftLines = [
			"",
			this.centerText(theme.bold("Welcome back!"), leftCol),
			"",
			...logoColored.map((l) => this.centerText(l, leftCol)),
			"",
			this.centerText(theme.fg("muted", this.modelName), leftCol),
			this.centerText(theme.fg("borderMuted", this.providerName), leftCol),
		];

		// Right column separator
		const separatorWidth = rightCol - 2; // padding on each side
		const separator = ` ${theme.fg("dim", "─".repeat(separatorWidth))}`;

		// Recent sessions content
		const sessionLines: string[] = [];
		if (this.recentSessions.length === 0) {
			sessionLines.push(` ${theme.fg("dim", "No recent sessions")}`);
		} else {
			for (const session of this.recentSessions.slice(0, 3)) {
				sessionLines.push(
					` ${theme.fg("dim", "▪ ")}${theme.fg("muted", session.name)}${theme.fg("dim", ` (${session.timeAgo})`)}`,
				);
			}
		}

		// LSP servers content
		const lspLines: string[] = [];
		if (this.lspServers.length === 0) {
			lspLines.push(` ${theme.fg("dim", "No LSP servers")}`);
		} else {
			for (const server of this.lspServers) {
				const icon =
					server.status === "ready"
						? theme.fg("success", "●")
						: server.status === "connecting"
							? theme.fg("warning", "○")
							: theme.fg("error", "●");
				const exts = server.fileTypes.slice(0, 3).join(" ");
				lspLines.push(` ${icon} ${theme.fg("muted", server.name)} ${theme.fg("dim", exts)}`);
			}
		}

		// Right column
		const rightLines = [
			` ${theme.bold(theme.fg("accent", "Tips"))}`,
			` ${theme.fg("dim", "?")}${theme.fg("muted", " for keyboard shortcuts")}`,
			` ${theme.fg("dim", "/")}${theme.fg("muted", " for commands")}`,
			` ${theme.fg("dim", "!")}${theme.fg("muted", " to run bash")}`,
			separator,
			` ${theme.bold(theme.fg("accent", "LSP Servers"))}`,
			...lspLines,
			separator,
			` ${theme.bold(theme.fg("accent", "Recent sessions"))}`,
			...sessionLines,
			"",
		];

		// Border characters (dim)
		const h = theme.fg("dim", "─");
		const v = theme.fg("dim", "│");
		const tl = theme.fg("dim", "╭");
		const tr = theme.fg("dim", "╮");
		const bl = theme.fg("dim", "╰");
		const br = theme.fg("dim", "╯");

		const lines: string[] = [];

		// Top border with embedded title
		const title = ` ${APP_NAME} v${this.version} `;
		const titleStyled = theme.fg("dim", "───") + theme.fg("muted", title);
		const titleVisLen = 3 + title.length;
		const afterTitle = boxWidth - 2 - titleVisLen;
		lines.push(tl + titleStyled + h.repeat(Math.max(0, afterTitle)) + tr);

		// Content rows
		const maxRows = Math.max(leftLines.length, rightLines.length);
		for (let i = 0; i < maxRows; i++) {
			const left = this.fitToWidth(leftLines[i] ?? "", leftCol);
			const right = this.fitToWidth(rightLines[i] ?? "", rightCol);
			lines.push(v + left + v + right + v);
		}

		// Bottom border
		lines.push(bl + h.repeat(leftCol) + theme.fg("dim", "┴") + h.repeat(rightCol) + br);

		return lines;
	}

	/** Center text within a given width */
	private centerText(text: string, width: number): string {
		const visLen = visibleWidth(text);
		if (visLen >= width) return text;
		const leftPad = Math.floor((width - visLen) / 2);
		const rightPad = width - visLen - leftPad;
		return " ".repeat(leftPad) + text + " ".repeat(rightPad);
	}

	/** Apply magenta→cyan gradient to a string */
	private gradientLine(line: string): string {
		const colors = [
			"\x1b[38;5;199m", // bright magenta
			"\x1b[38;5;171m", // magenta-purple
			"\x1b[38;5;135m", // purple
			"\x1b[38;5;99m", // purple-blue
			"\x1b[38;5;75m", // cyan-blue
			"\x1b[38;5;51m", // bright cyan
		];
		const reset = "\x1b[0m";

		let result = "";
		let colorIdx = 0;
		const step = Math.max(1, Math.floor(line.length / colors.length));

		for (let i = 0; i < line.length; i++) {
			if (i > 0 && i % step === 0 && colorIdx < colors.length - 1) {
				colorIdx++;
			}
			const char = line[i];
			if (char !== " ") {
				result += colors[colorIdx] + char + reset;
			} else {
				result += char;
			}
		}
		return result;
	}

	/** Fit string to exact width with ANSI-aware truncation/padding */
	private fitToWidth(str: string, width: number): string {
		const visLen = visibleWidth(str);
		if (visLen > width) {
			let truncated = "";
			let currentWidth = 0;
			let inEscape = false;
			for (const char of str) {
				if (char === "\x1b") inEscape = true;
				if (inEscape) {
					truncated += char;
					if (char === "m") inEscape = false;
				} else if (currentWidth < width - 1) {
					truncated += char;
					currentWidth++;
				}
			}
			return `${truncated}…`;
		}
		return str + " ".repeat(width - visLen);
	}
}
