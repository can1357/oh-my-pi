import type { Theme } from "../theme";
import type { SeparatorDef, StatusLineSeparatorStyle } from "./types";

export function getSeparator(style: StatusLineSeparatorStyle, theme: Theme): SeparatorDef {
	switch (style) {
		case "powerline":
			return {
				left: theme.sep.powerlineLeft,
				right: theme.sep.powerlineRight,
				endCaps: {
					left: theme.sep.powerlineRight,
					right: theme.sep.powerlineLeft,
					useBgAsFg: true,
				},
			};
		case "slash": {
			const slash = theme.sep.slash.trim();
			return { left: slash, right: slash };
		}
		case "pipe": {
			const pipe = theme.sep.pipe.trim();
			return { left: pipe, right: pipe };
		}
		case "block":
			return { left: theme.sep.block, right: theme.sep.block };
		case "none":
			return { left: theme.sep.space, right: theme.sep.space };
		case "ascii":
			return { left: theme.sep.asciiLeft, right: theme.sep.asciiRight };
		// "powerline-thin" is also the fallback for unknown styles.
		default:
			return {
				left: theme.sep.powerlineThinLeft,
				right: theme.sep.powerlineThinRight,
				endCaps: {
					left: theme.sep.powerlineRight,
					right: theme.sep.powerlineLeft,
					useBgAsFg: true,
				},
			};
	}
}
