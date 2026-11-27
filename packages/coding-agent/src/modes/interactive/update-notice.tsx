/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The "new version available" notice: natively a download notice row; a text
 * terminal draws it boxed by warning rules (`Update Available`, then the
 * command to run).
 */
import type { JSXNode } from "@oh-my-pi/pi-tui";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { bold } from "@oh-my-pi/pi-tui/theme/theme";
import { AnsiText } from "../../ui/transcript/ansi-text";
import { Notice } from "../../ui/transcript/messages/notices";

const UPDATE_COMMAND = "omp update";

export function UpdateNotice(props: { readonly version: string }): JSXNode {
	const prefix = `New version ${props.version} is available. Run: `;
	const theme = currentTheme();
	const title = bold(theme.fg("warning", "Update Available"));
	const rule = (): JSXNode => (
		<canvas paint={width => [theme.fg("warning", theme.symbols.box.horizontal.repeat(width))]} />
	);
	return (
		<Notice
			tone="info"
			icon="download"
			message={[
				{ t: "Update available", s: "strong" },
				{ t: ` · New version ${props.version} is available. Run ` },
				{ t: UPDATE_COMMAND, s: "code" },
			]}
			terminal={
				<col>
					{rule()}
					<AnsiText
						text={`${title}\n${theme.fg("muted", prefix)}${theme.fg("accent", UPDATE_COMMAND)}`}
						padX={1}
					/>
					{rule()}
				</col>
			}
		/>
	);
}
