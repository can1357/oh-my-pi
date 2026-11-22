/**
 * Interactive-TUI presentation of a running Bedrock AWS SSO refresh command
 * (`session/aws-auth-refresh`): one transcript block with the command, its
 * latest output (`aws sso login` prints the verification URL and code there),
 * and the outcome.
 */
import { replaceTabs, Text } from "@oh-my-pi/pi-tui";
import { TranscriptBlock } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { PREVIEW_LIMITS } from "@oh-my-pi/pi-tui/render/render-utils";
import { theme } from "@oh-my-pi/pi-tui/theme";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { AwsAuthRefreshPresenter } from "../session/aws-auth-refresh";
import type { InteractiveModeContext } from "./types";

export function createAwsAuthRefreshPresenter(
	ctx: Pick<InteractiveModeContext, "present" | "ui">,
): AwsAuthRefreshPresenter {
	return command => {
		const block = new TranscriptBlock();
		const status = new Text(
			theme.fg("accent", `Refreshing AWS SSO sign-in: ${replaceTabs(sanitizeText(command))}`),
			1,
			0,
		);
		const output = new Text("", 1, 0);
		block.addChild(status);
		block.addChild(output);
		ctx.present(block);
		let text = "";
		return {
			output: chunk => {
				text += chunk;
				// Lines stay whole (wrapped, not truncated): the verification URL must survive copy.
				const lines = sanitizeText(text)
					.replace(/\r\n?/g, "\n")
					.split("\n")
					.map(line => replaceTabs(line).trimEnd())
					.filter(line => line.length > 0)
					.slice(-PREVIEW_LIMITS.OUTPUT_EXPANDED);
				output.setText(theme.fg("muted", lines.join("\n")));
				ctx.ui.requestRender();
			},
			finish: error => {
				status.setText(
					error
						? theme.fg(
								"error",
								`${theme.status.error} AWS SSO refresh failed: ${replaceTabs(sanitizeText(error))}`,
							)
						: theme.fg("success", `${theme.status.success} AWS SSO sign-in refreshed; retrying the request`),
				);
				ctx.ui.requestRender();
			},
		};
	};
}
