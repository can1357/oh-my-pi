//! Destination editor for Plan Review's “Save and quit” action.
//!
//! The editor is observer-local: it retains the user's text and caret, offers
//! filesystem path completions, and emits one typed controller command only
//! after confirmation. The application owns the atomic write and session
//! transition (ADR 0005).

use std::path::PathBuf;

use omp_core::{Str, sf};
use omp_tui::{Frame, Key, MouseReport, Prop, Size, Ui, UiContext, UiEvent, dom};
use xutf::IntoUnicodeNormalized;

use super::{Panel, PanelAnchor, PanelEvent};
use crate::{commands::workspace::path_choices, host::HostCommand};

/// Stable panel identity reported to the host.
pub const ID: &str = "plan_save";
const INPUT_ID: &str = "plan-save-path";
const OPTION_PREFIX: &str = "plan-save-option:";
const SAVE_ID: &str = "plan-save-confirm";
const CANCEL_ID: &str = "plan-save-cancel";
const TITLE: &str = "Save and quit";
const HINT: &str = "Enter save and quit · Tab complete · Esc cancel";
const MAX_RESULTS: usize = 8;
const MAX_STEM_CHARS: usize = 32;

/// Retained plan destination editor.
pub struct PlanSavePanel {
	plan:      Str,
	cwd:       PathBuf,
	suggested: Str,
	input:     Str,
	choices:   Vec<(Str, Str)>,
	selected:  usize,
	ui:        Ui,
	ctx:       UiContext,
	width:     u16,
}

impl PlanSavePanel {
	/// Opens a destination editor for `plan`, suggesting a filename derived
	/// from the reviewed plan title.
	#[must_use]
	pub fn open(plan: Str, title: Str, cwd: PathBuf, viewport: Size, ctx: &UiContext) -> Self {
		let mut panel = Self {
			plan,
			cwd,
			suggested: suggested_filename(&title),
			input: Str::default(),
			choices: Vec::new(),
			selected: 0,
			ui: Ui::from_root(dom! { <col/> }, viewport.width, ctx.clone()),
			ctx: ctx.clone(),
			width: viewport.width,
		};
		panel.rebuild();
		panel
	}

	/// Current user-authored path. Empty means the dimmed suggestion will be
	/// used on confirmation.
	#[must_use]
	pub fn input(&self) -> &str {
		&self.input
	}

	/// Suggested filename accepted by an empty submission.
	#[must_use]
	pub fn suggested(&self) -> &str {
		&self.suggested
	}

	fn rebuild(&mut self) {
		let value = self.input.clone();
		let placeholder = self.suggested.clone();
		let tree = dom! {
			<box border=round title={TITLE} pad-x=1>
				<col>
					<row>
						<text fg=muted>{"Path: "}</text>
						<input id={INPUT_ID} value={value} placeholder={placeholder} submit/>
					</row>
					for index in 0..MAX_RESULTS {
						<button id={sf!("{OPTION_PREFIX}{index}")} variant=ghost active={index == self.selected}>{""}</button>
					}
					<hr border=round/>
					<row gap=1>
						<button id={SAVE_ID} variant=pill>{"Save"}</button>
						<button id={CANCEL_ID} variant=ghost>{"Cancel"}</button>
					</row>
					<text fg=muted truncate>{HINT}</text>
				</col>
			</box>
		};
		self.ui = Ui::from_root(tree, self.width, self.ctx.clone());
		self.refresh_choices();
	}

	fn refresh_choices(&mut self) {
		self.choices = if self.input.trim().is_empty() {
			Vec::new()
		} else {
			path_choices(self.input.as_str(), &self.cwd, MAX_RESULTS, false, true)
				.into_iter()
				.map(|choice| (choice.value, choice.label))
				.collect()
		};
		self.selected = self.selected.min(self.choices.len().saturating_sub(1));
		for index in 0..MAX_RESULTS {
			let id = sf!("{OPTION_PREFIX}{index}");
			if let Some((_, label)) = self.choices.get(index) {
				self.ui.set_prop(id.as_str(), Prop::Label, label.clone());
				self
					.ui
					.set_prop(id.as_str(), Prop::Active, index == self.selected);
				self.ui.set_visible(id.as_str(), true);
			} else {
				self.ui.set_visible(id.as_str(), false);
			}
		}
	}

	fn move_selection(&mut self, delta: isize) -> PanelEvent {
		if self.choices.is_empty() {
			return PanelEvent::Consumed;
		}
		let next = self
			.selected
			.saturating_add_signed(delta)
			.min(self.choices.len().saturating_sub(1));
		if next != self.selected {
			let previous = sf!("{OPTION_PREFIX}{}", self.selected);
			self.ui.set_prop(previous.as_str(), Prop::Active, false);
			self.selected = next;
			let selected = sf!("{OPTION_PREFIX}{}", self.selected);
			self.ui.set_prop(selected.as_str(), Prop::Active, true);
		}
		PanelEvent::Consumed
	}

	fn accept_completion(&mut self, index: usize) -> PanelEvent {
		let Some((value, _)) = self.choices.get(index) else {
			return PanelEvent::Consumed;
		};
		self.input = value.clone();
		self.selected = 0;
		// Completion acceptance is the only rebuild while editing. It places
		// the caret at the accepted directory's end; ordinary changes stay in
		// the retained widget and preserve the user's actual caret.
		self.rebuild();
		PanelEvent::Consumed
	}

	fn submit(&self) -> PanelEvent {
		let selected = self.input.as_str().trim();
		let selected = if selected.is_empty() {
			self.suggested.as_str()
		} else {
			selected
		};
		let path = crate::commands::workspace::resolve_to_cwd(selected, &self.cwd);
		PanelEvent::FinishCommand(HostCommand::PlanSave { path, content: self.plan.clone() })
	}

	fn ui_event(&mut self, event: UiEvent) -> PanelEvent {
		match event {
			UiEvent::Cancel => PanelEvent::Close,
			UiEvent::Submit => self.submit(),
			UiEvent::Changed { id, value } if id.as_str() == INPUT_ID => {
				self.input = value;
				self.selected = 0;
				self.refresh_choices();
				PanelEvent::Consumed
			},
			UiEvent::Pressed(id) if id.as_str() == SAVE_ID => self.submit(),
			UiEvent::Pressed(id) if id.as_str() == CANCEL_ID => PanelEvent::Close,
			UiEvent::Pressed(id) => {
				let Some(index) = id
					.as_str()
					.strip_prefix(OPTION_PREFIX)
					.and_then(|index| index.parse::<usize>().ok())
				else {
					return PanelEvent::Consumed;
				};
				self.accept_completion(index)
			},
			UiEvent::Copied(text) => PanelEvent::Copy(text),
			_ => PanelEvent::Consumed,
		}
	}
}

impl Panel for PlanSavePanel {
	fn id(&self) -> &'static str {
		ID
	}

	fn anchor(&self) -> PanelAnchor {
		PanelAnchor::Center
	}

	fn key(&mut self, key: Key) -> PanelEvent {
		match key {
			Key::Esc => PanelEvent::Close,
			Key::Enter => self.submit(),
			Key::Tab if self.choices.is_empty() => {
				self.input = self.suggested.clone();
				self.rebuild();
				PanelEvent::Consumed
			},
			Key::Tab => self.accept_completion(self.selected),
			Key::Up => self.move_selection(-1),
			Key::Down => self.move_selection(1),
			Key::PageUp => self.move_selection(-5),
			Key::PageDown => self.move_selection(5),
			_ => {
				let event = self.ui.handle_key(key);
				self.ui_event(event)
			},
		}
	}

	fn paste(&mut self, text: &str) -> PanelEvent {
		let event = self.ui.handle_paste(text);
		self.ui_event(event)
	}

	fn mouse(&mut self, report: MouseReport) -> PanelEvent {
		let event = self
			.ui
			.handle_mouse_with_mods(report.col, report.row, report.kind, report.mods);
		self.ui_event(event)
	}

	fn frame(&mut self, viewport: Size) -> &Frame {
		if viewport.width != self.width {
			self.width = viewport.width;
			self.rebuild();
		}
		self.ui.frame()
	}
}

/// Normalizes the reviewed topic into
/// `<TOPIC>_PLAN.md`, trimming verbose fallbacks at a word boundary.
#[must_use]
pub fn suggested_filename(title: &str) -> Str {
	let normalized = title.to_string().into_nfc();
	let mut stem = String::with_capacity(normalized.len().min(MAX_STEM_CHARS));
	let mut separator = false;
	for character in normalized.chars() {
		if character.is_alphanumeric() {
			if separator && !stem.is_empty() {
				stem.push('_');
			}
			separator = false;
			stem.extend(character.to_uppercase());
		} else {
			separator = true;
		}
	}
	if stem.chars().count() > MAX_STEM_CHARS {
		let byte = stem
			.char_indices()
			.nth(MAX_STEM_CHARS)
			.map_or(stem.len(), |(byte, _)| byte);
		stem.truncate(byte);
		if let Some(boundary) = stem.rfind('_')
			&& boundary > 0
		{
			stem.truncate(boundary);
		}
	}
	if stem.is_empty() || stem == "PLAN" {
		return Str::new_static("PLAN.md");
	}
	if !stem.ends_with("_PLAN") {
		stem.push_str("_PLAN");
	}
	stem.push_str(".md");
	Str::new(stem)
}

#[cfg(test)]
mod tests {
	use omp_tui::{Mods, Mouse, MouseButton, frame_text};

	use super::*;

	fn panel(dir: &std::path::Path) -> PlanSavePanel {
		PlanSavePanel::open(
			Str::new_static("# Auth plan\n\nShip it.\n"),
			Str::new_static("Auth plan"),
			dir.to_path_buf(),
			Size::new(72, 24),
			&UiContext::default(),
		)
	}

	fn point(text: &str, needle: &str) -> (u16, u16) {
		text
			.lines()
			.enumerate()
			.filter_map(|(row, line)| {
				line
					.find(needle)
					.map(|col| (u16::try_from(col).expect("col"), u16::try_from(row).expect("row")))
			})
			.last()
			.expect("needle in frame")
	}

	#[test]
	fn filename_matches_pi_topic_normalization_and_limit() {
		assert_eq!(suggested_filename("Auth plan").as_str(), "AUTH_PLAN.md");
		assert_eq!(suggested_filename(" plan ").as_str(), "PLAN.md");
		assert_eq!(suggested_filename("Pyo3 methods").as_str(), "PYO3_METHODS_PLAN.md");
		assert_eq!(
			suggested_filename("one two three four five six seven eight nine").as_str(),
			"ONE_TWO_THREE_FOUR_FIVE_SIX_PLAN.md"
		);
	}

	#[test]
	fn empty_enter_uses_suggestion_and_escape_cancels() {
		let dir = tempfile::tempdir().expect("tempdir");
		let mut first = panel(dir.path());
		assert_eq!(first.suggested(), "AUTH_PLAN.md");
		assert_eq!(
			first.key(Key::Enter),
			PanelEvent::FinishCommand(HostCommand::PlanSave {
				path:    dir.path().join("AUTH_PLAN.md"),
				content: Str::new_static("# Auth plan\n\nShip it.\n"),
			})
		);
		let mut panel = panel(dir.path());
		assert_eq!(panel.key(Key::Esc), PanelEvent::Close);
	}

	#[test]
	fn input_is_retained_and_tab_accepts_directory_completion() {
		let dir = tempfile::tempdir().expect("tempdir");
		std::fs::create_dir(dir.path().join("notes")).expect("notes");
		let mut panel = panel(dir.path());
		for character in "no".chars() {
			assert_eq!(panel.key(Key::Char(character)), PanelEvent::Consumed);
		}
		assert_eq!(panel.input(), "no");
		assert_eq!(panel.key(Key::Tab), PanelEvent::Consumed);
		assert_eq!(panel.input(), "notes/");
		for character in "release.md".chars() {
			panel.key(Key::Char(character));
		}
		assert_eq!(
			panel.key(Key::Enter),
			PanelEvent::FinishCommand(HostCommand::PlanSave {
				path:    dir.path().join("notes/release.md"),
				content: Str::new_static("# Auth plan\n\nShip it.\n"),
			})
		);
	}

	#[test]
	fn mouse_can_accept_completion_and_confirm() {
		let dir = tempfile::tempdir().expect("tempdir");
		std::fs::create_dir(dir.path().join("notes")).expect("notes");
		let mut panel = panel(dir.path());
		panel.key(Key::Char('n'));
		let text = frame_text(panel.frame(Size::new(72, 24)));
		let (col, row) = point(&text, "notes/");
		assert_eq!(
			panel.mouse(MouseReport {
				kind: Mouse::Click,
				col,
				row,
				button: MouseButton::Left,
				mods: Mods::default(),
				pressed: true,
			}),
			PanelEvent::Consumed
		);
		assert_eq!(panel.input(), "notes/");
		let text = frame_text(panel.frame(Size::new(72, 24)));
		let (col, row) = point(&text, "Save");
		assert_eq!(
			panel.mouse(MouseReport {
				kind: Mouse::Click,
				col,
				row,
				button: MouseButton::Left,
				mods: Mods::default(),
				pressed: true,
			}),
			PanelEvent::FinishCommand(HostCommand::PlanSave {
				path:    dir.path().join("notes"),
				content: Str::new_static("# Auth plan\n\nShip it.\n"),
			})
		);
	}
}
