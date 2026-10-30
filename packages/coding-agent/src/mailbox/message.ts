import { escapeXmlAttribute, prompt } from "@oh-my-pi/pi-utils";
import sessionPokeTemplate from "../prompts/session/session-poke.md" with { type: "text" };
import type { SessionMail } from "./types";

export const SESSION_POKE_MESSAGE_TYPE = "session-poke";

/** How the mail reached the session: a process that had it open, or one resumed headless to deliver it. */
export type MailDeliveryVia = "live" | "headless";

/** Details persisted on the transcript entry; `mailId` is how a delivery is confirmed in the session file. */
export interface MailMessageDetails {
	mailId: string;
	kind: SessionMail["kind"];
	via: MailDeliveryVia;
}

/** `Wed 2026-10-22 08:00 EDT`, local time. */
function formatWallClock(ms: number): string {
	const parts = new Intl.DateTimeFormat("en-US", {
		weekday: "short",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
		timeZoneName: "short",
	}).formatToParts(new Date(ms));
	const get = (type: Intl.DateTimeFormatPartTypes): string => parts.find(part => part.type === type)?.value ?? "";
	return `${get("weekday")} ${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} ${get("timeZoneName")}`;
}

/**
 * Render the model-visible message for one mail. The "now" line is computed
 * here, at injection time, so held mail never carries a stale clock.
 */
export function renderMail(mail: SessionMail, now: number): string {
	return prompt.render(sessionPokeTemplate, {
		from: escapeXmlAttribute(mail.poke.from),
		sent: formatWallClock(Date.parse(mail.createdAt)),
		// Untrusted text must not close the wrapper it is placed in.
		text: mail.poke.text.replaceAll("</session-poke", "<\\/session-poke"),
		now: formatWallClock(now),
	});
}
