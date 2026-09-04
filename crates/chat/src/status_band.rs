//! Composer status band docked to the
//! composer (`status-line/component.ts` `#buildStatusLine`).

use core::fmt::Write as _;
use std::{sync::Arc, time::Duration};

use jiff::Zoned;
use omp_con::Kv;
use omp_core::{Str, StrMut, sf};
use omp_tui::{
	Appearance, Charset, Color, Component, Icon, PaintCtx, Prop, Props, Rect, Slot, Style, Theme,
	UiContext,
	anim::{Easing, Tween},
	cell_width,
	components::{
		CompactionBoundaries, ContextGauge, GaugeCell, advisor_spend_label,
		compaction_boundary_color, spend_label, write_compact_count,
	},
	next_slot, session_accent_color,
};
use serde::{Deserialize, Serialize};
use smallvec::SmallVec;

use crate::chrome::STATUS_ID;

/// Longest path label in the status band ( `clampPathLength` default).
const PATH_MAX: u16 = 40;

/// Status-line segment preset.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum StatusPreset {
	/// Balanced launch/runtime bar.
	#[default]
	Default,
	/// Path, branch, title, mode, and context only.
	Minimal,
	/// Model/mode/VCS with title, cost, and context.
	Compact,
	/// Full diagnostic status.
	Full,
	/// Full diagnostic status with Nerd Font-oriented identities.
	Nerd,
	/// ASCII-safe compact status.
	Ascii,
	/// Host-supplied custom order; until arrays are supplied it follows the
	/// custom defaults.
	Custom,
}

/// Separator family between status segments.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum StatusSeparator {
	/// Full powerline wedge.
	Powerline,
	/// Thin powerline divider and solid end cap.
	#[default]
	PowerlineThin,
	/// Slash.
	Slash,
	/// Vertical pipe.
	Pipe,
	/// Block.
	Block,
	/// Space only.
	None,
	/// Seven-bit arrows.
	Ascii,
}

/// Context-line presentation.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum ContextLine {
	/// Solid identity rule.
	Off,
	/// Proportional used/remainder rule.
	Percentage,
	/// Proportional rule with compaction markers.
	Annotated,
	/// Markers plus percent/window labels.
	#[default]
	Embedded,
}

/// One configurable status-line segment.
///
/// String forms are the public `StatusLineSegmentId` vocabulary. Unknown
/// strings are intentionally rejected by `FromStr`; the host drops them
/// while retaining every known occurrence in declaration order.
#[derive(Clone, Copy, Debug, Eq, PartialEq, strum::EnumString, strum::IntoStaticStr)]
#[strum(serialize_all = "snake_case")]
pub enum StatusSegment {
	/// Omp identity / activity timer.
	Pi,
	/// Extension and hook status values.
	Status,
	/// Active model and thinking level.
	Model,
	/// Active workflow Director.
	Mode,
	/// Project path.
	Path,
	/// Git branch and worktree counts.
	Git,
	/// Pull request number.
	Pr,
	/// Running subagent count.
	Subagents,
	/// Input token count.
	TokenIn,
	/// Output token count.
	TokenOut,
	/// Input, output, and cache-write token count.
	TokenTotal,
	/// Output token rate.
	TokenRate,
	/// Session spend.
	Cost,
	/// Context-window percentage.
	ContextPct,
	/// Context-window size.
	ContextTotal,
	/// Active processing time.
	TimeSpent,
	/// Local wall clock.
	Time,
	/// Short session id.
	Session,
	/// Local hostname.
	Hostname,
	/// Prompt-cache read count.
	CacheRead,
	/// Prompt-cache write count.
	CacheWrite,
	/// Prompt-cache hit percentage.
	CacheHit,
	/// Session title.
	SessionName,
	/// Account quota windows.
	Usage,
	/// Collaboration role and participant count.
	Collab,
}

/// Model-segment overrides.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct ModelSegmentOptions {
	/// Whether to include the thinking level.
	pub show_thinking_level: Option<bool>,
}

/// Path-segment overrides.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct PathSegmentOptions {
	/// Whether to replace the home prefix with `~`.
	pub abbreviate:        Option<bool>,
	/// Maximum visible path cells.
	pub max_length:        Option<u16>,
	/// Whether to strip `/work`, `~/Projects`, and scratch roots.
	pub strip_work_prefix: Option<bool>,
}

/// Git-segment overrides.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct GitSegmentOptions {
	/// Whether to include the branch.
	pub show_branch:    Option<bool>,
	/// Whether to include the staged count.
	pub show_staged:    Option<bool>,
	/// Whether to include the unstaged count.
	pub show_unstaged:  Option<bool>,
	/// Whether to include the untracked count.
	pub show_untracked: Option<bool>,
}

/// Clock-segment overrides.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct TimeSegmentOptions {
	/// Twelve- or twenty-four-hour display.
	pub format:       Option<WallClockFormat>,
	/// Whether to include seconds.
	pub show_seconds: Option<bool>,
}

/// Typed status-segment options.
///
/// Missing fields inherit the active preset. Unknown keys are ignored for
/// forward compatibility; malformed recognized fields reject the whole
/// update so the host can retain the last valid appearance.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct StatusSegmentOptions {
	/// Model options.
	pub model: ModelSegmentOptions,
	/// Path options.
	pub path:  PathSegmentOptions,
	/// Git options.
	pub git:   GitSegmentOptions,
	/// Clock options.
	pub time:  TimeSegmentOptions,
}

impl StatusSegmentOptions {
	/// Parses the nested `segmentOptions` record.
	#[must_use]
	pub fn from_kv(options: &Kv) -> Option<Self> {
		let mut parsed = Self::default();
		for (segment, value) in options.iter() {
			match segment.as_str() {
				"model" => {
					let block = value.as_kv()?;
					for (key, value) in block.iter() {
						if key == "showThinkingLevel" {
							parsed.model.show_thinking_level = Some(value.as_bool()?);
						}
					}
					continue;
				},
				"path" => {
					let block = value.as_kv()?;
					for (key, value) in block.iter() {
						match key.as_str() {
							"abbreviate" => parsed.path.abbreviate = Some(value.as_bool()?),
							"maxLength" => {
								parsed.path.max_length =
									Some(u16::try_from(value.as_int()?).ok().filter(|n| *n > 0)?);
							},
							"stripWorkPrefix" => {
								parsed.path.strip_work_prefix = Some(value.as_bool()?);
							},
							_ => {},
						}
					}
					continue;
				},
				"git" => {
					let block = value.as_kv()?;
					for (key, value) in block.iter() {
						let target = match key.as_str() {
							"showBranch" => &mut parsed.git.show_branch,
							"showStaged" => &mut parsed.git.show_staged,
							"showUnstaged" => &mut parsed.git.show_unstaged,
							"showUntracked" => &mut parsed.git.show_untracked,
							_ => continue,
						};
						*target = Some(value.as_bool()?);
					}
					continue;
				},
				"time" => {
					let block = value.as_kv()?;
					for (key, value) in block.iter() {
						match key.as_str() {
							"format" => {
								parsed.time.format = Some(match value.as_str()? {
									"12h" => WallClockFormat::TwelveHour,
									"24h" => WallClockFormat::TwentyFourHour,
									_ => return None,
								});
							},
							"showSeconds" => parsed.time.show_seconds = Some(value.as_bool()?),
							_ => {},
						}
					}
					continue;
				},
				_ => {},
			}
		}
		Some(parsed)
	}

	fn overlay(self, overrides: Self) -> Self {
		Self {
			model: ModelSegmentOptions {
				show_thinking_level: overrides
					.model
					.show_thinking_level
					.or(self.model.show_thinking_level),
			},
			path:  PathSegmentOptions {
				abbreviate:        overrides.path.abbreviate.or(self.path.abbreviate),
				max_length:        overrides.path.max_length.or(self.path.max_length),
				strip_work_prefix: overrides
					.path
					.strip_work_prefix
					.or(self.path.strip_work_prefix),
			},
			git:   GitSegmentOptions {
				show_branch:    overrides.git.show_branch.or(self.git.show_branch),
				show_staged:    overrides.git.show_staged.or(self.git.show_staged),
				show_unstaged:  overrides.git.show_unstaged.or(self.git.show_unstaged),
				show_untracked: overrides.git.show_untracked.or(self.git.show_untracked),
			},
			time:  TimeSegmentOptions {
				format:       overrides.time.format.or(self.time.format),
				show_seconds: overrides.time.show_seconds.or(self.time.show_seconds),
			},
		}
	}
}

/// Retained status appearance, including settings-preview overrides.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StatusAppearance {
	/// Segment preset.
	pub preset:          StatusPreset,
	/// Segment separator.
	pub separator:       StatusSeparator,
	/// Flexible context-line mode.
	pub context_line:    ContextLine,
	/// Drop fill and powerline caps.
	pub transparent:     bool,
	/// Custom left-group order. Only the `custom` preset reads this field.
	pub left_segments:   Arc<[StatusSegment]>,
	/// Custom right-group order. Only the `custom` preset reads this field.
	pub right_segments:  Arc<[StatusSegment]>,
	/// User overrides layered over the active preset's segment defaults.
	pub segment_options: StatusSegmentOptions,
}

impl Default for StatusAppearance {
	fn default() -> Self {
		Self::for_preset(StatusPreset::Default)
	}
}

impl StatusAppearance {
	/// Default separator for a preset.
	#[must_use]
	pub fn for_preset(preset: StatusPreset) -> Self {
		let separator = match preset {
			StatusPreset::Full | StatusPreset::Nerd => StatusSeparator::Powerline,
			StatusPreset::Ascii => StatusSeparator::Ascii,
			StatusPreset::Minimal => StatusSeparator::Slash,
			StatusPreset::Default | StatusPreset::Compact | StatusPreset::Custom => {
				StatusSeparator::PowerlineThin
			},
		};
		Self {
			preset,
			separator,
			context_line: ContextLine::Embedded,
			transparent: false,
			left_segments: Arc::default(),
			right_segments: Arc::default(),
			segment_options: StatusSegmentOptions::default(),
		}
	}

	fn effective_segment_options(&self) -> StatusSegmentOptions {
		let preset = match self.preset {
			StatusPreset::Minimal => StatusSegmentOptions {
				path: PathSegmentOptions { max_length: Some(30), ..PathSegmentOptions::default() },
				git: GitSegmentOptions {
					show_branch:    Some(true),
					show_staged:    Some(false),
					show_unstaged:  Some(false),
					show_untracked: Some(false),
				},
				..StatusSegmentOptions::default()
			},
			StatusPreset::Compact => StatusSegmentOptions {
				model: ModelSegmentOptions { show_thinking_level: Some(false) },
				git: GitSegmentOptions { show_untracked: Some(false), ..GitSegmentOptions::default() },
				..StatusSegmentOptions::default()
			},
			StatusPreset::Full => StatusSegmentOptions {
				path: PathSegmentOptions { max_length: Some(50), ..PathSegmentOptions::default() },
				time: TimeSegmentOptions {
					format:       Some(WallClockFormat::TwentyFourHour),
					show_seconds: Some(false),
				},
				..StatusSegmentOptions::default()
			},
			StatusPreset::Nerd => StatusSegmentOptions {
				path: PathSegmentOptions { max_length: Some(60), ..PathSegmentOptions::default() },
				time: TimeSegmentOptions {
					format:       Some(WallClockFormat::TwentyFourHour),
					show_seconds: Some(true),
				},
				..StatusSegmentOptions::default()
			},
			StatusPreset::Default | StatusPreset::Ascii | StatusPreset::Custom => {
				StatusSegmentOptions::default()
			},
		};
		preset.overlay(self.segment_options)
	}

	/// Resolves preset defaults, nested `segmentOptions.time` values,
	/// and the two curated clock overrides. Presets without a configured
	/// `time` segment return `None`, so an invisible clock owns no timer.
	#[must_use]
	pub fn wall_clock_options(
		&self,
		format: WallClockFormatSetting,
		seconds: WallClockSecondsSetting,
	) -> Option<WallClockOptions> {
		let has_time = match self.preset {
			StatusPreset::Full | StatusPreset::Nerd => true,
			StatusPreset::Custom => self
				.left_segments
				.iter()
				.chain(self.right_segments.iter())
				.any(|segment| *segment == StatusSegment::Time),
			StatusPreset::Default
			| StatusPreset::Minimal
			| StatusPreset::Compact
			| StatusPreset::Ascii => false,
		};
		if !has_time {
			return None;
		}
		let resolved = self.effective_segment_options().time;
		let mut options = WallClockOptions {
			format:       resolved.format.unwrap_or(WallClockFormat::TwentyFourHour),
			show_seconds: resolved.show_seconds.unwrap_or(false),
		};
		options.format = match format {
			WallClockFormatSetting::Preset => options.format,
			WallClockFormatSetting::TwelveHour => WallClockFormat::TwelveHour,
			WallClockFormatSetting::TwentyFourHour => WallClockFormat::TwentyFourHour,
		};
		options.show_seconds = match seconds {
			WallClockSecondsSetting::Preset => options.show_seconds,
			WallClockSecondsSetting::Hide => false,
			WallClockSecondsSetting::Show => true,
		};
		Some(options)
	}
}

/// User override for the clock's hour format. `Preset` preserves the
/// per-preset option.
#[derive(
	Clone,
	Copy,
	Debug,
	Default,
	Eq,
	PartialEq,
	Deserialize,
	Serialize,
	strum::Display,
	strum::EnumString,
	strum::IntoStaticStr,
	strum::VariantNames,
)]
#[strum(ascii_case_insensitive)]
pub enum WallClockFormatSetting {
	/// Use the active preset's format.
	#[default]
	#[strum(serialize = "preset")]
	Preset,
	/// Twelve-hour time with a lowercase `am`/`pm` suffix.
	#[strum(serialize = "12h")]
	TwelveHour,
	/// Twenty-four-hour time.
	#[strum(serialize = "24h")]
	TwentyFourHour,
}
omp_con::con_enum!(WallClockFormatSetting);

/// User override for whether the clock includes seconds. `Preset` preserves
/// 's full/nerd distinction.
#[derive(
	Clone,
	Copy,
	Debug,
	Default,
	Eq,
	PartialEq,
	Deserialize,
	Serialize,
	strum::Display,
	strum::EnumString,
	strum::IntoStaticStr,
	strum::VariantNames,
)]
#[strum(serialize_all = "lowercase", ascii_case_insensitive)]
pub enum WallClockSecondsSetting {
	/// Use the active preset's choice.
	#[default]
	Preset,
	/// Update once a minute and hide seconds.
	Hide,
	/// Update once a second and show seconds.
	Show,
}
omp_con::con_enum!(WallClockSecondsSetting);

/// Resolved local clock format for a visible preset.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WallClockFormat {
	/// Twelve-hour time with a lowercase `am`/`pm` suffix.
	TwelveHour,
	/// Twenty-four-hour time.
	TwentyFourHour,
}

/// Resolved options for a visible local clock.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WallClockOptions {
	/// Hour format.
	pub format:       WallClockFormat,
	/// Whether seconds are visible.
	pub show_seconds: bool,
}

/// Formats one already-sampled local time. Callers cache the returned value;
/// painting reads the cache and never reads the clock or timezone.
#[must_use]
pub(crate) fn format_wall_clock(now: &Zoned, options: WallClockOptions) -> Str {
	let hour = now.hour();
	let mut out = StrMut::new_inline("");
	match options.format {
		WallClockFormat::TwelveHour => {
			let display = hour % 12;
			let _ = write!(out, "{}:{:02}", if display == 0 { 12 } else { display }, now.minute());
		},
		WallClockFormat::TwentyFourHour => {
			let _ = write!(out, "{hour}:{:02}", now.minute());
		},
	}
	if options.show_seconds {
		let _ = write!(out, ":{:02}", now.second());
	}
	if options.format == WallClockFormat::TwelveHour {
		out.push_str(if hour >= 12 { "pm" } else { "am" });
	}
	out.freeze()
}

/// Next host-clock instant at which [`format_wall_clock`] can change.
///
/// The deadline follows the visible unit rather than a repaint cadence:
/// seconds when shown, otherwise minutes.
#[must_use]
pub(crate) fn wall_clock_next_wake(
	host_now: Duration,
	local_now: &Zoned,
	options: WallClockOptions,
) -> Duration {
	const NANOS_PER_SECOND: u64 = 1_000_000_000;
	let unit_seconds = if options.show_seconds { 1 } else { 60 };
	let elapsed_seconds = u64::try_from(local_now.second()).unwrap_or_default() % unit_seconds;
	let subsec = u64::try_from(local_now.subsec_nanosecond()).unwrap_or_default();
	let remaining = unit_seconds
		.saturating_sub(elapsed_seconds)
		.saturating_mul(NANOS_PER_SECOND)
		.saturating_sub(subsec)
		.max(1);
	host_now.saturating_add(Duration::from_nanos(remaining))
}

/// Background compaction speculation state shown on the gauge tick (
/// `compactionSpeculation`).
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum Speculation {
	/// No speculative compaction in flight.
	#[default]
	None,
	/// A background summary is being produced; the tick pulses.
	Running,
	/// A summary is ready to apply at the threshold; the tick holds accent.
	Armed,
}

/// Worst status across the advisor roster ( `getAdvisorStatusOverview`).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AdvisorHealth {
	/// Every advisor is running.
	Running,
	/// At least one advisor is out of quota.
	QuotaExhausted,
	/// At least one advisor failed.
	Error,
	/// Everything is paused or has no model.
	Paused,
}

/// Advisor badge after the model name.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AdvisorBadge {
	/// Roster health; picks the badge color.
	pub health:  AdvisorHealth,
	/// Every advisor finished reviewing the yielded turn (closed eye).
	pub yielded: bool,
}

/// Exact porcelain counts shown after the branch ('s `git` segment).
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct GitStatus {
	/// Files staged in the index.
	pub staged:    u32,
	/// Tracked files changed in the worktree.
	pub unstaged:  u32,
	/// Untracked entries.
	pub untracked: u32,
}

impl GitStatus {
	/// Whether any status class is non-empty.
	#[must_use]
	pub const fn dirty(self) -> bool {
		self.staged != 0 || self.unstaged != 0 || self.untracked != 0
	}
}

/// Pull request associated with the checked-out branch.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PullRequest {
	/// GitHub pull request number.
	pub number: u64,
	/// Target URL used by hyperlink-capable presenters.
	pub url:    Str,
}

/// Linked-worktree display identity. The path segment collapses the nested
/// checkout path to `project`, adding `worktree` only when it differs from the
/// branch already visible beside it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorktreeLabel {
	/// Shared primary checkout directory name.
	pub project:  Str,
	/// Linked checkout directory name.
	pub worktree: Str,
}

/// One provider-account quota window for the `usage` segment.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct UsageWindow {
	/// Used percentage.
	pub percent:     f64,
	/// Time until reset. Minute windows retain minute precision; long windows
	/// format as hours/days.
	pub reset_after: Option<Duration>,
}

/// Cached provider-account usage. Fetchers update this off the paint path.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct AccountUsage {
	/// Human-facing account/tier label.
	pub tier:      Option<Str>,
	/// Five-hour request window.
	pub five_hour: Option<UsageWindow>,
	/// Daily request window.
	pub daily:     Option<UsageWindow>,
	/// Seven-day request window.
	pub seven_day: Option<UsageWindow>,
	/// Monthly request window.
	pub monthly:   Option<UsageWindow>,
}

/// Local collaboration role shown by the `collab` segment.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CollabStatusRole {
	/// This controller owns the authoritative session.
	Host,
	/// This actor renders the host's replicated session.
	Guest,
}

/// Status-line values published by the authoritative host.
///
/// The guest uses these instead of observer-local approximations. Participant
/// presence is carried by [`CollabStatus`] because it changes independently
/// from this debounced session snapshot.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct CollabHostSnapshot {
	/// Host model label, when the host published model metadata.
	pub model:          Option<Str>,
	/// Host reasoning level; `None` authoritatively means reasoning is off.
	pub thinking:       Option<Str>,
	/// Host working directory. The actor applies status-path normalization.
	pub cwd:            Str,
	/// Host session title; `None` authoritatively means unnamed.
	pub session_name:   Option<Str>,
	/// Host's provider-anchored context token count.
	pub tokens:         Option<u64>,
	/// Host model context window.
	pub context_window: Option<u64>,
}

/// Collaboration facts projected into the status band.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CollabStatus {
	/// Whether this observer owns or replicates the authoritative session.
	pub role:         CollabStatusRole,
	/// Connected participants, including the local observer.
	pub participants: u32,
	/// Latest authoritative footer snapshot. Present only for guests.
	pub host:         Option<Arc<CollabHostSnapshot>>,
}

const _: () = assert!(
	core::mem::size_of::<CollabStatus>() <= 16,
	"CollabStatus must remain cheap to clone into status facts"
);

impl CollabStatus {
	/// Constructs host status from the current authenticated presence count.
	#[must_use]
	pub const fn host(participants: u32) -> Self {
		Self { role: CollabStatusRole::Host, participants, host: None }
	}

	/// Constructs guest presence before the first authoritative footer
	/// snapshot arrives.
	#[must_use]
	pub const fn guest_pending(participants: u32) -> Self {
		Self { role: CollabStatusRole::Guest, participants, host: None }
	}

	/// Constructs guest status from host-published presence and footer values.
	#[must_use]
	pub fn guest(participants: u32, host: CollabHostSnapshot) -> Self {
		Self { role: CollabStatusRole::Guest, participants, host: Some(Arc::new(host)) }
	}
}

/// Lifecycle of an engaged goal Director ( `goalMode.status`).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GoalState {
	/// Working toward the objective.
	Active,
	/// Temporarily paused while preserving the objective.
	Paused,
	/// The objective was met.
	Complete,
	/// The token budget ran out first.
	BudgetLimited,
	/// The goal was dropped.
	Dropped,
}

/// Bounded loop status shown by the mode segment.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LoopLimit {
	/// Remaining and initial iteration counts.
	Iterations {
		/// Iterations still available.
		remaining: u64,
		/// Original iteration budget.
		initial:   u64,
	},
	/// Remaining wall-clock duration.
	Duration(Duration),
}

/// The active Director workflow shown as the band's mode chip ( `mode`
/// segment). At most one shows, in precedence: plan, prewalk, goal,
/// vibe, loop.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ModeChip {
	/// The plan Director is engaged.
	Plan,
	/// The plan Director is paused.
	PlanPaused,
	/// Prewalk is armed and controls the model handoff.
	Prewalk,
	/// The goal Director is engaged.
	Goal(GoalState),
	/// The vibe Director is engaged.
	Vibe,
	/// Loop mode is engaged but waiting for its first/next prompt.
	LoopWaiting {
		/// Optional iteration or duration bound.
		limit: Option<LoopLimit>,
	},
	/// Loop mode is engaged and running.
	Loop {
		/// Optional iteration or duration bound.
		limit: Option<LoopLimit>,
	},
	/// Loop mode is paused, retaining its optional bound.
	LoopPaused {
		/// Optional iteration or duration bound.
		limit: Option<LoopLimit>,
	},
}

/// Facts painted by the composer status band.
#[derive(Clone, Debug, PartialEq)]
pub struct StatusFacts {
	/// Short model label.
	pub model: Str,
	/// Active Director workflow, when one owns subsequent turns.
	pub mode: Option<ModeChip>,
	/// Reasoning level (`off`, `minimal` … `max`) when the model can reason;
	/// `None` for models without thinking.
	pub thinking: Option<Str>,
	/// Whether the thinking glyph replaces the model icon instead of trailing
	/// the name as ` · <level>` ( `statusLine.compactThinkingLevel`).
	pub compact_thinking: bool,
	/// Fast mode is on (`ai_fastmode`); the fast icon trails the model name.
	pub fast: bool,
	/// Advisor roster badge after the model name, when advisors are
	/// configured.
	pub advisor: Option<AdvisorBadge>,
	/// Project directory label: home-shortened and root-stripped, not yet
	/// clamped (the band clamps to the width it has).
	pub cwd: Str,
	/// Exact project directory before path-segment presentation options.
	pub raw_cwd: Option<Str>,
	/// Exact home directory used by path abbreviation.
	pub home: Option<Str>,
	/// Whether the project lives under a scratch root ( `scratchFolder`
	/// icon instead of the folder icon).
	pub scratch: bool,
	/// Absolute `file://` hyperlink target for the displayed path.
	pub path_url: Option<Str>,
	/// Checked-out git branch, an observer-local fact the app supplies.
	pub branch: Option<Str>,
	/// Exact staged/unstaged/untracked counts. `None` while the first
	/// background probe is pending.
	pub git_status: Option<GitStatus>,
	/// Pull request associated with the branch.
	pub pull_request: Option<PullRequest>,
	/// Linked-worktree identity used to collapse redundant path components.
	pub worktree: Option<WorktreeLabel>,
	/// Collaboration role, presence, and guest-only host status snapshot.
	pub collab: Option<CollabStatus>,
	/// Sanitized extension/hook status strings, already key-sorted by the host.
	pub hook_status: Vec<Str>,
	/// Number of running subagents.
	pub subagents: u32,
	/// Number of background jobs not already represented by `subagents`.
	pub background_jobs: u32,
	/// Short durable session id for the optional `session` segment.
	pub session_id: Option<Str>,
	/// Host label for the optional `hostname` segment.
	pub hostname: Option<Str>,
	/// Preformatted local wall clock (`H:MM`, optionally seconds/suffix),
	/// refreshed by the observer only when its visible unit changes.
	pub wall_time: Option<Str>,
	/// User-facing session title, the elastic right-group chip.
	pub session_name: Option<Str>,
	/// Status visual configuration.
	pub appearance: StatusAppearance,
	/// Tokens in the last inference request (context usage).
	pub tokens: u64,
	/// Total context window when known.
	pub context_window: Option<u64>,
	/// Auto-compaction threshold as a whole percent of the window
	/// (`ai_compact_threshold`), the gauge's tick position.
	pub compact_percent: u8,
	/// Background compaction speculation, animating the threshold tick.
	pub speculation: Speculation,
	/// Context percentage where background speculation begins; `None` when
	/// async/local compaction has no meaningful start marker.
	pub speculation_percent: Option<f64>,
	/// Cumulative input tokens across the session.
	pub tokens_in: u64,
	/// Cumulative output tokens across the session.
	pub tokens_out: u64,
	/// Cumulative prompt-cache tokens read (excluded from the total: it
	/// re-reads the whole cached context every turn).
	pub cache_read: u64,
	/// Cumulative prompt-cache tokens written.
	pub cache_write: u64,
	/// Output throughput of the last receipt.
	pub tokens_per_second: Option<f32>,
	/// Cumulative spend in nano-US dollars.
	pub cost_nano_usd: u64,
	/// The route bills to a subscription rather than metered usage.
	pub subscription: bool,
	/// Advisor spend in nano-US dollars, kept distinct from the main route.
	pub advisor_cost_nano_usd: u64,
	/// The advisor route bills to a subscription.
	pub advisor_subscription: bool,
	/// Cached account/tier quota windows.
	pub account_usage: Option<AccountUsage>,
	/// Display-quantized total active processing time; idle wall-clock time is
	/// excluded.
	pub active_time: Duration,
	/// Premium-request units consumed at millionth precision (GitHub Copilot
	/// `premium_interactions`: `330_000` is 0.33 of a request).
	pub premium_requests_millionths: u64,
	/// Start of the in-flight turn on the presentation clock; `Some` swaps
	/// the brand glyph for the spinner and elapsed-time timer.
	pub working: Option<Duration>,
	/// Subagent whose session the view shows ( `focusedAgentId`): the
	/// brand slot carries the ghost and the agent id in the warning color
	/// for as long as input goes to that agent.
	pub focused_agent: Option<Str>,
}

impl Default for StatusFacts {
	fn default() -> Self {
		Self {
			model: Str::default(),
			mode: None,
			thinking: None,
			compact_thinking: true,
			fast: false,
			advisor: None,
			cwd: Str::default(),
			raw_cwd: None,
			home: None,
			scratch: false,
			path_url: None,
			branch: None,
			git_status: None,
			pull_request: None,
			worktree: None,
			collab: None,
			hook_status: Vec::new(),
			subagents: 0,
			background_jobs: 0,
			session_id: None,
			hostname: None,
			wall_time: None,
			session_name: None,
			appearance: StatusAppearance::default(),
			tokens: 0,
			context_window: None,
			compact_percent: 80,
			speculation: Speculation::None,
			speculation_percent: None,
			tokens_in: 0,
			tokens_out: 0,
			cache_read: 0,
			cache_write: 0,
			tokens_per_second: None,
			cost_nano_usd: 0,
			subscription: false,
			advisor_cost_nano_usd: 0,
			advisor_subscription: false,
			account_usage: None,
			active_time: Duration::ZERO,
			premium_requests_millionths: 0,
			working: None,
			focused_agent: None,
		}
	}
}

impl StatusFacts {
	/// Applies collaboration state to freshly projected local facts.
	///
	/// Host facts keep their local values. Guest facts replace values whose
	/// local computation can diverge from the authoritative controller. A
	/// disconnected actor passes `None`; because callers rebuild base facts
	/// before each application, no host override survives a leave or session
	/// reset.
	pub fn apply_collab(&mut self, collab: Option<CollabStatus>) {
		if let Some(status) = collab.as_ref()
			&& status.role == CollabStatusRole::Guest
			&& let Some(host) = status.host.as_ref()
		{
			if let Some(model) = host.model.as_ref().filter(|model| !model.is_empty()) {
				self.model = model.clone();
			}
			self.thinking = host.thinking.clone();
			if !host.cwd.is_empty() {
				let path = display_path(&host.cwd, None, None);
				self.raw_cwd = Some(host.cwd.clone());
				self.cwd = path.text;
				self.scratch = path.scratch;
				self.path_url = None;
			}
			self.session_name = host.session_name.clone();
			if let Some(tokens) = host.tokens {
				self.tokens = tokens;
			}
			if let Some(context_window) = host.context_window {
				self.context_window = Some(context_window);
			}
		}
		self.collab = collab;
	}
}

/// Project label for the status band.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PathLabel {
	/// Display text, not yet clamped.
	pub text:    Str,
	/// Whether the path sits under a scratch (temporary) root.
	pub scratch: bool,
}

/// Scratch roots relabeled with the trash icon: the
/// platform temp dir plus the conventional temp locations.
const SCRATCH_ROOTS: [&str; 4] = ["/tmp", "/var/tmp", "/private/tmp", "/private/var/tmp"];
/// Roots dropped from the label.
const DISPLAY_ROOTS: [&str; 1] = ["/work"];

/// Path relative to `root` when `path` sits strictly inside it.
fn within_root<'a>(root: &str, path: &'a str) -> Option<&'a str> {
	let root = root.trim_end_matches('/');
	if root.is_empty() {
		return None;
	}
	path
		.strip_prefix(root)
		.and_then(|rest| rest.strip_prefix('/'))
		.filter(|rest| !rest.is_empty())
}

/// Labels a project path for the status band.
///
/// Scratch roots become relative labels with the scratch icon, `/work` and
/// `~/Projects` are stripped, and the home prefix becomes `~`. `tmp` is the
/// platform temp directory (`std::env::temp_dir`).
#[must_use]
pub fn display_path(path: &str, home: Option<&str>, tmp: Option<&str>) -> PathLabel {
	let home = home.filter(|home| !home.is_empty());
	let home_tmp = home.map(|home| format!("{home}/tmp"));
	let scratch_roots = tmp
		.into_iter()
		.chain(home_tmp.as_deref())
		.chain(SCRATCH_ROOTS);
	for root in scratch_roots {
		if path == root.trim_end_matches('/') {
			return PathLabel { text: shorten_home(path, home), scratch: true };
		}
		if let Some(relative) = within_root(root, path) {
			return PathLabel { text: Str::new(relative), scratch: true };
		}
	}
	let projects = home.map(|home| format!("{home}/Projects"));
	for root in projects.as_deref().into_iter().chain(DISPLAY_ROOTS) {
		if let Some(relative) = within_root(root, path) {
			return PathLabel { text: Str::new(relative), scratch: false };
		}
	}
	PathLabel { text: shorten_home(path, home), scratch: false }
}

/// `~` for the home prefix ( `shortenPath`).
fn shorten_home(path: &str, home: Option<&str>) -> Str {
	match home {
		Some(home) if path == home => Str::new_static("~"),
		Some(home) => match path.strip_prefix(home) {
			Some(rest) if rest.starts_with('/') => Str::new(format!("~{rest}")),
			_ => Str::new(path),
		},
		None => Str::new(path),
	}
}

fn expand_home(path: &str, home: Option<&str>) -> Str {
	match (path, home) {
		("~", Some(home)) => Str::new(home),
		(path, Some(home)) if path.starts_with("~/") => Str::new(format!("{home}{}", &path[1..])),
		_ => Str::new(path),
	}
}

/// Left-clamps a label to `max` cells with a leading ellipsis (
/// `clampPathLength`).
fn clamp_path(text: &str, max: u16) -> Str {
	if cell_width(text) <= max {
		return Str::new(text);
	}
	let budget = max.saturating_sub(1);
	let mut start = text.len();
	let mut used = 0;
	for (index, ch) in text.char_indices().rev() {
		let glyph = cell_width(&text[index..index + ch.len_utf8()]);
		if used + glyph > budget {
			break;
		}
		used += glyph;
		start = index;
	}
	Str::new(format!("…{}", &text[start..]))
}

/// Right-clamps a label to `max` cells with a trailing ellipsis (
/// `truncateToWidth` on the session title).
fn clamp_end(text: &str, max: u16) -> Str {
	if cell_width(text) <= max {
		return Str::new(text);
	}
	let budget = max.saturating_sub(1);
	let mut end = 0;
	let mut used = 0;
	for (index, ch) in text.char_indices() {
		let glyph = cell_width(&text[index..index + ch.len_utf8()]);
		if used + glyph > budget {
			break;
		}
		used += glyph;
		end = index + ch.len_utf8();
	}
	Str::new(format!("{}…", &text[..end]))
}

/// Turn timer in the brand slot: whole seconds, then minutes, then hours
/// capped at 99 ( `brandTimer`).
fn elapsed_label(out: &mut String, elapsed: Duration) {
	let seconds = elapsed.as_secs();
	if seconds < 60 {
		let _ = write!(out, "{seconds}s");
	} else if seconds < 3_600 {
		let _ = write!(out, "{}m", seconds / 60);
	} else {
		let _ = write!(out, "{}h", (seconds / 3_600).min(99));
	}
}

/// Premium-request count from millionths, rounded to two decimals with
/// trailing zeros dropped ( `normalizePremiumRequests` + `formatNumber`:
/// `330_000` → `0.33`, `1_500_000` → `1.5`, `2_000_000` → `2`); whole counts
/// of a thousand or more compact like every other count.
fn write_premium_requests(out: &mut String, millionths: u64) {
	let hundredths = millionths.saturating_add(5_000) / 10_000;
	let (whole, fraction) = (hundredths / 100, hundredths % 100);
	if fraction == 0 {
		let _ = write_compact_count(out, whole);
	} else if fraction % 10 == 0 {
		let _ = write!(out, "{whole}.{}", fraction / 10);
	} else {
		let _ = write!(out, "{whole}.{fraction:02}");
	}
}

fn count_label(charset: Charset, icon: Icon, value: u64) -> Str {
	let mut text = String::from(charset.icon(icon));
	if !text.is_empty() {
		text.push(' ');
	}
	let _ = write_compact_count(&mut text, value);
	Str::new(text)
}

fn context_percent_label(charset: Charset, tokens: u64, window: Option<u64>) -> Str {
	let mut text = String::from(charset.icon(Icon::Context));
	if !text.is_empty() {
		text.push(' ');
	}
	if let Some(window) = window.filter(|window| *window > 0) {
		let percent = tokens as f64 / window as f64 * 100.0;
		let _ = write!(text, "{percent:.1}%/");
		let _ = write_compact_count(&mut text, window);
	} else {
		let _ = write_compact_count(&mut text, tokens);
		text.push_str("/?");
	}
	Str::new(text)
}

fn context_color(theme: &Theme, tokens: u64, window: Option<u64>) -> Color {
	let Some(window) = window.filter(|window| *window > 0) else {
		return theme.status_context;
	};
	let percent = tokens as f64 / window as f64 * 100.0;
	if percent >= 90.0 || tokens >= 500_000 {
		theme.err
	} else if percent >= 70.0 || tokens >= 270_000 {
		theme.secondary
	} else if percent >= 50.0 || tokens >= 150_000 {
		theme.warn
	} else {
		theme.status_context
	}
}

fn append_git_counts(out: &mut String, status: GitStatus, options: GitSegmentOptions) {
	if options.show_unstaged.unwrap_or(true) && status.unstaged > 0 {
		let _ = write!(out, " *{}", status.unstaged);
	}
	if options.show_staged.unwrap_or(true) && status.staged > 0 {
		let _ = write!(out, " +{}", status.staged);
	}
	if options.show_untracked.unwrap_or(true) && status.untracked > 0 {
		let _ = write!(out, " ?{}", status.untracked);
	}
}

fn sanitize_status(value: &str) -> Str {
	let mut clean = String::with_capacity(value.len());
	let mut separated = false;
	for ch in value.chars() {
		if ch.is_control() || ch == '\n' || ch == '\r' {
			if !separated && !clean.is_empty() {
				clean.push(' ');
				separated = true;
			}
		} else {
			clean.push(ch);
			separated = ch.is_whitespace();
		}
	}
	Str::new(clean.trim())
}

fn active_time_label(charset: Charset, elapsed: Duration) -> Str {
	const MINUTE_MS: u128 = 60_000;
	const HOUR_MS: u128 = 60 * MINUTE_MS;
	const DAY_MS: u128 = 24 * HOUR_MS;

	let millis = elapsed.as_millis();
	let mut text = String::from(charset.icon(Icon::Time));
	if !text.is_empty() {
		text.push(' ');
	}
	if millis < MINUTE_MS {
		let _ = write!(text, "{:.1}s", millis as f64 / 1_000.0);
	} else if millis < HOUR_MS {
		let minutes = millis / MINUTE_MS;
		let seconds = millis % MINUTE_MS / 1_000;
		let _ = write!(text, "{minutes}m");
		if seconds > 0 {
			let _ = write!(text, "{seconds}s");
		}
	} else if millis < DAY_MS {
		let hours = millis / HOUR_MS;
		let minutes = millis % HOUR_MS / MINUTE_MS;
		let _ = write!(text, "{hours}h");
		if minutes > 0 {
			let _ = write!(text, "{minutes}m");
		}
	} else {
		let days = millis / DAY_MS;
		let hours = millis % DAY_MS / HOUR_MS;
		let _ = write!(text, "{days}d");
		if hours > 0 {
			let _ = write!(text, "{hours}h");
		}
	}
	Str::new(text)
}

fn write_reset(out: &mut String, reset: Duration, minute_window: bool) {
	let minutes = reset.as_secs().saturating_add(30) / 60;
	if minute_window {
		if minutes < 60 {
			let _ = write!(out, "{minutes}m");
		} else {
			let hours = minutes / 60;
			let rest = minutes % 60;
			let _ = write!(out, "{hours}h");
			if rest > 0 {
				let _ = write!(out, " {rest}m");
			}
		}
		return;
	}
	let hours = reset.as_secs().saturating_add(1_800) / 3_600;
	if hours < 24 {
		let _ = write!(out, "{hours}h");
	} else {
		let days = hours / 24;
		let rest = hours % 24;
		let _ = write!(out, "{days}d");
		if rest > 0 {
			let _ = write!(out, " {rest}h");
		}
	}
}

fn usage_color(theme: &Theme, percent: f64) -> Color {
	if percent >= 80.0 {
		theme.err
	} else if percent >= 50.0 {
		theme.warn
	} else {
		theme.muted
	}
}

type StyledPart = (u16, Str, Color);

fn write_usage_window(
	out: &mut String,
	parts: &mut SmallVec<StyledPart, 9>,
	label: &str,
	window: UsageWindow,
	minute_window: bool,
	floor_percent: bool,
	theme: &Theme,
) {
	if !out.is_empty() {
		out.push_str(" · ");
	}
	let _ = write!(out, "{label} ");
	let percent = if floor_percent {
		window.percent.floor()
	} else {
		window.percent.round()
	};
	let percent = sf!("{percent:.0}%");
	let offset = cell_width(out);
	out.push_str(&percent);
	parts.push((offset, percent, usage_color(theme, window.percent)));
	if let Some(reset) = window.reset_after {
		let mut reset_text = String::from(" (");
		write_reset(&mut reset_text, reset, minute_window);
		reset_text.push(')');
		let reset_text = Str::new(reset_text);
		let offset = cell_width(out);
		out.push_str(&reset_text);
		parts.push((offset, reset_text, theme.muted));
	}
}

fn account_usage_label(
	charset: Charset,
	usage: &AccountUsage,
	theme: &Theme,
	accent: Color,
) -> Option<(Str, SmallVec<StyledPart, 9>)> {
	if usage.five_hour.is_none()
		&& usage.daily.is_none()
		&& usage.seven_day.is_none()
		&& usage.monthly.is_none()
	{
		return None;
	}
	let mut text = String::new();
	let mut parts = SmallVec::new();
	if let Some(tier) = usage.tier.as_deref().filter(|tier| !tier.is_empty()) {
		let tier = clamp_end(&sanitize_status(tier), 40);
		let offset = cell_width(&text);
		text.push_str(&tier);
		parts.push((offset, tier, accent));
	}
	if let Some(window) = usage.five_hour {
		write_usage_window(&mut text, &mut parts, "5h", window, true, false, theme);
	}
	if let Some(window) = usage.daily {
		write_usage_window(&mut text, &mut parts, "1d", window, true, false, theme);
	}
	if let Some(window) = usage.seven_day {
		write_usage_window(&mut text, &mut parts, "7d", window, false, false, theme);
	}
	if let Some(window) = usage.monthly {
		write_usage_window(&mut text, &mut parts, "mo", window, false, true, theme);
	}
	if parts.is_empty() {
		return None;
	}
	let icon = charset.icon(Icon::Time);
	if !icon.is_empty() {
		let shift = cell_width(icon).saturating_add(1);
		for (offset, ..) in &mut parts {
			*offset = offset.saturating_add(shift);
		}
		text.insert(0, ' ');
		text.insert_str(0, icon);
	}
	Some((Str::new(text), parts))
}

/// Themed icon of a reasoning level ( `theme.thinking[level]`).
fn thinking_icon(level: &str) -> Icon {
	match level {
		"off" => Icon::Disabled,
		"auto" => Icon::AutoPending,
		"minimal" => Icon::Minimal,
		"low" => Icon::Low,
		"medium" => Icon::Medium,
		"high" => Icon::High,
		"xhigh" => Icon::Xhigh,
		"max" => Icon::Max,
		_ => Icon::Model,
	}
}

/// Glyph of a reasoning level for the compact model icon (
/// `thinkingGlyph`): the first token of the themed level label.
fn thinking_glyph(charset: Charset, level: &str) -> &'static str {
	charset
		.icon(thinking_icon(level))
		.split_whitespace()
		.next()
		.unwrap_or_default()
}

/// Brand-color fade across working-state edges ( `BRAND_FADE_MS`).
const BRAND_FADE: Duration = Duration::from_millis(450);
/// Repaint cadence while the brand fade is in flight (
/// `BRAND_FADE_FRAME_MS`).
const BRAND_FADE_FRAME: Duration = Duration::from_millis(40);
/// Narrowest path label retained before dropping other segments.
const PATH_MIN: u16 = 4;
/// Narrowest session title retained before dropping right segments.
const SESSION_NAME_MIN: u16 = 8;
/// Half-period of the compaction speculation pulse (
/// `#syncSpeculationBlink` `setInterval(…, 600)`).
const SPECULATION_BLINK: Duration = Duration::from_millis(600);

/// Whether the speculation pulse shows the accent phase at `now`: it starts
/// `on` and toggles every blink period.
const fn speculation_on(now: Duration) -> bool {
	(now.as_millis() / SPECULATION_BLINK.as_millis()).is_multiple_of(2)
}

/// Next presentation instant the speculation pulse flips.
fn speculation_flip(now: Duration) -> Duration {
	let period = SPECULATION_BLINK.as_millis();
	let next = (now.as_millis() / period + 1) * period;
	Duration::from_millis(u64::try_from(next).unwrap_or(u64::MAX))
}

/// Observer-clock accumulator for the union of active processing windows.
///
/// Repeated starts and stops are idempotent, so overlapping lifecycle signals
/// form one running window instead of double-counting. A session or branch
/// replacement resets both completed activity and the old in-flight window.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct ActiveTime {
	accumulated: Duration,
	started:     Option<Duration>,
}

impl ActiveTime {
	/// Starts or stops the current processing window at `now`.
	pub(crate) fn set_running(&mut self, now: Duration, running: bool) {
		match (self.started, running) {
			(None, true) => self.started = Some(now),
			(Some(started), false) => {
				self.accumulated = self.accumulated.saturating_add(now.saturating_sub(started));
				self.started = None;
			},
			(None, false) | (Some(_), true) => {},
		}
	}

	/// Starts a fresh meter for a replaced session or branch.
	pub(crate) fn reset(&mut self, now: Duration, running: bool) {
		self.accumulated = Duration::ZERO;
		self.started = running.then_some(now);
	}

	/// Returns completed activity plus the currently open window.
	#[must_use]
	pub(crate) fn elapsed(self, now: Duration) -> Duration {
		self.started.map_or(self.accumulated, |started| {
			self.accumulated.saturating_add(now.saturating_sub(started))
		})
	}

	/// Returns a stable value for [`StatusFacts::active_time`], changing only
	/// when [`active_time_label`] would paint different text.
	#[must_use]
	pub(crate) fn display_elapsed(self, now: Duration) -> Duration {
		let elapsed = self.elapsed(now);
		let millis = elapsed.as_millis();
		let visible_ms = if millis < 1_000 {
			0
		} else if millis < 60_000 {
			// Round to the nearest tenth while retaining
			// the sub-minute formatting branch for a rounded `60.0s`.
			((millis + 50) / 100 * 100).min(59_999)
		} else if millis < 3_600_000 {
			millis / 1_000 * 1_000
		} else if millis < 86_400_000 {
			millis / 60_000 * 60_000
		} else {
			millis / 3_600_000 * 3_600_000
		};
		Duration::from_millis(visible_ms.try_into().unwrap_or(u64::MAX))
	}

	/// Next instant at which the visible active-time label changes.
	#[must_use]
	pub(crate) fn next_wake(self, now: Duration) -> Option<Duration> {
		self.started?;
		let elapsed = self.elapsed(now);
		let millis = elapsed.as_millis();
		let next_ms = if millis < 1_000 {
			1_000
		} else if millis < 60_000 {
			let rounded_tenths = (millis + 50) / 100;
			(rounded_tenths * 100 + 50).min(60_000)
		} else if millis < 3_600_000 {
			(millis / 1_000 + 1) * 1_000
		} else if millis < 86_400_000 {
			(millis / 60_000 + 1) * 60_000
		} else {
			(millis / 3_600_000 + 1) * 3_600_000
		};
		let next_elapsed = Duration::from_millis(next_ms.try_into().unwrap_or(u64::MAX));
		Some(now.saturating_add(next_elapsed.saturating_sub(elapsed)))
	}
}

/// Identity of one band segment, for overflow policy.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Chip {
	Brand,
	Model,
	Mode,
	Collab,
	Path,
	Git,
	Pr,
	Hook,
	Subagents,
	Jobs,
	Session,
	SessionId,
	Hostname,
	TokenIn,
	TokenOut,
	TokenTotal,
	TokenRate,
	CacheRead,
	CacheWrite,
	CacheHit,
	ContextPct,
	ContextTotal,
	Cost,
	ActiveTime,
	Usage,
	Clock,
}

impl StatusSegment {
	const fn chip(self) -> Chip {
		match self {
			Self::Pi => Chip::Brand,
			Self::Status => Chip::Hook,
			Self::Model => Chip::Model,
			Self::Mode => Chip::Mode,
			Self::Path => Chip::Path,
			Self::Git => Chip::Git,
			Self::Pr => Chip::Pr,
			Self::Subagents => Chip::Subagents,
			Self::TokenIn => Chip::TokenIn,
			Self::TokenOut => Chip::TokenOut,
			Self::TokenTotal => Chip::TokenTotal,
			Self::TokenRate => Chip::TokenRate,
			Self::Cost => Chip::Cost,
			Self::ContextPct => Chip::ContextPct,
			Self::ContextTotal => Chip::ContextTotal,
			Self::TimeSpent => Chip::ActiveTime,
			Self::Time => Chip::Clock,
			Self::Session => Chip::SessionId,
			Self::Hostname => Chip::Hostname,
			Self::CacheRead => Chip::CacheRead,
			Self::CacheWrite => Chip::CacheWrite,
			Self::CacheHit => Chip::CacheHit,
			Self::SessionName => Chip::Session,
			Self::Usage => Chip::Usage,
			Self::Collab => Chip::Collab,
		}
	}
}

/// One rendered chip: identity, text, and foreground.
type Label = (Chip, Str, Color);

/// Both fitted groups of the band.
struct Layout {
	left:             SmallVec<Label, 5>,
	right:            SmallVec<Label, 6>,
	gauge:            Color,
	embedded_context: bool,
	pr_url:           Option<Str>,
	path_url:         Option<Str>,
	git_parts:        SmallVec<(u16, Str, Color), 3>,
	usage_parts:      SmallVec<StyledPart, 9>,
}

/// What a fitted layout depends on besides the facts: the row width, the
/// glyph set, the context revision (theme colors), and the brand label's
/// width (the timer grows from `9s` to `10s` to `1m00s`).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct LayoutKey {
	width:       u16,
	charset:     Charset,
	revision:    u64,
	brand_width: u16,
}

/// The fitted layout retained across animation frames (ADR 0030: the cache
/// owns the memory; the spinner repaints the band continuously while only
/// the brand text moves).
struct LayoutCache {
	key:    LayoutKey,
	layout: Layout,
}

/// One-row composer status in the band layout.
///
/// The powerline group (brand, model, path, git) is bridged by the embedded
/// context gauge to the right-docked group (session title, token counts,
/// throughput, spend). Overflow keeps the gauge
/// keeps room for its labels, the session title shrinks first, then right
/// chips pop from the right. Collaboration yields before the protected path;
/// the path then shrinks before other left chips drop from the configured
/// right edge.
pub struct StatusBand {
	props: Props,
	slot:  Slot,
	facts: StatusFacts,
	/// Brand foreground easing between idle and working; `None` until the
	/// first paint knows the theme.
	fade:  Option<Tween<Color>>,
	/// Scratch for the brand label (spinner and timer), reused every frame.
	brand: String,
	/// Fitted labels for the last `(facts, width, charset, revision, brand
	/// width)`; only the brand text and color are patched per frame.
	cache: Option<LayoutCache>,
}

impl StatusBand {
	/// Creates a band for the launch facts.
	#[must_use]
	pub fn new(facts: StatusFacts) -> Self {
		let mut props = Props::new();
		props.set(Prop::Id, STATUS_ID);
		Self { props, slot: next_slot(), facts, fade: None, brand: String::new(), cache: None }
	}

	/// Replaces the facts; returns whether anything changed.
	pub fn set_facts(&mut self, facts: StatusFacts) -> bool {
		if self.facts == facts {
			return false;
		}
		self.facts = facts;
		self.cache = None;
		true
	}

	/// Applies a live or preview appearance without rebuilding the component.
	pub fn set_appearance(&mut self, appearance: StatusAppearance) -> bool {
		if self.facts.appearance == appearance {
			return false;
		}
		self.facts.appearance = appearance;
		self.cache = None;
		true
	}

	/// Current appearance.
	#[must_use]
	pub const fn appearance(&self) -> &StatusAppearance {
		&self.facts.appearance
	}

	/// Whether the fitted layout is retained for `key` (test hook).
	#[cfg(test)]
	fn cached_for(&self, key: LayoutKey) -> bool {
		self.cache.as_ref().is_some_and(|cache| cache.key == key)
	}

	/// Writes the brand label for `now` into the scratch: the ghost and
	/// agent id while a subagent is focused ( `piSegment`), else the
	/// spinner and elapsed timer while working, else the brand glyph; one
	/// trailing pad.
	fn write_brand(&mut self, charset: Charset, now: Duration) {
		self.brand.clear();
		if let Some(agent) = self.facts.focused_agent.as_deref() {
			self.brand.push_str(charset.icon(Icon::Ghost));
			self.brand.push(' ');
			self.brand.push_str(agent);
			self.brand.push(' ');
			return;
		}
		match self.facts.working {
			Some(started) => {
				self.brand.push_str(charset.spinner().at(now));
				self.brand.push(' ');
				elapsed_label(&mut self.brand, now.saturating_sub(started));
			},
			None => self.brand.push_str(charset.icon(Icon::Omp)),
		}
		self.brand.push(' ');
	}

	/// Mode chip text and color ( `modeSegment`), when a Director owns
	/// subsequent turns.
	fn mode_label(&self, charset: Charset, theme: &Theme, accent: Color) -> Option<(Str, Color)> {
		let mode = self.facts.mode?;
		Some(match mode {
			ModeChip::Plan => (sf!("{} Plan", charset.icon(Icon::Plan)), accent),
			ModeChip::PlanPaused => {
				(sf!("{} Plan {}", charset.icon(Icon::Plan), charset.icon(Icon::Pause)), theme.warn)
			},
			ModeChip::Prewalk => (sf!("{} Prewalk", charset.icon(Icon::Prewalk)), accent),
			ModeChip::Goal(state) => {
				let (icon, color) = match state {
					GoalState::Active => (Icon::Goal, accent),
					GoalState::Paused => (Icon::Pause, theme.warn),
					GoalState::Complete => (Icon::Success, theme.ok),
					GoalState::BudgetLimited => (Icon::WarningStatus, theme.warn),
					GoalState::Dropped => (Icon::Aborted, theme.muted),
				};
				(sf!("{} Goal", charset.icon(icon)), color)
			},
			ModeChip::Vibe => (sf!("{} Vibe", charset.icon(Icon::Agents)), accent),
			ModeChip::LoopWaiting { limit } => {
				let icon = charset.icon(Icon::Loop);
				let label = Self::loop_label(icon, "waiting", limit);
				(label, theme.secondary)
			},
			ModeChip::Loop { limit } => {
				let icon = charset.icon(Icon::Loop);
				let label = Self::loop_label(icon, "running", limit);
				(label, theme.secondary)
			},
			ModeChip::LoopPaused { limit } => {
				let icon = charset.icon(Icon::Pause);
				let label = Self::loop_label(icon, "paused", limit);
				(label, theme.warn)
			},
		})
	}

	fn loop_label(icon: &str, state: &str, limit: Option<LoopLimit>) -> Str {
		let mut label = format!("{icon} Loop {state}");
		match limit {
			Some(LoopLimit::Iterations { remaining, initial }) => {
				let _ = write!(label, " {remaining}/{initial}");
			},
			Some(LoopLimit::Duration(remaining)) => {
				label.push(' ');
				let seconds = remaining.as_secs().max(u64::from(!remaining.is_zero()));
				if seconds >= 3_600 {
					let hours = seconds / 3_600;
					let minutes = (seconds % 3_600) / 60;
					let _ = write!(label, "{hours}h");
					if minutes > 0 {
						let _ = write!(label, "{minutes}m");
					}
				} else if seconds >= 60 {
					let _ = write!(label, "{}m{}s", seconds / 60, seconds % 60);
				} else {
					let _ = write!(label, "{seconds}s");
				}
				label.push_str(" left");
			},
			None => {},
		}
		Str::new(label)
	}

	/// Session-derived identity color, falling back to the requested theme
	/// role while the session remains unnamed.
	fn session_accent(&self, pc: &PaintCtx<'_>, fallback: Color) -> Color {
		let Some(name) = self
			.facts
			.session_name
			.as_deref()
			.filter(|name| !name.is_empty())
		else {
			return fallback;
		};
		let theme = pc.ctx.theme;
		let occupied = [theme.accent, theme.info, theme.ok, theme.warn, theme.err, theme.secondary];
		let surface = matches!(pc.ctx.appearance, Appearance::Light).then_some(1.0);
		session_accent_color(name, &occupied, surface)
	}

	/// Model icon: the thinking glyph in compact mode, else the model icon.
	fn model_icon(&self, charset: Charset) -> &'static str {
		let show_thinking = self
			.facts
			.appearance
			.effective_segment_options()
			.model
			.show_thinking_level
			.unwrap_or(true);
		match self.facts.thinking.as_deref() {
			Some(level) if show_thinking && self.facts.compact_thinking => {
				thinking_glyph(charset, level)
			},
			_ => charset.icon(Icon::Model),
		}
	}

	/// Advisor badge glyph and its cell offset inside the model chip, when
	/// advisors are configured ( paints it as its own span between the
	/// name and the tail).
	fn advisor_span(&self, charset: Charset) -> Option<(u16, &'static str)> {
		let badge = self.facts.advisor?;
		let icon = charset.icon(if badge.yielded {
			Icon::AdvisorClosed
		} else {
			Icon::Advisor
		});
		let mut offset = cell_width(self.model_icon(charset))
			.saturating_add(1)
			.saturating_add(cell_width(&self.facts.model));
		if self.facts.fast {
			offset = offset
				.saturating_add(1)
				.saturating_add(cell_width(charset.icon(Icon::Fast)));
		}
		Some((offset.saturating_add(1), icon))
	}

	/// Model chip text ( `modelSegment`): icon, name, fast icon, advisor
	/// badge, and the ` · <level>` tail when the level is not compact.
	fn model_label(&self, charset: Charset) -> Str {
		let model = if self.facts.model.is_empty() {
			"no-model"
		} else {
			self.facts.model.as_str()
		};
		let mut text = format!("{} {model}", self.model_icon(charset));
		if self.facts.fast {
			let _ = write!(text, " {}", charset.icon(Icon::Fast));
		}
		if let Some((_, icon)) = self.advisor_span(charset) {
			let _ = write!(text, " {icon}");
		}
		let show_thinking = self
			.facts
			.appearance
			.effective_segment_options()
			.model
			.show_thinking_level
			.unwrap_or(true);
		if let Some(level) = self.facts.thinking.as_deref()
			&& show_thinking
			&& !self.facts.compact_thinking
		{
			let _ =
				write!(text, "{}{} {level}", charset.icon(Icon::Dot), thinking_glyph(charset, level));
		}
		Str::new(text)
	}

	/// Left-group labels at `path_max`, in segment order. The brand
	/// label is the scratch written by [`Self::write_brand`] for this frame;
	/// its color is patched per frame by the caller.
	fn git_parts(&self, pc: &PaintCtx<'_>) -> SmallVec<(u16, Str, Color), 3> {
		let charset = pc.ctx.charset;
		let theme = pc.ctx.theme;
		let status = self.facts.git_status.unwrap_or_default();
		let options = self.facts.appearance.effective_segment_options().git;
		let show_branch = options.show_branch.unwrap_or(true);
		let mut parts = SmallVec::new();
		let mut offset = self
			.facts
			.branch
			.as_deref()
			.filter(|branch| show_branch && !branch.is_empty())
			.map_or_else(
				|| cell_width(charset.icon(Icon::Git)),
				|branch| {
					cell_width(charset.icon(Icon::Branch))
						.saturating_add(1)
						.saturating_add(cell_width(&sanitize_status(branch)))
				},
			);
		for (shown, prefix, count, color) in [
			(options.show_unstaged.unwrap_or(true), '*', status.unstaged, theme.status_dirty),
			(options.show_staged.unwrap_or(true), '+', status.staged, theme.status_staged),
			(options.show_untracked.unwrap_or(true), '?', status.untracked, theme.status_untracked),
		] {
			if !shown || count == 0 {
				continue;
			}
			offset = offset.saturating_add(1);
			let part = sf!("{prefix}{count}");
			let width = cell_width(&part);
			parts.push((offset, part, color));
			offset = offset.saturating_add(width);
		}
		parts
	}

	fn path_label(&self, pc: &PaintCtx<'_>, path_max: u16) -> Option<Label> {
		let options = self.facts.appearance.effective_segment_options().path;
		let strip = options.strip_work_prefix.unwrap_or(true);
		let abbreviate = options.abbreviate.unwrap_or(true);
		let charset = pc.ctx.charset;
		let theme = pc.ctx.theme;
		if strip && let Some(worktree) = &self.facts.worktree {
			let label = if self.facts.branch.as_deref() == Some(worktree.worktree.as_str()) {
				worktree.project.clone()
			} else {
				sf!("{}/{}", worktree.project, worktree.worktree)
			};
			return Some((
				Chip::Path,
				sf!("{} {}", charset.icon(Icon::Worktree), clamp_path(&label, path_max)),
				theme.status_path,
			));
		}
		let source = if strip {
			self.facts.cwd.as_str()
		} else {
			self.facts.raw_cwd.as_deref().unwrap_or(&self.facts.cwd)
		};
		if source.is_empty() {
			return None;
		}
		let path = if abbreviate {
			shorten_home(source, self.facts.home.as_deref())
		} else if strip {
			expand_home(source, self.facts.home.as_deref())
		} else {
			Str::new(source)
		};
		let icon = if strip && self.facts.scratch {
			Icon::ScratchFolder
		} else {
			Icon::Folder
		};
		Some((
			Chip::Path,
			sf!("{} {}", charset.icon(icon), clamp_path(&path, path_max)),
			theme.status_path,
		))
	}

	fn left_labels(&self, pc: &PaintCtx<'_>, path_max: u16) -> SmallVec<Label, 5> {
		let charset = pc.ctx.charset;
		let theme = pc.ctx.theme;
		let accent = self.session_accent(pc, theme.accent);
		let mut labels = SmallVec::new();
		labels.push((Chip::Brand, Str::new(&self.brand), theme.muted));
		labels.push((
			Chip::Model,
			self.model_label(charset),
			self.session_accent(pc, theme.status_model),
		));
		if let Some((label, color)) = self.mode_label(charset, &theme, accent) {
			labels.push((Chip::Mode, label, color));
		}
		if let Some(collab) = self.facts.collab.as_ref() {
			let role = if collab.role == CollabStatusRole::Guest {
				"collab guest:"
			} else {
				"collab:"
			};
			labels.push((
				Chip::Collab,
				sf!("{} {role}{}", charset.icon(Icon::Swap), collab.participants),
				accent,
			));
		}
		let mut hook = StrMut::new_inline("");
		for status in &self.facts.hook_status {
			let clean = sanitize_status(status);
			if clean.is_empty() {
				continue;
			}
			if !hook.is_empty() {
				hook.push_str(charset.icon(Icon::Dot));
			}
			hook.push_str(&clean);
		}
		if !hook.is_empty() {
			labels.push((Chip::Hook, hook.freeze(), accent));
		}
		if let Some(path) = self.path_label(pc, path_max) {
			labels.push(path);
		}
		let status = self.facts.git_status.unwrap_or_default();
		let git_options = self.facts.appearance.effective_segment_options().git;
		let branch = self
			.facts
			.branch
			.as_deref()
			.filter(|branch| git_options.show_branch.unwrap_or(true) && !branch.is_empty());
		let counts_visible = (git_options.show_unstaged.unwrap_or(true) && status.unstaged > 0)
			|| (git_options.show_staged.unwrap_or(true) && status.staged > 0)
			|| (git_options.show_untracked.unwrap_or(true) && status.untracked > 0);
		if let Some(branch) = branch {
			let branch = sanitize_status(branch);
			let mut label = format!("{} {branch}", charset.icon(Icon::Branch));
			append_git_counts(&mut label, status, git_options);
			let color = if status.dirty() {
				theme.status_git_dirty
			} else {
				theme.status_git_clean
			};
			labels.push((Chip::Git, Str::new(label), color));
		} else if counts_visible {
			let mut label = String::from(charset.icon(Icon::Git));
			append_git_counts(&mut label, status, git_options);
			labels.push((Chip::Git, Str::new(label), theme.status_git_dirty));
		}
		if let Some(pull) = &self.facts.pull_request {
			labels.push((Chip::Pr, sf!("{} #{}", charset.icon(Icon::Pr), pull.number), accent));
		}
		labels
	}

	/// Right-group labels with the session title clamped to `name_max`.
	/// Values are formatted only when the facts/layout key changes; animation
	/// frames re-slice this retained set.
	fn right_labels(
		&self,
		pc: &PaintCtx<'_>,
		name_max: u16,
		usage_label: Option<&Str>,
	) -> SmallVec<Label, 6> {
		let charset = pc.ctx.charset;
		let theme = pc.ctx.theme;
		let accent = self.session_accent(pc, theme.accent);
		let facts = &self.facts;
		let mut labels = SmallVec::new();
		if facts.background_jobs > 0 {
			labels.push((
				Chip::Jobs,
				count_label(charset, Icon::Job, u64::from(facts.background_jobs)),
				theme.status_subagents,
			));
		}
		if facts.subagents > 0 {
			let mut text = format!("{} {}", charset.icon(Icon::Agents), facts.subagents);
			text.push_str(if facts.subagents == 1 {
				" agent"
			} else {
				" agents"
			});
			labels.push((Chip::Subagents, Str::new(text), theme.status_subagents));
		}
		if let Some(name) = facts
			.session_name
			.as_deref()
			.filter(|name| !name.is_empty())
		{
			labels.push((Chip::Session, clamp_end(&sanitize_status(name), name_max), accent));
		}
		let session = facts
			.session_id
			.as_deref()
			.filter(|session| !session.is_empty())
			.unwrap_or("new");
		let end = session
			.char_indices()
			.nth(8)
			.map_or(session.len(), |(index, _)| index);
		labels.push((
			Chip::SessionId,
			sf!("{} {}", charset.icon(Icon::Session), &session[..end]),
			theme.muted,
		));
		if let Some(host) = facts.hostname.as_deref().filter(|host| !host.is_empty()) {
			let host = sanitize_status(host);
			labels.push((Chip::Hostname, sf!("{} {host}", charset.icon(Icon::Host)), accent));
		}
		if let Some(clock) = facts.wall_time.as_deref().filter(|clock| !clock.is_empty()) {
			let mut label = StrMut::new_inline(charset.icon(Icon::Time));
			if !label.is_empty() {
				label.push(' ');
			}
			label.push_str(clock);
			labels.push((Chip::Clock, label.freeze(), theme.muted));
		}
		if facts.tokens_in > 0 {
			labels.push((
				Chip::TokenIn,
				count_label(charset, Icon::Input, facts.tokens_in),
				theme.status_spend,
			));
		}
		if facts.tokens_out > 0 {
			labels.push((
				Chip::TokenOut,
				count_label(charset, Icon::Output, facts.tokens_out),
				theme.status_output,
			));
		}
		let total = facts
			.tokens_in
			.saturating_add(facts.tokens_out)
			.saturating_add(facts.cache_write);
		if total > 0 {
			labels.push((
				Chip::TokenTotal,
				count_label(charset, Icon::Tokens, total),
				theme.status_spend,
			));
		}
		if let Some(rate) = facts.tokens_per_second.filter(|rate| *rate > 0.0) {
			labels.push((
				Chip::TokenRate,
				sf!("{} {rate:.1} tok/s", charset.icon(Icon::Throughput)),
				theme.status_output,
			));
		}
		if facts.cache_read > 0 {
			labels.push((
				Chip::CacheRead,
				count_label(charset, Icon::Cache, facts.cache_read),
				theme.status_spend,
			));
		}
		if facts.cache_write > 0 {
			labels.push((
				Chip::CacheWrite,
				count_label(charset, Icon::Cache, facts.cache_write),
				theme.status_output,
			));
		}
		let prompt_total = facts
			.cache_read
			.saturating_add(facts.cache_write)
			.saturating_add(facts.tokens_in);
		if facts.cache_read > 0 && prompt_total > 0 {
			let hit = facts.cache_read as f64 / prompt_total as f64 * 100.0;
			labels.push((
				Chip::CacheHit,
				sf!("{} {hit:.2}%", charset.icon(Icon::Cache)),
				theme.status_spend,
			));
		}
		labels.push((
			Chip::ContextPct,
			context_percent_label(charset, facts.tokens, facts.context_window),
			context_color(&theme, facts.tokens, facts.context_window),
		));
		if let Some(window) = facts.context_window.filter(|window| *window > 0) {
			labels.push((
				Chip::ContextTotal,
				count_label(charset, Icon::Context, window),
				theme.status_context,
			));
		}
		if facts.active_time >= Duration::from_secs(1) {
			labels.push((
				Chip::ActiveTime,
				active_time_label(charset, facts.active_time),
				theme.muted,
			));
		}
		if let Some(label) = usage_label {
			labels.push((Chip::Usage, label.clone(), theme.fg));
		}
		let mut cost =
			String::from(spend_label(facts.cost_nano_usd, facts.subscription, charset).as_str());
		if facts.premium_requests_millionths > 0 {
			if !cost.is_empty() {
				cost.push(' ');
			}
			cost.push_str(charset.icon(Icon::Star));
			cost.push(' ');
			write_premium_requests(&mut cost, facts.premium_requests_millionths);
		}
		if facts.advisor_cost_nano_usd > 0 {
			if !cost.is_empty() {
				cost.push_str(" + ");
			}
			cost.push_str(
				advisor_spend_label(facts.advisor_cost_nano_usd, facts.advisor_subscription, charset)
					.as_str(),
			);
		}
		if !cost.is_empty() {
			labels.push((Chip::Cost, Str::new(cost), theme.status_cost));
		}
		labels
	}

	fn apply_preset(
		&self,
		left: SmallVec<Label, 5>,
		right: SmallVec<Label, 6>,
	) -> (SmallVec<Label, 5>, SmallVec<Label, 6>, bool) {
		const DEFAULT_LEFT: &[Chip] = &[
			Chip::Brand,
			Chip::Model,
			Chip::Mode,
			Chip::Collab,
			Chip::Path,
			Chip::Git,
			Chip::Pr,
			Chip::ContextPct,
			Chip::Cost,
		];
		const DEFAULT_RIGHT: &[Chip] = &[Chip::Jobs, Chip::Subagents, Chip::Session];
		const MINIMAL_LEFT: &[Chip] = &[Chip::Path, Chip::Git];
		const MINIMAL_RIGHT: &[Chip] =
			&[Chip::Jobs, Chip::Subagents, Chip::Session, Chip::Mode, Chip::ContextPct];
		const COMPACT_LEFT: &[Chip] = &[Chip::Model, Chip::Mode, Chip::Git, Chip::Pr];
		const COMPACT_RIGHT: &[Chip] =
			&[Chip::Jobs, Chip::Subagents, Chip::Session, Chip::Cost, Chip::ContextPct];
		const FULL_LEFT: &[Chip] = &[
			Chip::Brand,
			Chip::Hostname,
			Chip::Model,
			Chip::Mode,
			Chip::Path,
			Chip::Git,
			Chip::Pr,
			Chip::Subagents,
			Chip::Hook,
		];
		const FULL_RIGHT: &[Chip] = &[
			Chip::Jobs,
			Chip::Session,
			Chip::CacheHit,
			Chip::TokenIn,
			Chip::TokenOut,
			Chip::TokenRate,
			Chip::CacheRead,
			Chip::Cost,
			Chip::ContextPct,
			Chip::ActiveTime,
			Chip::Usage,
			Chip::Clock,
		];
		const NERD_LEFT: &[Chip] = &[
			Chip::Brand,
			Chip::Hostname,
			Chip::Model,
			Chip::Mode,
			Chip::Path,
			Chip::Git,
			Chip::Pr,
			Chip::SessionId,
			Chip::Subagents,
			Chip::Hook,
		];
		const NERD_RIGHT: &[Chip] = &[
			Chip::Jobs,
			Chip::Session,
			Chip::TokenIn,
			Chip::TokenOut,
			Chip::CacheRead,
			Chip::CacheWrite,
			Chip::TokenRate,
			Chip::Cost,
			Chip::ContextPct,
			Chip::ContextTotal,
			Chip::ActiveTime,
			Chip::Usage,
			Chip::Clock,
		];
		const ASCII_LEFT: &[Chip] = &[Chip::Model, Chip::Mode, Chip::Path, Chip::Git, Chip::Pr];
		const ASCII_RIGHT: &[Chip] = &[
			Chip::Jobs,
			Chip::Subagents,
			Chip::Session,
			Chip::TokenTotal,
			Chip::Cost,
			Chip::ContextPct,
		];
		let mut pool = Vec::with_capacity(left.len() + right.len());
		pool.extend(left);
		pool.extend(right);
		let mut selected_left = SmallVec::<Label, 5>::new();
		let mut selected_right = SmallVec::<Label, 6>::new();
		if self.facts.appearance.preset == StatusPreset::Custom {
			for segment in self.facts.appearance.left_segments.iter().copied() {
				if segment == StatusSegment::Subagents {
					continue;
				}
				let wanted = segment.chip();
				selected_left.extend(pool.iter().filter(|(chip, ..)| *chip == wanted).cloned());
			}
			for segment in self.facts.appearance.right_segments.iter().copied() {
				if segment == StatusSegment::Subagents {
					continue;
				}
				let wanted = segment.chip();
				selected_right.extend(pool.iter().filter(|(chip, ..)| *chip == wanted).cloned());
			}
			// Live lifecycle badges are semantic right-group prefixes:
			// configuration cannot hide, duplicate, or relocate them.
			for wanted in [Chip::Jobs, Chip::Subagents] {
				if let Some(label) = pool.iter().find(|(chip, ..)| *chip == wanted) {
					selected_right.insert(0, label.clone());
				}
			}
		} else {
			let (left_order, right_order) = match self.facts.appearance.preset {
				StatusPreset::Default => (DEFAULT_LEFT, DEFAULT_RIGHT),
				StatusPreset::Minimal => (MINIMAL_LEFT, MINIMAL_RIGHT),
				StatusPreset::Compact => (COMPACT_LEFT, COMPACT_RIGHT),
				StatusPreset::Full => (FULL_LEFT, FULL_RIGHT),
				StatusPreset::Nerd => (NERD_LEFT, NERD_RIGHT),
				StatusPreset::Ascii => (ASCII_LEFT, ASCII_RIGHT),
				StatusPreset::Custom => unreachable!(),
			};
			for wanted in left_order {
				if let Some(label) = pool.iter().find(|(chip, ..)| chip == wanted) {
					selected_left.push(label.clone());
				}
			}
			for wanted in right_order {
				if let Some(label) = pool.iter().find(|(chip, ..)| chip == wanted) {
					selected_right.push(label.clone());
				}
			}
		}
		// `showHookStatus` is orthogonal to status-line presets: a
		// producer update remains visible without requiring users to add the
		// optional `status` segment to a custom layout.
		if !selected_left.iter().any(|(chip, ..)| *chip == Chip::Hook)
			&& !selected_right.iter().any(|(chip, ..)| *chip == Chip::Hook)
			&& let Some(label) = pool.iter().find(|(chip, ..)| *chip == Chip::Hook)
		{
			selected_left.push(label.clone());
		}
		let embeds_context = self.facts.appearance.context_line == ContextLine::Embedded
			&& self.facts.context_window.is_some_and(|window| window > 0);
		let has_context = selected_left
			.iter()
			.chain(&selected_right)
			.any(|(chip, ..)| matches!(chip, Chip::ContextPct | Chip::ContextTotal));
		let has_non_context = selected_left
			.iter()
			.chain(&selected_right)
			.any(|(chip, ..)| !matches!(chip, Chip::ContextPct | Chip::ContextTotal));
		let embedded = embeds_context && has_context && has_non_context;
		if embedded {
			selected_left.retain(|(chip, ..)| !matches!(chip, Chip::ContextPct | Chip::ContextTotal));
			selected_right.retain(|(chip, ..)| !matches!(chip, Chip::ContextPct | Chip::ContextTotal));
		}
		(selected_left, selected_right, embedded)
	}

	fn band_chrome(
		charset: Charset,
		end: bool,
		separator: StatusSeparator,
		transparent: bool,
	) -> (&'static str, &'static str, &'static str) {
		let chrome = match separator {
			StatusSeparator::PowerlineThin => {
				if end {
					charset.status_band_end()
				} else {
					charset.status_band()
				}
			},
			StatusSeparator::Powerline => match (charset, end) {
				(Charset::Ascii, false) => ("", ">", ">"),
				(Charset::Ascii, true) => ("<", "<", ""),
				(Charset::Unicode, false) => ("", "▶", "▶"),
				(Charset::Unicode, true) => ("◀", "◀", ""),
				(Charset::NerdFont, false) => ("\u{e0b6}", "\u{e0b0}", "\u{e0b0}"),
				(Charset::NerdFont, true) => ("\u{e0b2}", "\u{e0b2}", ""),
			},
			StatusSeparator::Slash => (
				"",
				if charset == Charset::NerdFont {
					"\u{e0bb}"
				} else {
					"/"
				},
				"",
			),
			StatusSeparator::Pipe => (
				"",
				match charset {
					Charset::Ascii => "|",
					Charset::Unicode => "│",
					Charset::NerdFont => "\u{e0b3}",
				},
				"",
			),
			StatusSeparator::Block => (
				"",
				if charset == Charset::Ascii {
					"#"
				} else {
					"▌"
				},
				"",
			),
			StatusSeparator::None => ("", " ", ""),
			StatusSeparator::Ascii => ("", if end { "<" } else { ">" }, ""),
		};
		if transparent {
			("", chrome.1, "")
		} else {
			chrome
		}
	}

	/// Cells a group needs: labels, separators with their pads, the interior
	/// pads, and both caps ( `groupWidth`); zero for an empty group.
	fn group_width(labels: &[Label], chrome: (&str, &str, &str)) -> u16 {
		if labels.is_empty() {
			return 0;
		}
		let (left_cap, separator, cap) = chrome;
		let text = labels
			.iter()
			.fold(0_u16, |sum, (_, label, _)| sum.saturating_add(cell_width(label)));
		let separators = u16::try_from(labels.len() - 1)
			.unwrap_or(u16::MAX)
			.saturating_mul(cell_width(separator).saturating_add(2));
		text
			.saturating_add(separators)
			.saturating_add(2)
			.saturating_add(cell_width(left_cap))
			.saturating_add(cell_width(cap))
	}

	/// Narrowest gauge that still carries both labels (
	/// `embeddedContextGaugeMinWidth`); one cell without a window.
	fn gauge_min_width(&self) -> u16 {
		if self.facts.appearance.context_line != ContextLine::Embedded {
			return 1;
		}
		let Some(window) = self.facts.context_window.filter(|window| *window > 0) else {
			return 1;
		};
		let percent = self.facts.tokens as f64 / window as f64 * 100.0;
		let mut percent_label = String::new();
		if percent > 0.0 && percent < 1.0 {
			let _ = write!(percent_label, "{percent:.1}%");
		} else {
			let _ = write!(percent_label, "{percent:.0}%");
		}
		let mut window_label = String::new();
		let _ = write_compact_count(&mut window_label, window);
		cell_width(&percent_label)
			.saturating_add(cell_width(&window_label))
			.saturating_add(4)
	}

	/// Fits both groups into `width` around the gauge ( `#buildStatusLine`):
	/// clamp the session title, pop right chips, yield collaboration, shrink
	/// the path, then shed left chips from the declared right edge.
	fn fitted(&self, pc: &PaintCtx<'_>, width: u16) -> Layout {
		let charset = pc.ctx.charset;
		let transparent =
			self.facts.appearance.transparent || pc.ctx.theme.status_bg == Color::Default;
		let left_chrome =
			Self::band_chrome(charset, false, self.facts.appearance.separator, transparent);
		let right_chrome =
			Self::band_chrome(charset, true, self.facts.appearance.separator, transparent);
		let options = self.facts.appearance.effective_segment_options();
		let mut path_max = options.path.max_length.unwrap_or(PATH_MAX).max(4);
		let custom_usage = self.facts.appearance.preset == StatusPreset::Custom
			&& self
				.facts
				.appearance
				.left_segments
				.iter()
				.chain(self.facts.appearance.right_segments.iter())
				.any(|segment| *segment == StatusSegment::Usage);
		let usage = if matches!(self.facts.appearance.preset, StatusPreset::Full | StatusPreset::Nerd)
			|| custom_usage
		{
			self.facts.account_usage.as_ref().and_then(|usage| {
				account_usage_label(
					charset,
					usage,
					&pc.ctx.theme,
					self.session_accent(pc, pc.ctx.theme.accent),
				)
			})
		} else {
			None
		};
		let (mut left, mut right, embedded_context) = self.apply_preset(
			self.left_labels(pc, path_max),
			self.right_labels(pc, u16::MAX, usage.as_ref().map(|(label, _)| label)),
		);
		let gauge_min = if embedded_context {
			self.gauge_min_width()
		} else {
			1
		};
		let custom = self.facts.appearance.preset == StatusPreset::Custom;
		// A lone surviving chip that cannot share the
		// row with both gauge labels keeps the one-cell gauge instead of
		// losing the whole band.
		let overflow = |left: &[Label], right: &[Label]| {
			let groups = Self::group_width(left, left_chrome)
				.saturating_add(Self::group_width(right, right_chrome));
			let gap = if left.len() + right.len() == 1 && groups.saturating_add(gauge_min) > width {
				1
			} else {
				gauge_min
			};
			groups.saturating_add(gap).saturating_sub(width)
		};
		let excess = overflow(&left, &right);
		if excess > 0
			&& let Some(index) = right.iter().position(|(chip, ..)| *chip == Chip::Session)
		{
			let current = cell_width(&right[index].1);
			let shrink = current.saturating_sub(SESSION_NAME_MIN).min(excess);
			if shrink > 0 {
				if custom {
					right[index].1 = clamp_end(&right[index].1, current - shrink);
				} else {
					(_, right, _) = self.apply_preset(
						self.left_labels(pc, path_max),
						self.right_labels(pc, current - shrink, usage.as_ref().map(|(label, _)| label)),
					);
				}
			}
		}
		while overflow(&left, &right) > 0 && !right.is_empty() {
			right.pop();
		}
		// Collaboration is optional presence metadata, while the project path
		// is the stable location anchor. Keep the configured order for every
		// other chip, but apply those semantic roles before spending any of the
		// path's elastic width. Custom layouts may repeat either segment.
		if left.iter().any(|(chip, ..)| *chip == Chip::Path) {
			while overflow(&left, &right) > 0 {
				let Some(index) = left.iter().rposition(|(chip, ..)| *chip == Chip::Collab) else {
					break;
				};
				left.remove(index);
			}
		}
		loop {
			let excess = overflow(&left, &right);
			if excess == 0 || left.is_empty() {
				let usage_parts = if left
					.iter()
					.chain(&right)
					.any(|(chip, ..)| *chip == Chip::Usage)
				{
					usage
						.as_ref()
						.map_or_else(SmallVec::new, |(_, parts)| parts.clone())
				} else {
					SmallVec::new()
				};
				return Layout {
					left,
					right,
					gauge: self.session_accent(pc, pc.ctx.theme.status_rule),
					embedded_context,
					pr_url: self
						.facts
						.pull_request
						.as_ref()
						.map(|pull| pull.url.clone()),
					path_url: self.facts.path_url.clone(),
					git_parts: self.git_parts(pc),
					usage_parts,
				};
			}
			let path_width = left
				.iter()
				.find(|(chip, ..)| *chip == Chip::Path)
				.map(|(_, label, _)| cell_width(label));
			if let Some(current) = path_width
				&& path_max > PATH_MIN
				&& current > PATH_MIN
			{
				path_max = path_max.min(current).saturating_sub(excess).max(PATH_MIN);
				if custom {
					if let Some(index) = left.iter().position(|(chip, ..)| *chip == Chip::Path)
						&& let Some(label) = self.path_label(pc, path_max)
					{
						left[index] = label;
					}
				} else {
					(left, _, _) = self.apply_preset(
						self.left_labels(pc, path_max),
						self.right_labels(pc, u16::MAX, usage.as_ref().map(|(label, _)| label)),
					);
				}
				continue;
			}
			let drop = left
				.iter()
				.rposition(|(chip, ..)| *chip != Chip::Path)
				.unwrap_or(left.len() - 1);
			left.remove(drop);
		}
	}

	fn visit_group_labels(
		labels: &[Label],
		rect: Rect,
		chrome: (&str, &str, &str),
		mut visit: impl FnMut(&Label, u16),
	) {
		if labels.is_empty() {
			return;
		}
		let (left_cap, separator, _) = chrome;
		let mut column = rect
			.x
			.saturating_add(cell_width(left_cap))
			.saturating_add(1);
		for (index, label) in labels.iter().enumerate() {
			if index > 0 {
				column = column
					.saturating_add(cell_width(separator))
					.saturating_add(2);
			}
			visit(label, column);
			column = column.saturating_add(cell_width(&label.1));
		}
	}

	/// Paints one powerline group at `rect` — the same cells the `<status>`
	/// component paints, written straight into the frame from the fitted
	/// labels so an animation frame builds no component.
	fn paint_group(
		pc: &mut PaintCtx<'_>,
		labels: &[Label],
		rect: Rect,
		end: bool,
		dimmed: bool,
		separator: StatusSeparator,
		transparent: bool,
	) {
		let theme = pc.ctx.theme;
		let (left_cap, separator, cap) =
			Self::band_chrome(pc.ctx.charset, end, separator, transparent);
		let background = if transparent {
			Color::Default
		} else {
			theme.status_bg
		};
		let mut band = Style::new().fg(theme.fg).bg(background);
		let mut separator_style = Style::new().fg(theme.status_sep).bg(background);
		let mut edge = Style::new().fg(theme.status_bg);
		if dimmed {
			band = band.dim();
			separator_style = separator_style.dim();
			edge = edge.dim();
		}
		let y = rect.y;
		let mut column = pc.frame.put(rect.x, y, left_cap, edge);
		column = pc.frame.put(column, y, " ", band);
		for (index, (_, label, color)) in labels.iter().enumerate() {
			if index > 0 {
				column = pc.frame.put(column, y, " ", separator_style);
				column = pc.frame.put(column, y, separator, separator_style);
				column = pc.frame.put(column, y, " ", separator_style);
			}
			column = pc.frame.put(column, y, label, band.fg(*color));
		}
		column = pc.frame.put(column, y, " ", band);
		pc.frame.put(column, y, cap, edge);
	}

	/// The fitted layout for this frame: reused while the facts, width,
	/// charset, theme revision, and brand width hold; the brand label's
	/// text and color are patched in per frame.
	fn layout(&mut self, pc: &PaintCtx<'_>, width: u16, brand_color: Color) -> &Layout {
		let key = LayoutKey {
			width,
			charset: pc.ctx.charset,
			revision: pc.ctx.revision,
			brand_width: cell_width(&self.brand),
		};
		if self.cache.as_ref().is_none_or(|cache| cache.key != key) {
			let layout = self.fitted(pc, width);
			self.cache = Some(LayoutCache { key, layout });
		}
		let cache = self.cache.as_mut().expect("layout cached above");
		if let Some(brand) = cache
			.layout
			.left
			.first_mut()
			.filter(|(chip, ..)| *chip == Chip::Brand)
		{
			// The brand text is at most a spinner glyph, a timer, and two
			// pads: inline in `Str`, so the animated frames never allocate
			// (a focused agent id is static for as long as it shows).
			brand.1 = Str::new(&self.brand);
			brand.2 = brand_color;
		}
		&cache.layout
	}
}

impl Component for StatusBand {
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
		(16, 120)
	}

	fn height(&mut self, _ctx: &UiContext, _width: u16) -> u16 {
		1
	}

	fn paint(&mut self, pc: &mut PaintCtx<'_>, rect: Rect) {
		if rect.y >= pc.clip || rect.width == 0 {
			return;
		}
		let theme = pc.ctx.theme;
		let charset = pc.ctx.charset;
		// Brand color eases between idle and working ( `brandFgAnsi`); a
		// focused subagent holds the warning color instead.
		let target = if self.facts.focused_agent.is_some() {
			theme.warn
		} else if self.facts.working.is_some() {
			theme.accent
		} else {
			theme.muted
		};
		let fade = self.fade.get_or_insert_with(|| Tween::settled(target));
		fade.retarget(pc.now, target, BRAND_FADE, Easing::EaseInOut);
		let brand_color = fade.sample(pc.now);
		if !fade.is_settled(pc.now) {
			pc.wake(self.slot, pc.now.saturating_add(BRAND_FADE_FRAME));
		}
		if let Some(started) = self.facts.working {
			let spinner = charset.spinner().next_change(pc.now);
			let elapsed = pc.now.saturating_sub(started);
			let next_second = started.saturating_add(Duration::from_secs(elapsed.as_secs() + 1));
			pc.wake(self.slot, spinner.min(next_second));
		}

		self.write_brand(charset, pc.now);
		let advisor = self.advisor_span(charset);
		let advisor_badge = self.facts.advisor;
		let slot = self.slot;
		let (tokens, context_window, compact_percent, speculation, speculation_percent) = (
			self.facts.tokens,
			self.facts.context_window,
			self.facts.compact_percent,
			self.facts.speculation,
			self.facts.speculation_percent,
		);
		let dimmed = self.facts.focused_agent.is_some();
		let separator = self.facts.appearance.separator;
		let context_line = self.facts.appearance.context_line;
		let transparent = self.facts.appearance.transparent || theme.status_bg == Color::Default;
		let band_bg = if transparent {
			Color::Default
		} else {
			theme.status_bg
		};
		let speculation_accent = self.session_accent(pc, theme.accent);
		let Layout { left, right, gauge, embedded_context, pr_url, path_url, git_parts, usage_parts } =
			self.layout(pc, rect.width, brand_color);
		let gauge_color = *gauge;
		if left.is_empty() && right.is_empty() {
			return;
		}
		let left_width =
			Self::group_width(left, Self::band_chrome(charset, false, separator, transparent))
				.min(rect.width);
		let right_width =
			Self::group_width(right, Self::band_chrome(charset, true, separator, transparent))
				.min(rect.width.saturating_sub(left_width));
		let left_rect = Rect::new(rect.x, rect.y, left_width, 1);
		let right_rect =
			Rect::new(rect.x.saturating_add(rect.width - right_width), rect.y, right_width, 1);
		if left_width > 0 {
			Self::paint_group(pc, left, left_rect, false, dimmed, separator, transparent);
		}
		if right_width > 0 {
			Self::paint_group(pc, right, right_rect, true, dimmed, separator, transparent);
		}
		let mut overlay = |label: &Label, column: u16| match label.0 {
			Chip::Path => {
				if let Some(url) = path_url
					&& let Some((icon, path)) = label.1.split_once(' ')
				{
					let offset = cell_width(icon).saturating_add(1);
					let mut style = Style::new().fg(label.2).bg(band_bg).link(url);
					if dimmed {
						style = style.dim();
					}
					pc.frame
						.put(column.saturating_add(offset), rect.y, path, style);
				}
			},
			Chip::Git => {
				for (offset, part, color) in git_parts {
					let mut style = Style::new().fg(*color).bg(band_bg);
					if dimmed {
						style = style.dim();
					}
					pc.frame
						.put(column.saturating_add(*offset), rect.y, part, style);
				}
			},
			Chip::Pr => {
				if let Some(url) = pr_url {
					let mut style = Style::new().fg(label.2).bg(band_bg).link(url);
					if dimmed {
						style = style.dim();
					}
					pc.frame.put(column, rect.y, &label.1, style);
				}
			},
			Chip::Model => {
				if let Some(((offset, icon), badge)) = advisor.zip(advisor_badge) {
					let column = column.saturating_add(offset);
					if column.saturating_add(cell_width(icon)) <= rect.x.saturating_add(rect.width) {
						let color = match badge.health {
							AdvisorHealth::Error => theme.err,
							AdvisorHealth::QuotaExhausted => theme.warn,
							AdvisorHealth::Running => theme.ok,
							AdvisorHealth::Paused => theme.muted,
						};
						let mut style = Style::new().fg(color).bg(band_bg);
						if dimmed {
							style = style.dim();
						}
						pc.frame.put(column, rect.y, icon, style);
					}
				}
			},
			Chip::Usage => {
				for (offset, part, color) in usage_parts {
					let mut style = Style::new().fg(*color).bg(band_bg);
					if dimmed {
						style = style.dim();
					}
					pc.frame
						.put(column.saturating_add(*offset), rect.y, part, style);
				}
			},
			_ => {},
		};
		Self::visit_group_labels(
			left,
			left_rect,
			Self::band_chrome(charset, false, separator, transparent),
			&mut overlay,
		);
		Self::visit_group_labels(
			right,
			right_rect,
			Self::band_chrome(charset, true, separator, transparent),
			overlay,
		);

		let gap = rect
			.width
			.saturating_sub(left_width)
			.saturating_sub(right_width);
		if gap == 0 {
			return;
		}
		let mut rule_utf8 = [0; 4];
		let rule: &str = charset.rule().encode_utf8(&mut rule_utf8);
		let boundaries = Some(CompactionBoundaries {
			threshold_percent: f64::from(compact_percent),
			speculation_percent,
		});
		let gauge = match context_line {
			ContextLine::Off => ContextGauge::plan(gap, tokens, None, None),
			ContextLine::Percentage => {
				ContextGauge::plan_with_labels(gap, tokens, context_window, None, false)
			},
			ContextLine::Annotated => {
				ContextGauge::plan_with_labels(gap, tokens, context_window, boundaries, false)
			},
			ContextLine::Embedded if *embedded_context => {
				ContextGauge::plan(gap, tokens, context_window, boundaries)
			},
			ContextLine::Embedded => {
				ContextGauge::plan_with_labels(gap, tokens, context_window, boundaries, false)
			},
		};
		let dim = |style: Style| if dimmed { style.dim() } else { style };
		let used = dim(Style::new().fg(gauge_color));
		let unused = dim(Style::new().fg(theme.border));
		let boundary = dim(Style::new().fg(compaction_boundary_color(&theme)));
		let speculation_marker = dim(Style::new().fg(theme.muted));
		// Background speculation animates the compaction tick: pulsing
		// accent/muted while a summary is produced, solid accent once armed
		// ( `contextPctSegment`).
		let threshold = match speculation {
			Speculation::None => boundary,
			Speculation::Armed => dim(Style::new().fg(speculation_accent)),
			Speculation::Running => {
				pc.wake(slot, speculation_flip(pc.now));
				dim(Style::new().fg(if speculation_on(pc.now) {
					speculation_accent
				} else {
					theme.muted
				}))
			},
		};
		let percent = if gauge.overflowed() {
			dim(Style::new().fg(theme.err))
		} else {
			used
		};
		let tick = charset.icon(Icon::ContextCompaction);
		let mut column = rect.x.saturating_add(left_width);
		for index in 0..gauge.width() {
			column = match gauge.cell(index) {
				GaugeCell::Used => pc.frame.put(column, rect.y, rule, used),
				GaugeCell::Unused => pc.frame.put(column, rect.y, rule, unused),
				GaugeCell::Threshold => pc.frame.put(column, rect.y, tick, threshold),
				GaugeCell::Speculation => pc.frame.put(column, rect.y, tick, speculation_marker),
				GaugeCell::Percent(text) => pc.frame.put(column, rect.y, text, percent),
				GaugeCell::Window(text) => pc.frame.put(column, rect.y, text, boundary),
			};
		}
	}

	fn paints_background(&self) -> bool {
		false
	}
}

#[cfg(test)]
pub(crate) mod tests {
	use omp_tui::{Ui, frame_text};

	use super::*;

	fn rows(component: impl omp_tui::IntoComponent, width: u16) -> Vec<String> {
		let ui = Ui::from_root(component, width, UiContext::default());
		frame_text(ui.frame())
			.lines()
			.map(|line| line.trim_end().to_owned())
			.collect()
	}

	fn row(facts: StatusFacts, width: u16) -> String {
		rows(StatusBand::new(facts), width)
			.into_iter()
			.next()
			.unwrap_or_default()
	}

	#[test]
	fn display_path_strips_roots_and_labels_scratch_dirs() {
		let label = |path: &str| display_path(path, Some("/home/me"), Some("/var/folders/x/T"));
		assert_eq!(label("/home/me/src"), PathLabel {
			text:    Str::new_static("~/src"),
			scratch: false,
		});
		assert_eq!(label("/home/me").text.as_str(), "~");
		assert_eq!(label("/home/mesa").text.as_str(), "/home/mesa");
		assert_eq!(label("/work/omp"), PathLabel { text: Str::new_static("omp"), scratch: false });
		assert_eq!(label("/home/me/Projects/app/sub").text.as_str(), "app/sub");
		assert_eq!(label("/tmp/pi-face-filler-boot-120x40-parent-C61sEN/pi-capture"), PathLabel {
			text:    Str::new_static("pi-face-filler-boot-120x40-parent-C61sEN/pi-capture"),
			scratch: true,
		});
		assert_eq!(label("/var/folders/x/T/scratch").text.as_str(), "scratch");
		assert_eq!(label("/home/me/tmp/scratch"), PathLabel {
			text:    Str::new_static("scratch"),
			scratch: true,
		});
		assert_eq!(label("/tmp"), PathLabel { text: Str::new_static("/tmp"), scratch: true });
	}

	#[test]
	fn clamp_path_keeps_a_left_ellipsis_within_the_budget() {
		let long = format!("/very/{}/tail", "long".repeat(20));
		let shown = clamp_path(&long, PATH_MAX);
		assert!(shown.starts_with('…'));
		assert_eq!(cell_width(&shown), PATH_MAX);
		assert!(shown.ends_with("/tail"));
		assert_eq!(clamp_path("short", PATH_MAX).as_str(), "short");
	}

	#[test]
	fn clamp_end_keeps_a_trailing_ellipsis_within_the_budget() {
		assert_eq!(clamp_end("refactor the auth layer", 8).as_str(), "refacto…");
		assert_eq!(cell_width(&clamp_end("refactor the auth layer", 8)), 8);
		assert_eq!(clamp_end("short", 8).as_str(), "short");
	}

	pub(crate) fn facts() -> StatusFacts {
		StatusFacts {
			model: Str::new_static("Sonnet 4.5"),
			cwd: Str::new_static("~/proj"),
			branch: Some(Str::new_static("main")),
			tokens: 20_000,
			context_window: Some(200_000),
			compact_percent: 80,
			..StatusFacts::default()
		}
	}

	#[test]
	fn collaboration_renders_role_real_count_and_charset_icon() {
		let host_facts = StatusFacts { collab: Some(CollabStatus::host(3)), ..facts() };
		let host_ui = Ui::from_root(StatusBand::new(host_facts), 160, UiContext::default());
		let host = frame_text(host_ui.frame());
		assert!(host.contains("⇄ collab:3"), "{host}");
		let collab_column = cell_width(&host[..host.find('⇄').expect("collaboration icon")]);
		assert_eq!(
			host_ui
				.frame()
				.cell(collab_column, 0)
				.style()
				.foreground_color(),
			UiContext::default().theme.accent,
			"pi's collaboration segment uses the semantic accent"
		);

		let guest_facts = StatusFacts {
			collab: Some(CollabStatus::guest(7, CollabHostSnapshot::default())),
			..facts()
		};
		let guest = row(guest_facts.clone(), 160);
		assert!(guest.contains("⇄ collab guest:7"), "{guest}");

		let ctx = UiContext { charset: Charset::Ascii, ..UiContext::default() };
		let ui = Ui::from_root(StatusBand::new(guest_facts), 160, ctx);
		let ascii = frame_text(ui.frame());
		assert!(ascii.contains("<-> collab guest:7"), "{ascii}");
		assert!(!ascii.contains('⇄'), "{ascii}");
	}

	#[test]
	fn collaboration_guest_uses_host_snapshot_values() {
		let mut guest = StatusFacts {
			model: Str::new_static("Local model"),
			thinking: Some(Str::new_static("local")),
			cwd: Str::new_static("~/local"),
			scratch: true,
			path_url: Some(Str::new_static("file:///local")),
			session_name: Some(Str::new_static("Local title")),
			tokens: 11,
			context_window: Some(22),
			..StatusFacts::default()
		};
		let snapshot = CollabHostSnapshot {
			model:          Some(Str::new_static("Host model")),
			thinking:       None,
			cwd:            Str::new_static("/host/project"),
			session_name:   Some(Str::new_static("Host title")),
			tokens:         Some(33),
			context_window: Some(44),
		};
		guest.apply_collab(Some(CollabStatus::guest(4, snapshot)));
		assert_eq!(guest.model, "Host model");
		assert_eq!(guest.thinking, None);
		assert_eq!(guest.cwd, "/host/project");
		assert!(!guest.scratch);
		assert_eq!(guest.path_url, None, "a remote host path must not become a local file link");
		assert_eq!(guest.session_name.as_deref(), Some("Host title"));
		assert_eq!(guest.tokens, 33);
		assert_eq!(guest.context_window, Some(44));
		assert_eq!(guest.collab.as_ref().map(|status| status.participants), Some(4));

		let mut pending = facts();
		let pending_local = pending.clone();
		pending.apply_collab(Some(CollabStatus::guest_pending(2)));
		assert_eq!(pending.model, pending_local.model);
		assert_eq!(pending.cwd, pending_local.cwd);
		assert_eq!(pending.session_name, pending_local.session_name);

		let mut host = facts();
		let local = host.clone();
		host.apply_collab(Some(CollabStatus {
			role:         CollabStatusRole::Host,
			participants: 2,
			host:         Some(Arc::new(CollabHostSnapshot {
				model: Some(Str::new_static("must not override")),
				..CollabHostSnapshot::default()
			})),
		}));
		assert_eq!(host.model, local.model, "host status always uses local authoritative facts");
	}

	#[test]
	fn collaboration_overflow_drops_badge_before_the_project_path() {
		let collab = || StatusFacts { collab: Some(CollabStatus::host(12)), ..facts() };
		let cutoff = (1..=160)
			.find(|width| row(collab(), *width).contains("collab:12"))
			.expect("collaboration chip eventually fits");
		assert!(cutoff > 1);
		let overflowed = row(collab(), cutoff - 1);
		assert!(!overflowed.contains("collab:12"), "{overflowed}");
		assert!(
			overflowed.contains("proj"),
			"collaboration yields before the project path: {overflowed}"
		);

		let assert_protected_path = |appearance: StatusAppearance| {
			for width in 1..=160 {
				let baseline = row(StatusFacts { appearance: appearance.clone(), ..facts() }, width);
				let collaborative = row(
					StatusFacts {
						collab: Some(CollabStatus::host(12)),
						appearance: appearance.clone(),
						..facts()
					},
					width,
				);
				if !collaborative.contains("collab:12") && baseline.contains("📁") {
					assert!(
						collaborative.contains("📁"),
						"collaboration must yield before removing the path at width {width}: \
						 {collaborative}"
					);
				}
			}
		};
		assert_protected_path(StatusAppearance::for_preset(StatusPreset::Default));
		assert_protected_path(custom_appearance(
			&[StatusSegment::Model, StatusSegment::Path, StatusSegment::Collab, StatusSegment::Git],
			&[],
		));
	}

	/// Facts with an explicit custom layout exercising every right-group chip.
	fn spending() -> StatusFacts {
		let mut appearance = custom_appearance(
			&[
				StatusSegment::Pi,
				StatusSegment::Model,
				StatusSegment::Path,
				StatusSegment::Git,
				StatusSegment::ContextPct,
			],
			&[
				StatusSegment::SessionName,
				StatusSegment::TokenIn,
				StatusSegment::TokenOut,
				StatusSegment::TokenTotal,
				StatusSegment::TokenRate,
				StatusSegment::Cost,
			],
		);
		appearance.context_line = ContextLine::Embedded;
		StatusFacts {
			session_name: Some(Str::new_static("refactor the auth layer")),
			tokens_in: 12_000,
			tokens_out: 3_400,
			cache_read: 90_000,
			cache_write: 600,
			tokens_per_second: Some(42.4),
			cost_nano_usd: 120_000_000,
			premium_requests_millionths: 2_000_000,
			appearance,
			..facts()
		}
	}

	#[test]
	fn status_band_embeds_the_context_gauge_after_the_group() {
		let row = row(facts(), 80);
		assert!(row.starts_with(" π  > ⬢ Sonnet 4.5 > 📁 ~/proj > ⑂ main ▶"), "{row}");
		assert!(row.contains("10%"), "{row}");
		assert!(!row.contains("10.0%/"), "embedded mode absorbs the numeric chip: {row}");
		assert!(row.ends_with("200K─"), "{row}");
		assert!(row.contains('┃'), "{row}");
		assert_eq!(cell_width(&row), 80, "the gauge runs to the edge");
	}

	#[test]
	fn embedded_context_keeps_the_unknown_window_chip() {
		let row = row(StatusFacts { context_window: None, ..facts() }, 100);
		assert!(row.contains("◫ 20K/?"), "{row}");
	}

	#[test]
	fn non_embedded_context_modes_keep_their_numeric_chips() {
		for context_line in [ContextLine::Off, ContextLine::Percentage, ContextLine::Annotated] {
			let row = row(
				StatusFacts {
					appearance: StatusAppearance {
						context_line,
						..StatusAppearance::for_preset(StatusPreset::Default)
					},
					..facts()
				},
				120,
			);
			assert!(row.contains("◫ 10.0%/200K"), "{context_line:?}: {row}");
		}

		let nerd = row(
			StatusFacts {
				appearance: StatusAppearance {
					context_line: ContextLine::Percentage,
					..StatusAppearance::for_preset(StatusPreset::Nerd)
				},
				..facts()
			},
			220,
		);
		assert!(nerd.contains("◫ 10.0%/200K"), "{nerd}");
		assert!(nerd.contains("◫ 200K"), "{nerd}");
	}

	fn custom_appearance(left: &[StatusSegment], right: &[StatusSegment]) -> StatusAppearance {
		let mut appearance = StatusAppearance::for_preset(StatusPreset::Custom);
		appearance.context_line = ContextLine::Off;
		appearance.left_segments = left.to_vec().into();
		appearance.right_segments = right.to_vec().into();
		appearance
	}

	#[test]
	fn custom_layout_preserves_group_order_duplicates_and_empty_arrays() {
		let mut appearance =
			custom_appearance(&[StatusSegment::Path, StatusSegment::Model, StatusSegment::Path], &[
				StatusSegment::SessionName,
			]);
		let custom = row(
			StatusFacts {
				session_name: Some(Str::new_static("named")),
				appearance: appearance.clone(),
				..facts()
			},
			200,
		);
		let paths = custom
			.match_indices("~/proj")
			.map(|(index, _)| index)
			.collect::<Vec<_>>();
		assert_eq!(paths.len(), 2, "{custom}");
		let model = custom.find("Sonnet 4.5").expect("custom model");
		assert!(paths[0] < model && model < paths[1], "{custom}");
		assert!(custom.find("named").is_some_and(|name| name > paths[1]), "{custom}");

		appearance.left_segments = Arc::default();
		appearance.right_segments = Arc::default();
		let empty = row(StatusFacts { appearance, ..facts() }, 80);
		assert!(empty.trim().is_empty(), "empty custom arrays are exact: {empty:?}");

		let mut preset = StatusAppearance::for_preset(StatusPreset::Default);
		preset.left_segments = vec![StatusSegment::Time].into();
		let fixed = row(
			StatusFacts { wall_time: Some(Str::new_static("23:59")), appearance: preset, ..facts() },
			120,
		);
		assert!(fixed.contains("Sonnet 4.5") && !fixed.contains("23:59"), "{fixed}");
	}

	#[test]
	fn custom_layout_ignores_unknown_ids_and_preserves_known_duplicates() {
		assert!("future_segment".parse::<StatusSegment>().is_err());
		let parsed = ["model", "future_segment", "model"]
			.into_iter()
			.filter_map(|value| value.parse::<StatusSegment>().ok())
			.collect::<Vec<_>>();
		let row = row(StatusFacts { appearance: custom_appearance(&parsed, &[]), ..facts() }, 120);
		assert_eq!(row.matches("Sonnet 4.5").count(), 2, "{row}");
	}

	#[test]
	fn custom_segment_options_control_model_path_git_and_clock() {
		let nested = Kv(vec![
			(
				Str::new_static("model"),
				omp_con::Value::Kv(Kv(vec![(
					Str::new_static("showThinkingLevel"),
					omp_con::Value::Bool(false),
				)])),
			),
			(
				Str::new_static("path"),
				omp_con::Value::Kv(Kv(vec![
					(Str::new_static("abbreviate"), omp_con::Value::Bool(false)),
					(Str::new_static("maxLength"), omp_con::Value::Int(100)),
					(Str::new_static("stripWorkPrefix"), omp_con::Value::Bool(false)),
				])),
			),
			(
				Str::new_static("git"),
				omp_con::Value::Kv(Kv(vec![
					(Str::new_static("showBranch"), omp_con::Value::Bool(false)),
					(Str::new_static("showStaged"), omp_con::Value::Bool(true)),
					(Str::new_static("showUnstaged"), omp_con::Value::Bool(false)),
					(Str::new_static("showUntracked"), omp_con::Value::Bool(false)),
				])),
			),
			(
				Str::new_static("time"),
				omp_con::Value::Kv(Kv(vec![
					(Str::new_static("format"), omp_con::Value::Str(Str::new_static("12h"))),
					(Str::new_static("showSeconds"), omp_con::Value::Bool(true)),
				])),
			),
		]);
		let mut appearance = custom_appearance(
			&[StatusSegment::Model, StatusSegment::Path, StatusSegment::Git, StatusSegment::Time],
			&[],
		);
		appearance.segment_options =
			StatusSegmentOptions::from_kv(&nested).expect("valid typed options");
		assert_eq!(
			appearance
				.wall_clock_options(WallClockFormatSetting::Preset, WallClockSecondsSetting::Preset,),
			Some(WallClockOptions { format: WallClockFormat::TwelveHour, show_seconds: true })
		);
		let rendered = row(
			StatusFacts {
				thinking: Some(Str::new_static("high")),
				compact_thinking: false,
				raw_cwd: Some(Str::new_static("/home/me/Projects/app")),
				home: Some(Str::new_static("/home/me")),
				git_status: Some(GitStatus { staged: 1, unstaged: 2, untracked: 3 }),
				wall_time: Some(Str::new_static("1:04:05pm")),
				appearance,
				..facts()
			},
			240,
		);
		assert!(!rendered.contains("high") && !rendered.contains("main"), "{rendered}");
		assert!(rendered.contains("/home/me/Projects/app"), "{rendered}");
		assert!(rendered.contains("+1"), "{rendered}");
		assert!(!rendered.contains("*2") && !rendered.contains("?3"), "{rendered}");
		assert!(rendered.contains("1:04:05pm"), "{rendered}");

		let malformed = Kv(vec![(
			Str::new_static("path"),
			omp_con::Value::Kv(Kv(vec![(Str::new_static("maxLength"), omp_con::Value::Int(0))])),
		)]);
		assert_eq!(StatusSegmentOptions::from_kv(&malformed), None);
	}

	#[test]
	fn custom_overflow_uses_declared_semantic_roles() {
		let appearance =
			custom_appearance(&[StatusSegment::Path, StatusSegment::Model, StatusSegment::Git], &[
				StatusSegment::SessionName,
				StatusSegment::TokenIn,
				StatusSegment::Cost,
			]);
		let configured = StatusFacts { appearance, ..spending() };
		assert!(
			(20..=180).any(|width| {
				let line = row(configured.clone(), width);
				line.contains("12K") && !line.contains("$0.12")
			}),
			"right overflow pops the declared tail before earlier chips"
		);
		assert!(
			(20..=100).any(|width| {
				let line = row(configured.clone(), width);
				line.contains("📁") && !line.contains("Sonnet 4.5") && !line.contains("main")
			}),
			"the clamped path survives non-path left chips"
		);
	}

	#[test]
	fn custom_context_only_stays_a_chip_and_lifecycle_badges_stay_right() {
		let mut context_appearance = custom_appearance(&[StatusSegment::ContextPct], &[]);
		context_appearance.context_line = ContextLine::Embedded;
		let context = row(StatusFacts { appearance: context_appearance, ..facts() }, 80);
		assert!(context.contains("10.0%/200K"), "{context}");

		let lifecycle = row(
			StatusFacts {
				subagents: 2,
				background_jobs: 1,
				appearance: custom_appearance(
					&[StatusSegment::Subagents, StatusSegment::Subagents],
					&[],
				),
				..facts()
			},
			100,
		);
		assert_eq!(lifecycle.matches("2 agents").count(), 1, "{lifecycle}");
	}

	#[test]
	fn retained_custom_layout_updates_without_rebuilding_the_composer() {
		let mut ui = Ui::from_root(StatusBand::new(facts()), 120, UiContext::default());
		assert!(frame_text(ui.frame()).contains("Sonnet 4.5"));
		assert!(ui.update_component::<StatusBand>(STATUS_ID, |band| {
			band.set_appearance(custom_appearance(&[StatusSegment::Path], &[]))
		}));
		let updated = frame_text(ui.frame());
		assert!(updated.contains("~/proj") && !updated.contains("Sonnet 4.5"), "{updated}");
	}

	#[test]
	fn wall_clock_resolves_presets_and_overrides() {
		assert_eq!(
			StatusAppearance::for_preset(StatusPreset::Default)
				.wall_clock_options(WallClockFormatSetting::Preset, WallClockSecondsSetting::Preset,),
			None
		);
		assert_eq!(
			StatusAppearance::for_preset(StatusPreset::Full)
				.wall_clock_options(WallClockFormatSetting::Preset, WallClockSecondsSetting::Preset,),
			Some(WallClockOptions {
				format:       WallClockFormat::TwentyFourHour,
				show_seconds: false,
			})
		);
		assert_eq!(
			StatusAppearance::for_preset(StatusPreset::Nerd)
				.wall_clock_options(WallClockFormatSetting::Preset, WallClockSecondsSetting::Preset,),
			Some(WallClockOptions {
				format:       WallClockFormat::TwentyFourHour,
				show_seconds: true,
			})
		);

		let nested = Kv(vec![(
			Str::new_static("time"),
			omp_con::Value::Kv(Kv(vec![
				(Str::new_static("format"), omp_con::Value::Str(Str::new_static("12h"))),
				(Str::new_static("showSeconds"), omp_con::Value::Bool(true)),
			])),
		)]);
		let mut appearance = StatusAppearance::for_preset(StatusPreset::Full);
		appearance.segment_options =
			StatusSegmentOptions::from_kv(&nested).expect("valid nested options");
		assert_eq!(
			appearance.wall_clock_options(
				WallClockFormatSetting::TwentyFourHour,
				WallClockSecondsSetting::Hide,
			),
			Some(WallClockOptions {
				format:       WallClockFormat::TwentyFourHour,
				show_seconds: false,
			}),
			"curated settings override migrated nested options"
		);
	}

	#[test]
	fn wall_clock_formats_local_time_and_wakes_only_at_visible_units() {
		let stamp = "2026-09-03T13:04:05.250Z"
			.parse::<jiff::Timestamp>()
			.expect("timestamp");
		let utc = stamp.to_zoned(jiff::tz::TimeZone::UTC);
		let minute =
			WallClockOptions { format: WallClockFormat::TwentyFourHour, show_seconds: false };
		assert_eq!(format_wall_clock(&utc, minute).as_str(), "13:04");
		assert_eq!(
			wall_clock_next_wake(Duration::from_secs(10), &utc, minute),
			Duration::from_millis(64_750)
		);

		let seconds =
			WallClockOptions { format: WallClockFormat::TwelveHour, show_seconds: true };
		assert_eq!(format_wall_clock(&utc, seconds).as_str(), "1:04:05pm");
		assert_eq!(
			wall_clock_next_wake(Duration::from_secs(10), &utc, seconds),
			Duration::from_millis(10_750)
		);

		let midnight = "2026-09-03T00:04:05Z"
			.parse::<jiff::Timestamp>()
			.expect("timestamp")
			.to_zoned(jiff::tz::TimeZone::UTC);
		let noon = "2026-09-03T12:04:05Z"
			.parse::<jiff::Timestamp>()
			.expect("timestamp")
			.to_zoned(jiff::tz::TimeZone::UTC);
		assert_eq!(format_wall_clock(&midnight, seconds).as_str(), "12:04:05am");
		assert_eq!(format_wall_clock(&noon, seconds).as_str(), "12:04:05pm");

		let new_york = stamp.to_zoned(jiff::tz::TimeZone::get("America/New_York").expect("tz"));
		assert_eq!(
			format_wall_clock(&new_york, seconds).as_str(),
			"9:04:05am",
			"each refresh uses the newly supplied system timezone"
		);
	}

	#[test]
	fn full_and_nerd_include_clock_and_overflow_drops_it_first() {
		let with_clock = |preset| StatusFacts {
			wall_time: Some(Str::new_static("23:59:58")),
			appearance: StatusAppearance::for_preset(preset),
			..facts()
		};
		assert!(!row(with_clock(StatusPreset::Default), 160).contains("23:59:58"));
		assert!(row(with_clock(StatusPreset::Full), 160).contains("23:59:58"));
		assert!(row(with_clock(StatusPreset::Nerd), 160).contains("23:59:58"));

		let cutoff = (1..=160)
			.find(|width| row(with_clock(StatusPreset::Full), *width).contains("23:59:58"))
			.expect("clock eventually fits");
		assert!(cutoff > 1);
		let overflowed = row(with_clock(StatusPreset::Full), cutoff - 1);
		assert!(!overflowed.contains("23:59:58"), "{overflowed}");
		assert!(
			overflowed.contains("~/proj"),
			"the rightmost clock yields before the path: {overflowed}"
		);
	}

	#[test]
	fn active_time_unions_windows_resets_and_wakes_at_visible_units() {
		let mut meter = ActiveTime::default();
		meter.set_running(Duration::from_millis(100), true);
		meter.set_running(Duration::from_millis(400), true);
		assert_eq!(meter.elapsed(Duration::from_millis(900)), Duration::from_millis(800));
		assert_eq!(meter.display_elapsed(Duration::from_millis(900)), Duration::ZERO);
		assert_eq!(meter.next_wake(Duration::from_millis(900)), Some(Duration::from_millis(1_100)));

		meter.set_running(Duration::from_millis(1_100), false);
		meter.set_running(Duration::from_secs(5), false);
		assert_eq!(meter.elapsed(Duration::from_secs(5)), Duration::from_secs(1));
		meter.set_running(Duration::from_secs(8), true);
		assert_eq!(meter.elapsed(Duration::from_secs(10)), Duration::from_secs(3));

		meter.reset(Duration::from_secs(10), true);
		assert_eq!(meter.elapsed(Duration::from_secs(11)), Duration::from_secs(1));
		assert_eq!(meter.next_wake(Duration::from_secs(11)), Some(Duration::from_millis(11_050)));
		assert_eq!(meter.display_elapsed(Duration::from_millis(11_049)), Duration::from_secs(1));
		assert_eq!(
			meter.display_elapsed(Duration::from_millis(11_050)),
			Duration::from_millis(1_100)
		);

		assert!(
			active_time_label(Charset::Unicode, Duration::from_millis(1_234))
				.as_str()
				.ends_with("1.2s")
		);
		assert!(
			active_time_label(Charset::Unicode, Duration::from_secs(61))
				.as_str()
				.ends_with("1m1s")
		);
		assert!(
			active_time_label(Charset::Unicode, Duration::from_secs(9_000))
				.as_str()
				.ends_with("2h30m")
		);
		assert!(
			active_time_label(Charset::Unicode, Duration::from_secs(266_400))
				.as_str()
				.ends_with("3d2h")
		);

		meter.reset(Duration::ZERO, true);
		assert_eq!(
			meter.next_wake(Duration::from_secs(3_600)),
			Some(Duration::from_secs(3_660)),
			"hour-scale labels change only on minute boundaries"
		);
		meter.set_running(Duration::from_secs(3_601), false);
		assert_eq!(meter.next_wake(Duration::from_secs(4_000)), None);
	}

	#[test]
	fn status_band_shows_the_thinking_glyph_and_scratch_icon() {
		let row = row(
			StatusFacts {
				thinking: Some(Str::new_static("high")),
				scratch: true,
				branch: None,
				..facts()
			},
			80,
		);
		assert!(row.starts_with(" π  > ◒ Sonnet 4.5 > 🗑 ~/proj ▶"), "{row}");
	}

	#[test]
	fn model_chip_trails_fast_icon_and_thinking_level_when_not_compact() {
		let row = row(
			StatusFacts {
				thinking: Some(Str::new_static("high")),
				compact_thinking: false,
				fast: true,
				..facts()
			},
			100,
		);
		assert!(row.starts_with(" π  > ⬢ Sonnet 4.5 ⚡ · ◒ high > 📁 ~/proj"), "{row}");
		let compact = self::row(
			StatusFacts { thinking: Some(Str::new_static("high")), fast: true, ..facts() },
			100,
		);
		assert!(compact.starts_with(" π  > ◒ Sonnet 4.5 ⚡ > 📁 ~/proj"), "{compact}");
		let off = self::row(
			StatusFacts { thinking: Some(Str::new_static("off")), compact_thinking: false, ..facts() },
			100,
		);
		assert!(off.contains("⬢ Sonnet 4.5 · ⦸ off >"), "{off}");
	}

	#[test]
	fn advisor_badge_sits_between_the_name_and_the_tail_in_its_own_color() {
		let theme = UiContext::default().theme;
		let paint = |badge: AdvisorBadge| {
			let ui = Ui::from_root(
				StatusBand::new(StatusFacts {
					advisor: Some(badge),
					fast: true,
					thinking: Some(Str::new_static("high")),
					compact_thinking: false,
					..facts()
				}),
				100,
				UiContext::default(),
			);
			let row = frame_text(ui.frame()).lines().next().unwrap().to_owned();
			let column = cell_width(" π  > ⬢ Sonnet 4.5 ⚡ ");
			(row, ui.frame().cell(column, 0).style().foreground_color())
		};
		let (row, color) = paint(AdvisorBadge { health: AdvisorHealth::Running, yielded: false });
		assert!(row.starts_with(" π  > ⬢ Sonnet 4.5 ⚡ 👁 · ◒ high >"), "{row}");
		assert_eq!(color, theme.ok);
		let (row, color) = paint(AdvisorBadge { health: AdvisorHealth::Error, yielded: true });
		assert!(
			row.starts_with(" π  > ⬢ Sonnet 4.5 ⚡ 🙈 · ◒ high >"),
			"closed eye once yielded: {row}"
		);
		assert_eq!(color, theme.err);
		let (_, color) =
			paint(AdvisorBadge { health: AdvisorHealth::QuotaExhausted, yielded: false });
		assert_eq!(color, theme.warn);
		let (_, color) = paint(AdvisorBadge { health: AdvisorHealth::Paused, yielded: false });
		assert_eq!(color, theme.muted);
	}

	#[test]
	fn git_chip_marks_a_dirty_tree_in_the_semantic_dirty_color() {
		let ui = Ui::from_root(
			StatusBand::new(StatusFacts {
				git_status: Some(GitStatus { unstaged: 1, ..GitStatus::default() }),
				..facts()
			}),
			80,
			UiContext::default(),
		);
		let row = frame_text(ui.frame()).lines().next().unwrap().to_owned();
		assert!(row.contains("> ⑂ main *1 ▶"), "{row}");
		let column = cell_width(" π  > ⬢ Sonnet 4.5 > 📁 ~/proj > ");
		assert_eq!(
			ui.frame().cell(column, 0).style().foreground_color(),
			UiContext::default().theme.status_git_dirty
		);
	}

	#[test]
	fn right_group_docks_session_tokens_rate_and_cost_against_the_edge() {
		let row = row(spending(), 170);
		assert!(row.starts_with(" π  > ⬢ Sonnet 4.5 > 📁 ~/proj > ⑂ main ▶─"), "{row}");
		assert!(
			row.ends_with(
				"◀ refactor the auth layer < ⤵ 12K < ⤴ 3.4K < 🪙 16K < ⚡ 42.4 tok/s < $0.12 ★ 2"
			),
			"{row}"
		);
		assert!(!row.contains("90K"), "cache reads stay out of the total: {row}");
		assert!(row.contains("200K─◀"), "the gauge bridges the groups up to the right cap: {row}");
		let subscribed = self::row(StatusFacts { subscription: true, ..spending() }, 170);
		assert!(subscribed.ends_with("< S0.12 ★ 2"), "{subscribed}");
		let free = self::row(
			StatusFacts {
				cost_nano_usd: 0,
				premium_requests_millionths: 0,
				subscription: true,
				..spending()
			},
			170,
		);
		assert!(free.ends_with("tok/s < (sub)"), "a zero-cost subscription keeps its marker: {free}");
	}

	#[test]
	fn advisor_spend_keeps_its_identity_subscription_marker_color_and_overflow_unit() {
		let spending = StatusFacts {
			advisor_cost_nano_usd: 80_000_000,
			advisor_subscription: true,
			..spending()
		};
		let ctx = UiContext::default();
		let ui = Ui::from_root(StatusBand::new(spending.clone()), 210, ctx.clone());
		let row = frame_text(ui.frame()).lines().next().unwrap().to_owned();
		assert!(row.ends_with("< $0.12 ★ 2 + 👁 S0.08"), "{row}");
		let advisor = row.find('👁').expect("advisor identity");
		let advisor_column = cell_width(&row[..advisor]);
		assert_eq!(
			ui.frame()
				.cell(advisor_column, 0)
				.style()
				.foreground_color(),
			ctx.theme.status_cost,
			"advisor spend uses the semantic cost color"
		);

		for width in 40..=210 {
			let row = self::row(spending.clone(), width);
			assert_eq!(
				row.contains("$0.12"),
				row.contains('👁'),
				"primary and advisor spend are one atomic overflow chip at width {width}: {row}"
			);
		}
	}

	#[test]
	fn premium_requests_render_millionths_as_a_two_place_decimal() {
		let label = |millionths: u64| {
			let mut out = String::new();
			write_premium_requests(&mut out, millionths);
			out
		};
		assert_eq!(label(330_000), "0.33");
		assert_eq!(label(1_500_000), "1.5");
		assert_eq!(label(2_000_000), "2");
		assert_eq!(label(2_004_999), "2", "rounds to the nearest hundredth");
		assert_eq!(label(2_005_000), "2.01");
		assert_eq!(label(12_340_000_000), "12K", "whole thousands compact like counts");
		let fractional =
			self::row(StatusFacts { premium_requests_millionths: 330_000, ..spending() }, 170);
		assert!(fractional.ends_with("< $0.12 ★ 0.33"), "{fractional}");
	}

	#[test]
	fn overflow_clamps_the_title_then_pops_right_chips_before_the_path_shrinks() {
		let long_path =
			StatusFacts { cwd: Str::new(format!("~/{}tail", "segment/".repeat(4))), ..spending() };
		// Left group 73 cells, right group 80, gauge floor 11: 164 fits whole.
		let full = row(long_path.clone(), 170);
		assert!(full.contains("refactor the auth layer"), "{full}");
		assert!(full.contains("📁 ~/segment/"), "{full}");

		// Title clamps first (to its 8-cell floor) while every other chip stays.
		let clamped = row(long_path.clone(), 149);
		assert!(clamped.contains("◀ refacto… <"), "{clamped}");
		assert!(clamped.contains("$0.12 ★ 2"), "{clamped}");
		assert!(clamped.contains("📁 ~/segment/"), "path untouched: {clamped}");

		// Then right chips pop right to left: cost first, then rate, total…
		let popped = row(long_path.clone(), 140);
		assert!(!popped.contains("$0.12"), "cost pops first: {popped}");
		assert!(popped.contains("tok/s"), "{popped}");
		assert!(popped.contains("◀ refacto… <"), "{popped}");
		assert!(popped.contains("📁 ~/segment/"), "path still untouched: {popped}");
		let popped = row(long_path.clone(), 116);
		assert!(!popped.contains("tok/s"), "{popped}");
		assert!(!popped.contains("🪙"), "{popped}");
		assert!(popped.contains("⤵ 12K < ⤴ 3.4K"), "{popped}");
		assert!(popped.contains("📁 ~/segment/"), "path still untouched: {popped}");

		// Only once the right group is gone does the path shrink.
		let squeezed = row(long_path, 60);
		assert!(!squeezed.contains("refacto"), "{squeezed}");
		assert!(!squeezed.contains('◀'), "{squeezed}");
		assert!(squeezed.contains("📁 …"), "{squeezed}");
		assert!(squeezed.contains("⑂ main"), "{squeezed}");
	}

	#[test]
	fn status_band_shrinks_the_path_then_drops_chips_from_the_right() {
		let long =
			StatusFacts { cwd: Str::new(format!("~/{}/tail", "segment/".repeat(8))), ..facts() };
		let row = self::row(long.clone(), 70);
		assert!(row.contains("📁 …"), "path shrinks first: {row}");
		assert!(row.contains("⑂ main"), "git survives while the path can shrink: {row}");
		assert!(row.ends_with("200K─"), "{row}");

		let row = self::row(long, 36);
		assert!(!row.contains("⑂ main"), "git drops before the path: {row}");
		assert!(!row.contains("Sonnet"), "model drops before the path: {row}");
		assert!(row.contains("📁 …"), "the working directory survives: {row}");
	}

	#[test]
	fn status_band_swaps_the_brand_for_spinner_and_timer_while_working() {
		let mut ui = Ui::from_root(
			StatusBand::new(StatusFacts { working: Some(Duration::ZERO), ..facts() }),
			80,
			UiContext::default(),
		);
		let row = frame_text(ui.frame()).lines().next().unwrap().to_owned();
		assert!(row.starts_with(" ⠋ 0s  > ⬢ Sonnet 4.5"), "{row}");
		assert!(ui.next_wake().is_some(), "spinner schedules a wake");
		ui.tick(Duration::from_millis(3_300));
		let row = frame_text(ui.frame()).lines().next().unwrap().to_owned();
		assert!(row.starts_with(" ⠙ 3s  >"), "{row}");
		ui.tick(Duration::from_secs(61));
		let row = frame_text(ui.frame()).lines().next().unwrap().to_owned();
		assert!(row.contains(" 1m  >"), "{row}");
	}

	#[test]
	fn focused_subagent_holds_the_brand_slot_in_the_warning_color() {
		let ctx = UiContext::default();
		let theme = ctx.theme;
		let focused = StatusFacts {
			focused_agent: Some(Str::new_static("Fx2Cards")),
			working: Some(Duration::ZERO),
			..facts()
		};
		let mut ui = Ui::from_root(StatusBand::new(focused.clone()), 80, ctx);
		let row = frame_text(ui.frame()).lines().next().unwrap().to_owned();
		// The `piSegment` identifier: the ghost and the agent id replace the
		// brand glyph
		// and the spinner alike while input goes to the subagent.
		assert!(row.starts_with(" 👻 Fx2Cards  > ⬢ Sonnet 4.5"), "{row}");
		assert!(!row.contains('⠋'), "no spinner while focused: {row}");
		ui.tick(Duration::from_secs(2));
		let row = frame_text(ui.frame()).lines().next().unwrap().to_owned();
		assert!(row.starts_with(" 👻 Fx2Cards  >"), "the id persists across ticks: {row}");
		let column = cell_width(&row[..row.find('F').expect("agent id")]);
		assert_eq!(ui.frame().cell(column, 0).style().foreground_color(), theme.warn);
		// Leaving the subagent restores the brand glyph.
		ui.with_component_mut::<StatusBand, _>(STATUS_ID, |band| {
			band.set_facts(StatusFacts { focused_agent: None, working: None, ..facts() })
		});
		let row = frame_text(ui.frame()).lines().next().unwrap().to_owned();
		assert!(row.starts_with(" π  > ⬢ Sonnet 4.5"), "{row}");
	}

	#[test]
	fn working_frames_reuse_the_fitted_layout_until_the_timer_widens() {
		let ctx = UiContext::default();
		let mut ui = Ui::from_root(
			StatusBand::new(StatusFacts { working: Some(Duration::ZERO), ..facts() }),
			80,
			ctx.clone(),
		);
		let cached = |ui: &Ui, brand: &str| {
			ui.with_component::<StatusBand, _>(STATUS_ID, |band| {
				band.cached_for(LayoutKey {
					width:       80,
					charset:     ctx.charset,
					revision:    ui.context().revision,
					brand_width: cell_width(brand),
				})
			})
			.expect("the band is the root")
		};
		// `⠋ 0s ` … `⠴ 9s `: same width, one fit shared by every spinner frame.
		assert!(cached(&ui, "⠋ 0s "));
		for millis in [80, 160, 1_000, 5_500, 9_900] {
			ui.tick(Duration::from_millis(millis));
			assert!(cached(&ui, "⠋ 0s "), "frame at {millis}ms reused the fit");
		}
		// `10s` is one cell wider: the fit is redone once, then held.
		ui.tick(Duration::from_millis(10_100));
		assert!(!cached(&ui, "⠋ 0s "));
		assert!(cached(&ui, "⠋ 10s "));
		ui.tick(Duration::from_millis(30_000));
		assert!(cached(&ui, "⠋ 10s "));
		let row = frame_text(ui.frame()).lines().next().unwrap().to_owned();
		assert!(row.contains(" 30s  > ⬢ Sonnet 4.5"), "the patched brand text paints: {row}");
		// A fact change invalidates and immediately rebuilds the fit through
		// `Ui::with_component_mut`; the replacement label must be present
		// while the same geometry key is cached again.
		ui.with_component_mut::<StatusBand, _>(STATUS_ID, |band| {
			band.set_facts(StatusFacts { working: Some(Duration::ZERO), fast: true, ..facts() })
		});
		assert!(cached(&ui, "⠋ 10s "));
		let row = frame_text(ui.frame()).lines().next().unwrap().to_owned();
		assert!(row.contains("Sonnet 4.5 ⚡"), "changed facts rebuilt cached labels: {row}");
	}

	#[test]
	fn mode_chip_shows_the_active_director_after_the_model() {
		let theme = UiContext::default().theme;
		let chip = |mode: ModeChip| {
			let row = self::row(StatusFacts { mode: Some(mode), ..facts() }, 100);
			row.split(" > ").nth(2).expect("mode chip").to_owned()
		};
		assert_eq!(chip(ModeChip::Plan), "🗺 Plan");
		assert_eq!(chip(ModeChip::PlanPaused), "🗺 Plan ⏸");
		assert_eq!(chip(ModeChip::Prewalk), "🏃 Prewalk");
		assert_eq!(chip(ModeChip::Vibe), "👥 Vibe");
		assert_eq!(chip(ModeChip::Goal(GoalState::Active)), "🎯 Goal");
		assert_eq!(chip(ModeChip::Goal(GoalState::Paused)), "⏸ Goal");
		assert_eq!(chip(ModeChip::Goal(GoalState::Complete)), "✔ Goal");
		assert_eq!(chip(ModeChip::Goal(GoalState::BudgetLimited)), "⚠ Goal");
		assert_eq!(chip(ModeChip::Goal(GoalState::Dropped)), "⏹ Goal");
		assert_eq!(chip(ModeChip::Loop { limit: None }), "↻ Loop running");
		assert_eq!(
			chip(ModeChip::Loop { limit: Some(LoopLimit::Iterations { remaining: 3, initial: 5 }) }),
			"↻ Loop running 3/5"
		);
		assert_eq!(chip(ModeChip::LoopPaused { limit: None }), "⏸ Loop paused");
		assert_eq!(
			chip(ModeChip::LoopPaused {
				limit: Some(LoopLimit::Iterations { remaining: 3, initial: 5 }),
			}),
			"⏸ Loop paused 3/5"
		);
		let row = self::row(StatusFacts { mode: Some(ModeChip::Plan), ..facts() }, 100);
		assert!(row.starts_with(" π  > ⬢ Sonnet 4.5 > 🗺 Plan > 📁 ~/proj > ⑂ main ▶"), "{row}");
		assert!(!self::row(facts(), 100).contains("Plan"), "no chip without a Director");

		// Paused goals paint warn, dropped goals paint muted: the chip color
		// is semantic, not the model green.
		let color_at = |mode, glyph| {
			let ui = Ui::from_root(
				StatusBand::new(StatusFacts { mode: Some(mode), ..facts() }),
				100,
				UiContext::default(),
			);
			let row = frame_text(ui.frame()).lines().next().unwrap().to_owned();
			let column = row
				.chars()
				.take_while(|ch| *ch != glyph)
				.map(|ch| cell_width(ch.encode_utf8(&mut [0; 4])))
				.sum::<u16>();
			ui.frame().cell(column, 0).style().foreground_color()
		};
		assert_eq!(color_at(ModeChip::Goal(GoalState::Paused), '⏸'), theme.warn);
		assert_eq!(color_at(ModeChip::Goal(GoalState::Dropped), '⏹'), theme.muted);

		// Overflow follows the configured segment order: after the path reaches
		// its floor, the rightmost non-path chip yields first.
		let row = self::row(StatusFacts { mode: Some(ModeChip::Plan), ..facts() }, 40);
		assert!(!row.contains("Plan"), "{row}");
		assert!(row.contains("📁"), "the path survives the mode chip: {row}");
	}

	#[test]
	fn speculation_pulses_the_compaction_tick_then_holds_accent_once_armed() {
		let theme = UiContext::default().theme;
		let tick_color = |ui: &Ui| {
			let row = frame_text(ui.frame()).lines().next().unwrap().to_owned();
			let column = row
				.chars()
				.take_while(|ch| *ch != '┃')
				.map(|ch| cell_width(ch.encode_utf8(&mut [0; 4])))
				.sum::<u16>();
			ui.frame().cell(column, 0).style().foreground_color()
		};
		let mut ui = Ui::from_root(
			StatusBand::new(StatusFacts { speculation: Speculation::Running, ..facts() }),
			80,
			UiContext::default(),
		);
		assert_eq!(tick_color(&ui), theme.accent, "pi starts the blink on");
		assert_eq!(ui.next_wake(), Some(SPECULATION_BLINK), "wakes at the flip");
		ui.tick(SPECULATION_BLINK);
		assert_eq!(tick_color(&ui), theme.muted);
		assert_eq!(ui.next_wake(), Some(SPECULATION_BLINK * 2));
		ui.tick(SPECULATION_BLINK * 2);
		assert_eq!(tick_color(&ui), theme.accent);

		let mut ui = Ui::from_root(
			StatusBand::new(StatusFacts { speculation: Speculation::Armed, ..facts() }),
			80,
			UiContext::default(),
		);
		assert_eq!(tick_color(&ui), theme.accent);
		assert_eq!(ui.next_wake(), None, "an armed tick is static");
		ui.tick(SPECULATION_BLINK);
		assert_eq!(tick_color(&ui), theme.accent);

		let idle = Ui::from_root(StatusBand::new(facts()), 80, UiContext::default());
		assert_eq!(idle.next_wake(), None);
		assert_eq!(tick_color(&idle), compaction_boundary_color(&theme));
	}
}
