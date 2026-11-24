/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Interactive-TUI presentation of a running Bedrock AWS SSO refresh command
 * (`session/aws-auth-refresh`): one live transcript block with the command, its
 * latest output (`aws sso login` prints the verification URL and code there),
 * and the outcome; the block settles once the command finishes.
 */
import { signal } from "@oh-my-pi/pi-tui";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { AwsAuthRefreshPresenter } from "../session/aws-auth-refresh";
import { AnsiText } from "../ui/transcript/ansi-text";
import { PREVIEW_LIMITS } from "../utils/render-utils";
import { replaceTabs } from "../utils/text-width";
import type { InteractiveModeContext } from "./types";

/**
 * Raw output retained for display. `aws sso login` prints a few lines with a
 * sub-kilobyte verification URL; the cap bounds memory and per-chunk work when
 * a command is noisy while it waits for the browser.
 */
const RETAINED_OUTPUT_CHARS = 8_000;

export function createAwsAuthRefreshPresenter(
	ctx: Pick<InteractiveModeContext, "present" | "shell">,
): AwsAuthRefreshPresenter {
	return command => {
		const theme = currentTheme();
		const status = signal(theme.fg("accent", `Refreshing AWS SSO sign-in: ${replaceTabs(sanitizeText(command))}`));
		const output = signal("");
		const block = ctx.present(
			() => (
				<col>
					{() => <AnsiText text={status()} padX={1} />}
					{() => <AnsiText text={output()} padX={1} />}
				</col>
			),
			{ live: true },
		);
		let text = "";
		return {
			output: chunk => {
				text += chunk;
				if (text.length > RETAINED_OUTPUT_CHARS) {
					text = text.slice(-RETAINED_OUTPUT_CHARS);
					// Drop the line the cut landed in, so no URL or escape sequence shows half.
					const newline = text.indexOf("\n");
					if (newline !== -1) text = text.slice(newline + 1);
				}
				// Lines stay whole (wrapped, not truncated): the verification URL must survive copy.
				const lines = sanitizeText(text)
					.replace(/\r\n?/g, "\n")
					.split("\n")
					.map(line => replaceTabs(line).trimEnd())
					.filter(line => line.length > 0)
					.slice(-PREVIEW_LIMITS.OUTPUT_EXPANDED);
				output.set(currentTheme().fg("muted", lines.join("\n")));
			},
			finish: error => {
				const theme = currentTheme();
				status.set(
					error
						? theme.fg(
								"error",
								`${theme.symbols.symbol("status.error")} AWS SSO refresh failed: ${replaceTabs(sanitizeText(error))}`,
							)
						: theme.fg(
								"success",
								`${theme.symbols.symbol("status.success")} AWS SSO sign-in refreshed; retrying the request`,
							),
				);
				ctx.shell.transcript.settle(block);
			},
		};
	};
}
