//! `/hub` live supervisor as full-screen observer-local [`Panel`]s
//! (ADR 0005).
//!
//! Live agents are the `<meta><jobs>` children of the session replica
//! (`<subagent>` rows and detached `<job>` rows), refreshed after every DOM
//! patch. The hub projects them two ways — the `1 Agents` roster (flat table
//! or `By parent` tree over the `owner` link) beside an inspector, and the
//! `2 Activity` feed derived from the same rows — and asks for every effect
//! through a [`PanelEvent`]: Enter runs the `transcript <id>` console line
//! (ADR 0014), which stacks a [`TranscriptViewer`] over the hub.
//!
//! The viewer renders a controller-provided detached snapshot and applies
//! the ordered DOM patch stream that follows it. It never opens or polls the
//! child's journal (ADR 0005).

use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use flume::Receiver;
use jiff::{Timestamp, fmt::strtime, tz::TimeZone};
use omp_core::{Str, StrMut, sf};
use omp_dom::{Dom, KnownTag, Node, PropId, PropKey, Tag, Value};
use omp_tui::{
	Frame, IntoComponent, Key, MouseReport, Prop, Size, Ui, UiContext, UiEvent,
	components::hr::truncate_to_width, dom,
};

use super::{
	Outcome, Panel, PanelAction, PanelAnchor, PanelCx, PanelEvent, PanelNote,
	services::{AgentView, Pending, ServiceResult, SessionRow},
};
use crate::{
	cards::{CardRegistry, CardStatus, CardView, result_image},
	host::HostCommand,
	notices::{format_duration, format_number},
	project::{AssistantPart, assistant_parts},
};

/// Two-pane mode needs a useful roster and a readable inspector.
const SPLIT_MIN_WIDTH: u16 = 96;
const DETAIL_MIN_WIDTH: u16 = 34;
const ROSTER_MIN_WIDTH: u16 = 48;
/// Double-tap window for the roster's `←←` close gesture.
const LEFT_TAP_WINDOW: Duration = Duration::from_millis(500);
/// Wake cadence while waiting for a child subscription or its next patch.
pub const STREAM_POLL_MS: u64 = 50;
const STREAM_POLL: Duration = Duration::from_millis(STREAM_POLL_MS);
/// Border, section tabs, rule, and footer rows around the hub panes.
const HUB_CHROME_ROWS: u16 = 4;
const TITLE: &str = "Agent Hub";
const ACTIVITY_HINT: &str =
	"1:agents  j/k:select  Enter:transcript  Space:follow  f:filter  s:scope  /:search  Esc:close";
const NO_AGENTS: &str = "No agents in this session";
const NO_AGENTS_DETAIL: &str =
	"Finished and failed subagents remain with the session that created them.";
const NO_ACTIVITY: &str = "No agent activity recorded yet";
const NO_MATCHING_ACTIVITY: &str = "No matching activity";
const RESOLVED_MODEL_BADGE_VAR: &str = "cl_task_show_resolved_model_badge";
const RESOLVED_MODEL_BADGE_WIDTH: u16 = 30;
/// Agent transcript viewer footer hint.
const VIEWER_HINT: &str =
	"Enter:send  Esc:close  ctrl+o:expand  empty input → j/k:scroll  g/G:top/bottom";
const VIEWER_PLACEHOLDER: &str = "No messages yet.";
const STEER_PLACEHOLDER: &str = "Message this agent";
/// Header rows, rules, input, stats, hint, and border around the transcript.
const VIEWER_CHROME_ROWS: u16 = 9;
const CLOCK_FORMAT: &str = "%H:%M:%S";

/// Controller-owned supervision operation for one agent.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AgentOp {
	/// Restart a parked or completed agent.
	Revive,
	/// Terminate a live agent.
	Kill,
	/// Deliver steering text to a live agent.
	Send(Str),
}

/// Settled controller response for one [`AgentOp`].
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentOutcome {
	/// Agent id the request targeted.
	pub id:     Str,
	/// Request that settled.
	pub op:     AgentOp,
	/// Human-readable success line or typed service failure.
	pub result: ServiceResult<Str>,
}

/// One `<meta><jobs>` row as the hub reads it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct JobRow {
	/// Stable job id.
	pub id:         Str,
	/// `subagent`, `tool`, or `process`.
	pub kind:       Str,
	/// `running`, `completed`, or `failed`.
	pub status:     Str,
	/// Spawning owner id (`Main` or another job id).
	pub owner:      Str,
	/// Agent class for subagents.
	pub agent:      Option<Str>,
	/// Serving model resolved for the child.
	pub model:      Option<Str>,
	/// Start time, Unix milliseconds.
	pub started_ms: Option<u64>,
	/// Detached tool payload (JSON text).
	pub data:       Option<Str>,
}

/// Reads every `<subagent>`/`<job>` under `<meta><jobs>`.
#[must_use]
pub fn job_rows(dom: &Dom) -> Vec<JobRow> {
	let Some(jobs) = dom.children(dom.meta()).iter().copied().find(|handle| {
		dom.get(*handle)
			.is_some_and(|node| node.tag == Tag::Known(KnownTag::Jobs))
	}) else {
		return Vec::new();
	};
	dom.children(jobs)
		.iter()
		.filter_map(|handle| dom.get(*handle))
		.filter(|node| matches!(node.tag, Tag::Known(KnownTag::Subagent | KnownTag::Job)))
		.map(|node| JobRow {
			id:         prop_text(node, PropId::Id).unwrap_or_default(),
			kind:       prop_text(node, PropId::Kind).unwrap_or_else(|| Str::new_static("job")),
			status:     prop_text(node, PropId::Status).unwrap_or_else(|| Str::new_static("running")),
			owner:      custom_text(node, "owner").unwrap_or_else(|| Str::new_static("Main")),
			agent:      custom_text(node, "agent"),
			model:      prop_text(node, PropId::Model),
			started_ms: custom_text(node, "started").and_then(|text| text.parse().ok()),
			data:       node
				.prop(&PropId::Data.into())
				.and_then(|value| match value {
					Value::Json(raw) => Some(Str::new(raw.get())),
					other => other.as_str().map(Str::new),
				}),
		})
		.collect()
}

fn prop_text(node: &Node, prop: PropId) -> Option<Str> {
	node
		.prop(&prop.into())
		.and_then(Value::as_str)
		.map(Str::new)
}

fn custom_text(node: &Node, name: &'static str) -> Option<Str> {
	node
		.prop(&PropKey::Custom(Str::new_static(name)))
		.and_then(Value::as_str)
		.map(Str::new)
}

fn prop_u64(node: &Node, prop: PropId) -> u64 {
	match node.prop(&prop.into()) {
		Some(Value::Int(value)) => u64::try_from(*value).unwrap_or_default(),
		_ => 0,
	}
}

fn epoch_ms() -> u64 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map_or(0, |since| u64::try_from(since.as_millis()).unwrap_or(u64::MAX))
}

/// Journal stem the spawner derives from a child id
/// (`crates/driver/src/subagent/spawn.rs` `child_session_path`).
#[must_use]
pub fn session_stem(id: &str) -> Str {
	Str::new(
		id.chars()
			.map(|ch| {
				if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
					ch
				} else {
					'_'
				}
			})
			.collect::<String>(),
	)
}

/// Display order for job statuses.
fn status_rank(status: &str) -> u8 {
	match status {
		"running" => 0,
		"completed" => 1,
		"failed" => 2,
		_ => 3,
	}
}

/// Icon and color for a job status.
fn status_icon(status: &str) -> (&'static str, &'static str) {
	match status {
		"running" => ("running", "accent"),
		"completed" => ("completed", "ok"),
		"failed" => ("failed", "err"),
		_ => ("idle", "muted"),
	}
}

fn resolved_model_badge(model: &str) -> Str {
	let label = sf!("· {model}");
	let truncated = truncate_to_width(&label, RESOLVED_MODEL_BADGE_WIDTH);
	if truncated.ellipsis {
		sf!("{}…", truncated.text)
	} else {
		Str::new(truncated.text)
	}
}

fn clock(zone: &TimeZone, ms: Option<u64>) -> Str {
	ms.and_then(|ms| i64::try_from(ms).ok())
		.and_then(|ms| Timestamp::from_millisecond(ms).ok())
		.and_then(|stamp| strtime::format(CLOCK_FORMAT, &stamp.to_zoned(zone.clone())).ok())
		.map_or_else(|| Str::new_static("--:--:--"), Str::new)
}

/// Which top-level projection the hub shows.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Section {
	Agents,
	Activity,
}

/// Roster projection.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum View {
	Roster,
	Tree,
}

impl View {
	const fn toggled(self) -> Self {
		match self {
			Self::Roster => Self::Tree,
			Self::Tree => Self::Roster,
		}
	}

	/// Footer label for the next projection.
	const fn next_label(self) -> &'static str {
		match self {
			Self::Roster => "by parent",
			Self::Tree => "flat",
		}
	}
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ActivityFilter {
	All,
	Errors,
	Responses,
	Tools,
}

impl ActivityFilter {
	const fn next(self) -> Self {
		match self {
			Self::All => Self::Errors,
			Self::Errors => Self::Responses,
			Self::Responses => Self::Tools,
			Self::Tools => Self::All,
		}
	}

	const fn label(self) -> &'static str {
		match self {
			Self::All => "all",
			Self::Errors => "errors",
			Self::Responses => "responses",
			Self::Tools => "tools",
		}
	}
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ActivityScope {
	All,
	Agent,
	Subtree,
}

impl ActivityScope {
	const fn next(self) -> Self {
		match self {
			Self::All => Self::Agent,
			Self::Agent => Self::Subtree,
			Self::Subtree => Self::All,
		}
	}
}

/// One roster line: a job index plus its tree placement.
#[derive(Clone, Debug)]
struct Line {
	job:   usize,
	depth: usize,
	/// Per ancestor depth: whether that ancestor was the last sibling (rail
	/// omitted) — tree mode only.
	rails: Vec<bool>,
	last:  bool,
}

/// Retained `/hub` supervisor.
pub struct AgentHub {
	ui:              Ui,
	ctx:             UiContext,
	zone:            TimeZone,
	jobs:            Vec<JobRow>,
	/// Child session rows keyed by job id, for the inspector.
	sessions:        Vec<SessionRow>,
	lines:           Vec<Line>,
	selected:        usize,
	section:         Section,
	view:            View,
	filter:          String,
	filter_editing:  bool,
	activity:        Vec<usize>,
	activity_index:  usize,
	activity_filter: ActivityFilter,
	activity_scope:  ActivityScope,
	activity_search: String,
	search_editing:  bool,
	follow:          bool,
	show_model:      bool,
	narrow_details:  bool,
	split:           bool,
	detail_scroll:   usize,
	notice:          Option<Str>,
	last_left:       Option<Instant>,
	width:           u16,
	height:          u16,
}

impl AgentHub {
	/// Opens the hub over the replica's `<meta><jobs>` rows.
	pub fn open(cx: &PanelCx<'_>) -> Self {
		let jobs = job_rows(cx.dom);
		let stems = jobs
			.iter()
			.map(|job| session_stem(&job.id))
			.collect::<Vec<_>>();
		let sessions = cx
			.services
			.sessions(super::services::SessionScope::Project)
			.map(|rows| {
				rows
					.into_iter()
					.filter(|row| stems.iter().any(|stem| *stem == row.id))
					.collect()
			})
			.unwrap_or_default();
		let mut hub = Self::with_rows(jobs, sessions, cx.viewport, cx.ui);
		hub.show_model = cx
			.con
			.get_typed::<bool>(RESOLVED_MODEL_BADGE_VAR)
			.unwrap_or(false);
		if hub.show_model {
			hub.rebuild();
		}
		hub
	}

	/// Builds the hub over explicit rows (tests, hosts with their own feed).
	#[must_use]
	pub fn with_rows(
		jobs: Vec<JobRow>,
		sessions: Vec<SessionRow>,
		viewport: Size,
		ctx: &UiContext,
	) -> Self {
		let mut hub = Self {
			ui: Ui::from_root(dom! { <col/> }.into_component(), viewport.width, ctx.clone()),
			ctx: ctx.clone(),
			zone: TimeZone::system(),
			jobs,
			sessions,
			lines: Vec::new(),
			selected: 0,
			section: Section::Agents,
			view: View::Roster,
			filter: String::new(),
			filter_editing: false,
			activity: Vec::new(),
			activity_index: 0,
			activity_filter: ActivityFilter::All,
			activity_scope: ActivityScope::All,
			activity_search: String::new(),
			search_editing: false,
			follow: true,
			show_model: false,
			narrow_details: false,
			split: false,
			detail_scroll: 0,
			notice: None,
			last_left: None,
			width: viewport.width,
			height: viewport.height,
		};
		hub.refresh_rows();
		hub.rebuild();
		hub
	}

	/// Replaces the job projection after the host applies a DOM patch.
	pub fn refresh(&mut self, dom: &Dom) {
		self.jobs = job_rows(dom);
		self.refresh_rows();
		self.rebuild();
	}

	/// Seeds the `←←` close detector so one more `←` inside
	/// [`LEFT_TAP_WINDOW`] dismisses the hub.
	pub fn arm_close_tap(&mut self) {
		self.last_left = Some(Instant::now());
	}

	fn selected_job(&self) -> Option<&JobRow> {
		self
			.lines
			.get(self.selected)
			.map(|line| &self.jobs[line.job])
	}

	fn children_of(&self, id: &str) -> Vec<usize> {
		self
			.jobs
			.iter()
			.enumerate()
			.filter(|(_, job)| job.owner.as_str() == id)
			.map(|(index, _)| index)
			.collect()
	}

	/// Applies status-then-recency order, the `/` filter, then
	/// the tree projection when `By parent` is on.
	fn refresh_rows(&mut self) {
		let selected_id = self.selected_job().map(|job| job.id.clone());
		let query = self.filter.trim().to_ascii_lowercase();
		let mut ordered = (0..self.jobs.len())
			.filter(|&index| {
				let job = &self.jobs[index];
				query.is_empty()
					|| sf!("{} {}", job.id, job.agent.as_deref().unwrap_or_default())
						.to_ascii_lowercase()
						.contains(&query)
			})
			.collect::<Vec<_>>();
		ordered.sort_by(|&left, &right| {
			let (left, right) = (&self.jobs[left], &self.jobs[right]);
			status_rank(&left.status)
				.cmp(&status_rank(&right.status))
				.then_with(|| right.started_ms.cmp(&left.started_ms))
				.then_with(|| left.id.cmp(&right.id))
		});
		self.lines = match self.view {
			View::Roster => ordered
				.into_iter()
				.map(|job| Line { job, depth: 0, rails: Vec::new(), last: false })
				.collect(),
			View::Tree => {
				let mut lines = Vec::with_capacity(ordered.len());
				let ids = ordered
					.iter()
					.map(|&index| self.jobs[index].id.clone())
					.collect::<Vec<_>>();
				let roots = ordered
					.iter()
					.copied()
					.filter(|&index| !ids.contains(&self.jobs[index].owner))
					.collect::<Vec<_>>();
				self.push_tree(&ordered, &roots, 0, &mut Vec::new(), &mut lines);
				lines
			},
		};
		self.selected = selected_id
			.and_then(|id| {
				self
					.lines
					.iter()
					.position(|line| self.jobs[line.job].id == id)
			})
			.unwrap_or_else(|| self.selected.min(self.lines.len().saturating_sub(1)));
		self.refresh_activity();
	}

	fn push_tree(
		&self,
		ordered: &[usize],
		siblings: &[usize],
		depth: usize,
		rails: &mut Vec<bool>,
		lines: &mut Vec<Line>,
	) {
		for (at, &index) in siblings.iter().enumerate() {
			let last = at + 1 == siblings.len();
			lines.push(Line { job: index, depth, rails: rails.clone(), last });
			let id = self.jobs[index].id.as_str();
			let children = ordered
				.iter()
				.copied()
				.filter(|&child| self.jobs[child].owner.as_str() == id)
				.collect::<Vec<_>>();
			if children.is_empty() {
				continue;
			}
			rails.push(last);
			self.push_tree(ordered, &children, depth + 1, rails, lines);
			rails.pop();
		}
	}

	fn scope_ids(&self) -> Option<Vec<Str>> {
		match self.activity_scope {
			ActivityScope::All => None,
			ActivityScope::Agent => Some(
				self
					.selected_job()
					.map(|job| job.id.clone())
					.into_iter()
					.collect(),
			),
			ActivityScope::Subtree => {
				let Some(root) = self.selected_job() else {
					return Some(Vec::new());
				};
				let mut ids = vec![root.id.clone()];
				let mut at = 0;
				while at < ids.len() {
					let id = ids[at].clone();
					for child in self.children_of(&id) {
						let child = self.jobs[child].id.clone();
						if !ids.contains(&child) {
							ids.push(child);
						}
					}
					at += 1;
				}
				Some(ids)
			},
		}
	}

	/// Projects one event per job at its
	/// start time, filtered by kind/status, scope, and search.
	fn refresh_activity(&mut self) {
		let scope = self.scope_ids();
		let search = self.activity_search.trim().to_ascii_lowercase();
		let mut rows = (0..self.jobs.len())
			.filter(|&index| {
				let job = &self.jobs[index];
				let kind_ok = match self.activity_filter {
					ActivityFilter::All => true,
					ActivityFilter::Errors => job.status.as_str() == "failed",
					ActivityFilter::Responses => job.status.as_str() == "completed",
					ActivityFilter::Tools => job.kind.as_str() == "tool",
				};
				let scope_ok = scope
					.as_ref()
					.is_none_or(|ids| ids.iter().any(|id| *id == job.id));
				let search_ok = search.is_empty()
					|| self
						.activity_summary(job)
						.to_ascii_lowercase()
						.contains(&search)
					|| job.id.to_ascii_lowercase().contains(&search);
				kind_ok && scope_ok && search_ok
			})
			.collect::<Vec<_>>();
		rows.sort_by(|&left, &right| {
			self.jobs[left]
				.started_ms
				.cmp(&self.jobs[right].started_ms)
				.then_with(|| self.jobs[left].id.cmp(&self.jobs[right].id))
		});
		self.activity = rows;
		if self.activity.is_empty() {
			self.activity_index = 0;
		} else if self.follow {
			self.activity_index = self.activity.len() - 1;
		} else {
			self.activity_index = self.activity_index.min(self.activity.len() - 1);
		}
	}

	fn activity_summary(&self, job: &JobRow) -> Str {
		let mut out = StrMut::new(job.kind.as_str());
		if let Some(agent) = &job.agent {
			out.push_str(" ");
			out.push_str(agent.as_str());
		}
		out.push_str(" · ");
		out.push_str(job.status.as_str());
		out.push_str(" · owner ");
		out.push_str(job.owner.as_str());
		if let Some(data) = &job.data {
			out.push_str(" · ");
			out.push_str(data.as_str());
		}
		out.freeze()
	}

	fn split_roster_width(&self) -> Option<u16> {
		if self.width < SPLIT_MIN_WIDTH {
			return None;
		}
		let roster = (self.width * 58 / 100)
			.min(self.width.saturating_sub(DETAIL_MIN_WIDTH + 7))
			.max(ROSTER_MIN_WIDTH);
		(self.width.saturating_sub(roster + 7) >= DETAIL_MIN_WIDTH).then_some(roster)
	}

	fn section_tabs(&self) -> Box<dyn omp_tui::Component> {
		let agents = self.section == Section::Agents;
		dom! {
			<row>
				if agents { <text bold fg=accent bg=surface>{" 1 Agents "}</text> } else { <text fg=muted>{" 1 Agents "}</text> }
				<icon name="dot" fg=muted/>
				if agents { <text fg=muted>{" 2 Activity "}</text> } else { <text bold fg=accent bg=surface>{" 2 Activity "}</text> }
			</row>
		}.into_component()
	}

	fn footer(&self) -> Str {
		let filter = if self.filter.is_empty() {
			Str::default()
		} else if self.filter_editing {
			sf!("/{}▌  ·  ", self.filter)
		} else {
			sf!("/{}  ·  ", self.filter)
		};
		let next = self.view.next_label();
		if self.narrow_details && !self.split {
			return sf!(
				"{filter}1:agents  2:activity  Tab:roster  PgUp/PgDn:scroll  Enter:open  t:{next}  \
				 Esc:roster"
			);
		}
		if self.width.saturating_sub(4) < SPLIT_MIN_WIDTH {
			return sf!(
				"{filter}j/k:select  Enter:open  t:{next}  Tab:details  r/x:manage  Esc:close"
			);
		}
		sf!(
			"{filter}1:agents  2:activity  j/k:select  PgUp/PgDn:details  Enter:open  t:{next}  \
			 r:revive  x:kill  Esc:close"
		)
	}

	fn roster(&self, rows: u16, width: u16) -> Vec<Box<dyn omp_tui::Component>> {
		let mut lines: Vec<Box<dyn omp_tui::Component>> = Vec::with_capacity(usize::from(rows));
		let flat = self.view == View::Roster;
		let counts = ["running", "completed", "failed"]
			.into_iter()
			.filter_map(|status| {
				let count = self
					.lines
					.iter()
					.filter(|line| self.jobs[line.job].status.as_str() == status)
					.count();
				(count > 0).then(|| (status_icon(status), sf!("{count} {status}")))
			})
			.collect::<Vec<_>>();
		lines.push(dom! {
			<row>
				<text bold>{"Roster"}</text>
				<icon name="dot" fg=muted/>
				if flat { <text bold fg=accent bg=surface>{" Flat "}</text> } else { <text fg=muted>{" Flat "}</text> }
				<text fg=muted>{"/"}</text>
				if flat { <text fg=muted>{" By parent "}</text> } else { <text bold fg=accent bg=surface>{" By parent "}</text> }
				for ((icon, fg), label) in counts {
					<icon name="dot" fg=muted/>
					<icon name={icon} fg={fg}/>
					<pre fg={fg}>{" "}{label}</pre>
				}
			</row>
		}.into_component());
		if rows >= 8 {
			lines.push(dom! { <text>{" "}</text> }.into_component());
		}
		let budget =
			usize::from(rows).saturating_sub(lines.len() + usize::from(self.notice.is_some()));
		if self.lines.is_empty() {
			lines.push(
				dom! {
					<row gap=1>
						<icon name="idle" fg=muted/>
						<text bold truncate>{NO_AGENTS}</text>
					</row>
				}
				.into_component(),
			);
			lines.push(dom! { <text fg=muted truncate>{NO_AGENTS_DETAIL}</text> }.into_component());
		} else if budget > 0 {
			let start = self
				.selected
				.saturating_sub(budget / 2)
				.min(self.lines.len().saturating_sub(budget));
			let end = (start + budget).min(self.lines.len());
			if start > 0 {
				lines.push(dom! { <text fg=muted>{sf!("… {start} more")}</text> }.into_component());
			}
			let id_width = self
				.lines
				.iter()
				.map(|line| self.jobs[line.job].id.chars().count() + 2 * line.depth)
				.max()
				.unwrap_or(0);
			for (at, line) in self.lines.iter().enumerate().take(end).skip(start) {
				lines.push(self.roster_line(line, at == self.selected, id_width, width));
			}
			if end < self.lines.len() {
				let more = self.lines.len() - end;
				lines.push(dom! { <text fg=muted>{sf!("… {more} more")}</text> }.into_component());
			}
		}
		if let Some(notice) = &self.notice {
			let notice = notice.clone();
			lines.push(dom! { <text fg=err truncate>{notice}</text> }.into_component());
		}
		pad(&mut lines, rows);
		lines
	}

	fn roster_line(
		&self,
		line: &Line,
		selected: bool,
		id_width: usize,
		width: u16,
	) -> Box<dyn omp_tui::Component> {
		let job = &self.jobs[line.job];
		let (icon, fg) = status_icon(&job.status);
		let age = job
			.started_ms
			.map(|started| epoch_ms().saturating_sub(started));
		let agent = job.agent.clone().unwrap_or_else(|| job.kind.clone());
		let model = self
			.show_model
			.then(|| job.model.as_deref())
			.flatten()
			.map(resolved_model_badge);
		match self.view {
			View::Roster => {
				let id = sf!("{:width$}", job.id.as_str(), width = id_width);
				let status = sf!("{:9}", job.status.as_str());
				let wide = width >= 60;
				dom! {
					<row gap=1>
						if selected { <icon name="cursor" fg=accent/> } else { <text>{" "}</text> }
						<icon name={icon} fg={fg}/>
						if selected { <pre bold fg=accent>{id}</pre> } else { <pre bold>{id}</pre> }
						<pre fg={fg}>{status}</pre>
						if wide { <text fg=muted truncate grow>{agent}</text> }
						if let Some(model) = model { <text dim truncate>{model}</text> }
						if let Some(age) = age { <time ms={age} kind="relative" fg=muted/> }
					</row>
				}
				.into_component()
			},
			View::Tree => {
				let rails = line.rails.iter().map(|&last| !last).collect::<Vec<_>>();
				let branch = line.depth > 0;
				let last = line.last;
				let id = job.id.clone();
				dom! {
					<row gap=1>
						if selected { <icon name="cursor" fg=accent/> } else { <text>{" "}</text> }
						<row>
							for rail in rails {
								if rail { <icon name="tree-vertical" fg=muted/> } else { <text>{" "}</text> }
								<text>{" "}</text>
							}
							if branch && last { <icon name="tree-last" fg=muted/> } else if branch { <icon name="tree-branch" fg=muted/> }
						</row>
						<icon name={icon} fg={fg}/>
						if selected { <pre bold fg=accent>{id}</pre> } else { <pre bold>{id}</pre> }
						<text fg=muted truncate grow>{agent}</text>
						if let Some(model) = model { <text dim truncate>{model}</text> }
						if let Some(age) = age { <time ms={age} kind="relative" fg=muted/> }
					</row>
				}.into_component()
			},
		}
	}

	/// Renders the selected job's detail panel.
	fn inspector(&self, rows: u16) -> Vec<Box<dyn omp_tui::Component>> {
		let mut lines: Vec<Box<dyn omp_tui::Component>> = Vec::with_capacity(usize::from(rows));
		let Some(job) = self.selected_job() else {
			lines.push(dom! { <text fg=muted>{"Select an agent to inspect"}</text> }.into_component());
			pad(&mut lines, rows);
			return lines;
		};
		let (icon, fg) = status_icon(&job.status);
		let id = job.id.clone();
		let status = job.status.clone();
		let now = epoch_ms();
		let age = job.started_ms.map(|started| now.saturating_sub(started));
		lines.push(
			dom! {
				<row gap=1>
					<icon name={icon} fg={fg}/>
					<text bold truncate>{id}</text>
				</row>
			}
			.into_component(),
		);
		lines.push(
			dom! {
				<row>
					<text fg={fg}>{status}</text>
					if let Some(age) = age {
						<icon name="dot" fg=muted/>
						<pre fg=muted>{"started "}</pre>
						<time ms={age} kind="relative" fg=muted/>
					}
				</row>
			}
			.into_component(),
		);
		let kind = job.kind.clone();
		let agent = job.agent.clone().unwrap_or_else(|| Str::new_static("—"));
		let owner = job.owner.clone();
		let started = clock(&self.zone, job.started_ms);
		let elapsed = match (job.status.as_str(), age) {
			("running", Some(age)) => Str::new(format_duration(age)),
			_ => Str::new_static("—"),
		};
		lines.push(dom! { <text>{" "}</text> }.into_component());
		lines.push(
			dom! { <row><pre fg=muted>{"kind     "}</pre><text truncate>{kind}</text></row> }
				.into_component(),
		);
		lines.push(
			dom! { <row><pre fg=muted>{"agent    "}</pre><text truncate>{agent}</text></row> }
				.into_component(),
		);
		lines.push(
			dom! { <row><pre fg=muted>{"owner    "}</pre><text truncate>{owner}</text></row> }
				.into_component(),
		);
		lines.push(
			dom! { <row><pre fg=muted>{"started  "}</pre><text truncate>{started}</text></row> }
				.into_component(),
		);
		lines.push(
			dom! { <row><pre fg=muted>{"elapsed  "}</pre><text truncate>{elapsed}</text></row> }
				.into_component(),
		);
		if let Some(data) = &job.data {
			lines.push(dom! { <text>{" "}</text> }.into_component());
			lines.push(dom! { <text bold fg=accent>{"Data"}</text> }.into_component());
			let pretty = serde_json::from_str::<serde_json::Value>(data)
				.ok()
				.and_then(|value| serde_json::to_string_pretty(&value).ok())
				.unwrap_or_else(|| data.to_string());
			for text in pretty.lines().take(12) {
				let text = Str::new(text);
				lines.push(dom! { <text fg=muted truncate>{text}</text> }.into_component());
			}
		}
		let children = self.children_of(&job.id);
		lines.push(dom! { <text>{" "}</text> }.into_component());
		lines.push(dom! { <text bold fg=accent>{"Lineage"}</text> }.into_component());
		let spawned = if children.is_empty() {
			sf!("Spawned by {}", job.owner)
		} else {
			sf!("Spawned by {} · {} children", job.owner, children.len())
		};
		lines.push(dom! { <text truncate>{spawned}</text> }.into_component());
		if !children.is_empty() {
			let ids = Str::new(
				children
					.iter()
					.map(|&child| self.jobs[child].id.as_str())
					.collect::<Vec<_>>()
					.join(", "),
			);
			lines.push(dom! { <text fg=muted truncate>{ids}</text> }.into_component());
		}
		let stem = session_stem(&job.id);
		lines.push(dom! { <text>{" "}</text> }.into_component());
		lines.push(dom! { <text bold fg=accent>{"Transcript"}</text> }.into_component());
		match self.sessions.iter().find(|row| row.id == stem) {
			Some(row) => {
				let path = Str::new(row.path.display().to_string());
				let messages = sf!("{} messages", row.messages);
				lines.push(dom! { <text fg=muted truncate>{path}</text> }.into_component());
				lines.push(dom! { <text fg=muted truncate>{messages}</text> }.into_component());
			},
			None => lines.push(
				dom! { <text fg=muted>{"No session file available yet."}</text> }.into_component(),
			),
		}
		let max_scroll = lines.len().saturating_sub(usize::from(rows));
		let offset = self.detail_scroll.min(max_scroll);
		let mut visible = lines.split_off(offset);
		visible.truncate(usize::from(rows));
		pad(&mut visible, rows);
		visible
	}

	fn activity_line(&self, at: usize, width: u16) -> Box<dyn omp_tui::Component> {
		let job = &self.jobs[self.activity[at]];
		let selected = at == self.activity_index;
		let (icon, fg) = match job.status.as_str() {
			"failed" => ("error", "err"),
			"running" => ("running", "accent"),
			"completed" if job.kind.as_str() == "tool" => ("success", "ok"),
			"completed" => ("diamond-suit", "ok"),
			_ => ("idle", "muted"),
		};
		let stamp = clock(&self.zone, job.started_ms);
		let id_width = usize::from((width * 18 / 100).clamp(8, 18));
		let id = sf!("{:width$}", job.id.as_str(), width = id_width);
		let title = job.agent.clone().unwrap_or_else(|| job.kind.clone());
		let summary = self.activity_summary(job);
		let title_fg = if job.status.as_str() == "completed" {
			"ok"
		} else {
			"muted"
		};
		dom! {
			<row gap=1>
				if selected { <icon name="cursor" fg=accent/> } else { <text>{" "}</text> }
				<text fg=muted>{stamp}</text>
				<icon name={icon} fg={fg}/>
				<pre bold>{id}</pre>
				<text fg={title_fg}>{title}</text>
				<icon name="dot" fg=muted/>
				<text truncate grow>{summary}</text>
			</row>
		}
		.into_component()
	}

	fn activity_body(&self, rows: u16, width: u16) -> Vec<Box<dyn omp_tui::Component>> {
		let mut lines: Vec<Box<dyn omp_tui::Component>> = Vec::with_capacity(usize::from(rows));
		let selected = self.selected_job().map(|job| job.id.clone());
		let scope = match self.activity_scope {
			ActivityScope::All => Str::new_static("all agents"),
			ActivityScope::Agent => selected.unwrap_or_else(|| Str::new_static("selected agent")),
			ActivityScope::Subtree => {
				sf!("{} subtree", selected.as_deref().unwrap_or("selected"))
			},
		};
		let follow = if self.follow { "following" } else { "paused" };
		let search = if self.search_editing {
			sf!("search: {}▌", self.activity_search)
		} else if self.activity_search.is_empty() {
			Str::new_static("search: —")
		} else {
			sf!("search: {}", self.activity_search)
		};
		let header = sf!("{scope} · {} · {follow} · {search}", self.activity_filter.label());
		lines.push(dom! { <text fg=muted truncate>{header}</text> }.into_component());
		if rows >= 8 {
			lines.push(dom! { <text>{" "}</text> }.into_component());
		}
		let budget = usize::from(rows).saturating_sub(lines.len());
		if self.activity.is_empty() {
			let empty = if self.activity_search.is_empty() {
				NO_ACTIVITY
			} else {
				NO_MATCHING_ACTIVITY
			};
			lines.push(dom! { <text fg=muted>{empty}</text> }.into_component());
		} else if budget > 0 {
			let start = if self.follow {
				self.activity.len().saturating_sub(budget)
			} else {
				self
					.activity_index
					.saturating_sub(budget / 2)
					.min(self.activity.len().saturating_sub(budget))
			};
			let end = (start + budget).min(self.activity.len());
			if start > 0 {
				lines.push(dom! { <text fg=muted>{sf!("… {start} earlier")}</text> }.into_component());
			}
			for at in (start + usize::from(start > 0))..end {
				lines.push(self.activity_line(at, width));
			}
		}
		pad(&mut lines, rows);
		lines
	}

	fn rebuild(&mut self) {
		let content_rows = self.height.saturating_sub(HUB_CHROME_ROWS).max(1);
		let inner = self.width.saturating_sub(4).max(1);
		let tabs = self.section_tabs();
		let (body, footer): (Box<dyn omp_tui::Component>, Str) = match self.section {
			Section::Activity => {
				self.split = false;
				let lines = self.activity_body(content_rows.saturating_sub(1), inner);
				(
					dom! { <col>for line in lines { {line} }</col> }.into_component(),
					Str::new_static(ACTIVITY_HINT),
				)
			},
			Section::Agents => {
				let split = self.split_roster_width();
				self.split = split.is_some();
				let body = match split {
					Some(roster_width) => {
						let detail_width = self.width.saturating_sub(roster_width + 7);
						let roster = self.roster(content_rows.saturating_sub(1), roster_width);
						let detail = self.inspector(content_rows.saturating_sub(1));
						dom! {
							<row gap=1>
								<col w={roster_width}>for line in roster { {line} }</col>
								<hr vertical border=round fg=muted/>
								<col w={detail_width}>for line in detail { {line} }</col>
							</row>
						}
						.into_component()
					},
					None if self.narrow_details && self.selected_job().is_some() => {
						let detail = self.inspector(content_rows.saturating_sub(1));
						dom! { <col>for line in detail { {line} }</col> }.into_component()
					},
					None => {
						let roster = self.roster(content_rows.saturating_sub(1), inner);
						dom! { <col>for line in roster { {line} }</col> }.into_component()
					},
				};
				(body, self.footer())
			},
		};
		let title = match (self.section, self.narrow_details && !self.split) {
			(Section::Agents, true) => self
				.selected_job()
				.map_or_else(|| Str::new_static(TITLE), |job| sf!("{TITLE} · {}", job.id)),
			_ => Str::new_static(TITLE),
		};
		let tree = dom! {
			<box border=round title={title} pad-x=1>
				<col>
					{tabs}
					{body}
					<hr border=round/>
					<text fg=muted truncate>{footer}</text>
				</col>
			</box>
		}
		.into_component();
		self.ui = Ui::from_root(tree, self.width, self.ctx.clone());
	}

	fn switch_section(&mut self, section: Section) {
		if self.section == section {
			return;
		}
		self.section = section;
		self.narrow_details = false;
		if section == Section::Activity {
			self.refresh_activity();
		}
	}

	fn select(&mut self, index: usize) {
		if index != self.selected {
			self.detail_scroll = 0;
		}
		self.selected = index;
	}

	fn open_selected(&self) -> PanelEvent {
		match self.selected_job() {
			Some(job) if job.kind.as_str() == "subagent" => {
				PanelEvent::Run(sf!("transcript {}", job.id))
			},
			Some(job) => PanelEvent::Notice(sf!(
				"{} is a detached {} job without a transcript",
				job.id,
				job.kind
			)),
			None => PanelEvent::Consumed,
		}
	}

	fn text_key(buffer: &mut String, key: Key) -> Option<bool> {
		match key {
			Key::Esc | Key::Enter => Some(true),
			Key::Backspace => {
				buffer.pop();
				Some(false)
			},
			Key::Space => {
				buffer.push(' ');
				Some(false)
			},
			Key::Char(ch) if !ch.is_control() => {
				buffer.push(ch);
				Some(false)
			},
			_ => None,
		}
	}

	fn activity_key(&mut self, key: Key) -> PanelEvent {
		if self.search_editing {
			match Self::text_key(&mut self.activity_search, key) {
				Some(done) => self.search_editing = !done,
				None => return PanelEvent::Consumed,
			}
			self.refresh_activity();
			self.rebuild();
			return PanelEvent::Consumed;
		}
		match key {
			Key::Esc => {
				if self.activity_search.is_empty() {
					return PanelEvent::Close;
				}
				self.activity_search.clear();
				self.refresh_activity();
			},
			Key::Left => self.switch_section(Section::Agents),
			Key::Char('/') => self.search_editing = true,
			Key::Space => {
				self.follow = !self.follow;
				if self.follow && !self.activity.is_empty() {
					self.activity_index = self.activity.len() - 1;
				}
			},
			Key::Char('f') => {
				self.activity_filter = self.activity_filter.next();
				self.refresh_activity();
			},
			Key::Char('s') => {
				self.activity_scope = self.activity_scope.next();
				self.refresh_activity();
			},
			Key::Char('j') | Key::Down => {
				if !self.activity.is_empty() {
					self.follow = false;
					self.activity_index = (self.activity_index + 1).min(self.activity.len() - 1);
				}
			},
			Key::Char('k') | Key::Up => {
				if !self.activity.is_empty() {
					self.follow = false;
					self.activity_index = self.activity_index.saturating_sub(1);
				}
			},
			Key::Enter => {
				let Some(&job) = self.activity.get(self.activity_index) else {
					return PanelEvent::Consumed;
				};
				if let Some(at) = self.lines.iter().position(|line| line.job == job) {
					self.select(at);
				}
				return self.open_selected();
			},
			_ => return PanelEvent::Ignored,
		}
		self.rebuild();
		PanelEvent::Consumed
	}

	fn table_key(&mut self, key: Key) -> PanelEvent {
		if self.filter_editing {
			match Self::text_key(&mut self.filter, key) {
				Some(done) => {
					self.filter_editing = !done;
					if key == Key::Esc {
						self.filter.clear();
					}
				},
				None => return PanelEvent::Consumed,
			}
			self.refresh_rows();
			self.rebuild();
			return PanelEvent::Consumed;
		}
		match key {
			Key::Esc => {
				if !self.filter.is_empty() {
					self.filter.clear();
					self.refresh_rows();
				} else if self.narrow_details && !self.split {
					self.narrow_details = false;
				} else {
					return PanelEvent::Close;
				}
			},
			Key::Char('/') => self.filter_editing = true,
			Key::Tab if !self.split => {
				if !self.lines.is_empty() {
					self.narrow_details = !self.narrow_details;
				}
			},
			Key::PageUp if self.split || self.narrow_details => {
				self.detail_scroll = self.detail_scroll.saturating_sub(5);
			},
			Key::PageDown if self.split || self.narrow_details => self.detail_scroll += 5,
			Key::Char('t') => {
				self.view = self.view.toggled();
				self.refresh_rows();
			},
			Key::Left => {
				if self.narrow_details && !self.split {
					self.narrow_details = false;
				} else {
					let now = Instant::now();
					if self
						.last_left
						.is_some_and(|last| now.duration_since(last) < LEFT_TAP_WINDOW)
					{
						self.last_left = None;
						return PanelEvent::Close;
					}
					self.last_left = Some(now);
					return PanelEvent::Consumed;
				}
			},
			Key::Char('j') | Key::Down => {
				if !self.lines.is_empty() {
					self.select((self.selected + 1).min(self.lines.len() - 1));
				}
			},
			Key::Char('k') | Key::Up => {
				if !self.lines.is_empty() {
					self.select(self.selected.saturating_sub(1));
				}
			},
			Key::Enter => return self.open_selected(),
			Key::Char('r') => {
				return match self.selected_job() {
					Some(job) if job.status.as_str() == "running" => PanelEvent::Notice(sf!(
						"Agent \"{}\" is running — only finished agents can be revived.",
						job.id
					)),
					Some(job) => PanelEvent::Command(HostCommand::Agent {
						id: job.id.clone(),
						op: AgentOp::Revive,
					}),
					None => PanelEvent::Consumed,
				};
			},
			Key::Char('x') => {
				return match self.selected_job() {
					Some(job) => {
						PanelEvent::Command(HostCommand::Agent { id: job.id.clone(), op: AgentOp::Kill })
					},
					None => PanelEvent::Consumed,
				};
			},
			_ => return PanelEvent::Ignored,
		}
		self.rebuild();
		PanelEvent::Consumed
	}
}

fn pad(lines: &mut Vec<Box<dyn omp_tui::Component>>, rows: u16) {
	while lines.len() < usize::from(rows) {
		lines.push(dom! { <text>{" "}</text> }.into_component());
	}
	lines.truncate(usize::from(rows));
}

impl Panel for AgentHub {
	fn id(&self) -> &'static str {
		"hub"
	}

	fn anchor(&self) -> PanelAnchor {
		PanelAnchor::Full
	}

	fn key(&mut self, key: Key) -> PanelEvent {
		if self.section == Section::Activity && self.search_editing {
			return self.activity_key(key);
		}
		if !self.filter_editing {
			match key {
				Key::Char('1') => {
					self.switch_section(Section::Agents);
					self.rebuild();
					return PanelEvent::Consumed;
				},
				Key::Char('2') => {
					self.switch_section(Section::Activity);
					self.rebuild();
					return PanelEvent::Consumed;
				},
				_ => {},
			}
		}
		match self.section {
			Section::Activity => self.activity_key(key),
			Section::Agents => self.table_key(key),
		}
	}

	fn mouse(&mut self, report: MouseReport) -> PanelEvent {
		match self
			.ui
			.handle_mouse_with_mods(report.col, report.row, report.kind, report.mods)
		{
			UiEvent::Cancel => PanelEvent::Close,
			_ => PanelEvent::Consumed,
		}
	}

	fn notify(&mut self, note: PanelNote<'_>) -> PanelEvent {
		match note {
			PanelNote::Dom(dom) => {
				let jobs = job_rows(dom);
				if jobs == self.jobs {
					return PanelEvent::Ignored;
				}
				self.refresh(dom);
				PanelEvent::Consumed
			},
			PanelNote::Outcome(Outcome::Agent(outcome))
				if self.jobs.iter().any(|job| job.id == outcome.id) =>
			{
				match &outcome.result {
					Ok(line) => PanelEvent::Notice(line.clone()),
					Err(error) => PanelEvent::Notice(sf!("{error}")),
				}
			},
			PanelNote::Outcome(_) | PanelNote::Live(..) | PanelNote::SettingResult { .. } => {
				PanelEvent::Ignored
			},
		}
	}

	fn frame(&mut self, viewport: Size) -> &Frame {
		if viewport.width != self.width || viewport.height != self.height {
			self.width = viewport.width;
			self.height = viewport.height;
			self.rebuild();
		}
		self.ui.frame()
	}

	fn tick(&mut self, now: Duration) -> bool {
		self.ui.tick(now)
	}

	fn next_wake(&self) -> Option<Duration> {
		self.ui.next_wake()
	}
}

/// Rendered transcript facts the viewer header and footer show.
struct Rendered {
	blocks:   Vec<Box<dyn omp_tui::Component>>,
	model:    Option<Str>,
	tools:    u64,
	tokens:   u64,
	duration: u64,
	cost:     u64,
}

/// Projects a child session DOM into transcript blocks plus the usage
/// totals its `<usage>` receipts carry.
fn render_transcript(
	dom: &Dom,
	cards: &CardRegistry,
	ui: &UiContext,
	show_thinking: bool,
	expanded: bool,
) -> Rendered {
	let mut rendered = Rendered {
		blocks:   Vec::new(),
		model:    None,
		tools:    0,
		tokens:   0,
		duration: 0,
		cost:     0,
	};
	for turn in dom.children(dom.body()) {
		if dom
			.get(*turn)
			.is_none_or(|node| node.tag != Tag::Known(KnownTag::Turn))
		{
			continue;
		}
		for handle in dom.children(*turn) {
			let Some(node) = dom.get(*handle) else {
				continue;
			};
			match &node.tag {
				Tag::Known(KnownTag::User) => {
					let text = node.content.clone().unwrap_or_default();
					rendered
						.blocks
						.push(dom! { <text bg=surface pad="1 1">{text}</text> }.into_component());
				},
				Tag::Known(KnownTag::Assistant) => {
					if rendered.model.is_none() {
						rendered.model = prop_text(node, PropId::Model);
					}
					for part in assistant_parts(dom, *handle, node) {
						match part {
							AssistantPart::Thinking { text, .. } if show_thinking && !text.is_empty() => {
								rendered.blocks.push(
									dom! { <text fg=muted italic pad-x=1>{text}</text> }.into_component(),
								);
							},
							AssistantPart::Text { text, .. } if !text.is_empty() => {
								rendered
									.blocks
									.push(dom! { <md pad-x=1>{text}</md> }.into_component());
							},
							AssistantPart::Artifact { uri, mime, kind, .. } => {
								if kind.as_str() == "image" || mime.as_str().starts_with("image/") {
									rendered
										.blocks
										.push(result_image(&uri, mime.as_str(), None, ui));
								} else {
									rendered.blocks.push(
										dom! {
											<col pad-x=1>
												<text fg=muted>{sf!("[{}: {}]", kind, mime)}</text>
												<a href={uri.clone()}>{uri}</a>
											</col>
										}
										.into_component(),
									);
								}
							},
							_ => {},
						}
					}
				},
				Tag::Known(KnownTag::Notice) => {
					let text = node.content.clone().unwrap_or_default();
					rendered
						.blocks
						.push(dom! { <row gap=1 pad-x=1><icon name="info" fg=info/><text grow>{text}</text></row> }.into_component());
				},
				Tag::Known(KnownTag::Usage) => {
					rendered.tokens +=
						prop_u64(node, PropId::TokensIn) + prop_u64(node, PropId::TokensOut);
					rendered.duration += prop_u64(node, PropId::DurationMs);
					rendered.cost += prop_u64(node, PropId::CostNanoUsd);
				},
				Tag::Custom(tool) => {
					let Some(input) = child(dom, *handle, KnownTag::Input) else {
						continue;
					};
					rendered.tools += 1;
					let status =
						prop_text(node, PropId::Status).unwrap_or_else(|| Str::new_static("running"));
					let result = child_handle(dom, *handle, KnownTag::Result);
					let mut diag = None;
					let mut notices = smallvec::SmallVec::<&Node, 2>::new();
					for child in dom.children(*handle) {
						let Some(child) = dom.get(*child) else {
							continue;
						};
						if child.tag != Tag::Known(KnownTag::Diag) {
							continue;
						}
						let is_error = child.prop(&PropId::Fault.into()).is_some()
							|| child.prop(&PropId::Severity.into()).and_then(Value::as_str)
								== Some("error");
						if is_error {
							diag = Some(child);
						} else {
							notices.push(child);
						}
					}
					let view = CardView {
						input,
						result: result.and_then(|result| dom.get(result)),
						diag,
						notices,
						usage: child(dom, *handle, KnownTag::Usage),
						status: CardStatus::from_dom(status.as_str()),
						output: result.and_then(|result| dom.stream_text(result, &PropId::Text.into())),
						started: None,
					};
					rendered
						.blocks
						.push(cards.render(tool.as_str(), &view, expanded, ui));
				},
				_ => {},
			}
		}
	}
	rendered
}

fn child_handle(dom: &Dom, parent: omp_dom::Handle, tag: KnownTag) -> Option<omp_dom::Handle> {
	dom.children(parent).iter().copied().find(|handle| {
		dom.get(*handle)
			.is_some_and(|node| node.tag == Tag::Known(tag))
	})
}

fn child(dom: &Dom, parent: omp_dom::Handle, tag: KnownTag) -> Option<&Node> {
	child_handle(dom, parent, tag).and_then(|handle| dom.get(handle))
}

/// Retained full-screen transcript viewer for one child session.
pub struct TranscriptViewer {
	ui:            Ui,
	ctx:           UiContext,
	cards:         CardRegistry,
	job:           JobRow,
	/// Subscription request waiting for the controller's detached snapshot.
	pending:       Option<Pending<AgentView>>,
	/// Ordered child-DOM events following `dom`.
	events:        Option<Receiver<omp_dom::Event>>,
	/// Detached copy of the child's session tree.
	dom:           Dom,
	show_thinking: bool,
	expanded:      bool,
	follow:        bool,
	input:         String,
	notice:        Option<Str>,
	next_poll:     Option<Duration>,
	width:         u16,
	height:        u16,
}

impl TranscriptViewer {
	/// Opens the viewer for subagent `id` over the controller's snapshot and
	/// patch-stream feed.
	pub fn open(cx: &PanelCx<'_>, id: &str) -> Result<Self, Str> {
		let job = job_rows(cx.dom)
			.into_iter()
			.find(|job| job.id.as_str() == id)
			.ok_or_else(|| sf!("no agent \"{id}\" in this session"))?;
		let pending = cx
			.services
			.agent_view(id)
			.map_err(|error| Str::new(error.to_string()))?;
		let show_thinking = crate::settings::CL_SHOWTHINKING
			.try_get(cx.con)
			.unwrap_or(true);
		Ok(Self::waiting(job, pending, show_thinking, cx.viewport, cx.ui))
	}

	/// Opens the viewer over an already-delivered child snapshot and stream.
	#[must_use]
	pub fn with_view(
		job: JobRow,
		view: AgentView,
		show_thinking: bool,
		viewport: Size,
		ctx: &UiContext,
	) -> Self {
		let mut viewer = Self::base(job, show_thinking, viewport, ctx);
		viewer.install_view(view);
		viewer.rebuild();
		viewer
	}

	fn waiting(
		job: JobRow,
		pending: Pending<AgentView>,
		show_thinking: bool,
		viewport: Size,
		ctx: &UiContext,
	) -> Self {
		let mut viewer = Self::base(job, show_thinking, viewport, ctx);
		viewer.pending = Some(pending);
		viewer.next_poll = Some(Duration::ZERO);
		viewer.rebuild();
		viewer
	}

	fn base(job: JobRow, show_thinking: bool, viewport: Size, ctx: &UiContext) -> Self {
		Self {
			ui: Ui::from_root(dom! { <col/> }.into_component(), viewport.width, ctx.clone()),
			ctx: ctx.clone(),
			cards: CardRegistry::standard(),
			job,
			pending: None,
			events: None,
			dom: Dom::new(),
			show_thinking,
			expanded: false,
			follow: true,
			input: String::new(),
			notice: None,
			next_poll: None,
			width: viewport.width,
			height: viewport.height,
		}
	}

	fn install_view(&mut self, view: AgentView) {
		self.dom = Dom::from_snapshot(&view.snapshot);
		self.events = view.events;
		self.next_poll = self.events.as_ref().map(|_| Duration::ZERO);
		self.notice = None;
	}

	fn transcript_rows(&self) -> u16 {
		self.height.saturating_sub(VIEWER_CHROME_ROWS).max(3)
	}

	fn rebuild(&mut self) {
		let rows = self.transcript_rows();
		let rendered =
			render_transcript(&self.dom, &self.cards, &self.ctx, self.show_thinking, self.expanded);
		let blocks = rendered.blocks;
		let empty = blocks.is_empty();
		let id = self.job.id.clone();
		let status = self.job.status.clone();
		let status_fg = match self.job.status.as_str() {
			"running" => "ok",
			"completed" => "accent",
			"failed" => "err",
			_ => "muted",
		};
		let kind = if self.job.owner.as_str() == "Main" {
			self.job.kind.clone()
		} else {
			sf!("{} · of {}", self.job.kind, self.job.owner)
		};
		let model = rendered.model;
		let mut stats = Vec::new();
		if rendered.tools > 0 {
			stats.push(sf!("{} tools", format_number(rendered.tools)));
		}
		if rendered.tokens > 0 {
			stats.push(sf!("{} tok", format_number(rendered.tokens)));
		}
		if rendered.duration > 0 {
			stats.push(Str::new(format_duration(rendered.duration)));
		}
		if rendered.cost > 0 {
			#[allow(clippy::cast_precision_loss, reason = "display rounding only")]
			let dollars = rendered.cost as f64 / 1e9;
			stats.push(sf!("${dollars:.2}"));
		}
		let stats = Str::new(stats.join(" · "));
		let notice = self.notice.clone();
		let input = Str::new(self.input.as_str());
		let tree = dom! {
			<box border=round>
				<col>
					<row pad-x=1>
						<text fg=accent>{"Agent Hub"}</text>
						<icon name="dot" fg=muted/>
						<text fg=accent>{id.clone()}</text>
					</row>
					<row gap=1 pad-x=1>
						<text bold>{id}</text>
						<text fg={status_fg}>{status}</text>
						<text fg=muted>{kind}</text>
						if let Some(model) = model {
							<icon name="dot" fg=muted/>
							<text fg=muted>{model}</text>
						}
					</row>
					<hr border=round/>
					<scroll id="transcript" h={rows}>
						<col gap=1>
							if empty { <text fg=muted pad-x=1>{VIEWER_PLACEHOLDER}</text> }
							for block in blocks { {block} }
						</col>
					</scroll>
					if let Some(notice) = notice { <text fg=err pad-x=1 truncate>{notice}</text> }
					<input id="steer" value={input} placeholder={STEER_PLACEHOLDER} submit focus/>
					if !stats.is_empty() { <text fg=muted pad-x=1 truncate>{stats}</text> }
					<text fg=muted pad-x=1 truncate>{VIEWER_HINT}</text>
				</col>
			</box>
		}
		.into_component();
		self.ui = Ui::from_root(tree, self.width, self.ctx.clone());
		if self.follow {
			self.scroll(Key::End);
		}
	}

	/// Routes one scroll key to the transcript pane, then returns focus to
	/// the input line.
	fn scroll(&mut self, key: Key) {
		self.ui.focus_id("transcript");
		let _ = self.ui.handle_key(key);
		self.ui.focus_id("steer");
	}

	fn submit(&mut self) -> PanelEvent {
		let text = Str::new(self.input.trim());
		self.input.clear();
		self.ui.set_prop("steer", Prop::Value, "");
		if text.is_empty() {
			return PanelEvent::Consumed;
		}
		PanelEvent::Command(HostCommand::Agent { id: self.job.id.clone(), op: AgentOp::Send(text) })
	}

	/// Applies a ready snapshot and every currently queued patch. Returns
	/// whether the rendered projection changed.
	fn poll_stream(&mut self) -> bool {
		let mut changed = false;
		let pending = self.pending.as_ref().map(|receiver| receiver.try_recv());
		match pending {
			Some(Ok(Ok(view))) => {
				self.pending = None;
				self.install_view(view);
				changed = true;
			},
			Some(Ok(Err(error))) => {
				self.pending = None;
				self.notice = Some(sf!("{error}"));
				changed = true;
			},
			Some(Err(flume::TryRecvError::Disconnected)) => {
				self.pending = None;
				self.notice = Some(Str::new_static("agent transcript subscription ended"));
				changed = true;
			},
			Some(Err(flume::TryRecvError::Empty)) | None => {},
		}

		let mut closed = false;
		if let Some(events) = &self.events {
			loop {
				match events.try_recv() {
					Ok(event) => match self.dom.apply_event(&event) {
						Ok(()) => changed = true,
						Err(error) => {
							self.notice = Some(sf!("agent transcript patch: {error}"));
							changed = true;
						},
					},
					Err(flume::TryRecvError::Empty) => break,
					Err(flume::TryRecvError::Disconnected) => {
						closed = true;
						break;
					},
				}
			}
		}
		if closed {
			self.events = None;
		}
		changed
	}
}

impl Panel for TranscriptViewer {
	fn id(&self) -> &'static str {
		"transcript"
	}

	fn anchor(&self) -> PanelAnchor {
		PanelAnchor::Full
	}

	fn action(&mut self, action: PanelAction) -> PanelEvent {
		match action {
			PanelAction::Expand => {
				self.expanded = !self.expanded;
				self.rebuild();
				PanelEvent::Consumed
			},
			_ => PanelEvent::Ignored,
		}
	}

	fn key(&mut self, key: Key) -> PanelEvent {
		if key == Key::Esc {
			if self.input.trim().is_empty() {
				return PanelEvent::Close;
			}
			self.input.clear();
			self.ui.set_prop("steer", Prop::Value, "");
			return PanelEvent::Consumed;
		}
		if self.input.trim().is_empty() {
			let scroll = match key {
				Key::Char('j') | Key::Down => Some((Key::Down, self.follow)),
				Key::Char('k') | Key::Up => Some((Key::Up, false)),
				Key::Char('g') | Key::Home => Some((Key::Home, false)),
				Key::Char('G') | Key::End => Some((Key::End, true)),
				Key::PageUp => Some((Key::PageUp, false)),
				Key::PageDown => Some((Key::PageDown, self.follow)),
				_ => None,
			};
			if let Some((key, follow)) = scroll {
				self.follow = follow;
				self.scroll(key);
				return PanelEvent::Consumed;
			}
		}
		match self.ui.handle_key(key) {
			UiEvent::Submit => self.submit(),
			UiEvent::Changed { id, value } if id.as_str() == "steer" => {
				self.input = value.to_string();
				PanelEvent::Consumed
			},
			UiEvent::Cancel => PanelEvent::Close,
			_ => PanelEvent::Consumed,
		}
	}

	fn paste(&mut self, text: &str) -> PanelEvent {
		if let UiEvent::Changed { id, value } = self.ui.handle_paste(text)
			&& id.as_str() == "steer"
		{
			self.input = value.to_string();
		}
		PanelEvent::Consumed
	}

	fn mouse(&mut self, report: MouseReport) -> PanelEvent {
		match self
			.ui
			.handle_mouse_with_mods(report.col, report.row, report.kind, report.mods)
		{
			UiEvent::Submit => self.submit(),
			UiEvent::Changed { id, value } if id.as_str() == "steer" => {
				self.input = value.to_string();
				PanelEvent::Consumed
			},
			UiEvent::Cancel => PanelEvent::Close,
			_ => PanelEvent::Consumed,
		}
	}

	fn notify(&mut self, note: PanelNote<'_>) -> PanelEvent {
		match note {
			PanelNote::Dom(dom) => {
				let Some(job) = job_rows(dom).into_iter().find(|job| job.id == self.job.id) else {
					return PanelEvent::Ignored;
				};
				if job == self.job {
					return PanelEvent::Ignored;
				}
				self.job = job;
				self.rebuild();
				PanelEvent::Consumed
			},
			PanelNote::Outcome(Outcome::Agent(outcome)) if outcome.id == self.job.id => {
				match &outcome.result {
					Ok(line) => PanelEvent::Notice(line.clone()),
					Err(error) => PanelEvent::Notice(sf!("{error}")),
				}
			},
			PanelNote::Outcome(_) | PanelNote::Live(..) | PanelNote::SettingResult { .. } => {
				PanelEvent::Ignored
			},
		}
	}

	fn frame(&mut self, viewport: Size) -> &Frame {
		if viewport.width != self.width || viewport.height != self.height {
			self.width = viewport.width;
			self.height = viewport.height;
			self.rebuild();
		}
		self.ui.frame()
	}

	fn tick(&mut self, now: Duration) -> bool {
		let mut repaint = self.ui.tick(now);
		if self.next_poll.is_some_and(|due| now >= due) {
			repaint |= self.poll_stream();
			self.next_poll =
				(self.pending.is_some() || self.events.is_some()).then_some(now + STREAM_POLL);
			if repaint {
				self.rebuild();
			}
		}
		repaint
	}

	fn next_wake(&self) -> Option<Duration> {
		match (self.next_poll, self.ui.next_wake()) {
			(Some(poll), Some(wake)) => Some(poll.min(wake)),
			(poll, wake) => poll.or(wake),
		}
	}
}

#[cfg(test)]
mod tests {
	use omp_core::Str;
	use omp_session::{
		ComponentRegistry, Session,
		components::jobs::{self, JobSpec},
	};
	use omp_tui::{Mods, Mouse, MouseButton};
	use tempfile::tempdir;

	use super::*;

	fn viewport() -> Size {
		Size { width: 120, height: 32 }
	}

	fn session_with_jobs() -> (Session, tempfile::TempDir) {
		let directory = tempdir().expect("temp directory");
		let path = directory.path().join("parent.oms");
		let mut session = Session::create(path, ComponentRegistry::standard()).expect("create");
		for (id, owner, agent, status) in
			[("alpha", "Main", "task", "running"), ("beta", "alpha", "sonic", "completed")]
		{
			let cause = session.head().expect("head");
			let txn = jobs::insert(session.dom(), cause, JobSpec {
				id:      Str::new(id),
				kind:    Str::new_static("subagent"),
				owner:   Str::new(owner),
				started: Str::new(epoch_ms().saturating_sub(65_000).to_string()),
				agent:   Some(Str::new(agent)),
			})
			.expect("jobs component");
			session.patch(txn).expect("insert job");
			if status != "running" {
				let handle = session
					.dom()
					.select(&format!("jobs subagent[id={id}]"))
					.expect("selector")
					.next()
					.expect("job handle");
				let cause = session.head().expect("head");
				session
					.patch(jobs::set_status(cause, handle, status))
					.expect("status");
			}
		}
		(session, directory)
	}

	fn hub_over(session: &Session) -> AgentHub {
		AgentHub::with_rows(job_rows(session.dom()), Vec::new(), viewport(), &UiContext::default())
	}

	fn text(panel: &mut dyn Panel) -> String {
		omp_tui::frame_text(panel.frame(viewport()))
	}

	fn click(col: u16, row: u16) -> MouseReport {
		MouseReport {
			kind: Mouse::Click,
			col,
			row,
			button: MouseButton::Left,
			mods: Mods::default(),
			pressed: true,
		}
	}

	#[test]
	fn job_rows_read_subagent_elements() {
		let (mut session, _dir) = session_with_jobs();
		let alpha = session
			.dom()
			.select("jobs subagent[id=alpha]")
			.expect("selector")
			.next()
			.expect("alpha");
		let cause = session.head().expect("head");
		session
			.patch(omp_dom::Txn {
				cause,
				label: Some(Str::new_static("test.model")),
				ops: vec![omp_dom::Op::Set {
					h:     alpha,
					prop:  PropId::Model.into(),
					value: Value::Str(Str::new_static("provider/model")),
				}],
			})
			.expect("model patch");
		let rows = job_rows(session.dom());
		assert_eq!(rows.len(), 2);
		assert_eq!(rows[0].id, "alpha");
		assert_eq!(rows[0].owner, "Main");
		assert_eq!(rows[0].agent.as_deref(), Some("task"));
		assert_eq!(rows[0].model.as_deref(), Some("provider/model"));
		assert_eq!(rows[1].status, "completed");
		assert_eq!(rows[1].owner, "alpha");
		assert!(rows[1].started_ms.is_some());
	}

	#[test]
	fn resolved_model_badge_is_flagged_and_clamped_to_thirty_cells() {
		let (session, _dir) = session_with_jobs();
		let mut hub = hub_over(&session);
		hub.jobs[0].model = Some(Str::new_static("provider/a-very-long-resolved-model-name"));
		hub.rebuild();
		assert!(
			!text(&mut hub).contains("· provider/"),
			"the default-off convar must omit the resolved model"
		);
		hub.show_model = true;
		hub.rebuild();
		let badge = resolved_model_badge("provider/a-very-long-resolved-model-name");
		assert_eq!(omp_tui::cell_width(&badge), RESOLVED_MODEL_BADGE_WIDTH);
		assert!(badge.ends_with('…'));
		assert!(text(&mut hub).contains(badge.as_str()));
	}

	#[test]
	fn hub_mouse_routes_through_the_retained_ui() {
		let (session, _dir) = session_with_jobs();
		let mut hub = hub_over(&session);
		let _ = hub.frame(viewport());
		assert_eq!(hub.mouse(click(1, 1)), PanelEvent::Consumed);
	}

	#[test]
	fn hub_refreshes_job_rows_when_the_replica_is_patched() {
		let (mut session, _dir) = session_with_jobs();
		let mut hub = hub_over(&session);
		let beta = session
			.dom()
			.select("jobs subagent[id=beta]")
			.expect("selector")
			.next()
			.expect("beta");
		let cause = session.head().expect("head");
		session
			.patch(jobs::set_status(cause, beta, "failed"))
			.expect("status patch");
		assert_eq!(hub.notify(PanelNote::Dom(session.dom())), PanelEvent::Consumed);
		assert_eq!(
			hub.jobs
				.iter()
				.find(|job| job.id == "beta")
				.map(|job| job.status.as_str()),
			Some("failed")
		);
		let painted = text(&mut hub);
		assert!(painted.contains("1 failed"), "{painted}");
		assert_eq!(
			hub.notify(PanelNote::Dom(session.dom())),
			PanelEvent::Ignored,
			"an unrelated DOM patch does not rebuild identical rows"
		);
	}

	#[test]
	fn hub_renders_ids_footer_and_switches_sections_and_views() {
		let (session, _dir) = session_with_jobs();
		let mut hub = hub_over(&session);
		let painted = text(&mut hub);
		assert!(painted.contains("Agent Hub"), "{painted}");
		assert!(painted.contains("alpha"), "{painted}");
		assert!(painted.contains("beta"), "{painted}");
		assert!(painted.contains("1 running"), "{painted}");
		assert!(painted.contains("1 completed"), "{painted}");
		assert!(painted.contains("t:by parent"), "footer missing:\n{painted}");
		assert!(painted.contains("x:kill"), "{painted}");
		assert!(painted.contains("Spawned by Main"), "inspector missing:\n{painted}");

		assert_eq!(hub.key(Key::Char('2')), PanelEvent::Consumed);
		let painted = text(&mut hub);
		assert!(painted.contains("all agents · all · following"), "{painted}");
		assert!(painted.contains("Enter:transcript"), "{painted}");
		assert!(painted.contains("owner alpha"), "{painted}");
		assert_eq!(hub.key(Key::Char('f')), PanelEvent::Consumed);
		let painted = text(&mut hub);
		assert!(painted.contains("all agents · errors"), "{painted}");
		assert!(painted.contains(NO_ACTIVITY), "{painted}");
		assert_eq!(hub.key(Key::Char('1')), PanelEvent::Consumed);

		assert_eq!(hub.key(Key::Char('t')), PanelEvent::Consumed);
		let painted = text(&mut hub);
		assert!(painted.contains("t:flat"), "{painted}");
		assert_eq!(hub.lines.len(), 2);
		assert_eq!(hub.lines[1].depth, 1, "beta hangs under alpha");
		assert_eq!(hub.key(Key::Char('j')), PanelEvent::Consumed);
		assert_eq!(hub.selected_job().map(|job| job.id.as_str()), Some("beta"));
		assert_eq!(hub.key(Key::Enter), PanelEvent::Run(Str::new_static("transcript beta")));
		assert_eq!(
			hub.key(Key::Char('r')),
			PanelEvent::Command(HostCommand::Agent {
				id: Str::new_static("beta"),
				op: AgentOp::Revive,
			})
		);
		assert_eq!(
			hub.key(Key::Char('x')),
			PanelEvent::Command(HostCommand::Agent { id: Str::new_static("beta"), op: AgentOp::Kill })
		);
	}

	#[test]
	fn double_left_within_the_window_closes_and_a_slow_tap_does_not() {
		let (session, _dir) = session_with_jobs();
		let mut hub = hub_over(&session);
		assert_eq!(hub.key(Key::Left), PanelEvent::Consumed);
		assert_eq!(hub.key(Key::Left), PanelEvent::Close);
		let mut hub = hub_over(&session);
		hub.last_left = Some(Instant::now() - LEFT_TAP_WINDOW - Duration::from_millis(10));
		assert_eq!(hub.key(Key::Left), PanelEvent::Consumed);
		assert_eq!(hub.key(Key::Esc), PanelEvent::Close);
	}

	#[test]
	fn filter_narrows_rows_and_esc_clears_before_closing() {
		let (session, _dir) = session_with_jobs();
		let mut hub = hub_over(&session);
		assert_eq!(hub.key(Key::Char('/')), PanelEvent::Consumed);
		assert_eq!(hub.key(Key::Char('b')), PanelEvent::Consumed);
		assert_eq!(hub.key(Key::Enter), PanelEvent::Consumed);
		assert_eq!(hub.lines.len(), 1);
		let painted = text(&mut hub);
		assert!(painted.contains("/b  ·"), "{painted}");
		assert_eq!(hub.key(Key::Esc), PanelEvent::Consumed);
		assert_eq!(hub.lines.len(), 2);
		assert_eq!(hub.key(Key::Esc), PanelEvent::Close);
	}

	#[test]
	fn narrow_terminal_tabs_into_the_inspector() {
		let (session, _dir) = session_with_jobs();
		let mut hub = AgentHub::with_rows(
			job_rows(session.dom()),
			Vec::new(),
			Size { width: 70, height: 24 },
			&UiContext::default(),
		);
		let painted = omp_tui::frame_text(hub.frame(Size { width: 70, height: 24 }));
		assert!(painted.contains("Tab:details"), "{painted}");
		assert_eq!(hub.key(Key::Tab), PanelEvent::Consumed);
		let painted = omp_tui::frame_text(hub.frame(Size { width: 70, height: 24 }));
		assert!(painted.contains("Agent Hub · alpha"), "{painted}");
		assert!(painted.contains("Tab:roster"), "{painted}");
		assert!(painted.contains("elapsed  "), "{painted}");
		assert_eq!(hub.key(Key::Esc), PanelEvent::Consumed);
		assert_eq!(hub.key(Key::Esc), PanelEvent::Close);
	}

	#[test]
	fn empty_hub_shows_the_empty_state() {
		let mut hub = AgentHub::with_rows(Vec::new(), Vec::new(), viewport(), &UiContext::default());
		let painted = text(&mut hub);
		assert!(painted.contains(NO_AGENTS), "{painted}");
		assert_eq!(hub.key(Key::Enter), PanelEvent::Consumed);
	}

	fn child_session(directory: &std::path::Path) -> Session {
		let path = directory.join("alpha.oms");
		let mut session =
			Session::create(&path, ComponentRegistry::standard()).expect("create child");
		session.begin_turn().expect("turn");
		session
			.user("inspect the widgets", Vec::new())
			.expect("user");
		session
			.assistant_start("test/model", "test", "test/model")
			.expect("assistant");
		let turn = *session
			.dom()
			.children(session.dom().body())
			.last()
			.expect("turn");
		let assistant = session
			.dom()
			.children(turn)
			.iter()
			.copied()
			.find(|handle| {
				session
					.dom()
					.get(*handle)
					.is_some_and(|node| node.tag == Tag::Known(KnownTag::Assistant))
			})
			.expect("assistant handle");
		let stream = session
			.stream_open(assistant, PropId::Text.into())
			.expect("stream");
		session
			.stream_append(stream, "widgets look fine")
			.expect("delta");
		session.stream_close(stream).expect("close");
		session.assistant_end("stop").expect("end");
		session
			.receipt(omp_journal::data::TurnReceipt::tokens(12, 7, 0))
			.expect("receipt");
		session
	}

	fn view(session: &mut Session) -> AgentView {
		let (snapshot, events) = session.subscribe();
		AgentView { snapshot, events: Some(events) }
	}

	fn job(id: &str) -> JobRow {
		JobRow {
			id:         Str::new(id),
			kind:       Str::new_static("subagent"),
			status:     Str::new_static("running"),
			owner:      Str::new_static("Main"),
			agent:      Some(Str::new_static("task")),
			model:      None,
			started_ms: Some(epoch_ms()),
			data:       None,
		}
	}

	#[test]
	fn viewer_installs_the_controller_snapshot_when_subscription_settles() {
		let directory = tempdir().expect("temp directory");
		let mut session = child_session(directory.path());
		let (sender, pending) = flume::bounded(1);
		let mut viewer =
			TranscriptViewer::waiting(job("alpha"), pending, true, viewport(), &UiContext::default());
		assert!(!text(&mut viewer).contains("inspect the widgets"));
		assert!(sender.send(Ok(view(&mut session))).is_ok(), "subscription result");
		assert!(viewer.tick(Duration::ZERO));
		assert!(text(&mut viewer).contains("inspect the widgets"));
	}

	#[test]
	fn viewer_shows_user_text_header_footer_and_applies_patch_stream() {
		let directory = tempdir().expect("temp directory");
		let mut session = child_session(directory.path());
		let mut viewer = TranscriptViewer::with_view(
			job("alpha"),
			view(&mut session),
			true,
			viewport(),
			&UiContext::default(),
		);
		let painted = text(&mut viewer);
		assert!(painted.contains("Agent Hub"), "{painted}");
		assert!(painted.contains("alpha"), "{painted}");
		assert!(painted.contains("running"), "{painted}");
		assert!(painted.contains("test/model"), "model missing:\n{painted}");
		assert!(painted.contains("inspect the widgets"), "user text missing:\n{painted}");
		assert!(painted.contains("widgets look fine"), "assistant text missing:\n{painted}");
		assert!(painted.contains("19 tok"), "stats missing:\n{painted}");
		assert!(painted.contains("Enter:send"), "hint missing:\n{painted}");

		session.begin_turn().expect("turn");
		session.user("second question", Vec::new()).expect("user");
		assert!(viewer.tick(Duration::ZERO), "queued patches repaint");
		let painted = text(&mut viewer);
		assert!(painted.contains("second question"), "{painted}");
		assert_eq!(
			viewer.next_poll,
			Some(Duration::from_millis(STREAM_POLL_MS)),
			"the live stream schedules another non-blocking drain"
		);
	}

	#[test]
	fn viewer_input_gates_scrolling_and_esc_clears_before_closing() {
		let directory = tempdir().expect("temp directory");
		let mut session = child_session(directory.path());
		let mut viewer = TranscriptViewer::with_view(
			job("alpha"),
			view(&mut session),
			true,
			viewport(),
			&UiContext::default(),
		);
		assert_eq!(viewer.key(Key::Char('k')), PanelEvent::Consumed);
		assert!(!viewer.follow);
		assert_eq!(viewer.key(Key::Char('G')), PanelEvent::Consumed);
		assert!(viewer.follow);
		assert_eq!(viewer.key(Key::Char('h')), PanelEvent::Consumed);
		assert_eq!(viewer.key(Key::Char('i')), PanelEvent::Consumed);
		assert_eq!(viewer.input, "hi");
		assert_eq!(viewer.key(Key::Char('j')), PanelEvent::Consumed);
		assert_eq!(viewer.input, "hij", "typing owns j once the input has text");
		assert_eq!(
			viewer.key(Key::Enter),
			PanelEvent::Command(HostCommand::Agent {
				id: Str::new_static("alpha"),
				op: AgentOp::Send(Str::new_static("hij")),
			})
		);
		assert!(viewer.input.is_empty());
		assert_eq!(viewer.key(Key::Char('x')), PanelEvent::Consumed);
		assert_eq!(viewer.key(Key::Esc), PanelEvent::Consumed);
		assert!(viewer.input.is_empty());
		assert_eq!(viewer.key(Key::Esc), PanelEvent::Close);
		assert_eq!(viewer.action(PanelAction::Expand), PanelEvent::Consumed);
		assert!(viewer.expanded);
	}

	#[test]
	fn session_stem_mirrors_the_spawner() {
		assert_eq!(session_stem("alpha"), "alpha");
		assert_eq!(session_stem("a b/c"), "a_b_c");
	}
}
