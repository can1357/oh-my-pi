//! Full-screen `/usage` dashboard: a compact
//! subscriptions grid (one card per provider, worst window per quota
//! bucket) above a GitHub-style daily activity heatmap, with Enter flipping
//! into the classic per-account report scrollable in place.
//!
//! The provider fetch settles asynchronously through
//! [`Services::usage`](super::Services::usage); until then the body shows
//! a spinner and [`Panel::tick`] polls the receiver.

use std::{
	sync::Arc,
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use jiff::{Timestamp, ToSpan as _, Zoned, civil::Date, tz::TimeZone};
use omp_core::Str;
use omp_tui::{
	Component, Frame, Icon, IntoComponent as _, Key, MouseReport, PaintCtx, Props, Rect, Size, Slot,
	Style, Ui, UiContext, UiEvent, cell_width, components::hr::truncate_to_width, dom, next_slot,
};

use super::{
	Panel, PanelAnchor, PanelCx, PanelEvent,
	services::{Pending, ServiceError, UsageAccount, UsageDay, UsageReport, UsageStatus},
};
use crate::notices::{format_duration, format_number};

/// Narrowest provider card.
const CARD_MIN_WIDTH: u16 = 32;
/// Cells between card columns.
const CARD_GUTTER: u16 = 3;
/// Window rows shown per card before `+N more`.
const CARD_MAX_WINDOWS: usize = 4;
/// Fraction below which a window counts as untouched.
const IDLE_FRACTION: f64 = 0.005;
/// Border rows, the `checked … ago` row, the rule, and the hint row.
const CHROME_ROWS: u16 = 5;
/// Receiver poll cadence while the fetch is in flight.
const POLL: Duration = Duration::from_millis(100);
const LOADING: &str = "Fetching provider usage…";
const HINT_OVERVIEW: &str = "↵ details · Esc close";
const HINT_DETAIL: &str = "Esc back";
const SCROLL_HINT: &str = "↑/↓ scroll · ";
const MONTHS: [&str; 12] =
	["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_LABELS: [&str; 7] = ["M", "T", "W", "T", "F", "S", "S"];

/// What the dashboard body shows.
enum State {
	/// Waiting on the application fetch.
	Loading(Pending<UsageReport>),
	/// Settled report.
	Ready(Box<Report>),
	/// The feed failed or is unavailable.
	Failed(Str),
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum View {
	Overview,
	Detail,
}

/// Settled report plus its derived grid model.
struct Report {
	report: UsageReport,
	cards:  Arc<[Card]>,
}

/// Retained full-screen usage dashboard.
pub struct UsageDashboard {
	ui:     Ui,
	ctx:    UiContext,
	state:  State,
	view:   View,
	now_ms: u64,
	width:  u16,
	rows:   u16,
}

impl UsageDashboard {
	/// Opens the dashboard, starting the provider fetch through the host's
	/// services.
	pub fn open(cx: &PanelCx<'_>) -> Result<Self, Str> {
		let state = match cx.services.usage() {
			Ok(pending) => State::Loading(pending),
			Err(error) => State::Failed(Str::new(error.to_string())),
		};
		Ok(Self::with_state(state, cx.ui, cx.viewport.width, unix_now_ms()))
	}

	/// Builds the dashboard over an already settled report (tests, replay).
	#[must_use]
	pub fn from_report(report: UsageReport, ctx: &UiContext, width: u16, now_ms: u64) -> Self {
		Self::with_state(State::Ready(Box::new(Report::new(report))), ctx, width, now_ms)
	}

	fn with_state(state: State, ctx: &UiContext, width: u16, now_ms: u64) -> Self {
		let mut panel = Self {
			ui: Ui::from_root(dom! { <col/> }, width, ctx.clone()),
			ctx: ctx.clone(),
			state,
			view: View::Overview,
			now_ms,
			width,
			rows: 10,
		};
		panel.rebuild();
		panel
	}

	fn set_view(&mut self, view: View) {
		if self.view != view {
			self.view = view;
			self.rebuild();
		}
	}

	fn route(&mut self, event: UiEvent) -> PanelEvent {
		match event {
			UiEvent::Cancel => PanelEvent::Close,
			_ => PanelEvent::Consumed,
		}
	}

	fn checked_text(&self) -> Str {
		let State::Ready(report) = &self.state else {
			return Str::default();
		};
		match report.report.checked_at_ms {
			Some(checked) => Str::new(format!(
				"checked {} ago",
				format_duration(self.now_ms.saturating_sub(checked))
			)),
			None => Str::default(),
		}
	}

	fn rebuild(&mut self) {
		let rows = self.rows;
		let width = self.width;
		// Border, padding, and the scroll pane's bar column.
		let inner = width.saturating_sub(5).max(20);
		let checked = self.checked_text();
		let (title, body, scrollable): (&str, Box<dyn Component>, bool) = match &self.state {
			State::Loading(_) => {
				("Usage", dom! { <spinner fg=accent>{LOADING}</spinner> }.into_component(), false)
			},
			State::Failed(error) => {
				let error = error.clone();
				("Usage", dom! { <text fg=err wrap=word>{error}</text> }.into_component(), false)
			},
			State::Ready(report) => match self.view {
				View::Overview => {
					let mut overview = Overview::new(
						Arc::clone(&report.cards),
						report.report.activity.clone().into(),
						report.report.activity_note.clone(),
					);
					let height = overview.height(&self.ctx, inner);
					("Usage", Box::new(overview), height > rows)
				},
				View::Detail => {
					let detail = report.report.detail.clone();
					let lines = u16::try_from(detail.lines().count()).unwrap_or(u16::MAX);
					("Usage · Details", dom! { <md>{detail}</md> }.into_component(), lines > rows)
				},
			},
		};
		let hint = match (self.view, scrollable) {
			(View::Detail, true) => Str::new(format!("{SCROLL_HINT}{HINT_DETAIL}")),
			(View::Detail, false) => Str::new_static(HINT_DETAIL),
			(View::Overview, true) => Str::new(format!("{SCROLL_HINT}{HINT_OVERVIEW}")),
			(View::Overview, false) => Str::new_static(HINT_OVERVIEW),
		};
		let tree = dom! {
			<box border=round title={title} pad-x=1>
				<col>
					<text fg=muted truncate>{checked}</text>
					<scroll id="body" h={rows} focus>
						{body}
					</scroll>
					<hr border=round/>
					<text fg=muted truncate>{hint}</text>
				</col>
			</box>
		};
		self.ui = Ui::from_root(tree, width, self.ctx.clone());
	}
}

impl Panel for UsageDashboard {
	fn id(&self) -> &'static str {
		"usage"
	}

	fn anchor(&self) -> PanelAnchor {
		PanelAnchor::Full
	}

	fn key(&mut self, key: Key) -> PanelEvent {
		match key {
			Key::Esc | Key::Char('q') => {
				if self.view == View::Detail {
					self.set_view(View::Overview);
					PanelEvent::Consumed
				} else {
					PanelEvent::Close
				}
			},
			Key::Enter | Key::Tab | Key::Char('d') if self.view == View::Overview => {
				if matches!(self.state, State::Ready(_)) {
					self.set_view(View::Detail);
				}
				PanelEvent::Consumed
			},
			Key::Up | Key::Down | Key::PageUp | Key::PageDown | Key::Home | Key::End => {
				let event = self.ui.handle_key(key);
				self.route(event)
			},
			_ => PanelEvent::Ignored,
		}
	}

	fn mouse(&mut self, report: MouseReport) -> PanelEvent {
		let event = self
			.ui
			.handle_mouse_with_mods(report.col, report.row, report.kind, report.mods);
		self.route(event)
	}

	fn frame(&mut self, viewport: Size) -> &Frame {
		// The scroll hint depends on the row budget, so a resize in either
		// axis rebuilds; resizes are rare and the tree is small.
		let rows = viewport.height.saturating_sub(CHROME_ROWS).max(5);
		if viewport.width != self.width || rows != self.rows {
			self.width = viewport.width;
			self.rows = rows;
			self.rebuild();
		}
		self.ui.frame()
	}

	fn tick(&mut self, _now: Duration) -> bool {
		let State::Loading(pending) = &self.state else {
			return false;
		};
		let settled = match pending.try_recv() {
			Ok(Ok(report)) => State::Ready(Box::new(Report::new(report))),
			Ok(Err(error)) => State::Failed(Str::new(error.to_string())),
			Err(flume::TryRecvError::Empty) => return false,
			Err(flume::TryRecvError::Disconnected) => State::Failed(Str::new(
				ServiceError::Failed(Str::new_static("usage fetch ended without a report")).to_string(),
			)),
		};
		self.state = settled;
		self.rebuild();
		true
	}

	fn next_wake(&self) -> Option<Duration> {
		matches!(self.state, State::Loading(_)).then_some(POLL)
	}
}

impl Report {
	fn new(report: UsageReport) -> Self {
		let cards = build_cards(&report.accounts).into();
		Self { report, cards }
	}
}

fn unix_now_ms() -> u64 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.ok()
		.and_then(|elapsed| u64::try_from(elapsed.as_millis()).ok())
		.unwrap_or_default()
}

// =============================================================================
// Subscriptions grid model
// =============================================================================

/// One quota bucket row on a provider card.
#[derive(Clone, Debug, PartialEq)]
struct WindowRow {
	label:    Str,
	fraction: Option<f64>,
	status:   UsageStatus,
	reset:    Option<String>,
}

/// Compact per-provider summary backing one card.
#[derive(Clone, Debug, PartialEq)]
struct Card {
	name:      Str,
	accounts:  usize,
	windows:   Vec<WindowRow>,
	status:    UsageStatus,
	unlimited: bool,
	idle:      bool,
	error:     Option<Str>,
}

/// Card-level status from its rows: a mix of
/// healthy and pressured windows reads as a warning, not as the worst.
fn aggregate_status(windows: &[WindowRow]) -> UsageStatus {
	let has = |status| windows.iter().any(|window| window.status == status);
	if has(UsageStatus::Ok) || has(UsageStatus::Idle) {
		if has(UsageStatus::Warning) || has(UsageStatus::Exhausted) {
			UsageStatus::Warning
		} else {
			UsageStatus::Ok
		}
	} else if has(UsageStatus::Warning) {
		UsageStatus::Warning
	} else if has(UsageStatus::Exhausted) {
		UsageStatus::Exhausted
	} else {
		UsageStatus::Unknown
	}
}

/// Collapses the report's accounts into cards sorted most-pressing first;
/// fully idle providers collapse into a tick.
fn build_cards(accounts: &[UsageAccount]) -> Vec<Card> {
	let mut cards = accounts
		.iter()
		.map(|account| {
			let mut windows = account
				.windows
				.iter()
				.map(|window| WindowRow {
					label:    window.label.clone(),
					fraction: (window.status != UsageStatus::Unknown).then_some(window.fraction),
					status:   window.status,
					reset:    window
						.resets_in
						.filter(|left| !left.is_zero())
						.map(|left| format_duration(u64::try_from(left.as_millis()).unwrap_or(u64::MAX))),
				})
				.collect::<Vec<_>>();
			windows.sort_by(|a, b| {
				b.fraction
					.unwrap_or(-1.0)
					.total_cmp(&a.fraction.unwrap_or(-1.0))
			});
			let unlimited = windows.is_empty() && account.error.is_none();
			let idle = !windows.is_empty()
				&& windows.iter().all(|window| {
					window
						.fraction
						.is_some_and(|fraction| fraction < IDLE_FRACTION)
				});
			let status = if account.error.is_some() {
				UsageStatus::Unknown
			} else if unlimited {
				UsageStatus::Ok
			} else {
				aggregate_status(&windows)
			};
			Card {
				name: account.title.clone(),
				accounts: account.accounts.len(),
				windows,
				status,
				unlimited,
				idle,
				error: account.error.clone(),
			}
		})
		.collect::<Vec<_>>();
	cards.sort_by(|a, b| {
		let worst = |card: &Card| {
			card
				.windows
				.first()
				.and_then(|window| window.fraction)
				.unwrap_or(-1.0)
		};
		worst(b)
			.total_cmp(&worst(a))
			.then_with(|| a.name.cmp(&b.name))
	});
	cards
}

// =============================================================================
// Activity heatmap model
// =============================================================================

/// Week-per-column heatmap grid: 7 rows × N week
/// columns, `None` = future day, else intensity `0..=4`.
struct Heatmap {
	month_labels:   Vec<Option<&'static str>>,
	cells:          Vec<[Option<u8>; 7]>,
	total_cost:     u64,
	total_requests: u64,
}

fn utc_date(day_ms: u64) -> Option<Date> {
	Timestamp::from_millisecond(i64::try_from(day_ms).ok()?)
		.ok()
		.map(|timestamp| timestamp.to_zoned(TimeZone::UTC).date())
}

/// Lays daily activity into a Monday-first grid ending at `today`'s week
/// Intensity is square-root scaled against the
/// busiest day over cost, falling back to requests when nothing is priced.
fn build_heatmap(points: &[UsageDay], weeks: usize, today: Date) -> Heatmap {
	let any_cost = points.iter().any(|point| point.cost_nano_usd > 0);
	let metric = |point: &UsageDay| {
		if any_cost {
			point.cost_nano_usd
		} else {
			point.requests
		}
	};
	let monday_offset = i64::from(today.weekday().to_monday_zero_offset());
	let current_monday = today.checked_sub(monday_offset.days()).unwrap_or(today);
	let start = current_monday
		.checked_sub((i64::try_from(weeks).unwrap_or(1).saturating_sub(1) * 7).days())
		.unwrap_or(current_monday);
	let dated = points
		.iter()
		.filter_map(|point| utc_date(point.day_ms).map(|date| (date, *point)))
		.filter(|(date, _)| *date >= start && *date <= today)
		.collect::<Vec<_>>();
	let max = dated
		.iter()
		.map(|(_, point)| metric(point))
		.max()
		.unwrap_or(0);
	#[allow(clippy::cast_precision_loss, reason = "intensity bucketing only")]
	let level = |value: u64| -> u8 {
		if value == 0 || max == 0 {
			return 0;
		}
		let scaled = ((value as f64 / max as f64).sqrt() * 4.0).ceil();
		scaled.clamp(1.0, 4.0) as u8
	};
	let mut month_labels = Vec::with_capacity(weeks);
	let mut cells = vec![[None; 7]; weeks];
	let mut previous_month = 0_i8;
	for (week, column) in cells.iter_mut().enumerate() {
		let Some(week_start) = start
			.checked_add((i64::try_from(week).unwrap_or(0) * 7).days())
			.ok()
		else {
			month_labels.push(None);
			continue;
		};
		let month = week_start.month();
		month_labels
			.push((month != previous_month).then(|| MONTHS[usize::from(month.unsigned_abs()) - 1]));
		previous_month = month;
		for (day, cell) in column.iter_mut().enumerate() {
			let Some(date) = week_start
				.checked_add(i64::try_from(day).unwrap_or(0).days())
				.ok()
			else {
				continue;
			};
			if date > today {
				continue;
			}
			let value = dated
				.iter()
				.find(|(when, _)| *when == date)
				.map_or(0, |(_, point)| metric(point));
			*cell = Some(level(value));
		}
	}
	Heatmap {
		month_labels,
		cells,
		total_cost: dated.iter().map(|(_, point)| point.cost_nano_usd).sum(),
		total_requests: dated.iter().map(|(_, point)| point.requests).sum(),
	}
}

/// `$12` at or above one dollar, else `$0.34`.
fn format_cost(nano_usd: u64) -> String {
	let dollars = nano_usd / 1_000_000_000;
	if dollars >= 1 {
		let digits = dollars.to_string();
		let mut out = String::with_capacity(digits.len() + digits.len() / 3 + 1);
		out.push('$');
		for (index, digit) in digits.chars().enumerate() {
			if index > 0 && (digits.len() - index) % 3 == 0 {
				out.push(',');
			}
			out.push(digit);
		}
		out
	} else {
		format!("${}.{:02}", dollars, (nano_usd % 1_000_000_000) / 10_000_000)
	}
}

// =============================================================================
// Overview component
// =============================================================================

/// Theme role of one painted span.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Tone {
	Fg,
	Bold,
	Accent,
	Muted,
	Dim,
	Ok,
	Warn,
	Err,
	/// Heatmap intensity `1..=4`.
	Heat(u8),
}

fn status_tone(status: UsageStatus) -> Tone {
	match status {
		UsageStatus::Exhausted => Tone::Err,
		UsageStatus::Warning => Tone::Warn,
		UsageStatus::Ok | UsageStatus::Idle => Tone::Ok,
		UsageStatus::Unknown => Tone::Dim,
	}
}

fn status_icon(status: UsageStatus) -> Icon {
	match status {
		UsageStatus::Exhausted => Icon::Error,
		UsageStatus::Warning => Icon::WarningStatus,
		UsageStatus::Ok | UsageStatus::Idle => Icon::Success,
		UsageStatus::Unknown => Icon::InfoStatus,
	}
}

#[derive(Clone, Debug)]
struct Span {
	text: String,
	tone: Tone,
}

/// One painted overview row.
#[derive(Clone, Debug, Default)]
struct Line {
	spans: Vec<Span>,
	width: u16,
}

impl Line {
	fn push(&mut self, text: impl Into<String>, tone: Tone) {
		let text = text.into();
		self.width = self.width.saturating_add(cell_width(&text));
		self.spans.push(Span { text, tone });
	}

	fn pad_to(&mut self, width: u16) {
		if self.width < width {
			self.push(" ".repeat(usize::from(width - self.width)), Tone::Fg);
		}
	}
}

/// Cards grid plus heatmap; lines are laid out once per width.
struct Overview {
	props:  Props,
	slot:   Slot,
	cards:  Arc<[Card]>,
	points: Arc<[UsageDay]>,
	note:   Option<Str>,
	width:  u16,
	lines:  Vec<Line>,
}

impl Overview {
	fn new(cards: Arc<[Card]>, points: Arc<[UsageDay]>, note: Option<Str>) -> Self {
		Self {
			props: Props::new(),
			slot: next_slot(),
			cards,
			points,
			note,
			width: 0,
			lines: Vec::new(),
		}
	}

	fn layout(&mut self, ctx: &UiContext, width: u16) {
		if self.width == width && !self.lines.is_empty() {
			return;
		}
		self.width = width;
		self.lines.clear();
		self.cards_grid(ctx, width);
		self.lines.push(Line::default());
		self.heatmap(ctx, width);
	}

	fn card_lines(ctx: &UiContext, card: &Card, width: u16) -> Vec<Line> {
		let mut lines = Vec::with_capacity(CARD_MAX_WINDOWS + 2);
		let accounts = if card.accounts > 1 {
			format!("{} accts", card.accounts)
		} else {
			String::new()
		};
		let accounts_width = cell_width(&accounts);
		let title_budget = width
			.saturating_sub(2)
			.saturating_sub(accounts_width)
			.saturating_sub(u16::from(!accounts.is_empty()))
			.max(4);
		let title = truncate_to_width(&card.name, title_budget);
		let mut head = Line::default();
		head.push(ctx.charset.icon(status_icon(card.status)), status_tone(card.status));
		head.push(" ", Tone::Fg);
		head.push(title.text, Tone::Bold);
		if title.ellipsis {
			head.push("…", Tone::Bold);
		}
		if !accounts.is_empty() {
			head.pad_to(width.saturating_sub(accounts_width));
			head.push(accounts, Tone::Dim);
		}
		lines.push(head);

		if let Some(error) = &card.error {
			let mut line = Line::default();
			line.push("  ", Tone::Fg);
			let text = truncate_to_width(error, width.saturating_sub(2).max(1));
			line.push(text.text, Tone::Err);
			if text.ellipsis {
				line.push("…", Tone::Err);
			}
			lines.push(line);
			return lines;
		}
		if card.unlimited {
			let mut line = Line::default();
			line.push("  ", Tone::Fg);
			line.push("no limits", Tone::Dim);
			lines.push(line);
			return lines;
		}

		let visible = &card.windows[..card.windows.len().min(CARD_MAX_WINDOWS)];
		let hidden = card.windows.len().saturating_sub(CARD_MAX_WINDOWS);
		// Fixed columns across every row of the card so bars all start and
		// end at the same x: label | bar | pct | reset.
		let reset_width = visible
			.iter()
			.filter_map(|window| window.reset.as_deref().map(cell_width))
			.max()
			.unwrap_or(0);
		let label_width = width.saturating_sub(24).clamp(6, 16);
		let bar_width = width
			.saturating_sub(2)
			.saturating_sub(label_width)
			.saturating_sub(1)
			.saturating_sub(5)
			.saturating_sub(if reset_width > 0 { reset_width + 1 } else { 0 })
			.max(5);
		let (filled, empty) = ctx.charset.progress();
		for window in visible {
			let mut line = Line::default();
			line.push("  ", Tone::Fg);
			let label = truncate_to_width(&window.label, label_width);
			let mut label_text = String::with_capacity(usize::from(label_width) + 1);
			label_text.push_str(label.text);
			if label.ellipsis {
				label_text.push('…');
			}
			let label_cells = cell_width(&label_text);
			label_text
				.extend(std::iter::repeat_n(' ', usize::from(label_width.saturating_sub(label_cells))));
			line.push(label_text, Tone::Muted);
			line.push(" ", Tone::Fg);
			let Some(fraction) = window.fraction else {
				line.push("no data", Tone::Dim);
				lines.push(line);
				continue;
			};
			let clamped = fraction.clamp(0.0, 1.0);
			#[allow(clippy::cast_possible_truncation, reason = "bar_width bounds the product")]
			#[allow(clippy::cast_sign_loss, reason = "clamped to 0..=1")]
			let fill = (clamped * f64::from(bar_width)).round() as u16;
			line.push(filled.repeat(usize::from(fill)), status_tone(window.status));
			line.push(empty.repeat(usize::from(bar_width - fill)), Tone::Dim);
			#[allow(clippy::cast_possible_truncation, reason = "percent fits")]
			#[allow(clippy::cast_sign_loss, reason = "max(0) applied")]
			let free = ((1.0 - fraction) * 100.0).round().max(0.0) as u32;
			line.push(format!("{:>5}", format!("{free}%")), status_tone(window.status));
			if reset_width > 0 {
				line.push(" ", Tone::Fg);
				line.push(
					format!(
						"{:>width$}",
						window.reset.as_deref().unwrap_or(""),
						width = usize::from(reset_width)
					),
					Tone::Dim,
				);
			}
			lines.push(line);
		}
		if hidden > 0 {
			let mut line = Line::default();
			line.push("  ", Tone::Fg);
			line.push(format!("+{hidden} more"), Tone::Dim);
			lines.push(line);
		}
		lines
	}

	fn cards_grid(&mut self, ctx: &UiContext, inner: u16) {
		if self.cards.is_empty() {
			let mut line = Line::default();
			line.push("No usage data available.", Tone::Dim);
			self.lines.push(line);
			return;
		}
		let cards = Arc::clone(&self.cards);
		let active = cards.iter().filter(|card| !card.idle).collect::<Vec<_>>();
		let idle = cards.iter().filter(|card| card.idle).collect::<Vec<_>>();
		let columns = usize::from(((inner + CARD_GUTTER) / (CARD_MIN_WIDTH + CARD_GUTTER)).max(1));
		let card_width = (inner
			.saturating_sub(u16::try_from(columns - 1).unwrap_or(0) * CARD_GUTTER))
			/ u16::try_from(columns).unwrap_or(1);
		for (row_index, row) in active.chunks(columns).enumerate() {
			if row_index > 0 {
				self.lines.push(Line::default());
			}
			let rendered = row
				.iter()
				.map(|card| Self::card_lines(ctx, card, card_width))
				.collect::<Vec<_>>();
			let height = rendered.iter().map(Vec::len).max().unwrap_or(0);
			for line_index in 0..height {
				let mut line = Line::default();
				for (column, card) in rendered.iter().enumerate() {
					if column > 0 {
						line.push(" ".repeat(usize::from(CARD_GUTTER)), Tone::Fg);
					}
					let column_start = line.width;
					if let Some(source) = card.get(line_index) {
						for span in &source.spans {
							line.push(span.text.clone(), span.tone);
						}
					}
					if column + 1 < rendered.len() {
						line.pad_to(column_start.saturating_add(card_width));
					}
				}
				self.lines.push(line);
			}
		}
		// Untouched providers collapse into a single tick line: their
		// windows are all at 100% free, so per-window bars are noise.
		if !idle.is_empty() {
			if !active.is_empty() {
				self.lines.push(Line::default());
			}
			let names = idle
				.iter()
				.map(|card| card.name.as_str())
				.collect::<Vec<_>>()
				.join(" · ");
			let mut line = Line::default();
			line.push(ctx.charset.icon(Icon::Success), Tone::Ok);
			line.push(" ", Tone::Fg);
			let budget = inner.saturating_sub(line.width).max(1);
			let untouched = format!("untouched: {names}");
			let text = truncate_to_width(&untouched, budget);
			line.push(text.text, Tone::Dim);
			if text.ellipsis {
				line.push("…", Tone::Dim);
			}
			self.lines.push(line);
		}
	}

	fn heatmap(&mut self, ctx: &UiContext, inner: u16) {
		if let Some(note) = &self.note {
			let mut line = Line::default();
			line.push(note.as_str(), Tone::Dim);
			self.lines.push(line);
			return;
		}
		let label_width = 2_u16;
		let weeks = usize::from((inner.saturating_sub(label_width) / 2).clamp(4, 53));
		let layout = build_heatmap(&self.points, weeks, Zoned::now().date());
		let mut header = Line::default();
		header.push("Activity", Tone::Accent);
		header.push(" ", Tone::Fg);
		header.push(
			format!(
				"{} · {} requests · last {weeks} weeks",
				format_cost(layout.total_cost),
				format_number(layout.total_requests)
			),
			Tone::Dim,
		);
		self.lines.push(header);
		self.lines.push(Line::default());

		let mut months = " ".repeat(usize::from(label_width));
		for (week, label) in layout.month_labels.iter().enumerate() {
			let Some(label) = label else {
				continue;
			};
			let target = usize::from(label_width) + week * 2;
			if target >= cell_width(&months).into() {
				months.extend(std::iter::repeat_n(' ', target.saturating_sub(months.len())));
				months.push_str(label);
			}
		}
		let mut month_line = Line::default();
		let months = truncate_to_width(&months, inner);
		month_line.push(months.text, Tone::Dim);
		self.lines.push(month_line);

		let (block, empty) = ctx.charset.progress();
		for (day, label) in DAY_LABELS.iter().enumerate() {
			let mut line = Line::default();
			line.push(*label, Tone::Dim);
			line.push(" ", Tone::Fg);
			for column in &layout.cells {
				match column[day] {
					None => line.push("  ", Tone::Fg),
					Some(0) => {
						line.push(empty, Tone::Dim);
						line.push(" ", Tone::Fg);
					},
					Some(level) => {
						line.push(block, Tone::Heat(level));
						line.push(" ", Tone::Fg);
					},
				}
			}
			self.lines.push(line);
		}
	}
}

impl Component for Overview {
	fn props(&self) -> &Props {
		&self.props
	}

	fn props_mut(&mut self) -> &mut Props {
		&mut self.props
	}

	fn slot(&self) -> Slot {
		self.slot
	}

	fn measure(&mut self, _ctx: &UiContext) -> (u16, u16) {
		(20, u16::MAX)
	}

	fn height(&mut self, ctx: &UiContext, width: u16) -> u16 {
		self.layout(ctx, width);
		u16::try_from(self.lines.len()).unwrap_or(u16::MAX)
	}

	fn paint(&mut self, pc: &mut PaintCtx<'_>, rect: Rect) {
		self.layout(pc.ctx, rect.width);
		let theme = pc.ctx.theme;
		let style = |tone: Tone| match tone {
			Tone::Fg => Style::new().fg(theme.fg),
			Tone::Bold => Style::new().fg(theme.fg).bold(),
			Tone::Accent => Style::new().fg(theme.accent).bold(),
			Tone::Muted => Style::new().fg(theme.muted),
			Tone::Dim => Style::new().fg(theme.border),
			Tone::Ok => Style::new().fg(theme.ok),
			Tone::Warn => Style::new().fg(theme.warn),
			Tone::Err => Style::new().fg(theme.err),
			Tone::Heat(1) => Style::new().fg(theme.border),
			Tone::Heat(2) => Style::new().fg(theme.muted),
			Tone::Heat(3) => Style::new().fg(theme.info),
			Tone::Heat(_) => Style::new().fg(theme.accent),
		};
		let right = rect.x.saturating_add(rect.width);
		for (row, line) in self.lines.iter().enumerate() {
			let Some(y) = u16::try_from(row)
				.ok()
				.and_then(|row| rect.y.checked_add(row))
			else {
				break;
			};
			if y >= pc.clip {
				break;
			}
			let mut x = rect.x;
			for span in &line.spans {
				if x >= right {
					break;
				}
				x = pc.frame.put(x, y, &span.text, style(span.tone));
			}
		}
	}
}

#[cfg(test)]
mod tests {
	use std::time::Duration;

	use omp_core::sf;
	use omp_tui::{Mods, Mouse, MouseButton};

	use super::*;
	use crate::overlays::services::{ServiceResult, UsageWindow};

	const NOW_MS: u64 = 1_800_000_000_000;

	/// Today's local date as a UTC day start, the way the app keys activity.
	fn today_utc_ms() -> u64 {
		let today = Zoned::now().date();
		let ts = today
			.to_zoned(TimeZone::UTC)
			.unwrap()
			.timestamp()
			.as_millisecond();
		u64::try_from(ts).unwrap()
	}

	fn wheel_down(col: u16, row: u16) -> MouseReport {
		MouseReport {
			kind: Mouse::WheelDown,
			col,
			row,
			button: MouseButton::WheelDown,
			mods: Mods::default(),
			pressed: true,
		}
	}

	fn point(text: &str, needle: &str) -> (u16, u16) {
		text
			.lines()
			.enumerate()
			.find_map(|(row, line)| {
				let byte = line.find(needle)?;
				Some((omp_tui::cell_width(&line[..byte]), u16::try_from(row).unwrap()))
			})
			.expect("text point")
	}

	fn report() -> UsageReport {
		UsageReport {
			checked_at_ms: Some(NOW_MS - 5 * 60_000),
			accounts:      vec![
				UsageAccount {
					provider: sf!("anthropic"),
					title:    sf!("Anthropic"),
					accounts: vec![sf!("a@x"), sf!("b@x")],
					windows:  vec![
						UsageWindow {
							label:     sf!("5h"),
							fraction:  0.42,
							resets_in: Some(Duration::from_secs(3 * 3600)),
							status:    UsageStatus::Ok,
						},
						UsageWindow {
							label:     sf!("weekly"),
							fraction:  0.91,
							resets_in: Some(Duration::from_secs(2 * 86_400)),
							status:    UsageStatus::Warning,
						},
					],
					error:    None,
				},
				UsageAccount {
					provider: sf!("openai"),
					title:    sf!("OpenAI"),
					accounts: vec![sf!("c@x")],
					windows:  vec![UsageWindow {
						label:     sf!("daily"),
						fraction:  0.0,
						resets_in: None,
						status:    UsageStatus::Idle,
					}],
					error:    None,
				},
			],
			activity:      vec![UsageDay {
				day_ms:        today_utc_ms(),
				cost_nano_usd: 2_500_000_000,
				requests:      12,
			}],
			activity_note: None,
			detail:        sf!("**Usage**\n\n- `anthropic`: 42 / 100"),
		}
	}

	#[test]
	fn overview_renders_cards_heatmap_and_footer() {
		let ctx = UiContext::default();
		let mut panel = UsageDashboard::from_report(report(), &ctx, 100, NOW_MS);
		let text = omp_tui::frame_text(panel.frame(Size { width: 100, height: 30 }));
		assert!(text.contains("Usage"), "title missing:\n{text}");
		assert!(text.contains("checked 5m ago"), "checked row missing:\n{text}");
		assert!(text.contains("Anthropic"), "card title missing:\n{text}");
		assert!(text.contains("2 accts"), "account count missing:\n{text}");
		assert!(text.contains("weekly"), "worst window first:\n{text}");
		assert!(text.contains("9%"), "free percent missing:\n{text}");
		assert!(text.contains("2d"), "reset countdown missing:\n{text}");
		assert!(text.contains("untouched: OpenAI"), "idle tick line missing:\n{text}");
		assert!(text.contains("Activity"), "heatmap header missing:\n{text}");
		assert!(text.contains("$2 · 12 requests"), "activity totals missing:\n{text}");
		assert!(!text.contains("↑/↓ scroll"), "overview fits, no scroll hint:\n{text}");
		assert!(text.contains("↵ details · Esc close"), "footer missing:\n{text}");
	}

	#[test]
	fn enter_opens_detail_and_esc_walks_back_then_closes() {
		let ctx = UiContext::default();
		let mut panel = UsageDashboard::from_report(report(), &ctx, 80, NOW_MS);
		assert_eq!(panel.key(Key::Enter), PanelEvent::Consumed);
		let text = omp_tui::frame_text(panel.frame(Size { width: 80, height: 24 }));
		assert!(text.contains("Usage · Details"), "detail title missing:\n{text}");
		assert!(text.contains("anthropic"), "detail body missing:\n{text}");
		assert!(text.contains("Esc back"), "detail footer missing:\n{text}");
		assert_eq!(panel.key(Key::Esc), PanelEvent::Consumed);
		let text = omp_tui::frame_text(panel.frame(Size { width: 80, height: 24 }));
		assert!(text.contains("↵ details · Esc close"), "overview footer missing:\n{text}");
		assert_eq!(panel.key(Key::Char('q')), PanelEvent::Close);
		assert_eq!(panel.key(Key::Down), PanelEvent::Consumed);
	}

	#[test]
	fn wheel_scrolls_the_detail_report() {
		let ctx = UiContext::default();
		let mut report = report();
		report.detail =
			sf!("line 1  \nline 2  \nline 3  \nline 4  \nline 5  \nline 6  \nline 7  \nline 8");
		let mut panel = UsageDashboard::from_report(report, &ctx, 60, NOW_MS);
		assert_eq!(panel.key(Key::Enter), PanelEvent::Consumed);
		let size = Size { width: 60, height: 10 };
		let before = omp_tui::frame_text(panel.frame(size));
		let (col, row) = point(&before, "line 1");
		assert_eq!(panel.mouse(wheel_down(col, row)), PanelEvent::Consumed);
		let after = omp_tui::frame_text(panel.frame(size));
		assert_ne!(after, before, "wheel must move the details viewport");
		assert!(after.contains("line 6"), "next detail row did not enter the viewport:\n{after}");
	}

	#[test]
	fn pending_shows_loader_then_settles_on_tick() {
		let ctx = UiContext::default();
		let (tx, rx) = flume::bounded::<ServiceResult<UsageReport>>(1);
		let mut panel = UsageDashboard::with_state(State::Loading(rx), &ctx, 80, NOW_MS);
		assert_eq!(panel.next_wake(), Some(POLL));
		let text = omp_tui::frame_text(panel.frame(Size { width: 80, height: 20 }));
		assert!(text.contains(LOADING), "loader missing:\n{text}");
		assert!(!panel.tick(Duration::ZERO), "nothing settled yet");
		assert_eq!(panel.key(Key::Enter), PanelEvent::Consumed, "detail needs a report");
		tx.send(Ok(report())).unwrap();
		assert!(panel.tick(Duration::ZERO), "settling repaints");
		assert_eq!(panel.next_wake(), None);
		let text = omp_tui::frame_text(panel.frame(Size { width: 80, height: 20 }));
		assert!(text.contains("Anthropic"), "report not shown after settle:\n{text}");
	}

	#[test]
	fn failed_fetch_shows_error_with_footer() {
		let ctx = UiContext::default();
		let (tx, rx) = flume::bounded::<ServiceResult<UsageReport>>(1);
		let mut panel = UsageDashboard::with_state(State::Loading(rx), &ctx, 80, NOW_MS);
		tx.send(Err(ServiceError::Unavailable("usage"))).unwrap();
		assert!(panel.tick(Duration::ZERO));
		let text = omp_tui::frame_text(panel.frame(Size { width: 80, height: 20 }));
		assert!(text.contains("usage is unavailable in this host"), "error missing:\n{text}");
		assert!(text.contains("↵ details · Esc close"), "footer missing:\n{text}");
		assert_eq!(panel.key(Key::Esc), PanelEvent::Close);
	}

	#[test]
	fn heatmap_levels_scale_against_the_busiest_day() {
		let today = Date::constant(2026, 9, 3);
		let day = |offset: i64| {
			let date = today.checked_sub(offset.days()).unwrap();
			let ts = date
				.to_zoned(TimeZone::UTC)
				.unwrap()
				.timestamp()
				.as_millisecond();
			u64::try_from(ts).unwrap()
		};
		let points = [
			UsageDay { day_ms: day(0), cost_nano_usd: 4_000_000_000, requests: 4 },
			UsageDay { day_ms: day(1), cost_nano_usd: 1_000_000_000, requests: 1 },
			UsageDay { day_ms: day(2), cost_nano_usd: 0, requests: 0 },
		];
		let layout = build_heatmap(&points, 4, today);
		assert_eq!(layout.total_cost, 5_000_000_000);
		assert_eq!(layout.total_requests, 5);
		assert_eq!(layout.cells.len(), 4);
		let last = layout.cells.last().unwrap();
		// 2026-09-03 is a Thursday (row 3); tomorrow is in the future.
		assert_eq!(last[3], Some(4));
		assert_eq!(last[2], Some(2));
		assert_eq!(last[1], Some(0));
		assert_eq!(last[4], None);
		assert_eq!(format_cost(layout.total_cost), "$5");
		assert_eq!(format_cost(340_000_000), "$0.34");
		assert_eq!(format_cost(1_234_000_000_000), "$1,234");
	}
}
