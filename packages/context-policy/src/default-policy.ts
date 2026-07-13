import defaultPolicyJson from "../policy/default-policy.v1.json" with { type: "json" };
import type { ContextCategory, ContextRetentionPolicy } from "./types";

export const DEFAULT_CONTEXT_POLICY = defaultPolicyJson as ContextRetentionPolicy;

export interface RetentionSchedule {
	expiresAt?: string;
	transitionToColdAt?: string;
}

export interface RetentionOptions {
	caseClosedAt?: string | Date;
}

export function calculateRetention(
	category: ContextCategory,
	createdAt: string | Date,
	options: RetentionOptions = {},
): RetentionSchedule {
	const rule = DEFAULT_CONTEXT_POLICY.categories[category];
	const created = parseDate(createdAt, "createdAt");
	const transitionToColdAt = rule.coldAfterDays === undefined ? undefined : addDays(created, rule.coldAfterDays);

	if (rule.ttlDays !== undefined) {
		return { expiresAt: addDays(created, rule.ttlDays), transitionToColdAt };
	}
	if (
		rule.ttlMode === "case_closed_plus_days" &&
		rule.daysAfterClose !== undefined &&
		options.caseClosedAt !== undefined
	) {
		return {
			expiresAt: addDays(parseDate(options.caseClosedAt, "caseClosedAt"), rule.daysAfterClose),
			transitionToColdAt,
		};
	}
	return { transitionToColdAt };
}

function parseDate(value: string | Date, name: string): Date {
	const date = value instanceof Date ? new Date(value) : new Date(value);
	if (Number.isNaN(date.getTime())) throw new Error(`${name} must be a valid date`);
	return date;
}

function addDays(date: Date, days: number): string {
	const result = new Date(date);
	result.setUTCDate(result.getUTCDate() + days);
	return result.toISOString();
}
