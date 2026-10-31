import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { formatCompact, formatPercent, formatTimestamp } from "../../data/formatters";
import { Badge, Card, SearchInput } from "../../ui";
import type { ContextTimeline } from "../../types";
import { ContextNotice } from "./ContextNotice";
import { CATEGORY_KEYS, CATEGORY_STYLE } from "./view-models";

export function BrowserTab({
	timeline,
	selected,
	onSelect,
	onOpenTrend,
}: {
	timeline: ContextTimeline;
	selected: number;
	onSelect: (index: number) => void;
	onOpenTrend?: (index: number) => void;
}) {
	const [query, setQuery] = useState("");
	const [category, setCategory] = useState<string | null>(null);
	const selectedRef = useRef<HTMLButtonElement | null>(null);
	useEffect(() => {
		const element = selectedRef.current;
		const rail = element?.parentElement;
		if (!element || !rail) return;
		const railRect = rail.getBoundingClientRect();
		const elementRect = element.getBoundingClientRect();
		rail.scrollTop += elementRect.top - railRect.top - rail.clientHeight / 2 + elementRect.height / 2;
	}, [selected]);
	const step = timeline.steps[selected] ?? timeline.steps.at(-1);
	const details = step?.details;
	const needle = query.trim().toLowerCase();
	const tools = (details?.toolSchemas ?? []).filter(item => item.name.toLowerCase().includes(needle));
	const skills = (details?.skills ?? []).filter(item => item.name.toLowerCase().includes(needle));
	const categories = useMemo(() => {
		if (!step?.composition) return [];
		const sum = CATEGORY_KEYS.reduce((total, key) => total + Math.max(0, step.composition![key]), 0);
		const denominator = sum > step.promptTokens ? sum : step.promptTokens;
		return CATEGORY_KEYS.map(key => ({
			key,
			...CATEGORY_STYLE[key],
			tokens: step.composition![key],
			share: denominator > 0 ? step.composition![key] / denominator : 0,
		}));
	}, [step]);
	const show = (key: string) => category === null || category === key;
	return (
		<div className="context-browser">
			<Card title="Steps">
				<div className="context-browser-steps">
					{timeline.steps.map((candidate, index) => (
						<button
							type="button"
							ref={element => {
								if (index === selected) selectedRef.current = element;
							}}
							className={index === selected ? "context-browser-step active" : "context-browser-step"}
							key={candidate.id}
							onClick={() => onSelect(index)}
						>
							<span>#{candidate.index}</span>
							<span>{formatTimestamp(candidate.timestamp)}</span>
							<strong>{formatCompact(candidate.promptTokens)}</strong>
						</button>
					))}
				</div>
			</Card>
			<Card
				title="Context details"
				description={`Step #${step?.index ?? "—"}`}
				actions={
					<div className="context-browser-actions">
						<SearchInput value={query} onChange={setQuery} placeholder="Search names" width={220} />
						{onOpenTrend && (
							<button
								type="button"
								className="btn"
								data-size="sm"
								data-variant="ghost"
								onClick={() => onOpenTrend(selected)}
							>
								Open in Trend
							</button>
						)}
					</div>
				}
			>
				{!step || !details ? (
					<ContextNotice tone="info">Details unavailable for this step.</ContextNotice>
				) : (
					<div className="context-browser-details">
						<div className="context-kind-chips context-browser-categories">
							<button
								type="button"
								className="badge"
								data-active={category === null}
								onClick={() => setCategory(null)}
							>
								All
							</button>
							{categories.map(item => (
								<button
									type="button"
									className="badge"
									data-active={category === item.key}
									key={item.key}
									onClick={() => setCategory(current => (current === item.key ? null : item.key))}
								>
									<i className="context-category-dot" style={{ background: item.color }} aria-hidden="true" />
									{item.label} {formatCompact(item.tokens)} · {formatPercent(item.share, 0)}
								</button>
							))}
						</div>
						{show("systemTools") && (
							<BrowserSection
								title="Tools"
								count={details.toolSchemas?.length ?? 0}
								omitted={details.omittedToolSchemas}
							>
								{tools.map(item => (
									<BrowserItem
										key={item.name}
										name={item.name}
										tokens={item.tokens}
										total={details.categories.systemTools}
										color={CATEGORY_STYLE.systemTools.color}
									/>
								))}
							</BrowserSection>
						)}
						{show("skills") && (
							<BrowserSection title="Skills" count={details.skills?.length ?? 0} omitted={details.omittedSkills}>
								{skills.map(item => (
									<BrowserItem
										key={item.name}
										name={item.name}
										tokens={item.tokens}
										total={details.categories.skills}
										color={CATEGORY_STYLE.skills.color}
									/>
								))}
							</BrowserSection>
						)}
						{show("systemPrompt") && (
							<BrowserSection
								title="System parts"
								count={details.systemPromptParts?.length ?? 0}
								omitted={details.systemPromptPartsOmitted}
							>
								{(details.systemPromptParts ?? []).map((tokens, index) => (
									<BrowserItem
										key={index}
										name={`part ${index}`}
										tokens={tokens}
										total={details.categories.systemPrompt}
										color={CATEGORY_STYLE.systemPrompt.color}
									/>
								))}
							</BrowserSection>
						)}
						{show("messages") && (
							<BrowserSection title="Messages" count={details.messageCount}>
								<BrowserItem
									name="messages"
									tokens={details.categories.messages}
									total={details.categories.messages}
									color={CATEGORY_STYLE.messages.color}
								/>
								<div className="context-browser-note">
									pending tokens: {formatCompact(details.pendingMessageTokens)} · context window:{" "}
									{formatCompact(details.contextWindow)}
								</div>
							</BrowserSection>
						)}
						{show("systemContext") && category === "systemContext" && (
							<BrowserSection title="System context" count={1}>
								<BrowserItem
									name="system context"
									tokens={details.categories.systemContext}
									total={details.categories.systemContext}
									color={CATEGORY_STYLE.systemContext.color}
								/>
							</BrowserSection>
						)}
						<ContextNotice>
							Names and token counts only; message/tool content is not stored in this payload.
						</ContextNotice>
					</div>
				)}
			</Card>
		</div>
	);
}

function BrowserSection({
	title,
	count,
	omitted,
	children,
}: {
	title: string;
	count: number;
	omitted?: number;
	children: ReactNode;
}) {
	return (
		<details className="context-browser-section" open>
			<summary>
				<h3>{title}</h3>
				<span>{count} entries</span>
				{omitted ? <Badge>+{omitted} omitted</Badge> : null}
			</summary>
			<div className="context-browser-list">{children}</div>
		</details>
	);
}

function BrowserItem({ name, tokens, total, color }: { name: string; tokens: number; total: number; color: string }) {
	const share = total > 0 ? tokens / total : 0;
	return (
		<div className="context-browser-item">
			<span className="mono truncate" title={name}>
				{name}
			</span>
			<span className="context-category-track" aria-hidden="true">
				<i style={{ width: `${Math.min(100, share * 100)}%`, background: color }} />
			</span>
			<b>{formatCompact(tokens)}</b>
			<small>{formatPercent(share, 0)}</small>
		</div>
	);
}
