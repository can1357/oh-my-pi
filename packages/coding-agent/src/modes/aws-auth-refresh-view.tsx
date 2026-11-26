/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Interactive-TUI presentation of a Bedrock AWS SSO sign-in
 * (`session/aws-auth-refresh`): one live transcript block with the session,
 * the verification URL (opened in the browser, shown whole for copying), the
 * latest progress, and the outcome; the block settles once the sign-in ends.
 */
import { signal } from "@oh-my-pi/pi-tui";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { AwsAuthRefreshPresenter } from "../session/aws-auth-refresh";
import { AnsiText } from "../ui/transcript/ansi-text";
import { openPath } from "../utils/open";
import { replaceTabs } from "../utils/text-width";
import type { InteractiveModeContext } from "./types";

const clean = (text: string): string => replaceTabs(sanitizeText(text));

export function createAwsAuthRefreshPresenter(
	ctx: Pick<InteractiveModeContext, "present" | "shell">,
): AwsAuthRefreshPresenter {
	return sso => {
		const theme = currentTheme();
		const status = signal(theme.fg("accent", `Signing in to AWS SSO: ${clean(sso.sessionName ?? sso.startUrl)}`));
		const detail = signal("");
		const progress = signal("");
		const block = ctx.present(
			() => (
				<col>
					{() => <AnsiText text={status()} padX={1} />}
					{() => <AnsiText text={detail()} padX={1} />}
					{() => <AnsiText text={progress()} padX={1} />}
				</col>
			),
			{ live: true },
		);
		return {
			onAuth: info => {
				openPath(info.url);
				const theme = currentTheme();
				// Wrapped, never truncated: the URL must survive copying.
				const lines = [info.instructions ? clean(info.instructions) : "", theme.fg("accent", clean(info.url))];
				detail.set(lines.filter(line => line.length > 0).join("\n"));
			},
			onProgress: message => progress.set(currentTheme().fg("muted", clean(message))),
			finish: error => {
				const theme = currentTheme();
				progress.set("");
				status.set(
					error
						? theme.fg("error", `${theme.symbols.symbol("status.error")} AWS SSO sign-in failed: ${clean(error)}`)
						: theme.fg(
								"success",
								`${theme.symbols.symbol("status.success")} AWS SSO sign-in renewed; retrying the request`,
							),
				);
				ctx.shell.transcript.settle(block);
			},
		};
	};
}
