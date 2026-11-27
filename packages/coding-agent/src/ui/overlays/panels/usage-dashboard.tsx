/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * `/usage`: a toolbar (Overview/Details tabs, report freshness, Refresh),
 * then the Overview — headline figures, one row per provider with quotas,
 * footnotes naming the rest, a year of daily activity — or Details, the
 * per-provider limit tables; Close at the foot.
 *
 * The terminal draws its own boxed sheet from the same model
 * (`styles/panels/usage-dashboard.ts`): provider cards in columns, a
 * width-fitted calendar, the classic report under Details.
 */
import { resolveUsedFraction, type UsageReport } from "@oh-my-pi/pi-ai";
import { type JSXNode, untrack } from "@oh-my-pi/pi-tui";
import { formatDuration } from "@oh-my-pi/pi-utils";
import type { TspSpan, TspTableColumn, TspText, TspTone } from "@oh-my-pi/pi-wire";
import { sanitizeDisplayLine } from "../../../extensibility/inventory/display-text";
import { formatAiuCredits } from "../../../session/aiu-billing";
import {
	collapseSharedUsageReports,
	formatLimitTitle,
	summarizeUsageResetCredits,
} from "../../../session/usage-display";
import "../../styles/panels/usage-dashboard";
import { rowsRole } from "../sheet";
import { ActionButton, segmentedVariant } from "./common";
import {
	type ActivityFigures,
	absoluteAmount,
	activityErrorDetail,
	activityFigures,
	activityTotals,
	addDays,
	amountText,
	bucketKey,
	buildCalendar,
	CARD_MAX_WINDOWS,
	type Calendar,
	COMPACT_COUNT,
	cardStatus,
	formatCost,
	type LimitStatus,
	localIso,
	MONTH_NAMES,
	type ProviderCard,
	pressureTone,
	type QuotaRow,
	requestsText,
	resetLabel,
	shortDate,
	type UsageDashboardModel,
} from "./usage-dashboard-model";
import { keyTitle } from "../../styles/panels/common";
import { actionKeyId, cancelKbd } from "../../keys/hints";

/** Weeks the native calendar covers (a year). */
const CALENDAR_WEEKS = 53;
const CALENDAR_ROW_LABELS = ["M", "", "W", "", "F", "", ""];

const STATUS_DOT: Readonly<Record<NonNullable<LimitStatus>, { token: string; label: string }>> = {
	exhausted: { token: "error", label: "Exhausted" },
	warning: { token: "warning", label: "Under pressure" },
	ok: { token: "success", label: "OK" },
	unknown: { token: "dim", label: "Unknown" },
};

function dim(text: string): TspSpan[] {
	return [{ s: "dim", t: text }];
}

function StatusDot(props: { readonly status: LimitStatus }): JSXNode {
	const dot = STATUS_DOT[props.status ?? "unknown"];
	return <text role="omp.usage.dot" spans={[{ s: dot.token, t: "●" }]} title={dot.label} aria={dot.label} />;
}

/** `62%` mono (toned by status) and a quiet `left`. */
function leftSpans(fraction: number, status: LimitStatus): TspSpan[] {
	const token = status === "exhausted" ? "mono error" : status === "warning" ? "mono warning" : "mono";
	return [
		{ s: token, t: `${Math.max(0, Math.round((1 - fraction) * 100))}%` },
		{ s: "dim", t: " left" },
	];
}

function meterTone(status: LimitStatus): TspTone {
	return status === "exhausted" ? "error" : status === "warning" ? "warning" : status === "ok" ? "accent" : "muted";
}

function SectionHead(props: { readonly title: string; readonly children?: JSXNode }): JSXNode {
	return (
		<row key="head" role="omp.usage.section" gap="sm" align="center">
			<text role="omp.usage.section.title" spans={[{ t: props.title }]} />
			<spacer grow={1} />
			{props.children}
		</row>
	);
}

function StatTile(props: {
	readonly id: string;
	readonly label: string;
	readonly value: TspText;
	readonly sub: TspText;
	readonly title?: string;
	readonly chart?: JSXNode;
}): JSXNode {
	return (
		<col key={props.id} role="omp.usage.stat" gap="xs" title={props.title}>
			<text role="omp.usage.stat.label" spans={[{ t: props.label }]} truncate="end" />
			<row key="figure" gap="md" align="end">
				<text role="omp.usage.stat.value" spans={props.value as TspSpan[]} truncate="end" />
				{props.chart}
			</row>
			<text role="omp.usage.stat.sub" spans={props.sub as TspSpan[]} truncate="end" />
		</col>
	);
}

function Footnote(props: {
	readonly id: string;
	readonly label: string;
	readonly cards: readonly ProviderCard[];
	readonly title?: string;
}): JSXNode {
	return (
		<row
			key={props.id}
			role="omp.usage.footnote"
			align="baseline"
			title={props.title === undefined ? undefined : sanitizeDisplayLine(props.title)}
		>
			<text role="omp.usage.footnote.k" spans={dim(props.label)} />
			<text spans={[{ t: props.cards.map(card => card.name).join(", ") }]} wrap="word" />
		</row>
	);
}

function Head(props: { readonly model: UsageDashboardModel }): JSXNode {
	const { model } = props;
	const fetchedAt = model.fetchedAt();
	let checked: JSXNode = null;
	if (model.refreshing) checked = <spinner style="dots" label={dim("Refreshing…")} />;
	else if (model.refreshError) {
		const error = sanitizeDisplayLine(model.refreshError);
		checked = <text spans={[{ s: "warning", t: `Refresh failed: ${error}` }]} truncate="end" title={error} />;
	} else if (fetchedAt) {
		checked = [
			<text spans={dim("Updated")} />,
			<elapsed age={model.now() - fetchedAt} format="short" />,
			<text spans={dim("ago")} />,
		];
	}
	return (
		<row key="head" role="omp.usage.head" gap="md" align="center">
			<tabs
				key="tabs"
				items={[
					{ id: "overview", label: "Overview" },
					{ id: "detail", label: "Details" },
				]}
				active={model.view}
				variant={segmentedVariant}
			/>
			<spacer grow={1} />
			<row key="checked" gap="xs" align="baseline" shrink={1}>
				{checked}
			</row>
			{model.options.refresh && <ActionButton id="refresh" label="Refresh" title="Refresh  r" keys={["r"]} />}
		</row>
	);
}

function Stats(props: {
	readonly model: UsageDashboardModel;
	readonly framed: readonly ProviderCard[];
	readonly calendar: Calendar | undefined;
	readonly figures: ActivityFigures | undefined;
}): JSXNode {
	const { model, framed, calendar, figures } = props;
	let tightest: { card: ProviderCard; row: QuotaRow; fraction: number } | undefined;
	for (const card of framed) {
		for (const row of card.windows) {
			if (row.fraction !== undefined && (!tightest || row.fraction > tightest.fraction))
				tightest = { card, row, fraction: row.fraction };
		}
	}
	let quota: JSXNode;
	if (tightest) {
		const where = `${sanitizeDisplayLine(tightest.row.label)} · ${tightest.card.name}`;
		const reset = tightest.row.resetMs === undefined ? undefined : resetLabel(model.nowMs, tightest.row.resetMs);
		quota = (
			<StatTile
				id="quota"
				label="Tightest quota"
				value={leftSpans(tightest.fraction, tightest.row.status)}
				sub={dim(where)}
				title={reset ? `${where} · ${reset.title}` : where}
			/>
		);
	} else {
		quota = (
			<StatTile
				id="quota"
				label="Tightest quota"
				value={dim("—")}
				sub={dim(model.cards.length > 0 ? "Every quota untouched" : "No quotas reported")}
			/>
		);
	}
	if (!figures || !calendar) {
		const sub = dim(model.activityError ? "History unavailable" : "Loading…");
		return (
			<row key="stats" role="omp.usage.stats" wrap>
				{quota}
				<StatTile id="year" label="Past year" value={dim("—")} sub={sub} />
				<StatTile id="month" label="Last 30 days" value={dim("—")} sub={sub} />
				<StatTile id="busiest" label="Busiest day" value={dim("—")} sub={sub} />
			</row>
		);
	}
	const amount = (cost: number, requests: number): TspSpan[] => [
		{ t: figures.priced ? formatCost(cost) : COMPACT_COUNT.format(requests) },
	];
	const counted = (requests: number) =>
		figures.priced ? requestsText(requests) : `request${requests === 1 ? "" : "s"}`;
	const spark =
		figures.monthCost > 0 || figures.monthRequests > 0 ? (
			<chart
				key="spark"
				kind="spark"
				token="accent"
				series={figures.month.map(day => ({
					value: figures.priced ? day.cost : day.requests,
					title: `${shortDate(day.date)} · ${formatCost(day.cost)} · ${requestsText(day.requests)}`,
				}))}
			/>
		) : undefined;
	const busiest = figures.busiest;
	return (
		<row key="stats" role="omp.usage.stats" wrap>
			{quota}
			<StatTile
				id="year"
				label="Past year"
				value={amount(calendar.totalCost, calendar.totalRequests)}
				sub={dim(counted(calendar.totalRequests))}
			/>
			<StatTile
				id="month"
				label="Last 30 days"
				value={amount(figures.monthCost, figures.monthRequests)}
				sub={dim(counted(figures.monthRequests))}
				chart={spark}
			/>
			{busiest ? (
				<StatTile
					id="busiest"
					label="Busiest day"
					value={amount(busiest.cost, busiest.requests)}
					sub={dim(
						figures.priced
							? `${shortDate(busiest.date)} · ${requestsText(busiest.requests)}`
							: `requests · ${shortDate(busiest.date)}`,
					)}
				/>
			) : (
				<StatTile id="busiest" label="Busiest day" value={dim("—")} sub={dim("No activity yet")} />
			)}
		</row>
	);
}

function QuotaWindow(props: { readonly model: UsageDashboardModel; readonly row: QuotaRow; readonly index: number }) {
	const { row } = props;
	const label: TspSpan[] = [{ t: sanitizeDisplayLine(row.label) }];
	if (row.windowTag) label.push({ s: "dim", t: ` ${sanitizeDisplayLine(row.windowTag)}` });
	const reset = row.resetMs === undefined ? undefined : resetLabel(props.model.nowMs, row.resetMs);
	return (
		<row key={`w${props.index}`} role="omp.usage.window" gap="md" align="center">
			<text role="omp.usage.label" spans={label} truncate="end" title={sanitizeDisplayLine(row.label)} />
			{row.fraction === undefined ? (
				<text
					role="omp.usage.amount"
					spans={[{ s: pressureTone(row.status) ?? "muted", t: amountText(row.amount, row.status, true) }]}
					truncate="end"
				/>
			) : (
				[
					<meter
						value={Math.min(Math.max(row.fraction, 0), 1)}
						style="bar"
						size="md"
						tone={meterTone(row.status)}
					/>,
					<text role="omp.usage.pct" spans={leftSpans(row.fraction, row.status)} />,
					reset && <text role="omp.usage.reset" spans={dim(reset.text)} title={reset.title} />,
				]
			)}
		</row>
	);
}

function Provider(props: { readonly model: UsageDashboardModel; readonly card: ProviderCard }): JSXNode {
	const { model, card } = props;
	const who: JSXNode[] = [];
	if (card.accounts > 1) who.push(<text role="omp.usage.provider.meta" spans={dim(`${card.accounts} accounts`)} />);
	if (card.resetCredits) {
		const resets = card.resetCredits;
		const details: string[] = [];
		if (resets.redeemableCount !== resets.bankedCount) details.push(`${resets.redeemableCount} usable now`);
		if (resets.soonestExpiryMs !== undefined)
			details.push(resets.soonestExpiryMs > 0 ? `expires in ${formatDuration(resets.soonestExpiryMs)}` : "expired");
		if (resets.redeemableCount === 0 && resets.unavailableReasons.length > 0)
			details.push(`unavailable: ${sanitizeDisplayLine(resets.unavailableReasons.join(" • "))}`);
		const label = `${resets.bankedCount} reset${resets.bankedCount === 1 ? "" : "s"} banked`;
		who.push(
			<text
				role="omp.usage.provider.meta"
				spans={[{ s: resets.redeemableCount > 0 ? "success" : "warning", t: label }]}
				title={details.length > 0 ? `${label} · ${details.join(" · ")}` : label}
			/>,
		);
	}
	for (const account of card.daybreakAccounts ?? []) {
		const name = sanitizeDisplayLine(account);
		who.push(
			<text
				role="omp.usage.provider.meta"
				spans={[{ s: "success", t: `Daybreak · ${name}` }]}
				truncate="middle"
				title={`Daybreak access · ${name}`}
			/>,
		);
	}
	for (const account of card.unavailableAccounts) {
		const line = `${sanitizeDisplayLine(account)}: no usage data`;
		who.push(
			<text role="omp.usage.provider.meta" spans={[{ s: "warning", t: line }]} truncate="middle" title={line} />,
		);
	}
	const hidden = card.windows.length - CARD_MAX_WINDOWS;
	return (
		<row key={card.provider} role="omp.usage.provider" gap="lg" align="start">
			<col key="who" role="omp.usage.provider.head" gap="xs">
				<row key="name" gap="sm" align="center">
					<StatusDot status={cardStatus(card)} />
					<text role="omp.usage.provider.name" spans={[{ t: card.name }]} truncate="end" title={card.name} />
				</row>
				{who}
			</col>
			<col key="windows" role="omp.usage.windows" grow={1}>
				{card.unlimited ? (
					<text role="omp.usage.none" spans={[{ s: "muted", t: "No quotas reported" }]} />
				) : (
					[
						card.windows
							.slice(0, CARD_MAX_WINDOWS)
							.map((row, index) => <QuotaWindow model={model} row={row} index={index} />),
						hidden > 0 && (
							<text
								role="omp.usage.more"
								spans={dim(`${hidden} more in Details`)}
								title={`Details lists every quota per account  ${keyTitle(actionKeyId("tui.select.confirm", "enter"))}`}
							/>
						),
					]
				)}
			</col>
		</row>
	);
}

function Heatmap(props: {
	readonly calendar: Calendar;
	readonly points: readonly { day: string; cost: number; requests: number }[];
	readonly summary: string;
}): JSXNode {
	const { calendar } = props;
	const byDay = new Map(props.points.map(point => [point.day, point]));
	const tips = calendar.cells.map((days, day) =>
		days.map((level, week) => {
			if (level === null) return null;
			const date = addDays(calendar.start, week * 7 + day);
			const point = byDay.get(localIso(date));
			if (!point || (point.cost <= 0 && point.requests <= 0)) return `${shortDate(date)} · No activity`;
			const cost = point.cost >= 100 ? `$${Math.round(point.cost)}` : `$${point.cost.toFixed(2)}`;
			return `${shortDate(date)} · ${cost} · ${point.requests} request${point.requests === 1 ? "" : "s"}`;
		}),
	);
	// A month label needs two free columns before the next one.
	const starts = calendar.monthLabels.flatMap((label, at) => (label ? [{ at, label }] : []));
	const cols = starts.filter((entry, index) => !starts[index + 1] || starts[index + 1]!.at - entry.at > 2);
	return (
		<chart
			key="heatmap"
			kind="heatmap"
			cells={calendar.cells.map(days => days.map(level => (level === null ? null : level / 4)))}
			cols={cols}
			rows={CALENDAR_ROW_LABELS}
			tips={tips}
			token="accent"
			summary={props.summary}
			size="md"
		/>
	);
}

function Activity(props: {
	readonly model: UsageDashboardModel;
	readonly calendar: Calendar | undefined;
	readonly figures: ActivityFigures | undefined;
}): JSXNode {
	const { model, calendar, figures } = props;
	let meta: JSXNode = null;
	if (model.syncing && model.activity) meta = <spinner style="dots" label={dim("Syncing")} />;
	else if (model.syncError) meta = <text role="omp.usage.section.meta" spans={dim(model.staleNote())} />;
	else if (calendar) {
		const { start, today } = calendar;
		const range = `${start.getDate()} ${MONTH_NAMES[start.getMonth()]} ${start.getFullYear()} – ${today.getDate()} ${MONTH_NAMES[today.getMonth()]} ${today.getFullYear()}`;
		meta = <text role="omp.usage.section.meta" spans={dim(range)} />;
	}
	let body: JSXNode;
	if (model.activityError) {
		const detail = activityErrorDetail(model.activityError);
		body = (
			<text
				role="omp.usage.none"
				spans={[
					{
						s: "muted",
						t: detail ? `Usage history unavailable (${detail}).` : "Usage history unavailable.",
					},
				]}
				wrap="word"
			/>
		);
	} else if (!model.activity || !calendar || !figures) {
		body = <spinner key="loading" style="dots" label={[{ s: "muted", t: "Loading usage history…" }]} />;
	} else {
		const quiet = `No activity in the last ${CALENDAR_WEEKS} weeks`;
		const summary =
			calendar.totalRequests > 0 || calendar.totalCost > 0
				? `${activityTotals(calendar)} · last ${CALENDAR_WEEKS} weeks`
				: quiet;
		const streak = `${figures.activeDays} active day${figures.activeDays === 1 ? "" : "s"} · longest streak ${figures.longestStreak} day${figures.longestStreak === 1 ? "" : "s"}`;
		body = [
			<Heatmap calendar={calendar} points={model.activity} summary={summary} />,
			<row key="foot" role="omp.usage.activity.foot" gap="md" align="center">
				<text spans={dim(figures.activeDays > 0 ? streak : quiet)} truncate="end" />
				<spacer grow={1} />
				<row key="legend" role="omp.usage.legend" gap="sm" align="center">
					<text spans={dim("Less")} />
					<chart key="scale" kind="heatmap" cells={[[0, 0.25, 0.5, 0.75, 1]]} token="accent" size="md" />
					<text spans={dim("More")} />
				</row>
			</row>,
		];
	}
	return (
		<col key="activity" role="omp.usage.activity">
			<SectionHead title="Activity">{meta}</SectionHead>
			{body}
		</col>
	);
}

function Overview(props: { readonly model: UsageDashboardModel }): JSXNode {
	const { model } = props;
	const framed: ProviderCard[] = [];
	const untouched: ProviderCard[] = [];
	const unreported: ProviderCard[] = [];
	const unmetered: ProviderCard[] = [];
	for (const card of model.cards) {
		const shown = card.windows.length > 0 || card.resetCredits !== undefined || card.daybreakAccounts !== undefined;
		if (!shown) (card.unavailableAccounts.length > 0 ? unreported : unmetered).push(card);
		else (card.idle ? untouched : framed).push(card);
	}
	const notes: JSXNode[] = [];
	if (untouched.length > 0) notes.push(<Footnote id="idle" label="Untouched" cards={untouched} />);
	if (unreported.length > 0) {
		const accounts = unreported.flatMap(card => card.unavailableAccounts.map(account => `${card.name} (${account})`));
		notes.push(
			<Footnote
				id="unreported"
				label="No usage data"
				cards={unreported}
				title={`No usage report came back for ${accounts.join(", ")}: the sign-in expired, the request failed, or the plan has no quotas`}
			/>,
		);
	}
	if (unmetered.length > 0) {
		const why = unmetered.flatMap(card => card.notes.map(note => `${card.name}: ${note}`));
		notes.push(
			<Footnote
				id="unmetered"
				label="No quotas reported"
				cards={unmetered}
				title={why.length > 0 ? why.join(" • ") : "These providers report no quota windows to track"}
			/>,
		);
	}
	const points = model.activity;
	const calendar = points ? buildCalendar(points, CALENDAR_WEEKS, model.now()) : undefined;
	const figures = points && calendar ? activityFigures(points, calendar) : undefined;
	const sessionAiu = model.options.sessionAiu;
	const sessionAiuSummary = sessionAiu ? (
		<row key="session-aiu" role="omp.usage.session-aiu" wrap>
			<StatTile
				id="session-aiu"
				label="Session AI Credits"
				value={[{ t: formatAiuCredits(sessionAiu, 4) }]}
				sub={dim(
					sessionAiu.unknownCalls > 0
						? `${sessionAiu.unknownCalls.toLocaleString()} call${sessionAiu.unknownCalls === 1 ? "" : "s"} without billing frame`
						: "Reported this session",
				)}
				title={
					sessionAiu.unknownCalls > 0
						? `Lower bound; ${sessionAiu.unknownCalls.toLocaleString()} calls without a billing frame`
						: "Server-reported session AI-credit charge"
				}
			/>
		</row>
	) : null;
	const quiet = calendar !== undefined && calendar.totalCost <= 0 && calendar.totalRequests <= 0;
	if (framed.length === 0 && quiet && !model.activityError && !model.syncError && sessionAiu === undefined) {
		return (
			<col key="empty" role="omp.usage.empty" gap="sm" align="center">
				<icon key="icon" name="gauge" />
				<text role="omp.usage.empty.title" spans={[{ t: "No usage yet" }]} />
				<text
					role="omp.usage.empty.body"
					spans={[
						{
							s: "muted",
							t: "Quotas show here once a signed-in provider reports usage, and the calendar fills in as you work.",
						},
					]}
					wrap="word"
				/>
				{notes.length > 0 && (
					<col key="footnotes" gap="xs">
						{notes}
					</col>
				)}
			</col>
		);
	}
	const accounts = framed.reduce((sum, card) => sum + card.accounts, 0);
	const meta = [`${framed.length} provider${framed.length === 1 ? "" : "s"}`];
	if (accounts > framed.length) meta.push(`${accounts} accounts`);
	return [
		<Stats key="stats" model={model} framed={framed} calendar={calendar} figures={figures} />,
		<col key="quotas" role="omp.usage.quotas">
			<SectionHead title="Quotas">
				{framed.length > 0 && (
					<text
						role="omp.usage.section.meta"
						spans={dim(meta.join(" · "))}
						title="Each quota shows the mean across a provider's accounts; it resets with the fullest one"
					/>
				)}
			</SectionHead>
			{sessionAiuSummary}
			{framed.map(card => (
				<Provider model={model} card={card} />
			))}
			{model.cards.length === 0 ? (
				<text role="omp.usage.none" spans={[{ s: "muted", t: "No usage data available." }]} wrap="word" />
			) : (
				framed.length === 0 && (
					<text role="omp.usage.none" spans={[{ s: "muted", t: "Nothing used on any quota yet." }]} wrap="word" />
				)
			)}
			{notes}
		</col>,
		<Activity model={model} calendar={calendar} figures={figures} />,
	];
}

/** Account name of a report in Details: email, account, project, else `account N`, with its org. */
function accountLabel(report: UsageReport, projectId: string | undefined, index: number): string {
	const metadata = report.metadata;
	const pick = (value: unknown) => (typeof value === "string" && value ? value : undefined);
	const identity =
		pick(metadata?.email) ??
		pick(metadata?.accountId) ??
		pick(metadata?.projectId) ??
		pick(projectId) ??
		`account ${index + 1}`;
	const org = pick(metadata?.orgName);
	return sanitizeDisplayLine(org && org !== identity ? `${identity} (${org})` : identity);
}

const LIMIT_COLUMNS: TspTableColumn[] = [
	{ id: "limit", head: "Limit", grow: 1, priority: 4 },
	{ id: "account", head: "Account", truncate: "middle", priority: 1 },
	{ id: "left", head: "Left", align: "end", priority: 3 },
	{ id: "reset", head: "Resets", align: "end", priority: 2 },
];

function DetailReport(props: { readonly model: UsageDashboardModel; readonly card: ProviderCard }): JSXNode {
	const { model, card } = props;
	const nowMs = model.nowMs;
	const reports = collapseSharedUsageReports(model.data.reports).filter(report => report.provider === card.provider);
	const unavailable = card.unavailableAccounts;
	const facts: { k: TspText; v: TspText }[] = [];
	const notes = [...new Set(reports.flatMap(report => report.notes ?? []))];
	if (notes.length > 0) facts.push({ k: [{ s: "muted", t: "Notes" }], v: sanitizeDisplayLine(notes.join(" • ")) });
	for (const [index, report] of reports.entries()) {
		const resets = summarizeUsageResetCredits(report.resetCredits, nowMs);
		if (!resets || resets.bankedCount <= 0) continue;
		const value: TspSpan[] = [
			{
				s: resets.redeemableCount > 0 ? "success" : "warning",
				t: `${resets.bankedCount} saved reset${resets.bankedCount === 1 ? "" : "s"}`,
			},
		];
		if (resets.redeemableCount !== resets.bankedCount)
			value.push({ s: "muted", t: ` · ${resets.redeemableCount} usable now` });
		if (resets.soonestExpiry) {
			const remaining = Date.parse(resets.soonestExpiry) - nowMs;
			const date = resets.soonestExpiry.slice(0, 10);
			value.push({
				s: "muted",
				t: remaining > 0 ? ` · expires in ${formatDuration(remaining)} (${date})` : ` · expired (${date})`,
			});
		}
		if (resets.redeemableCount === 0 && resets.unavailableReason)
			value.push({ s: "muted", t: ` · unavailable: ${sanitizeDisplayLine(resets.unavailableReason)}` });
		const first = report.limits[0];
		facts.push({
			k: [{ s: "muted", t: `Resets · ${accountLabel(report, first?.scope.projectId, index)}` }],
			v: value,
		});
	}
	const buckets = new Map<string, { label: string; window?: string; rows: Record<string, TspText>[] }>();
	const limitNotes = new Set<string>();
	for (const [index, report] of reports.entries()) {
		for (const limit of report.limits) {
			const label = sanitizeDisplayLine(formatLimitTitle(limit));
			const key = bucketKey(label, limit);
			let bucket = buckets.get(key);
			if (!bucket) {
				const windowLabel = limit.window?.label ?? limit.window?.id ?? limit.scope.windowId;
				const named =
					!windowLabel ||
					windowLabel.toLowerCase() === "quota window" ||
					label.toLowerCase().includes(windowLabel.toLowerCase());
				bucket = { label, window: named ? undefined : sanitizeDisplayLine(windowLabel), rows: [] };
				buckets.set(key, bucket);
			}
			const fraction = resolveUsedFraction(limit);
			const resetsAt = limit.window?.resetsAt;
			bucket.rows.push({
				account: [{ s: "muted", t: accountLabel(report, limit.scope.projectId, index) }],
				left:
					fraction === undefined
						? [
								{
									s: pressureTone(limit.status) ?? "muted",
									t: amountText(absoluteAmount([limit]), limit.status, true),
								},
							]
						: leftSpans(fraction, limit.status),
				reset:
					resetsAt !== undefined && resetsAt > nowMs
						? dim(`${limit.window?.resetLabel ?? "resets"} in ${formatDuration(resetsAt - nowMs)}`)
						: "",
			});
			for (const note of limit.notes ?? []) limitNotes.add(sanitizeDisplayLine(note));
		}
	}
	const rows: { id: string; cells: Record<string, TspText> }[] = [];
	for (const bucket of buckets.values()) {
		for (const [index, cells] of bucket.rows.entries()) {
			const limit: TspSpan[] =
				index === 0 ? [{ t: bucket.label }, ...(bucket.window ? dim(` ${bucket.window}`) : [])] : [];
			rows.push({ id: `r${rows.length}`, cells: { limit, ...cells } });
		}
	}
	return (
		<col key={card.provider} role="omp.usage.report" gap="sm">
			<row key="head" role="omp.usage.report.head" gap="sm" align="baseline">
				<StatusDot status={cardStatus(card)} />
				<text role="omp.usage.provider.name" spans={[{ t: card.name }]} truncate="end" />
				{card.accounts > 1 && <text role="omp.usage.provider.meta" spans={dim(`${card.accounts} accounts`)} />}
			</row>
			{unavailable.map(label => (
				<text spans={[{ s: "muted", t: `${sanitizeDisplayLine(label)}: no usage data` }]} wrap="word" />
			))}
			{facts.length > 0 && <kv key="facts" items={facts} layout="grid" role="omp.usage.facts" />}
			{buckets.size > 0
				? [
						<table key="limits" cols={LIMIT_COLUMNS} rows={rows} role="omp.usage.limits" />,
						[...limitNotes].map(note => <text spans={[{ s: "muted", t: note }]} wrap="word" />),
					]
				: unavailable.length === 0 && <text spans={[{ s: "muted", t: "No quotas reported" }]} truncate="end" />}
		</col>
	);
}

function Details(props: { readonly model: UsageDashboardModel }): JSXNode {
	const { model } = props;
	if (model.cards.length === 0)
		return <text role="omp.usage.none" spans={[{ s: "muted", t: "No usage data available." }]} />;
	return model.cards.map(card => <DetailReport model={model} card={card} />);
}

export function UsageDashboard(props: { readonly model: UsageDashboardModel }): JSXNode {
	const { model } = props;
	return () => {
		model.rev();
		return untrack(() => {
			const view = model.view;
			return (
				<col
					gap="lg"
					role={rowsRole("omp.usage.dashboard")}
					term={{ model, rev: untrack(model.rev) }}
					onKey={key => model.key(key.id)}
					onAction={act => {
						if (act === "refresh") void model.refresh();
						else if (act === "close") model.close();
					}}
					onSelect={(item, event) => {
						if (event.key.split("/").pop() === "tabs" && (item === "overview" || item === "detail"))
							if (item !== model.view) model.setView(item);
					}}
					onActivate={(item, event) => {
						if (event.key.split("/").pop() === "tabs" && (item === "overview" || item === "detail"))
							if (item !== model.view) model.setView(item);
					}}
				>
					<Head model={model} />
					<col key={view} role="omp.usage.body" gap="lg">
						{view === "detail" ? <Details model={model} /> : <Overview model={model} />}
					</col>
					<row key="actions" role="omp.actions" align="center" gap="sm">
						<spacer grow={1} />
						{view === "overview" ? (
							<ActionButton
								id="close"
								label="Close"
								title={`Close  ${keyTitle(actionKeyId("tui.select.cancel", "escape"))}`}
								keys={cancelKbd()}
							/>
						) : (
							<ActionButton id="close" label="Close" />
						)}
					</row>
				</col>
			);
		});
	};
}
