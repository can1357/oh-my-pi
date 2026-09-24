import { common as enCommon } from "./en/common";
import { browserRelay as enBrowserRelay } from "./en/browser-relay";
import { codingAgent as enCodingAgent } from "./en/coding-agent";
import { collab as enCollab } from "./en/collab";
import { metaharness as enMetaharness } from "./en/metaharness";
import { stats as enStats } from "./en/stats";
import { tui as enTui } from "./en/tui";
import { browserRelay as zhBrowserRelay } from "./zh-CN/browser-relay";
import { codingAgent as zhCodingAgent } from "./zh-CN/coding-agent";
import { collab as zhCollab } from "./zh-CN/collab";
import { metaharness as zhMetaharness } from "./zh-CN/metaharness";
import { stats as zhStats } from "./zh-CN/stats";
import { tui as zhTui } from "./zh-CN/tui";
import { common as zhCommon } from "./zh-CN/common";

export const EN_MESSAGES = {
	browserRelay: enBrowserRelay,
	codingAgent: enCodingAgent,
	common: enCommon,
	collab: enCollab,
	metaharness: enMetaharness,
	stats: enStats,
	tui: enTui,
} as const;

type Localized<T> = T extends string
	? string
	: T extends Readonly<Record<string, unknown>>
		? { readonly [K in keyof T]: Localized<T[K]> }
		: never;

export const ZH_CN_MESSAGES = {
	browserRelay: zhBrowserRelay,
	codingAgent: zhCodingAgent,
	common: zhCommon,
	collab: zhCollab,
	metaharness: zhMetaharness,
	stats: zhStats,
	tui: zhTui,
} satisfies Localized<typeof EN_MESSAGES>;

export type Messages = typeof EN_MESSAGES;
export type MessageValue = string | Readonly<Record<string, string>>;

type MessageKeys<T> = {
	[K in keyof T & string]: T[K] extends string
		? K
		: T[K] extends { readonly other: string }
			? K
			: T[K] extends Readonly<Record<string, unknown>>
				? `${K}.${MessageKeys<T[K]>}`
				: never;
}[keyof T & string];

export type MessageKey = MessageKeys<Messages>;
