//! `/plan-review` dialog as an observer-local [`Panel`] (ADR 0005).
//!
//! The plan is split into sections (preamble + one per ATX heading) and
//! rendered as one scrollable markdown body; beneath it
//! sit the prompt title, the optional model-tier slider, the approval
//! options, and a focus-aware help line. A Contents sidebar appears when
//! the terminal is wide enough and the plan has at least two headings; it
//! tracks the scrolled section, jumps between sections, deletes sections
//! (with undo), and annotates them with feedback that feeds the Refine
//! branch.
//!
//! Execution choices leave as a console line (ADR 0014), refinement recalls
//! the composed feedback, and “Save and quit” opens the native destination
//! editor with the exact reviewed plan contents.

use std::fmt::Write as _;

use omp_core::{Str, StrMut, sf};
use omp_tui::{
	Component as _, Dim, Frame, Key, Mouse, MouseReport, Size, Ui, UiContext, UiEvent,
	components::Markdown, dom,
};

use super::{Panel, PanelAction, PanelAnchor, PanelCx, PanelEvent};

/// Box title.
const OVERLAY_TITLE: &str = "Plan Review";
/// Prompt rendered above the options.
const PROMPT_TITLE: &str = "Plan mode - next step";
/// Approval options in display order.
const OPTIONS: [&str; 5] = [
	"Approve and execute",
	"Approve and compact context",
	"Approve, execute, and keep full context",
	"Refine plan",
	"Save and quit",
];
/// Slider caption.
const SLIDER_CAPTION: &str = "continue with";
/// Trailing footer hint.
const HELP_SUFFIX: &str = "esc cancel";
/// Composer seed when Refine is chosen without any annotation feedback.
const REFINE_SEED: &str = "Refine the plan: ";
/// Minimum plan-body rows kept visible even on short terminals.
const MIN_BODY_ROWS: u16 = 3;
/// Sidebar display gates.
const SIDEBAR_MIN_HEADINGS: usize = 2;
const SIDEBAR_MIN_TOTAL_WIDTH: u16 = 64;
const SIDEBAR_MIN_BODY_WIDTH: u16 = 40;
/// Rows a Shift+arrow scroll moves.
const FAST_SCROLL: u16 = 5;
/// Box border, section rule, options rule, and bottom border.
const FRAME_ROWS: u16 = 4;
/// Local artifact suffix the agent writes plans under.
const PLAN_SUFFIX: &str = "-plan.md";
/// Legacy single-plan artifact.
const LEGACY_PLAN_URL: &str = "local://PLAN.md";
/// Error when no plan artifact exists.
const NO_PLAN: &str = "No plan to review yet — write one to a local://<slug>-plan.md file first.";

/// One plan section.
#[derive(Clone, Debug, Eq, PartialEq)]
struct Section {
	/// `0` = preamble (no heading, no ToC entry); `1..=6` = heading depth.
	level:       u8,
	/// Plain-text heading label with inline markdown lightly stripped.
	title:       Str,
	/// Exact source slice, including its trailing newline(s).
	raw:         Str,
	/// Operator notes attached to this section.
	annotations: Vec<Str>,
}

/// Keyboard focus region.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Focus {
	Toc,
	Body,
	Actions,
}

/// Undo snapshot.
struct UndoEntry {
	text:        Str,
	annotations: Vec<Vec<Str>>,
	deleted:     Vec<Str>,
}

/// An annotation prompt in progress.
struct Annotating {
	section: usize,
	draft:   Str,
}

/// Retained plan review dialog.
pub struct PlanReviewPanel {
	title:           Str,
	sections:        Vec<Section>,
	toc:             Vec<usize>,
	toc_base:        u8,
	cycle:           Vec<(Str, Str)>,
	slider:          usize,
	selected:        usize,
	focus:           Focus,
	toc_cursor:      usize,
	undo:            Vec<UndoEntry>,
	deleted:         Vec<Str>,
	annotating:      Option<Annotating>,
	/// Mirrored body scroll offset (the scroll widget owns the real one).
	offset:          u16,
	section_offsets: Vec<u16>,
	content_h:       u16,
	pending_scroll:  Option<u16>,
	ui:              Ui,
	ctx:             UiContext,
	width:           u16,
	height:          u16,
	rows:            u16,
	sidebar:         bool,
	dirty:           bool,
}

impl PlanReviewPanel {
	/// Opens the review over the newest `local://<slug>-plan.md` artifact
	/// (falling back to `local://PLAN.md`). `cycle` is the `(role, model)`
	/// roster for the model-tier slider, shown only with two or more
	/// entries and starting on `default`.
	pub fn open(cx: &PanelCx<'_>, cycle: &[(Str, Str)]) -> Result<Self, Str> {
		let services = cx.services;
		let url = services
			.list_local(PLAN_SUFFIX)
			.ok()
			.and_then(|urls| urls.into_iter().next())
			.unwrap_or_else(|| Str::new_static(LEGACY_PLAN_URL));
		let content = match services.read_local(&url) {
			Ok(content) => content,
			Err(_) if url.as_str() != LEGACY_PLAN_URL => services
				.read_local(LEGACY_PLAN_URL)
				.map_err(|_| Str::new_static(NO_PLAN))?,
			Err(_) => return Err(Str::new_static(NO_PLAN)),
		};
		if content.trim().is_empty() {
			return Err(Str::new_static(NO_PLAN));
		}
		let cycle = cycle.to_vec();
		let slider = cycle
			.iter()
			.position(|(role, _)| role.as_str() == "default")
			.unwrap_or(0);
		let mut panel = Self {
			title: plan_title(&content, &url),
			sections: Vec::new(),
			toc: Vec::new(),
			toc_base: 1,
			cycle,
			slider,
			selected: 0,
			focus: Focus::Actions,
			toc_cursor: 0,
			undo: Vec::new(),
			deleted: Vec::new(),
			annotating: None,
			offset: 0,
			section_offsets: Vec::new(),
			content_h: 0,
			pending_scroll: None,
			ui: Ui::from_root(dom! { <col/> }, cx.viewport.width, cx.ui.clone()),
			ctx: cx.ui.clone(),
			width: cx.viewport.width,
			height: cx.viewport.height,
			rows: MIN_BODY_ROWS,
			sidebar: false,
			dirty: true,
		};
		panel.set_sections(&content);
		Ok(panel)
	}

	/// Plan title derived from its content.
	#[must_use]
	pub fn title(&self) -> &str {
		&self.title
	}

	/// Current plan text (after in-overlay deletions).
	#[must_use]
	pub fn plan(&self) -> Str {
		join_sections(&self.sections)
	}

	/// Refine feedback markdown built from deletions and annotations; empty
	/// when there is none.
	#[must_use]
	pub fn feedback(&self) -> Str {
		let annotated = self
			.sections
			.iter()
			.filter(|section| !section.annotations.is_empty());
		if self.deleted.is_empty() && annotated.clone().next().is_none() {
			return Str::default();
		}
		let mut feedback = StrMut::new("Refinement feedback on the plan:\n");
		if !self.deleted.is_empty() {
			feedback.push_str("\nRemove these sections:\n");
			for title in &self.deleted {
				let _ = writeln!(feedback, "- {title}");
			}
		}
		for section in annotated {
			let title = if section.title.is_empty() {
				"Plan preamble"
			} else {
				section.title.as_str()
			};
			let _ = write!(feedback, "\n## {title}\n");
			for note in &section.annotations {
				if note.contains('\n') {
					let fence = fence_for(note);
					let _ = write!(feedback, "{fence}md\n{note}\n{fence}\n");
				} else {
					let _ = writeln!(feedback, "- {note}");
				}
			}
		}
		feedback.freeze()
	}

	/// Selected slider role (`default` when no roster was supplied).
	fn role(&self) -> &str {
		self
			.cycle
			.get(self.slider)
			.map_or("default", |(role, _)| role.as_str())
	}

	fn set_sections(&mut self, text: &str) {
		self.sections = parse_sections(text)
			.into_iter()
			.map(|(level, title, raw)| Section { level, title, raw, annotations: Vec::new() })
			.collect();
		self.rebuild_toc();
		self.toc_cursor = self.toc_cursor.min(self.toc.len().saturating_sub(1));
		self.dirty = true;
	}

	/// Rebuilds every heading, minus a lone shallowest heading at
	/// the top of the document (the plan's own name).
	fn rebuild_toc(&mut self) {
		let headings = self
			.sections
			.iter()
			.enumerate()
			.filter(|(_, section)| section.level >= 1)
			.map(|(index, _)| index)
			.collect::<Vec<_>>();
		let min_level = headings
			.iter()
			.map(|&index| self.sections[index].level)
			.min()
			.unwrap_or(1);
		let top_level = headings
			.iter()
			.copied()
			.filter(|&index| self.sections[index].level == min_level)
			.collect::<Vec<_>>();
		let title_index = match (top_level.as_slice(), headings.first()) {
			([only], Some(first)) if only == first => Some(*only),
			_ => None,
		};
		self.toc = headings
			.into_iter()
			.filter(|index| Some(*index) != title_index)
			.collect();
		self.toc_base = self
			.toc
			.iter()
			.map(|&index| self.sections[index].level)
			.min()
			.unwrap_or(1);
	}

	fn sidebar_width(width: u16) -> u16 {
		((f32::from(width) * 0.24).round() as u16).clamp(18, 30)
	}

	fn sidebar_visible(&self, width: u16) -> bool {
		self.toc.len() >= SIDEBAR_MIN_HEADINGS
			&& width >= SIDEBAR_MIN_TOTAL_WIDTH
			&& width.saturating_sub(Self::sidebar_width(width) + 7) >= SIDEBAR_MIN_BODY_WIDTH
	}

	/// Markdown column inside the scroll pane (box border, padding, the
	/// sidebar split, and the scrollbar column).
	fn body_width(&self) -> u16 {
		let inner = self.width.saturating_sub(4);
		let body = if self.sidebar {
			inner.saturating_sub(Self::sidebar_width(self.width) + 3)
		} else {
			inner
		};
		body.saturating_sub(1).max(1)
	}

	fn max_offset(&self) -> u16 {
		self.content_h.saturating_sub(self.rows)
	}

	/// Greatest ToC position whose section starts at or above the scroll
	/// offset.
	fn toc_from_scroll(&self) -> usize {
		if self.toc.is_empty() {
			return 0;
		}
		let mut current = 0;
		for (index, &start) in self.section_offsets.iter().enumerate() {
			if start <= self.offset {
				current = index;
			} else {
				break;
			}
		}
		let mut pos = 0;
		for (p, &index) in self.toc.iter().enumerate() {
			if index <= current {
				pos = p;
			} else {
				break;
			}
		}
		pos
	}

	fn set_focus(&mut self, focus: Focus) {
		self.focus = focus;
		if focus == Focus::Toc {
			self.toc_cursor = self.toc_from_scroll();
		}
		self.dirty = true;
	}

	fn cycle_region(&mut self, forward: bool) {
		let regions: &[Focus] = if self.sidebar {
			&[Focus::Toc, Focus::Body, Focus::Actions]
		} else {
			&[Focus::Body, Focus::Actions]
		};
		let current = regions
			.iter()
			.position(|&focus| focus == self.focus)
			.unwrap_or(regions.len() - 1);
		let next = if forward {
			(current + 1) % regions.len()
		} else {
			(current + regions.len() - 1) % regions.len()
		};
		self.set_focus(regions[next]);
	}

	fn move_slider(&mut self, delta: isize) {
		if self.cycle.len() < 2 {
			return;
		}
		let next = self
			.slider
			.saturating_add_signed(delta)
			.min(self.cycle.len() - 1);
		if next != self.slider {
			self.slider = next;
			self.dirty = true;
		}
	}

	fn move_selection(&mut self, delta: isize) {
		let next = self
			.selected
			.saturating_add_signed(delta)
			.min(OPTIONS.len() - 1);
		if next != self.selected {
			self.selected = next;
			self.dirty = true;
		}
	}

	fn confirm(&mut self) -> PanelEvent {
		let role = self.role();
		match self.selected {
			0 => PanelEvent::Finish(sf!("plan_approve {role}")),
			1 => PanelEvent::Finish(sf!("plan_approve {role} compact")),
			2 => PanelEvent::Finish(sf!("plan_approve {role} keep")),
			3 => {
				let feedback = self.feedback();
				if feedback.trim().is_empty() {
					PanelEvent::Recall(Str::new_static(REFINE_SEED))
				} else {
					PanelEvent::Recall(feedback)
				}
			},
			_ => PanelEvent::OpenPlanSave { content: self.plan(), title: self.title.clone() },
		}
	}

	/// Scrolls the body by `delta` rows through the scroll widget, keeping
	/// the mirrored offset in step.
	fn scroll_by(&mut self, delta: i32) {
		let next =
			(i64::from(self.offset) + i64::from(delta)).clamp(0, i64::from(self.max_offset())) as u16;
		if next == self.offset {
			return;
		}
		if self.dirty {
			self.offset = next;
			return;
		}
		self.ui.focus_id("body");
		let key = if delta < 0 { Key::Up } else { Key::Down };
		for _ in 0..next.abs_diff(self.offset) {
			self.ui.handle_key(key);
		}
		self.offset = next;
		self.ui.focus_id("body");
	}

	fn scroll_to(&mut self, offset: u16) {
		let delta = i32::from(offset.min(self.max_offset())) - i32::from(self.offset);
		self.scroll_by(delta);
	}

	/// Scrolls the body so the selected ToC section's heading sits at the
	/// top.
	fn scrub_body_to_toc(&mut self) {
		let Some(&index) = self.toc.get(self.toc_cursor) else {
			return;
		};
		let Some(&start) = self.section_offsets.get(index) else {
			return;
		};
		if self.dirty {
			self.pending_scroll = Some(start);
		} else {
			self.scroll_to(start);
		}
	}

	/// Shared paging keys for body and actions focus.
	fn body_scroll_key(&mut self, key: Key) -> bool {
		let rows = i32::from(self.rows);
		let delta = match key {
			Key::PageUp => -rows,
			Key::PageDown => rows,
			Key::SelectUp => -i32::from(FAST_SCROLL),
			Key::SelectDown => i32::from(FAST_SCROLL),
			Key::Home | Key::Char('g') => -i32::from(self.content_h),
			Key::End | Key::Char('G') => i32::from(self.content_h),
			_ => return false,
		};
		self.scroll_by(delta);
		true
	}

	fn handle_actions(&mut self, key: Key) -> PanelEvent {
		let has_slider = self.cycle.len() > 1;
		match key {
			Key::Left => self.move_slider(-1),
			Key::Char('h') if has_slider => self.move_slider(-1),
			Key::Right => self.move_slider(1),
			Key::Char('l') if has_slider => self.move_slider(1),
			Key::Up | Key::Char('k') => {
				if self.selected == 0 {
					self.set_focus(Focus::Body);
				} else {
					self.move_selection(-1);
				}
			},
			Key::Down | Key::Char('j') => self.move_selection(1),
			Key::Enter => return self.confirm(),
			_ => {
				self.body_scroll_key(key);
			},
		}
		PanelEvent::Consumed
	}

	fn handle_body(&mut self, key: Key) -> PanelEvent {
		match key {
			Key::Char('a') => self.start_body_annotate(),
			Key::Left | Key::Char('h') => {
				if self.sidebar {
					self.set_focus(Focus::Toc);
				}
			},
			Key::Right | Key::Char('l') | Key::Enter => self.set_focus(Focus::Actions),
			Key::Up | Key::Char('k') => {
				if self.offset == 0 && self.sidebar {
					self.set_focus(Focus::Toc);
				} else {
					self.scroll_by(-1);
				}
			},
			Key::Down | Key::Char('j') => {
				if self.offset >= self.max_offset() {
					self.set_focus(Focus::Actions);
				} else {
					self.scroll_by(1);
				}
			},
			_ => {
				self.body_scroll_key(key);
			},
		}
		PanelEvent::Consumed
	}

	fn handle_toc(&mut self, key: Key) -> PanelEvent {
		match key {
			Key::Up | Key::Char('k') => self.move_toc_cursor(-1),
			Key::Down | Key::Char('j') => {
				if self.toc_cursor + 1 >= self.toc.len() {
					self.set_focus(Focus::Actions);
				} else {
					self.move_toc_cursor(1);
				}
			},
			Key::Right | Key::Char('l') | Key::Enter => self.set_focus(Focus::Body),
			Key::Char('d') | Key::Delete => self.delete_selected_section(),
			Key::Char('a') => self.start_section_annotate(),
			Key::Char('u') => self.undo_last(),
			_ => {},
		}
		PanelEvent::Consumed
	}

	fn move_toc_cursor(&mut self, delta: isize) {
		if self.toc.is_empty() {
			return;
		}
		let next = self
			.toc_cursor
			.saturating_add_signed(delta)
			.min(self.toc.len() - 1);
		if next == self.toc_cursor {
			return;
		}
		self.toc_cursor = next;
		self.dirty = true;
		self.scrub_body_to_toc();
	}

	fn push_undo(&mut self) {
		self.undo.push(UndoEntry {
			text:        join_sections(&self.sections),
			annotations: self
				.sections
				.iter()
				.map(|section| section.annotations.clone())
				.collect(),
			deleted:     self.deleted.clone(),
		});
	}

	/// Deletes the heading plus every deeper section
	/// that follows it; the removed titles feed the Refine feedback.
	fn delete_selected_section(&mut self) {
		let Some(&index) = self.toc.get(self.toc_cursor) else {
			return;
		};
		let span = deletion_span(&self.sections, index);
		if span.is_empty() {
			return;
		}
		self.push_undo();
		for &i in &span {
			let section = &self.sections[i];
			if section.level >= 1 && !section.title.is_empty() {
				self.deleted.push(section.title.clone());
			}
		}
		self.sections.drain(span[0]..=span[span.len() - 1]);
		self.rebuild_toc();
		self.toc_cursor = self.toc_cursor.min(self.toc.len().saturating_sub(1));
		self.dirty = true;
		self.scrub_body_to_toc();
	}

	fn undo_last(&mut self) {
		let Some(entry) = self.undo.pop() else {
			return;
		};
		self.set_sections(&entry.text);
		for (section, annotations) in self.sections.iter_mut().zip(entry.annotations) {
			section.annotations = annotations;
		}
		self.deleted = entry.deleted;
		self.toc_cursor = self.toc_cursor.min(self.toc.len().saturating_sub(1));
		self.scrub_body_to_toc();
	}

	fn start_section_annotate(&mut self) {
		if let Some(&section) = self.toc.get(self.toc_cursor) {
			self.start_annotate(section);
		}
	}

	/// Annotates the section under the top visible body row.
	fn start_body_annotate(&mut self) {
		if self.sections.is_empty() {
			return;
		}
		let section = self
			.section_offsets
			.iter()
			.rposition(|&start| start <= self.offset)
			.unwrap_or(0);
		self.start_annotate(section);
	}

	fn start_annotate(&mut self, section: usize) {
		self.annotating = Some(Annotating { section, draft: Str::default() });
		self.dirty = true;
	}

	fn submit_annotation(&mut self) {
		let Some(Annotating { section, draft }) = self.annotating.take() else {
			return;
		};
		let note = draft.trim();
		if !note.is_empty() && section < self.sections.len() {
			self.push_undo();
			self.sections[section].annotations.push(note);
		}
		self.dirty = true;
	}

	fn handle_annotating(&mut self, key: Key) -> PanelEvent {
		match key {
			Key::Esc => {
				self.annotating = None;
				self.dirty = true;
				PanelEvent::Consumed
			},
			Key::Enter => {
				self.submit_annotation();
				PanelEvent::Consumed
			},
			_ => {
				let event = self.ui.handle_key(key);
				self.route_ui(event)
			},
		}
	}

	fn route_ui(&mut self, event: UiEvent) -> PanelEvent {
		match event {
			UiEvent::Cancel => PanelEvent::Close,
			UiEvent::Changed { id, value } if id.as_str() == "note" => {
				if let Some(annotating) = &mut self.annotating {
					annotating.draft = value;
				}
				PanelEvent::Consumed
			},
			UiEvent::Changed { id, value } if id.as_str() == "tier" => {
				if let Some(index) = self
					.cycle
					.iter()
					.position(|(role, _)| role.as_str() == value.as_str())
					&& index != self.slider
				{
					self.slider = index;
					self.dirty = true;
				}
				PanelEvent::Consumed
			},
			_ => PanelEvent::Consumed,
		}
	}

	fn sync_pointer_tier(&mut self) {
		let values = self.ui.values();
		let Some(role) = values.get("tier").and_then(|value| value.as_str()) else {
			return;
		};
		if let Some(index) = self
			.cycle
			.iter()
			.position(|(candidate, _)| candidate.as_str() == role)
			&& index != self.slider
		{
			self.slider = index;
			self.dirty = true;
		}
	}

	/// Builds the contextual help line.
	fn help(&self) -> Str {
		let mut parts: Vec<&str> = Vec::with_capacity(8);
		match self.focus {
			Focus::Actions => {
				parts.extend(["↑↓ select", "⏎ confirm"]);
				if self.cycle.len() > 1 {
					parts.push("◂▸ model");
				}
			},
			Focus::Toc => parts.extend(["↑↓ section", "⏎ open", "a annotate", "d delete", "u undo"]),
			Focus::Body => {
				parts.extend(["↑↓ scroll", "⇧ faster", "pgup/pgdn", "g/G ends", "a annotate"]);
			},
		}
		parts.extend(["c copy", "tab regions", HELP_SUFFIX]);
		Str::from(parts.join(" · "))
	}

	/// Body rows for the current viewport: chrome rows are the
	/// four frame rows plus prompt, slider, options, and footer rows).
	fn body_rows(&self) -> u16 {
		let slider_rows = if self.cycle.len() > 1 { 2 } else { 0 };
		let footer_rows = if self.annotating.is_some() { 3 } else { 1 };
		let chrome = FRAME_ROWS + 1 + slider_rows + OPTIONS.len() as u16 + footer_rows;
		self.height.saturating_sub(chrome).max(MIN_BODY_ROWS)
	}

	fn measure_sections(&mut self) {
		let width = self.body_width();
		let mut offset = 0u16;
		self.section_offsets.clear();
		for section in &self.sections {
			self.section_offsets.push(offset);
			let height = Markdown::text_of(section.raw.clone()).height(&self.ctx, width);
			offset = offset.saturating_add(height);
		}
		self.content_h = offset;
		self.offset = self.offset.min(self.max_offset());
	}

	fn rebuild(&mut self) {
		self.sidebar = self.sidebar_visible(self.width);
		self.rows = self.body_rows();
		self.measure_sections();
		if self.focus != Focus::Toc {
			self.toc_cursor = self.toc_from_scroll();
		}
		let rows = self.rows;
		let sidebar = self.sidebar;
		let sidebar_w = Dim::Cells(Self::sidebar_width(self.width));
		let title = sf!("{OVERLAY_TITLE} · {}", self.title);
		let sections = self
			.sections
			.iter()
			.map(|section| section.raw.clone())
			.collect::<Vec<_>>();
		let toc = self.toc_rows();
		let show_slider = self.cycle.len() > 1;
		let role = Str::new(self.role());
		let detail = self
			.cycle
			.get(self.slider)
			.map(|(_, model)| model.clone())
			.unwrap_or_default();
		let left_fg = if self.slider > 0 { "accent" } else { "muted" };
		let right_fg = if self.slider + 1 < self.cycle.len() {
			"accent"
		} else {
			"muted"
		};
		let roles = self
			.cycle
			.iter()
			.map(|(role, _)| role.clone())
			.collect::<Vec<_>>();
		let actions = self.focus == Focus::Actions;
		let options = OPTIONS
			.iter()
			.enumerate()
			.map(|(index, label)| {
				let selected = index == self.selected;
				let cursor_fg = if actions { "accent" } else { "muted" };
				let label_fg = if selected && actions { "accent" } else { "fg" };
				(selected, cursor_fg, label_fg, selected && actions, Str::new_static(label))
			})
			.collect::<Vec<_>>();
		let annotating = self.annotating.as_ref().map(|annotating| {
			let section = self.sections.get(annotating.section);
			let title = section
				.filter(|section| !section.title.is_empty())
				.map_or("Plan preamble", |section| section.title.as_str());
			(sf!("‹{title}›"), annotating.draft.clone())
		});
		let help = self.help();
		let tree = dom! {
			<box border=round title={title} pad-x=1>
				<col>
					if sidebar {
						<row gap=1>
							<col w={sidebar_w}>
								for (gutter, fg, label, annotated) in toc {
									match gutter {
										Gutter::Cursor => {
											<row gap=1 bg=selection>
												<icon name="cursor" fg={fg} bold/>
												<text fg={fg} bold truncate>{label}</text>
												if annotated { <icon name="edit" fg={fg}/> }
											</row>
										},
										Gutter::Glow => {
											<row gap=1>
												<icon name="rail" fg={fg}/>
												<text fg={fg} truncate>{label}</text>
												if annotated { <icon name="edit" fg={fg}/> }
											</row>
										},
										Gutter::Blank => {
											<row gap=1>
												<spacer w=1/>
												<text fg={fg} truncate>{label}</text>
												if annotated { <icon name="edit" fg={fg}/> }
											</row>
										},
									}
								}
							</col>
							<hr vertical border=round h={rows}/>
							<scroll id="body" h={rows} grow>
								for raw in sections {
									<md>{raw}</md>
								}
							</scroll>
						</row>
					} else {
						<scroll id="body" h={rows}>
							for raw in sections {
								<md>{raw}</md>
							}
						</scroll>
					}
					<hr border=round/>
					<text bold fg=accent>{PROMPT_TITLE}</text>
					if show_slider {
						<row gap=2>
							<text fg=muted>{SLIDER_CAPTION}</text>
							<icon name="previous" fg={left_fg}/>
							<segmented id="tier" value={role}>
								for role in roles {
									<option value={role.clone()} label={role}/>
								}
							</segmented>
							<icon name="next" fg={right_fg}/>
						</row>
						<row gap=1>
							<spacer w=2/>
							<icon name="tree-last" fg=muted/>
							<text fg=muted truncate>{detail}</text>
						</row>
					}
					for (selected, cursor_fg, label_fg, bold, label) in options {
						<row gap=1>
							if selected { <icon name="cursor" fg={cursor_fg}/> } else { <spacer w=1/> }
							<text fg={label_fg} bold={bold}>{label}</text>
						</row>
					}
					<hr border=round/>
					if let Some((location, draft)) = annotating {
						<row gap=1>
							<text fg=muted>{"Annotate"}</text>
							<text fg=accent truncate>{location}</text>
						</row>
						<input id="note" value={draft} placeholder="feedback for this section"/>
						<text fg=muted truncate>{"enter save · esc cancel"}</text>
					} else {
						<text fg=muted truncate>{help}</text>
					}
				</col>
			</box>
		};
		self.ui = Ui::from_root(tree, self.width, self.ctx.clone());
		if self.annotating.is_some() {
			self.ui.focus_id("note");
		} else {
			self.ui.focus_id("body");
		}
		self.dirty = false;
	}

	/// Sidebar rows windowed around the cursor: gutter glyph, indent per
	/// nesting level, title,
	/// and an annotation marker.
	fn toc_rows(&self) -> Vec<(Gutter, &'static str, Str, bool)> {
		let slots = usize::from(self.rows);
		let total = self.toc.len();
		let start = if total > slots {
			self.toc_cursor.saturating_sub(slots / 2).min(total - slots)
		} else {
			0
		};
		self
			.toc
			.iter()
			.enumerate()
			.skip(start)
			.take(slots)
			.map(|(pos, &index)| {
				let section = &self.sections[index];
				let highlighted = pos == self.toc_cursor;
				let selected = highlighted && self.focus == Focus::Toc;
				let glow = highlighted && self.focus != Focus::Toc;
				let indent = usize::from(section.level.saturating_sub(self.toc_base));
				let mut label = StrMut::new("");
				for _ in 0..indent {
					label.push(' ');
				}
				if section.title.is_empty() {
					label.push_str("(untitled)");
				} else {
					label.push_str(&section.title);
				}
				let (gutter, fg) = if selected {
					(Gutter::Cursor, "fg")
				} else if glow {
					(Gutter::Glow, "accent")
				} else {
					(Gutter::Blank, "muted")
				};
				(gutter, fg, label.freeze(), !section.annotations.is_empty())
			})
			.collect()
	}

	/// Rebuilds a stale tree so keys land on live widgets.
	fn sync(&mut self) {
		if self.dirty {
			self.rebuild();
			self.restore_scroll();
		}
	}

	/// Re-applies the mirrored offset to a freshly built scroll widget.
	fn restore_scroll(&mut self) {
		let target = self
			.pending_scroll
			.take()
			.map_or(self.offset, |start| start.min(self.max_offset()));
		self.ui.frame();
		self.ui.focus_id("body");
		self.ui.handle_key(Key::Home);
		let pages = target / self.rows.max(1);
		for _ in 0..pages {
			self.ui.handle_key(Key::PageDown);
		}
		for _ in 0..target % self.rows.max(1) {
			self.ui.handle_key(Key::Down);
		}
		self.offset = target;
		// A refused Down hands focus to the next widget; take it back.
		self.ui.focus_id("body");
		if self.annotating.is_some() {
			self.ui.focus_id("note");
		}
	}
}

/// Sidebar gutter glyph.
#[derive(Clone, Copy)]
enum Gutter {
	Cursor,
	Glow,
	Blank,
}

impl Panel for PlanReviewPanel {
	fn id(&self) -> &'static str {
		"plan_review"
	}

	fn anchor(&self) -> PanelAnchor {
		PanelAnchor::Center
	}

	fn action(&mut self, _action: PanelAction) -> PanelEvent {
		// This overlay has no section folding; Ctrl+O and the other chords
		// fall through to the raw key path.
		PanelEvent::Ignored
	}

	fn key(&mut self, key: Key) -> PanelEvent {
		if self.annotating.is_some() {
			self.sync();
			return self.handle_annotating(key);
		}
		match key {
			Key::Esc => PanelEvent::Close,
			Key::Char('c') => PanelEvent::Copy(self.plan()),
			Key::Tab => {
				self.cycle_region(true);
				PanelEvent::Consumed
			},
			Key::BackTab => {
				self.cycle_region(false);
				PanelEvent::Consumed
			},
			_ => match self.focus {
				Focus::Actions => self.handle_actions(key),
				Focus::Body => self.handle_body(key),
				Focus::Toc => self.handle_toc(key),
			},
		}
	}

	fn paste(&mut self, text: &str) -> PanelEvent {
		if self.annotating.is_none() {
			return PanelEvent::Ignored;
		}
		self.sync();
		let event = self.ui.handle_paste(text);
		self.route_ui(event)
	}

	fn mouse(&mut self, report: MouseReport) -> PanelEvent {
		self.sync();
		let event = self
			.ui
			.handle_mouse_with_mods(report.col, report.row, report.kind, report.mods);
		let routed = self.route_ui(event);
		if self.annotating.is_none() {
			self.sync_pointer_tier();
		}
		if report.row > 0 && report.row <= self.rows {
			match report.kind {
				Mouse::WheelUp => self.offset = self.offset.saturating_sub(1),
				Mouse::WheelDown => {
					self.offset = self.offset.saturating_add(1).min(self.max_offset());
				},
				_ => {},
			}
		}
		routed
	}

	fn frame(&mut self, viewport: Size) -> &Frame {
		if viewport.width != self.width || viewport.height != self.height {
			self.width = viewport.width;
			self.height = viewport.height;
			self.dirty = true;
		}
		if !self.dirty && self.focus != Focus::Toc && self.toc_cursor != self.toc_from_scroll() {
			self.dirty = true;
		}
		self.sync();
		self.ui.frame()
	}
}

/// Resolves the first level-1 heading, else the artifact filename stem, else
/// `plan`, each run through `normalize_plan_title`.
fn plan_title(content: &str, url: &str) -> Str {
	let heading = content.lines().find_map(|line| {
		let rest = line.trim_start_matches([' ', '\t']).strip_prefix('#')?;
		let title = rest.strip_prefix([' ', '\t'])?.trim();
		(!title.is_empty()).then_some(title)
	});
	let stem = url
		.trim_start_matches("local:")
		.trim_start_matches('/')
		.rsplit(['/', '\\'])
		.next()
		.map(|last| {
			last
				.strip_suffix(".md")
				.or_else(|| last.strip_suffix(".MD"))
				.unwrap_or(last)
		})
		.unwrap_or_default();
	heading
		.and_then(normalize_plan_title)
		.or_else(|| normalize_plan_title(stem))
		.unwrap_or_else(|| Str::new_static("plan"))
}

/// Normalizes a title without errors: `None` for invalid input.
fn normalize_plan_title(title: &str) -> Option<Str> {
	let trimmed = title.trim();
	if trimmed.is_empty() || trimmed.contains(['/', '\\']) || trimmed.contains("..") {
		return None;
	}
	let without_ext = trimmed
		.strip_suffix(".md")
		.or_else(|| trimmed.strip_suffix(".MD"))
		.unwrap_or(trimmed);
	let mut out = StrMut::new("");
	let mut pending_hyphen = false;
	for ch in without_ext.chars() {
		if ch.is_whitespace() || ch == '-' {
			pending_hyphen = true;
		} else if ch.is_ascii_alphanumeric() || ch == '_' {
			if pending_hyphen && !out.is_empty() {
				out.push('-');
			}
			pending_hyphen = false;
			out.push(ch);
		}
	}
	(!out.is_empty()).then(|| out.freeze())
}

/// ATX heading: 1-6 `#`, required whitespace, a title, and optional closing
/// `#`s.
fn heading(line: &str) -> Option<(u8, &str)> {
	let level = line.bytes().take_while(|&b| b == b'#').count();
	if !(1..=6).contains(&level) {
		return None;
	}
	let rest = line[level..].strip_prefix([' ', '\t'])?;
	let title = rest
		.trim_end_matches([' ', '\t'])
		.trim_end_matches('#')
		.trim_end_matches([' ', '\t']);
	(!title.is_empty()).then_some((level as u8, title))
}

/// Opening/closing code fence run (``` or ~~~) allowing up to 3 lead spaces:
/// fence character, run length, and
/// whether the remainder is blank.
fn fence(line: &str) -> Option<(u8, usize, bool)> {
	let lead = line.bytes().take_while(|&b| b == b' ').count();
	if lead > 3 {
		return None;
	}
	let rest = &line[lead..];
	let first = *rest.as_bytes().first()?;
	if first != b'`' && first != b'~' {
		return None;
	}
	let run = rest.bytes().take_while(|&b| b == first).count();
	(run >= 3).then(|| (first, run, rest[run..].trim().is_empty()))
}

/// Collapses inline markdown emphasis, link, and code syntax to readable text.
fn strip_inline_markdown(text: &str) -> Str {
	let mut out = String::from(text);
	strip_links(&mut out);
	for pair in ["`", "**", "__", "*", "_", "~~"] {
		strip_pairs(&mut out, pair);
	}
	Str::from(out.split_whitespace().collect::<Vec<_>>().join(" "))
}

/// `![alt](url)`, `[text](url)`, `[text][ref]` → their text; `<url>` → url.
fn strip_links(text: &mut String) {
	let mut out = String::with_capacity(text.len());
	let mut rest = text.as_str();
	while let Some(open) = rest.find(['[', '<']) {
		let (before, tail) = rest.split_at(open);
		let (before, kind) = match tail.as_bytes()[0] {
			b'<' => (before, '<'),
			_ if before.ends_with('!') => (&before[..before.len() - 1], '['),
			_ => (before, '['),
		};
		let replaced = if kind == '<' {
			tail[1..]
				.find('>')
				.filter(|&end| !tail[1..1 + end].contains(char::is_whitespace) && end > 0)
				.map(|end| (&tail[1..1 + end], 2 + end))
		} else {
			tail[1..].find(']').and_then(|close| {
				let label = &tail[1..1 + close];
				let after = &tail[1 + close + 1..];
				let target = after
					.strip_prefix('(')
					.map(|inner| (')', inner))
					.or_else(|| after.strip_prefix('[').map(|inner| (']', inner)))?;
				let end = target.1.find(target.0)?;
				Some((label, 1 + close + 1 + 1 + end + 1))
			})
		};
		out.push_str(before);
		match replaced {
			Some((label, consumed)) => {
				out.push_str(label);
				rest = &tail[consumed..];
			},
			None => {
				out.push_str(&tail[..1]);
				rest = &tail[1..];
			},
		}
	}
	out.push_str(rest);
	*text = out;
}

/// Removes matched `pair` delimiter runs around non-empty spans.
fn strip_pairs(text: &mut String, pair: &str) {
	let mut out = String::with_capacity(text.len());
	let mut rest = text.as_str();
	while let Some(open) = rest.find(pair) {
		let after = &rest[open + pair.len()..];
		match after.find(pair).filter(|&close| close > 0) {
			Some(close) => {
				out.push_str(&rest[..open]);
				out.push_str(&after[..close]);
				rest = &after[close + pair.len()..];
			},
			None => {
				out.push_str(&rest[..open + pair.len()]);
				rest = after;
			},
		}
	}
	out.push_str(rest);
	*text = out;
}

/// Splits `text` into preamble + heading sections; `#` inside fenced code
/// is never a heading; concatenating every `raw` reproduces the source.
fn parse_sections(text: &str) -> Vec<(u8, Str, Str)> {
	let mut heads: Vec<(usize, u8, Str)> = Vec::new();
	let mut open_fence: Option<(u8, usize)> = None;
	let mut offset = 0;
	for line in text.split('\n') {
		let start = offset;
		offset += line.len() + 1;
		let fence = fence(line);
		match open_fence {
			None => {
				if let Some((ch, run, _)) = fence {
					open_fence = Some((ch, run));
					continue;
				}
			},
			Some((ch, run)) => {
				if let Some((close_ch, close_run, blank)) = fence
					&& close_ch == ch
					&& close_run >= run
					&& blank
				{
					open_fence = None;
				}
				continue;
			},
		}
		if let Some((level, title)) = heading(line) {
			heads.push((start, level, strip_inline_markdown(title)));
		}
	}
	let mut sections = Vec::with_capacity(heads.len() + 1);
	let first = heads.first().map_or(text.len(), |head| head.0);
	if first > 0 {
		sections.push((0, Str::default(), Str::new(&text[..first])));
	}
	for (index, (start, level, title)) in heads.iter().enumerate() {
		let end = heads.get(index + 1).map_or(text.len(), |next| next.0);
		sections.push((*level, title.clone(), Str::new(&text[*start..end])));
	}
	sections
}

/// Joins every `raw` back-to-back with one trailing newline.
fn join_sections(sections: &[Section]) -> Str {
	let mut joined = StrMut::new("");
	for section in sections {
		joined.push_str(&section.raw);
	}
	if !joined.is_empty() && !joined.ends_with('\n') {
		joined.push('\n');
	}
	joined.freeze()
}

/// Finds the heading plus every following section
/// nested deeper than it; the preamble is never a deletion target.
fn deletion_span(sections: &[Section], index: usize) -> Vec<usize> {
	let Some(target) = sections.get(index) else {
		return Vec::new();
	};
	if target.level == 0 {
		return Vec::new();
	}
	let mut span = vec![index];
	span.extend(
		sections
			.iter()
			.enumerate()
			.skip(index + 1)
			.take_while(|(_, section)| section.level > target.level)
			.map(|(i, _)| i),
	);
	span
}

/// A backtick fence longer than any run inside `text`.
fn fence_for(text: &str) -> Str {
	let mut fence = StrMut::new("```");
	while text.contains(fence.as_str()) {
		fence.push('`');
	}
	fence.freeze()
}

#[cfg(test)]
mod tests {
	use std::sync::Arc;

	use omp_con::Ctx;
	use omp_dom::Dom;
	use omp_tui::{Mods, MouseButton};

	use super::*;
	use crate::overlays::services::{ServiceError, ServiceResult, Services};

	/// One `-plan.md` artifact.
	struct Plan(Str);

	impl Services for Plan {
		fn read_local(&self, url: &str) -> ServiceResult<Str> {
			if url == "local://auth-plan.md" {
				Ok(self.0.clone())
			} else {
				Err(ServiceError::Unavailable("local artifacts"))
			}
		}

		fn list_local(&self, suffix: &str) -> ServiceResult<Vec<Str>> {
			assert_eq!(suffix, "-plan.md");
			Ok(vec![Str::new_static("local://auth-plan.md")])
		}
	}

	/// Only the legacy `local://PLAN.md`.
	struct Legacy;

	impl Services for Legacy {
		fn read_local(&self, url: &str) -> ServiceResult<Str> {
			if url == "local://PLAN.md" {
				Ok(Str::new_static("# Legacy\n\nbody\n"))
			} else {
				Err(ServiceError::Unavailable("local artifacts"))
			}
		}

		fn list_local(&self, _suffix: &str) -> ServiceResult<Vec<Str>> {
			Ok(Vec::new())
		}
	}

	struct NoPlan;

	impl Services for NoPlan {}

	const PLAN: &str = "# Auth plan\n\nIntro paragraph.\n\n## Goal\n\nShip **login**.\n\n## \
	                    Steps\n\n1. one\n2. two\n\n### Detail\n\nmore\n\n## Risks\n\nnone\n";

	fn roster(roles: &[&str]) -> Vec<(Str, Str)> {
		roles
			.iter()
			.map(|role| (Str::new(role), sf!("{role}-model")))
			.collect()
	}

	fn plan() -> Arc<dyn Services> {
		Arc::new(Plan(Str::new_static(PLAN)))
	}

	fn open(
		services: Arc<dyn Services>,
		roles: &[&str],
		size: Size,
	) -> Result<PlanReviewPanel, Str> {
		let dom = Dom::new();
		let con = Ctx::new();
		let ui = UiContext::default();
		let cx = PanelCx {
			dom:      &dom,
			con:      &con,
			ui:       &ui,
			viewport: size,
			services: &services,
		};
		PlanReviewPanel::open(&cx, &roster(roles))
	}

	fn text(panel: &mut PlanReviewPanel, size: Size) -> String {
		omp_tui::frame_text(panel.frame(size))
	}

	fn mouse(kind: Mouse, col: u16, row: u16, button: MouseButton) -> MouseReport {
		MouseReport { kind, col, row, button, mods: Mods::default(), pressed: true }
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

	const NARROW: Size = Size { width: 60, height: 24 };
	const WIDE: Size = Size { width: 100, height: 30 };

	#[test]
	fn renders_title_first_section_options_and_hint() {
		let mut panel = open(plan(), &["default"], NARROW).unwrap();
		assert_eq!(panel.id(), "plan_review");
		assert_eq!(panel.anchor(), PanelAnchor::Center);
		assert_eq!(panel.title(), "Auth-plan");
		let text = text(&mut panel, NARROW);
		assert!(text.contains("Plan Review"), "box title missing:\n{text}");
		assert!(text.contains("Auth plan"), "first section heading missing:\n{text}");
		assert!(text.contains("Intro paragraph."), "preamble body missing:\n{text}");
		assert!(text.contains("Plan mode - next step"), "prompt title missing:\n{text}");
		for option in OPTIONS {
			assert!(text.contains(option), "option {option:?} missing:\n{text}");
		}
		// The 57-cell help exceeds the 56 inner cells of a 60-column overlay,
		// so it truncates at `fit(content, width - 4)`.
		assert!(
			text.contains("↑↓ select · ⏎ confirm · c copy · tab regions · esc canc…"),
			"help missing:\n{text}"
		);
		assert!(!text.contains("continue with"), "lone role must not show the slider:\n{text}");
		let wide = self::text(&mut panel, WIDE);
		assert!(
			wide.contains("↑↓ select · ⏎ confirm · c copy · tab regions · esc cancel"),
			"help missing:\n{wide}"
		);
	}

	#[test]
	fn slider_shows_with_roster_and_right_moves_role() {
		let mut panel = open(plan(), &["smol", "default", "slow"], NARROW).unwrap();
		let before = text(&mut panel, NARROW);
		assert!(before.contains("continue with"), "slider caption missing:\n{before}");
		assert!(before.contains("default-model"), "slider detail missing:\n{before}");
		assert!(before.contains("◂▸ model"), "slider help missing:\n{before}");
		assert_eq!(panel.key(Key::Right), PanelEvent::Consumed);
		let after = text(&mut panel, NARROW);
		assert!(after.contains("slow-model"), "detail must follow the slider:\n{after}");
		assert_eq!(panel.key(Key::Right), PanelEvent::Consumed, "slider clamps at the last role");
		assert_eq!(panel.key(Key::Enter), PanelEvent::Finish(Str::new_static("plan_approve slow")));
	}

	#[test]
	fn pointer_selects_a_role_and_wheel_scrolls_the_plan() {
		let mut panel = open(plan(), &["smol", "default", "slow"], NARROW).unwrap();
		let before = text(&mut panel, NARROW);
		let (col, row) = point(&before, "slow");
		assert_eq!(
			panel.mouse(mouse(Mouse::Click, col, row, MouseButton::Left)),
			PanelEvent::Consumed
		);
		assert_eq!(panel.key(Key::Enter), PanelEvent::Finish(Str::new_static("plan_approve slow")));

		let short = Size { width: 60, height: 14 };
		let mut panel = open(plan(), &["default"], short).unwrap();
		let before = text(&mut panel, short);
		let (col, row) = point(&before, "Auth plan");
		assert_eq!(
			panel.mouse(mouse(Mouse::WheelDown, col, row, MouseButton::WheelDown)),
			PanelEvent::Consumed
		);
		assert_eq!(panel.offset, 1, "wheel keeps the mirrored body offset in sync");
		let after = text(&mut panel, short);
		assert_ne!(after, before, "wheel must move the plan viewport");
	}

	#[test]
	fn slider_starts_on_default_and_left_clamps() {
		let mut panel = open(plan(), &["smol", "default", "slow"], NARROW).unwrap();
		panel.key(Key::Left);
		panel.key(Key::Left);
		panel.key(Key::Left);
		assert_eq!(panel.key(Key::Enter), PanelEvent::Finish(Str::new_static("plan_approve smol")));
	}

	#[test]
	fn options_emit_their_console_lines() {
		let mut panel = open(plan(), &["smol", "default", "slow"], NARROW).unwrap();
		panel.key(Key::Down);
		assert_eq!(
			panel.key(Key::Enter),
			PanelEvent::Finish(Str::new_static("plan_approve default compact"))
		);
		panel.key(Key::Down);
		assert_eq!(
			panel.key(Key::Enter),
			PanelEvent::Finish(Str::new_static("plan_approve default keep"))
		);
		panel.key(Key::Down);
		assert_eq!(panel.key(Key::Enter), PanelEvent::Recall(Str::new_static(REFINE_SEED)));
		panel.key(Key::Down);
		panel.key(Key::Down);
		assert_eq!(
			panel.key(Key::Enter),
			PanelEvent::OpenPlanSave {
				content: Str::new_static(PLAN),
				title:   Str::new_static("Auth-plan"),
			},
			"cursor clamps at the last option"
		);
	}

	#[test]
	fn esc_closes_and_c_copies_plan() {
		let mut panel = open(plan(), &["default"], NARROW).unwrap();
		assert_eq!(panel.key(Key::Esc), PanelEvent::Close);
		assert_eq!(panel.key(Key::Char('c')), PanelEvent::Copy(Str::new_static(PLAN)));
		assert_eq!(panel.action(PanelAction::Expand), PanelEvent::Ignored);
	}

	#[test]
	fn missing_plan_is_an_error_and_legacy_path_is_a_fallback() {
		let error = open(Arc::new(NoPlan), &["default"], NARROW).err().unwrap();
		assert_eq!(error.as_str(), NO_PLAN);
		let panel = open(Arc::new(Legacy), &["default"], NARROW).unwrap();
		assert_eq!(panel.title(), "Legacy");
	}

	#[test]
	fn up_from_first_option_focuses_body_then_toc() {
		let mut panel = open(plan(), &["default"], WIDE).unwrap();
		let text_before = text(&mut panel, WIDE);
		assert!(text_before.contains("Goal"), "sidebar entry missing:\n{text_before}");
		assert!(text_before.contains("Steps"), "sidebar entry missing:\n{text_before}");
		assert!(text_before.contains(" Detail"), "nested entry indents:\n{text_before}");
		panel.key(Key::Up);
		assert_eq!(panel.focus, Focus::Body);
		let body = text(&mut panel, WIDE);
		assert!(
			body.contains("↑↓ scroll · ⇧ faster · pgup/pgdn · g/G ends · a annotate"),
			"body help:\n{body}"
		);
		panel.key(Key::Up);
		assert_eq!(panel.focus, Focus::Toc, "scrolling off the top steps into the sidebar");
		let toc = text(&mut panel, WIDE);
		assert!(
			toc.contains("↑↓ section · ⏎ open · a annotate · d delete · u undo"),
			"toc help:\n{toc}"
		);
		panel.key(Key::Tab);
		assert_eq!(panel.focus, Focus::Body);
		panel.key(Key::Tab);
		assert_eq!(panel.focus, Focus::Actions);
		panel.key(Key::Tab);
		assert_eq!(panel.focus, Focus::Toc);
	}

	#[test]
	fn narrow_terminal_hides_sidebar_and_body_up_stays_in_body() {
		let mut panel = open(plan(), &["default"], NARROW).unwrap();
		text(&mut panel, NARROW);
		assert!(!panel.sidebar);
		panel.key(Key::Up);
		panel.key(Key::Up);
		assert_eq!(panel.focus, Focus::Body, "no sidebar: Up at the top stays in the body");
		panel.key(Key::Tab);
		assert_eq!(panel.focus, Focus::Actions);
	}

	#[test]
	fn toc_delete_and_undo_feed_refine_feedback() {
		let mut panel = open(plan(), &["default"], WIDE).unwrap();
		text(&mut panel, WIDE);
		panel.key(Key::Tab);
		assert_eq!(panel.focus, Focus::Toc, "Tab from the actions wraps to the sidebar");
		panel.key(Key::Down);
		assert_eq!(panel.toc_cursor, 1, "cursor on Steps");
		panel.key(Key::Char('d'));
		assert_eq!(panel.deleted, vec![Str::new_static("Steps"), Str::new_static("Detail")]);
		assert!(!panel.plan().contains("## Steps"), "section removed from the plan");
		assert!(!panel.plan().contains("### Detail"), "nested section removed too");
		assert_eq!(panel.toc.len(), 2);
		let feedback = panel.feedback();
		assert_eq!(
			feedback.as_str(),
			"Refinement feedback on the plan:\n\nRemove these sections:\n- Steps\n- Detail\n"
		);
		panel.key(Key::Tab);
		panel.key(Key::Tab);
		assert_eq!(panel.focus, Focus::Actions);
		panel.key(Key::Down);
		panel.key(Key::Down);
		panel.key(Key::Down);
		assert_eq!(panel.key(Key::Enter), PanelEvent::Recall(feedback));
		panel.key(Key::Tab);
		assert_eq!(panel.focus, Focus::Toc);
		panel.key(Key::Char('u'));
		assert_eq!(panel.plan().as_str(), PLAN);
		assert!(panel.deleted.is_empty());
		assert!(panel.feedback().is_empty());
	}

	#[test]
	fn toc_annotation_is_typed_saved_and_marked() {
		let mut panel = open(plan(), &["default"], WIDE).unwrap();
		text(&mut panel, WIDE);
		panel.key(Key::Tab);
		assert_eq!(panel.focus, Focus::Toc);
		panel.key(Key::Char('a'));
		let prompt = text(&mut panel, WIDE);
		assert!(prompt.contains("Annotate ‹Goal›"), "annotation caption:\n{prompt}");
		assert!(prompt.contains("enter save · esc cancel"), "annotation hint:\n{prompt}");
		for ch in "too vague".chars() {
			panel.key(Key::Char(ch));
		}
		assert_eq!(panel.key(Key::Enter), PanelEvent::Consumed);
		assert!(panel.annotating.is_none());
		assert_eq!(panel.sections[1].annotations, vec![Str::new_static("too vague")]);
		assert_eq!(
			panel.feedback().as_str(),
			"Refinement feedback on the plan:\n\n## Goal\n- too vague\n"
		);
		let marked = text(&mut panel, WIDE);
		assert!(marked.contains("Goal ✎"), "annotated entry is marked:\n{marked}");
		panel.key(Key::Char('a'));
		assert_eq!(panel.key(Key::Esc), PanelEvent::Consumed, "Esc leaves the prompt, not the panel");
		assert!(panel.annotating.is_none());
		assert_eq!(panel.key(Key::Esc), PanelEvent::Close);
	}

	#[test]
	fn paging_scrolls_the_body_and_sidebar_tracks_the_section() {
		let mut long = String::from(PLAN);
		for _ in 0..40 {
			long.push_str("filler line\n\n");
		}
		long.push_str("## Tail\n\nend\n");
		let mut panel = open(Arc::new(Plan(Str::from(long))), &["default"], WIDE).unwrap();
		let top = text(&mut panel, WIDE);
		assert!(top.contains("Intro paragraph."), "starts at the top:\n{top}");
		assert!(!top.contains("end"), "tail is below the fold:\n{top}");
		assert_eq!(panel.key(Key::End), PanelEvent::Consumed);
		let bottom = text(&mut panel, WIDE);
		assert!(bottom.contains("end"), "End scrolls to the bottom:\n{bottom}");
		assert_eq!(panel.offset, panel.max_offset());
		assert_eq!(
			panel.sections[panel.toc[panel.toc_cursor]].title.as_str(),
			"Risks",
			"glow follows the section under the top visible row"
		);
		panel.key(Key::PageUp);
		assert_eq!(panel.offset, panel.max_offset() - panel.rows);
		panel.key(Key::Home);
		assert_eq!(panel.offset, 0);
		assert!(text(&mut panel, WIDE).contains("Intro paragraph."));
		panel.key(Key::Tab);
		assert_eq!(panel.focus, Focus::Toc);
		for _ in 0..4 {
			panel.key(Key::Down);
		}
		let jumped = text(&mut panel, WIDE);
		assert_eq!(panel.sections[panel.toc[panel.toc_cursor]].title.as_str(), "Tail");
		assert_eq!(
			panel.offset,
			panel.section_offsets[panel.toc[panel.toc_cursor]].min(panel.max_offset())
		);
		assert!(jumped.contains("end"), "jump lands on the tail section:\n{jumped}");
		panel.key(Key::Down);
		assert_eq!(
			panel.focus,
			Focus::Actions,
			"Down past the last section falls through to the actions"
		);
	}

	#[test]
	fn parses_sections_with_fences_and_strips_inline_markdown() {
		let text =
			"pre\n\n# Top\n\n```\n# not a heading\n```\n\n## **Bold** [link](x) `code`\n\nbody\n";
		let sections = parse_sections(text);
		let titles = sections
			.iter()
			.map(|(level, title, _)| (*level, title.as_str()))
			.collect::<Vec<_>>();
		assert_eq!(titles, vec![(0, ""), (1, "Top"), (2, "Bold link code")]);
		let joined = sections
			.iter()
			.map(|(_, _, raw)| raw.as_str())
			.collect::<String>();
		assert_eq!(joined, text, "sections round-trip the source");
	}

	#[test]
	fn plan_title_prefers_heading_then_stem() {
		assert_eq!(
			plan_title("# My feature plan\n", "local://x-plan.md").as_str(),
			"My-feature-plan"
		);
		assert_eq!(plan_title("no heading\n", "local://auth-plan.md").as_str(), "auth-plan");
		assert_eq!(plan_title("# ../bad\n", "local://???.md").as_str(), "plan");
	}
}
