import { toolIntentLabel } from "@oh-my-pi/pi-wire";

/** A job's compact display name, never interpreting a command or a manually supplied label as intent. */
export function jobDisplayLabel(job: { intent?: string; label: string }): string {
	return job.intent ? toolIntentLabel(job.intent) : job.label;
}
