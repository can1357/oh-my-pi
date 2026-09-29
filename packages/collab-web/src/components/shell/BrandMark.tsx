import type { ReactNode } from "react";
import { useId } from "react";

/** The omp π glyph (same path as public/favicon.svg), stroked in the brand gradient. */
export function BrandMark({ size = 18, tile = false }: { size?: number; tile?: boolean }): ReactNode {
	const id = useId();
	return (
		<svg
			className={tile ? "sh-mark sh-mark--tile" : "sh-mark"}
			width={size}
			height={size}
			viewBox={tile ? "0 0 64 64" : "12 14 40 44"}
			aria-hidden="true"
		>
			<defs>
				<linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
					<stop offset="0" stopColor="var(--brand-pink)" />
					<stop offset=".5" stopColor="var(--brand-violet)" />
					<stop offset="1" stopColor="var(--brand-cyan)" />
				</linearGradient>
			</defs>
			{tile && <rect width="64" height="64" rx="14" className="sh-mark-tile" />}
			<path fill={`url(#${id})`} d="M14 16h36v8H40v32h-8V24h-6v22h-8V24h-4z" />
		</svg>
	);
}
