import type { AssistantMessage } from "../../types";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const QUOTA_NOTICE_PREFIX = "Usage Limit Reached\n\nYou have reached your current quota for this period.";
const QUOTA_NOTICE_RESET = /^ Your limit will reset (.+)\.$/u;
const QUOTA_RELATIVE_RESET = /^in (\d+ (?:day|hour|minute|second)s?(?:, \d+ (?:day|hour|minute|second)s?)*)$/u;
const QUOTA_ABSOLUTE_RESET = new RegExp(`^on (${MONTHS.join("|")}) (\\d{1,2}), (\\d{4}) (\\d{2}):(\\d{2}) UTC$`, "u");
const UNIT_MS: Record<string, number> = { day: 86_400_000, hour: 3_600_000, minute: 60_000, second: 1_000 };

function quotaResetDate(month: string, day: string, year: string, hours: string, minutes: string): Date | undefined {
	const monthIndex = MONTHS.indexOf(month);
	const dayNumber = Number(day);
	const yearNumber = Number(year);
	const hourNumber = Number(hours);
	const minuteNumber = Number(minutes);
	if (dayNumber < 1 || dayNumber > 31 || hourNumber > 23 || minuteNumber > 59) return undefined;
	const date = new Date(Date.UTC(2000, monthIndex, dayNumber, hourNumber, minuteNumber));
	date.setUTCFullYear(yearNumber);
	if (
		date.getUTCFullYear() !== yearNumber ||
		date.getUTCMonth() !== monthIndex ||
		date.getUTCDate() !== dayNumber ||
		date.getUTCHours() !== hourNumber ||
		date.getUTCMinutes() !== minuteNumber
	) {
		return undefined;
	}
	return date;
}

/** True while text can still become the official quota notice. */
export function isQuotaNoticePrefix(text: string): boolean {
	const normalized = text.replace(/\r\n?/gu, "\n").trimStart();
	return QUOTA_NOTICE_PREFIX.startsWith(normalized) || normalized.startsWith(QUOTA_NOTICE_PREFIX);
}

/** Parse the official Antigravity quota notice; a new reset wording still counts as exhaustion. */
export function quotaExhaustion(text: string, now = Date.now()): { resetAt?: string } | undefined {
	const notice = text.replace(/\r\n?/gu, "\n").trim();
	if (!notice.startsWith(QUOTA_NOTICE_PREFIX)) return undefined;
	const suffix = notice.slice(QUOTA_NOTICE_PREFIX.length);
	if (!suffix) return {};
	const reset = QUOTA_NOTICE_RESET.exec(suffix)?.[1];
	if (!reset) return {};
	const relative = QUOTA_RELATIVE_RESET.exec(reset)?.[1];
	if (relative) {
		let ms = 0;
		for (const [, count, unit] of relative.matchAll(/(\d+) (day|hour|minute|second)/gu)) {
			ms += Number(count) * UNIT_MS[unit!]!;
			if (!Number.isFinite(ms)) return {};
		}
		const resetAt = new Date(now + ms);
		return Number.isFinite(resetAt.getTime()) ? { resetAt: resetAt.toISOString() } : {};
	}
	const absolute = QUOTA_ABSOLUTE_RESET.exec(reset);
	if (absolute) {
		const [, month, day, year, hours, minutes] = absolute;
		const resetAt = quotaResetDate(month!, day!, year!, hours!, minutes!);
		return resetAt ? { resetAt: resetAt.toISOString() } : {};
	}
	return {};
}

/** Build the quota error from a step's visible text, if it contains the official notice. */
/** Turn a quota notice into the provider error, when the text carries one. */
export function quotaErrorFromText(text: string): Error | undefined {
	const quota = quotaExhaustion(text);
	if (!quota) return undefined;
	return new Error(`Antigravity quota exceeded${quota.resetAt ? `; reset at ${quota.resetAt}` : ""}`);
}

export function quotaError(output: AssistantMessage): Error | undefined {
	const text = output.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("");
	return quotaErrorFromText(text);
}
