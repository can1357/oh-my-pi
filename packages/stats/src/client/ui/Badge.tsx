import type { ReactNode } from "react";

export type Tone = "neutral" | "ok" | "warn" | "bad" | "accent";

/** Pill label; status badges always carry a word, never color alone. */
export function Badge({ tone = "neutral", mono, children }: { tone?: Tone; mono?: boolean; children: ReactNode }) {
	return (
		<span className="badge" data-tone={tone} data-mono={mono ?? false}>
			{children}
		</span>
	);
}

/** Round status dot; `pulse` for things happening right now. */
export function Dot({ tone = "neutral", pulse }: { tone?: Tone | "live"; pulse?: boolean }) {
	return <span className="dot" data-tone={tone} data-pulse={pulse ?? false} />;
}

/** Color square matching a chart series. */
export function Swatch({ color }: { color: string }) {
	return <span className="swatch" style={{ background: color }} />;
}

/** Badge tone for an error rate (fraction). */
export function errorRateTone(rate: number): Tone {
	if (rate >= 0.05) return "bad";
	if (rate >= 0.01) return "warn";
	return "ok";
}
