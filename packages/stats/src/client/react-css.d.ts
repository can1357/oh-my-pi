import "react";

declare module "react" {
	/** Custom properties (`--kind`, `--i` …) in `style` objects, which React passes through to the element. */
	interface CSSProperties {
		[property: `--${string}`]: string | number | undefined;
	}
}
