/** The shortcut editor sheet: name, prompt, and the schedule fields that make a shortcut run on its own. */
import { Ellipsis, Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { Schedule, Shortcut } from "../../messages";
import { isoDate, MONTHS, nextRunLabel, parseTime, QUARTER_HOURS, WEEKDAYS } from "../schedule";
import type { PanelModel } from "../session";
import { sanitizeShortcutName } from "../storage";
import { Menu, Sheet, Toggle, useEscape, useOutsidePress } from "../ui";

/** What the editor opens with: an existing shortcut, or the seeds of a new one. */
export interface ShortcutDraft {
	existing: Shortcut | null;
	name: string;
	prompt: string;
	startUrl: string;
	/** Open with the schedule switched on (Schedule… from the slash menu). */
	scheduled: boolean;
}

type Recurrence = Schedule["kind"];
type Weekday = Extract<Schedule, { kind: "weekly" }>["weekday"];
const WEEKDAY_VALUES: readonly Weekday[] = [0, 1, 2, 3, 4, 5, 6];

const RECURRENCES: { kind: Recurrence; label: string }[] = [
	{ kind: "once", label: "Once" },
	{ kind: "daily", label: "Daily" },
	{ kind: "weekly", label: "Weekly" },
	{ kind: "monthly", label: "Monthly" },
	{ kind: "yearly", label: "Yearly" },
];

/** Time entry that takes typed 12h or 24h times and offers every quarter hour. */
function TimeField(props: { value: string; onChange(value: string): void; invalid: boolean }): ReactNode {
	const [text, setText] = useState(props.value);
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement | null>(null);
	useEffect(() => setText(props.value), [props.value]);
	useOutsidePress(ref, open, () => setOpen(false));
	useEscape(open, () => setOpen(false));
	// The quarter hour at or before what is typed; the list opens scrolled to it.
	const typed = parseTime(text) ?? "09:00";
	const nearest = `${typed.slice(0, 3)}${String(Math.floor(Number(typed.slice(3)) / 15) * 15).padStart(2, "0")}`;
	useEffect(() => {
		if (open) ref.current?.querySelector("[data-nearest]")?.scrollIntoView({ block: "center" });
	}, [open]);
	const commit = (raw: string): void => {
		const parsed = parseTime(raw);
		props.onChange(parsed ?? raw);
		if (parsed !== null) setText(parsed);
	};
	return (
		<div className="pn-time" ref={ref}>
			<input
				className={`pn-field${props.invalid ? " pn-field--invalid" : ""}`}
				value={text}
				inputMode="numeric"
				placeholder="09:00"
				aria-label="Time"
				aria-invalid={props.invalid}
				onFocus={() => setOpen(true)}
				onChange={event => setText(event.target.value)}
				onBlur={event => commit(event.target.value)}
				onKeyDown={event => {
					if (event.key !== "Enter") return;
					event.preventDefault();
					commit(event.currentTarget.value);
					setOpen(false);
				}}
			/>
			{open && (
				<div className="pn-time-list" role="listbox">
					{QUARTER_HOURS.map(option => (
						<button
							key={option}
							type="button"
							role="option"
							aria-selected={option === props.value}
							className="pn-time-option"
							data-nearest={option === nearest || undefined}
							// mousedown, not click: the input's blur must not close the list first.
							onMouseDown={event => {
								event.preventDefault();
								props.onChange(option);
								setText(option);
								setOpen(false);
							}}
						>
							{option}
						</button>
					))}
				</div>
			)}
		</div>
	);
}

/** The sheet. `onSave` receives the complete shortcut; the app writes it to storage. */
export function ShortcutSheet(props: {
	draft: ShortcutDraft;
	/** Names already taken by other shortcuts. */
	taken: readonly string[];
	models: readonly PanelModel[];
	defaultCwd: string;
	onSave(shortcut: Shortcut): void;
	onDelete(shortcut: Shortcut): void;
	onClose(): void;
}): ReactNode {
	const { draft } = props;
	const existing = draft.existing;
	const initial = existing?.schedule;
	const tomorrow = useMemo(() => isoDate(new Date(Date.now() + 86_400_000)), []);

	const [name, setName] = useState(draft.name);
	const [prompt, setPrompt] = useState(draft.prompt);
	const [startUrl, setStartUrl] = useState(draft.startUrl);
	const [scheduled, setScheduled] = useState(draft.scheduled || initial !== undefined);
	const [kind, setKind] = useState<Recurrence>(initial?.kind ?? "daily");
	const [time, setTime] = useState(initial?.time ?? "09:00");
	const [date, setDate] = useState(initial?.kind === "once" ? initial.date : tomorrow);
	const [weekday, setWeekday] = useState<Weekday>(initial?.kind === "weekly" ? initial.weekday : 1);
	const [day, setDay] = useState(initial?.kind === "monthly" || initial?.kind === "yearly" ? initial.day : 1);
	const [month, setMonth] = useState(initial?.kind === "yearly" ? initial.month : 1);
	const [model, setModel] = useState(existing?.model ?? "");
	const [cwd, setCwd] = useState(existing?.cwd ?? "");
	const [menu, setMenu] = useState(false);
	const [tried, setTried] = useState(false);

	const promptRef = useRef<HTMLTextAreaElement | null>(null);
	useEffect(() => {
		// Grow with the prompt between the sheet's 128px and 256px bounds.
		const area = promptRef.current;
		if (area === null) return;
		area.style.setProperty("height", "0px");
		area.style.setProperty("height", `${Math.max(128, Math.min(256, area.scrollHeight + 2))}px`);
	}, [prompt]);

	const validTime = parseTime(time);
	const schedule = useMemo((): Schedule | null => {
		if (validTime === null) return null;
		switch (kind) {
			case "once":
				return /^\d{4}-\d{2}-\d{2}$/.test(date) ? { kind, date, time: validTime } : null;
			case "daily":
				return { kind, time: validTime };
			case "weekly":
				return { kind, weekday, time: validTime };
			case "monthly":
				return day >= 1 && day <= 31 ? { kind, day, time: validTime } : null;
			case "yearly":
				return day >= 1 && day <= 31 && month >= 1 && month <= 12 ? { kind, month, day, time: validTime } : null;
		}
	}, [kind, date, weekday, day, month, validTime]);

	const nameError =
		name === "" ? "Give the shortcut a name" : props.taken.includes(name) ? `/${name} already exists` : null;
	const promptError = prompt.trim() === "" ? "Write the prompt this shortcut sends" : null;
	const scheduleError = scheduled && schedule === null ? "Pick a valid date and time" : null;
	const next = scheduled && schedule !== null ? nextRunLabel(schedule, Date.now()) : null;

	const save = (): void => {
		setTried(true);
		if (nameError !== null || promptError !== null || scheduleError !== null) return;
		const base: Shortcut = existing ?? { id: crypto.randomUUID(), name, prompt, uses: 0, createdAt: Date.now() };
		const saved: Shortcut = { ...base, name, prompt: prompt.trim() };
		const url = startUrl.trim();
		if (url === "") delete saved.startUrl;
		else saved.startUrl = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
		if (scheduled && schedule !== null) saved.schedule = schedule;
		else delete saved.schedule;
		// The worker owns run times: drop the stored one so it re-arms from the schedule as saved.
		delete saved.nextRunAt;
		if (model === "") delete saved.model;
		else saved.model = model;
		if (cwd.trim() === "") delete saved.cwd;
		else saved.cwd = cwd.trim();
		props.onSave(saved);
	};

	const modelOptions = useMemo(() => {
		const options = props.models.map(option => ({ value: `${option.provider}/${option.id}`, label: option.name }));
		if (model !== "" && !options.some(option => option.value === model))
			options.unshift({ value: model, label: model });
		return options;
	}, [props.models, model]);

	return (
		<Sheet
			title={existing === null ? "New shortcut" : "Edit shortcut"}
			onClose={props.onClose}
			onSubmit={save}
			footer={
				<>
					{existing !== null && (
						<span className="pn-pop-anchor pn-sheet-foot-left">
							<button
								type="button"
								className="pn-icon-btn"
								aria-label="More"
								onClick={() => setMenu(open => !open)}
							>
								<Ellipsis size={16} />
							</button>
							{menu && (
								<Menu
									className="pn-pop pn-pop--above-left"
									width={180}
									dense
									autoFocus
									onClose={() => setMenu(false)}
									entries={[
										{
											kind: "item",
											id: "delete",
											label: "Delete shortcut",
											danger: true,
											icon: <Trash2 size={14} />,
											onSelect: () => props.onDelete(existing),
										},
									]}
								/>
							)}
						</span>
					)}
					<button type="button" className="sh-btn pn-btn" onClick={props.onClose}>
						Cancel
					</button>
					<button type="button" className="sh-btn sh-btn-primary pn-btn" onClick={save}>
						Save
					</button>
				</>
			}
		>
			<label className="pn-form-row">
				<span className="pn-form-label">Name</span>
				<span className={`pn-prefixed${tried && nameError !== null ? " pn-field--invalid" : ""}`}>
					<span className="pn-prefix">/</span>
					<input
						data-autofocus
						value={name}
						placeholder="morning-triage"
						spellCheck={false}
						autoCapitalize="off"
						onChange={event => setName(sanitizeShortcutName(event.target.value))}
					/>
				</span>
				{tried && nameError !== null && <span className="pn-form-error">{nameError}</span>}
			</label>
			<label className="pn-form-row">
				<span className="pn-form-label">Prompt</span>
				<textarea
					ref={promptRef}
					className={`pn-field pn-prompt-area${tried && promptError !== null ? " pn-field--invalid" : ""}`}
					value={prompt}
					placeholder="What should omp do?"
					onChange={event => setPrompt(event.target.value)}
				/>
				{tried && promptError !== null && <span className="pn-form-error">{promptError}</span>}
			</label>
			<label className="pn-form-row">
				<span className="pn-form-label">Start from</span>
				<input
					className="pn-field"
					value={startUrl}
					placeholder="https://… (optional)"
					inputMode="url"
					spellCheck={false}
					onChange={event => setStartUrl(event.target.value)}
				/>
			</label>
			<div className="pn-form-row pn-form-row--inline">
				<span className="pn-form-label">Run on a schedule</span>
				<Toggle checked={scheduled} onChange={setScheduled} label="Run on a schedule" />
			</div>
			{scheduled && (
				<div className="pn-schedule">
					<div className="pn-schedule-grid">
						<select
							className="pn-field"
							aria-label="Repeat"
							value={kind}
							onChange={event => {
								const picked = RECURRENCES.find(option => option.kind === event.target.value);
								if (picked !== undefined) setKind(picked.kind);
							}}
						>
							{RECURRENCES.map(option => (
								<option key={option.kind} value={option.kind}>
									{option.label}
								</option>
							))}
						</select>
						{kind === "once" && (
							<input
								type="date"
								className="pn-field"
								aria-label="Date"
								value={date}
								onChange={event => setDate(event.target.value)}
							/>
						)}
						{kind === "weekly" && (
							<select
								className="pn-field"
								aria-label="Weekday"
								value={weekday}
								onChange={event => setWeekday(WEEKDAY_VALUES[event.target.selectedIndex] ?? 1)}
							>
								{WEEKDAY_VALUES.map(value => (
									<option key={value} value={value}>
										{WEEKDAYS[value]}
									</option>
								))}
							</select>
						)}
						{kind === "yearly" && (
							<select
								className="pn-field"
								aria-label="Month"
								value={month}
								onChange={event => setMonth(Number(event.target.value))}
							>
								{MONTHS.map((label, index) => (
									<option key={label} value={index + 1}>
										{label}
									</option>
								))}
							</select>
						)}
						{(kind === "monthly" || kind === "yearly") && (
							<select
								className="pn-field"
								aria-label="Day of month"
								value={day}
								onChange={event => setDay(Number(event.target.value))}
							>
								{Array.from({ length: 31 }, (_, index) => (
									<option key={index + 1} value={index + 1}>
										{index + 1}
									</option>
								))}
							</select>
						)}
						<TimeField value={time} onChange={setTime} invalid={validTime === null} />
					</div>
					<div className="pn-schedule-grid">
						<select
							className="pn-field"
							aria-label="Model"
							value={model}
							onChange={event => setModel(event.target.value)}
						>
							<option value="">Default model</option>
							{modelOptions.map(option => (
								<option key={option.value} value={option.value}>
									{option.label}
								</option>
							))}
						</select>
						<input
							className="pn-field pn-field--mono"
							aria-label="Directory"
							value={cwd}
							placeholder={props.defaultCwd}
							spellCheck={false}
							onChange={event => setCwd(event.target.value)}
						/>
					</div>
					{tried && scheduleError !== null ? (
						<span className="pn-form-error">{scheduleError}</span>
					) : (
						<span className="pn-next-run">
							{next ?? (schedule === null ? "Enter a time like 9am or 21:15" : "This time has already passed")}
						</span>
					)}
				</div>
			)}
		</Sheet>
	);
}
