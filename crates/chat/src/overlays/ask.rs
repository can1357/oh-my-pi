//! `ask@2` dialog as an observer-local [`Panel`] (ADR 0005).
//!
//! The dialog is projected from the tool's own `<ask status=running>`
//! element — its `<input>` carries the questions — and closes when that
//! element settles; nothing about the dialog enters the DOM. Answers go back
//! through [`PanelEvent::Ask`] and become the call's result (ADR 0008).
//!
//! Shape: one tab per question plus a `Submit` tab when there is more
//! than one question or any multi-select; a radio/checkbox list per
//! question with the recommended option highlighted first, an `Other (type
//! your own)` row that takes free text inline, `n` attaches a note to the
//! highlighted row; Enter advances (or submits a single question); a
//! `cl_ask_timeout` countdown auto-submits the recommended answers; Ctrl+O
//! expands a question header longer than four rows; Esc cancels the tool.

use std::time::Duration;

use omp_core::{Str, StrMut, sf};
use omp_dom::{KnownTag, PropKey, Tag, Value};
use omp_tools::ask::{OTHER_OPTION, Question, Selection};
use omp_tui::{Frame, Key, Size, Ui, UiContext, UiEvent, cell_width, dom};

use super::{Panel, PanelAction, PanelAnchor, PanelCx, PanelEvent};

omp_con::var! {
	/// Auto-select the recommended ask option after this many seconds. Zero
	/// disables the countdown, and Plan mode never counts down.
	pub static CL_ASK_TIMEOUT = cl_ask_timeout: i64 {
		default: 0,
		min: 0,
		flags: archive,
		meta: {
			"ui.tab": "interaction",
			"ui.group": "Notifications",
			"ui.label": "Ask Timeout",
			"ui.unit": "s",
			"legacy.path": "ask.timeout",
		},
	};
}

/// Stable overlay identity.
pub const ID: &str = "ask";

/// Resolves the ask inactivity timeout from the actor's live facts.
#[must_use]
pub fn timeout(cx: &PanelCx<'_>) -> Option<Duration> {
	if director_engaged(cx, "plan") {
		return None;
	}
	u64::try_from(CL_ASK_TIMEOUT.get(cx.con))
		.ok()
		.filter(|seconds| *seconds > 0)
		.map(Duration::from_secs)
}

fn director_engaged(cx: &PanelCx<'_>, family: &str) -> bool {
	let Some(root) = cx
		.dom
		.children(cx.dom.meta())
		.iter()
		.copied()
		.find(|handle| {
			cx.dom
				.get(*handle)
				.is_some_and(|node| node.tag == Tag::Known(KnownTag::Directors))
		})
	else {
		return false;
	};
	let family_key = PropKey::Custom(Str::new_static("family"));
	let status = PropKey::Custom(Str::new_static("status"));
	let mut pending = cx.dom.children(root).to_vec();
	while let Some(handle) = pending.pop() {
		let Some(node) = cx.dom.get(handle) else {
			continue;
		};
		if node.tag == Tag::Known(KnownTag::Director)
			&& node.prop(&family_key).and_then(Value::as_str) == Some(family)
			&& node.prop(&status).and_then(Value::as_str) == Some("active")
		{
			return true;
		}
		pending.extend(node.kids.iter().copied());
	}
	false
}
/// The dialog may occupy this fraction of the terminal.
const HEIGHT_RATIO: (u16, u16) = (7, 10);
/// Minimum number of dialog rows.
const MIN_DIALOG_ROWS: u16 = 12;
/// Minimum number of selectable body rows.
const MIN_BODY_ROWS: u16 = 5;
/// Maximum visible question-header rows; Ctrl+O expands a longer question.
const MAX_HEADER_ROWS: u16 = 4;
/// Maximum tab-label width in cells.
const MAX_TAB_CELLS: usize = 16;
/// Label for the final submission tab.
const SUBMIT_LABEL: &str = "Submit";
/// Suffix shown on a recommended option.
const RECOMMENDED_SUFFIX: &str = " (Recommended)";
/// Border rows, header rule, footer rule, and footer.
const CHROME_ROWS: u16 = 5;

/// Which row a note or custom prompt targets.
#[derive(Clone, Debug, Eq, PartialEq)]
enum RowKey {
	Option(usize),
	Other,
}

/// Per-question answer state.
#[derive(Clone, Debug, Default)]
struct QuestionState {
	/// Selected option labels in selection order.
	selected:  Vec<Str>,
	/// Free text entered through the `Other` row.
	custom:    Option<Str>,
	/// Note attached to one row.
	note:      Option<(RowKey, Str)>,
	/// Highlighted row index (options, then `Other`).
	cursor:    usize,
	/// The countdown chose this answer.
	timed_out: bool,
}

/// An inline note prompt over the highlighted row.
struct NotePrompt {
	question: usize,
	row:      RowKey,
	draft:    Str,
}

/// Retained `ask` dialog.
pub struct AskDialog {
	id:             Str,
	questions:      Vec<Question>,
	states:         Vec<QuestionState>,
	tab:            usize,
	note:           Option<NotePrompt>,
	expanded:       bool,
	ui:             Ui,
	ctx:            UiContext,
	width:          u16,
	rows:           u16,
	dirty:          bool,
	/// Whether the current question's `Other` row owns keyboard input.
	custom_editing: bool,
	/// Countdown: total, its deadline on the presentation clock, the
	/// seconds the title last showed, and the newest clock reading the host
	/// handed to `tick` (keys restart the countdown from it).
	timeout:        Option<Duration>,
	deadline:       Duration,
	shown_secs:     u64,
	now_hint:       Duration,
	/// Timed-out submission waiting for the host's `settled()` poll.
	settled:        Option<PanelEvent>,
}

impl AskDialog {
	/// Opens the dialog for call `id`. `timeout` starts counting at `now` on
	/// the presentation clock; `None` waits indefinitely.
	#[must_use]
	pub fn open(
		id: Str,
		questions: Vec<Question>,
		timeout: Option<Duration>,
		now: Duration,
		viewport: Size,
		ctx: &UiContext,
	) -> Self {
		let states = questions
			.iter()
			.map(|question| QuestionState {
				cursor: question
					.recommended
					.unwrap_or(0)
					.min(question.options.len().saturating_sub(1)),
				..QuestionState::default()
			})
			.collect();
		let mut dialog = Self {
			id,
			questions,
			states,
			tab: 0,
			note: None,
			expanded: false,
			ui: Ui::from_root(dom! { <col/> }, viewport.width, ctx.clone()),
			ctx: ctx.clone(),
			width: viewport.width,
			rows: Self::body_rows(viewport),
			dirty: true,
			custom_editing: false,
			timeout,
			deadline: now.saturating_add(timeout.unwrap_or_default()),
			shown_secs: 0,
			now_hint: now,
			settled: None,
		};
		dialog.shown_secs = dialog.remaining(now).unwrap_or(0);
		dialog
	}

	/// Questions asked, for tests and the debug `values` op.
	#[must_use]
	pub fn questions(&self) -> &[Question] {
		&self.questions
	}

	/// Body rows clamp to 70% of the terminal after reserving the tallest tab.
	/// The select scrolls inside that region.
	fn body_rows(viewport: Size) -> u16 {
		let cap = (viewport.height * HEIGHT_RATIO.0 / HEIGHT_RATIO.1).max(MIN_DIALOG_ROWS);
		cap.saturating_sub(CHROME_ROWS + MAX_HEADER_ROWS + 1)
			.max(MIN_BODY_ROWS)
	}

	fn has_submit_tab(&self) -> bool {
		self.questions.len() > 1 || self.questions.iter().any(|question| question.multi)
	}

	fn is_submit_tab(&self) -> bool {
		self.has_submit_tab() && self.tab == self.questions.len()
	}

	fn current(&self) -> usize {
		self.tab.min(self.questions.len().saturating_sub(1))
	}

	fn tab_label(question: &Question, index: usize) -> Str {
		let base = question
			.header
			.as_deref()
			.map(str::trim)
			.filter(|header| !header.is_empty())
			.map_or_else(|| sf!("Q{}", index + 1), Str::new);
		if base.chars().count() <= MAX_TAB_CELLS {
			return base;
		}
		let mut cut = StrMut::new("");
		for character in base.chars().take(MAX_TAB_CELLS - 1) {
			cut.push(character);
		}
		cut.push('…');
		cut.freeze()
	}

	fn option_label(question: &Question, index: usize) -> Str {
		let label = &question.options[index].label;
		if question.recommended == Some(index) && !label.ends_with(RECOMMENDED_SUFFIX) {
			sf!("{label}{RECOMMENDED_SUFFIX}")
		} else {
			label.clone()
		}
	}

	/// Whether the current question's text overflows the truncated header.
	fn header_overflows(&self) -> bool {
		if self.is_submit_tab() {
			return false;
		}
		let width = usize::from(self.width.saturating_sub(4).max(1));
		let rows: usize = self.questions[self.current()]
			.question
			.lines()
			.map(|line| usize::from(cell_width(line)).div_ceil(width).max(1))
			.sum();
		rows > usize::from(MAX_HEADER_ROWS)
	}

	fn remaining(&self, now: Duration) -> Option<u64> {
		self.timeout?;
		let left = self.deadline.saturating_sub(now);
		Some(u64::try_from(left.as_millis().saturating_add(999) / 1000).unwrap_or(u64::MAX))
	}

	fn title(&self) -> Str {
		match self.timeout {
			Some(_) => sf!("Ask ({}s)", self.shown_secs),
			None => Str::new_static("Ask"),
		}
	}

	fn unanswered(&self) -> usize {
		self
			.states
			.iter()
			.filter(|state| state.selected.is_empty() && state.custom.is_none())
			.count()
	}

	/// Summarizes the submitted answer and whether it is answered.
	fn summary(question: &Question, state: &QuestionState) -> (Str, bool) {
		let selected = question
			.options
			.iter()
			.map(|option| &option.label)
			.filter(|label| state.selected.contains(label))
			.cloned()
			.collect::<Vec<_>>();
		if question.multi {
			let mut parts = selected;
			if let Some(custom) = &state.custom {
				parts.push(sf!("Other: “{}”", custom.split_whitespace().collect::<Vec<_>>().join(" ")));
			}
			if parts.is_empty() {
				return (Str::new_static("unanswered"), false);
			}
			return (Str::new(parts.join(", ")), true);
		}
		if let Some(custom) = &state.custom {
			return (sf!("“{}”", custom.split_whitespace().collect::<Vec<_>>().join(" ")), true);
		}
		match selected.into_iter().next() {
			Some(label) => (label, true),
			None => (Str::new_static("unanswered"), false),
		}
	}

	/// A note survives only with its row's
	/// answer.
	fn submitted_note(question: &Question, state: &QuestionState) -> Option<Str> {
		let (row, note) = state.note.as_ref()?;
		match row {
			RowKey::Other => state.custom.is_some().then(|| note.clone()),
			RowKey::Option(index) => question
				.options
				.get(*index)
				.filter(|option| state.selected.contains(&option.label))
				.map(|_| note.clone()),
		}
	}

	fn footer(&self) -> Str {
		if self.note.is_some() {
			return Str::new_static("Enter save note · Esc back");
		}
		let expand = if self.header_overflows() {
			if self.expanded {
				" · Ctrl+O collapse"
			} else {
				" · Ctrl+O expand"
			}
		} else {
			""
		};
		if self.is_submit_tab() {
			return sf!("Enter submit · ↑/↓ scroll · Esc cancel{expand}");
		}
		let question = &self.questions[self.current()];
		let next = if self.questions.len() > 1 {
			"next"
		} else {
			"submit"
		};
		let action = if question.multi {
			sf!("Space toggle · Enter {next}")
		} else {
			Str::new_static("Enter select · n note")
		};
		let tabs = if self.has_submit_tab() {
			" · Tab/←/→"
		} else {
			""
		};
		sf!("{action} · ↑/↓ move{tabs} · Esc cancel{expand}")
	}

	fn rebuild(&mut self) {
		let title = self.title();
		let rows = self.rows;
		let tabs = self.has_submit_tab().then(|| {
			let mut labels = self
				.questions
				.iter()
				.enumerate()
				.map(|(index, question)| Self::tab_label(question, index))
				.collect::<Vec<_>>();
			labels.push(Str::new_static(SUBMIT_LABEL));
			(sf!("{}", self.tab), labels)
		});
		let footer = self.footer();
		let note = self
			.note
			.as_ref()
			.map(|prompt| (self.note_title(prompt), prompt.draft.clone()));
		// Expanding borrows rows from the scrolling options body. Header and
		// body always share one fixed budget, so Ctrl+O cannot grow the
		// bottom overlay past the same terminal-height cap.
		let content_rows = rows.saturating_add(MAX_HEADER_ROWS);
		let header_rows = if self.expanded {
			content_rows.saturating_sub(MIN_BODY_ROWS)
		} else {
			MAX_HEADER_ROWS
		};
		let option_rows = content_rows.saturating_sub(header_rows).max(MIN_BODY_ROWS);
		let tree = if self.is_submit_tab() {
			let unanswered = self.unanswered();
			let warning = (unanswered > 0).then(|| {
				sf!(
					"{unanswered} unanswered question{}; Enter still submits.",
					if unanswered == 1 { "" } else { "s" }
				)
			});
			let lines = self
				.questions
				.iter()
				.zip(&self.states)
				.enumerate()
				.map(|(index, (question, state))| {
					let (answer, answered) = Self::summary(question, state);
					let note = Self::submitted_note(question, state).map(|note| {
						sf!("   Note: {}", note.split_whitespace().collect::<Vec<_>>().join(" "))
					});
					(sf!("{}. {}:", index + 1, Self::tab_label(question, index)), answer, answered, note)
				})
				.collect::<Vec<_>>();
			dom! {
				<box border=round title={title} pad-x=1>
					<col>
						if let Some((value, labels)) = tabs {
							<segmented id="tab" value={value}>
								for (index, label) in labels.into_iter().enumerate() {
									<option value={sf!("{index}")} label={label}/>
								}
							</segmented>
						}
						<text bold fg=accent>{"Review answers"}</text>
						<hr border=round/>
						<scroll id="review" h={rows} focus>
							<col>
								if let Some(warning) = warning {
									<text fg=warning>{warning}</text>
									<spacer h=1/>
								}
								for (label, answer, answered, note) in lines {
									<row gap=1>
										<text fg=muted>{label}</text>
										if answered { <text truncate>{answer}</text> } else { <text fg=warning>{answer}</text> }
									</row>
									if let Some(note) = note { <text fg=muted truncate>{note}</text> }
								}
								<spacer h=1/>
								<row gap=1>
									<icon name="cursor" fg=accent/>
									<text fg=accent>{SUBMIT_LABEL}</text>
								</row>
							</col>
						</scroll>
						<hr border=round/>
						<text fg=muted truncate>{footer}</text>
					</col>
				</box>
			}
		} else {
			let current = self.current();
			let question = &self.questions[current];
			let state = &self.states[current];
			let prompt = question.question.clone();
			let multi = question.multi;
			let select_id = sf!("q{current}");
			let options = question
				.options
				.iter()
				.enumerate()
				.map(|(index, option)| {
					let noted = matches!(&state.note, Some((RowKey::Option(at), _)) if *at == index);
					(
						option.label.clone(),
						Self::option_label(question, index),
						option.description.clone().unwrap_or_default(),
						option.preview.clone(),
						state.selected.contains(&option.label),
						state.cursor == index,
						noted,
					)
				})
				.collect::<Vec<_>>();
			let custom = state.custom.clone();
			dom! {
				<box border=round title={title} pad-x=1>
					<col>
						if let Some((value, labels)) = tabs {
							<segmented id="tab" value={value}>
								for (index, label) in labels.into_iter().enumerate() {
									<option value={sf!("{index}")} label={label}/>
								}
							</segmented>
						}
						<col h={header_rows}>
							<text>{prompt}</text>
						</col>
						<hr border=round/>
						<select id={select_id} multi={multi} custom h={option_rows}>
							for (value, label, desc, preview, selected, active, noted) in options {
								if desc.is_empty() {
									<option value={value} label={label} selected={selected} active={active}>
										if noted { <text fg=success>{"✎ note"}</text> }
										if let Some(preview) = preview { <md>{preview}</md> }
									</option>
								} else {
									<option value={value} label={label} desc={desc} selected={selected} active={active}>
										if noted { <text fg=success>{"✎ note"}</text> }
										if let Some(preview) = preview { <md>{preview}</md> }
									</option>
								}
							}
						</select>
						if let Some(custom) = custom {
							<row gap=1>
								<spacer w=4/>
								<text fg=muted truncate>{sf!("Other: {custom}")}</text>
							</row>
						}
						<hr border=round/>
						if let Some((title, draft)) = note {
							<text fg=muted truncate>{title}</text>
							<input id="note" value={draft} placeholder="note for this answer"/>
						}
						<text fg=muted truncate>{footer}</text>
					</col>
				</box>
			}
		};
		self.ui = Ui::from_root(tree, self.width, self.ctx.clone());
		if self.note.is_some() {
			self.ui.focus_id("note");
		} else if self.is_submit_tab() {
			self.ui.focus_id("review");
		} else {
			let current = self.current();
			let id = sf!("q{current}");
			self.ui.focus_id(&id);
			let cursor = self.states[current].cursor;
			let options = self.questions[current].options.len();
			// The select highlights its `active` option on focus entry; the
			// `Other` row has no option to flag, so the cursor walks there.
			if cursor >= options {
				for _ in 0..=options {
					self.ui.handle_key(Key::Down);
				}
			}
		}
		self.dirty = false;
	}

	fn note_title(&self, prompt: &NotePrompt) -> Str {
		let question = &self.questions[prompt.question];
		let row = match &prompt.row {
			RowKey::Other => Str::new_static(OTHER_OPTION),
			RowKey::Option(index) => Self::option_label(question, *index),
		};
		sf!(
			"Note for {row}: {}",
			question
				.question
				.split_whitespace()
				.collect::<Vec<_>>()
				.join(" ")
		)
	}

	fn sync(&mut self) {
		// Rebuilding replaces the retained select, including its inline
		// custom editor and draft. Defer countdown/title repaint until that
		// editor commits or cancels.
		if self.dirty && !self.custom_editing {
			self.rebuild();
		}
	}

	fn mark(&mut self) -> PanelEvent {
		self.dirty = true;
		PanelEvent::Consumed
	}

	/// Moves to the next or previous tab.
	fn switch_tab(&mut self, forward: bool) -> PanelEvent {
		self.custom_editing = false;
		let count = self.questions.len() + 1;
		self.tab = if forward {
			(self.tab + 1) % count
		} else {
			(self.tab + count - 1) % count
		};
		self.mark()
	}

	/// A lone question submits; otherwise advances to the
	/// next question, then the Submit tab.
	fn advance(&mut self) -> PanelEvent {
		if self.questions.len() == 1 && !self.has_submit_tab() {
			return self.finish(false);
		}
		let current = self.current();
		self.tab = if current + 1 < self.questions.len() {
			current + 1
		} else {
			self.questions.len()
		};
		self.mark()
	}

	/// Builds the submitted answers.
	fn finish(&mut self, timed_out: bool) -> PanelEvent {
		let answers = self
			.questions
			.iter()
			.zip(&self.states)
			.map(|(question, state)| Selection {
				id:           question.id.clone(),
				selected:     question
					.options
					.iter()
					.map(|option| option.label.clone())
					.filter(|label| state.selected.contains(label))
					.collect(),
				custom_input: state.custom.clone(),
				note:         Self::submitted_note(question, state),
				timed_out:    timed_out && state.timed_out,
			})
			.collect();
		PanelEvent::Ask { id: self.id.clone(), answers: Some(answers) }
	}

	fn cancel(&self) -> PanelEvent {
		PanelEvent::Ask { id: self.id.clone(), answers: None }
	}

	/// On timeout, unanswered questions take their noted option,
	/// else the recommended one, and the dialog submits.
	fn timed_out(&mut self) -> PanelEvent {
		for (question, state) in self.questions.iter().zip(&mut self.states) {
			if !state.selected.is_empty() || state.custom.is_some() {
				continue;
			}
			let noted = match &state.note {
				Some((RowKey::Option(index), _)) if *index < question.options.len() => Some(*index),
				_ => None,
			};
			let fallback = noted.unwrap_or_else(|| {
				question
					.recommended
					.unwrap_or(0)
					.min(question.options.len().saturating_sub(1))
			});
			if let Some(option) = question.options.get(fallback) {
				state.selected.push(option.label.clone());
			}
			state.timed_out = true;
		}
		self.finish(true)
	}

	/// Applies one committed value from the question's select: an option
	/// label toggles/selects it, anything else is the `Other` row's text.
	fn committed(&mut self, value: Str) -> PanelEvent {
		let current = self.current();
		let question = &self.questions[current];
		let multi = question.multi;
		let is_option = question.options.iter().any(|option| option.label == value);
		let state = &mut self.states[current];
		if is_option {
			if multi {
				match state.selected.iter().position(|label| *label == value) {
					Some(at) => {
						state.selected.remove(at);
						if matches!(&state.note, Some((RowKey::Option(index), _)) if question.options[*index].label == value)
						{
							state.note = None;
						}
					},
					None => state.selected.push(value),
				}
				return self.mark();
			}
			state.selected = vec![value.clone()];
			state.custom = None;
			if let Some((RowKey::Option(index), _)) = &state.note
				&& question.options[*index].label != value
			{
				state.note = None;
			}
			if matches!(state.note, Some((RowKey::Other, _))) {
				state.note = None;
			}
			return self.advance();
		}
		// An empty value unselects the custom
		// answer.
		if value.trim().is_empty() {
			state.custom = None;
			if matches!(state.note, Some((RowKey::Other, _))) {
				state.note = None;
			}
			return self.mark();
		}
		state.custom = Some(value);
		if multi {
			return self.mark();
		}
		state.selected.clear();
		if matches!(&state.note, Some((RowKey::Option(_), _))) {
			state.note = None;
		}
		self.advance()
	}

	fn note_key(&mut self, key: Key) -> PanelEvent {
		match self.ui.handle_key(key) {
			UiEvent::Cancel => {
				self.note = None;
				self.mark()
			},
			UiEvent::Submit => {
				let Some(prompt) = self.note.take() else {
					return PanelEvent::Consumed;
				};
				self.states[prompt.question].note = Some((prompt.row, prompt.draft));
				self.mark()
			},
			UiEvent::Changed { value, .. } => {
				if let Some(prompt) = &mut self.note {
					prompt.draft = value;
				}
				PanelEvent::Consumed
			},
			_ => PanelEvent::Consumed,
		}
	}

	fn submit_key(&mut self, key: Key) -> PanelEvent {
		match key {
			Key::Enter => self.finish(false),
			Key::Esc => self.cancel(),
			_ => {
				self.ui.handle_key(key);
				PanelEvent::Consumed
			},
		}
	}

	fn question_key(&mut self, key: Key) -> PanelEvent {
		let current = self.current();
		if self.custom_editing {
			let done = matches!(key, Key::Enter | Key::Esc);
			let event = self.ui.handle_key(key);
			if done {
				self.custom_editing = false;
			}
			return match event {
				UiEvent::Changed { value, .. } => self.committed(value),
				_ => PanelEvent::Consumed,
			};
		}
		match key {
			Key::Char('n' | 'N') => {
				let row = if self.states[current].cursor < self.questions[current].options.len() {
					RowKey::Option(self.states[current].cursor)
				} else {
					RowKey::Other
				};
				let draft = match &self.states[current].note {
					Some((noted, text)) if *noted == row => text.clone(),
					_ => Str::default(),
				};
				self.note = Some(NotePrompt { question: current, row, draft });
				return self.mark();
			},
			Key::Esc => {
				// The `Other` row's inline editor swallows a first Esc; a
				// second one (or Esc anywhere else) cancels the tool.
				return match self.ui.handle_key(Key::Esc) {
					UiEvent::Cancel => self.cancel(),
					_ => PanelEvent::Consumed,
				};
			},
			_ => {},
		}
		let opens_custom = self.states[current].cursor >= self.questions[current].options.len()
			&& matches!(key, Key::Enter | Key::Space);
		let event = self.ui.handle_key(key);
		if opens_custom && matches!(&event, UiEvent::None) {
			self.custom_editing = true;
			return PanelEvent::Consumed;
		}
		match event {
			UiEvent::Highlighted { value, .. } => {
				let question = &self.questions[current];
				self.states[current].cursor = question
					.options
					.iter()
					.position(|option| option.label == value)
					.unwrap_or(question.options.len());
				PanelEvent::Consumed
			},
			UiEvent::Changed { value, .. } => self.committed(value),
			UiEvent::Submit => self.advance(),
			UiEvent::Cancel => self.cancel(),
			_ => PanelEvent::Consumed,
		}
	}
}

impl Panel for AskDialog {
	fn id(&self) -> &'static str {
		ID
	}

	fn anchor(&self) -> PanelAnchor {
		PanelAnchor::Bottom
	}

	fn action(&mut self, action: PanelAction) -> PanelEvent {
		if self.custom_editing {
			// Let the raw key reach the inline editor before any dialog
			// shortcut lowered from it.
			return PanelEvent::Ignored;
		}
		match action {
			PanelAction::Expand if self.header_overflows() => {
				self.expanded = !self.expanded;
				self.mark()
			},
			_ => PanelEvent::Ignored,
		}
	}

	fn key(&mut self, key: Key) -> PanelEvent {
		self.sync();
		// Any key restarts the inactivity countdown.
		if let Some(timeout) = self.timeout {
			self.deadline = self.now_hint.saturating_add(timeout);
		}
		if self.note.is_some() {
			return self.note_key(key);
		}
		if self.custom_editing {
			return self.question_key(key);
		}
		if self.has_submit_tab() {
			match key {
				Key::Tab | Key::Right => return self.switch_tab(true),
				Key::BackTab | Key::Left => return self.switch_tab(false),
				_ => {},
			}
		}
		if self.is_submit_tab() {
			return self.submit_key(key);
		}
		self.question_key(key)
	}

	fn paste(&mut self, text: &str) -> PanelEvent {
		self.sync();
		match self.ui.handle_paste(text) {
			UiEvent::Changed { value, .. } if self.note.is_some() => {
				if let Some(prompt) = &mut self.note {
					prompt.draft = value;
				}
				PanelEvent::Consumed
			},
			_ => PanelEvent::Consumed,
		}
	}

	fn touch(&mut self, now: Duration) {
		self.now_hint = now;
		if let Some(timeout) = self.timeout {
			self.deadline = now.saturating_add(timeout);
			let remaining = self.remaining(now).unwrap_or(0);
			if remaining != self.shown_secs {
				self.shown_secs = remaining;
				self.dirty = true;
			}
		}
	}

	fn frame(&mut self, viewport: Size) -> &Frame {
		let rows = Self::body_rows(viewport);
		if viewport.width != self.width || rows != self.rows {
			self.width = viewport.width;
			self.rows = rows;
			self.dirty = true;
		}
		self.sync();
		self.ui.frame()
	}

	fn tick(&mut self, now: Duration) -> bool {
		self.now_hint = now;
		let Some(remaining) = self.remaining(now) else {
			return false;
		};
		if self.settled.is_some() {
			return false;
		}
		if now >= self.deadline {
			self.settled = Some(self.timed_out());
			return true;
		}
		if remaining != self.shown_secs {
			self.shown_secs = remaining;
			self.dirty = true;
			return true;
		}
		false
	}

	fn next_wake(&self) -> Option<Duration> {
		self.timeout?;
		if self.settled.is_some() {
			return None;
		}
		// The next whole-second flip of the title, never past the deadline.
		let left = self.deadline.saturating_sub(self.now_hint);
		let sub = Duration::from_millis(u64::try_from(left.as_millis() % 1000).unwrap_or(0));
		let step = if sub.is_zero() {
			Duration::from_secs(1)
		} else {
			sub
		};
		Some(self.now_hint.saturating_add(step.min(left)))
	}

	fn settled(&mut self) -> Option<PanelEvent> {
		self.settled.take()
	}
}

#[cfg(test)]
mod tests {
	use omp_tools::ask::OptionItem;

	use super::*;

	const VIEWPORT: Size = Size { width: 80, height: 20 };
	const LONG_QUESTION: &str = concat!(
		"A long question that deliberately wraps over many rows so Ctrl+O is a valid dialog \
		 shortcut. ",
		"A long question that deliberately wraps over many rows so Ctrl+O is a valid dialog \
		 shortcut. ",
		"A long question that deliberately wraps over many rows so Ctrl+O is a valid dialog \
		 shortcut. ",
		"A long question that deliberately wraps over many rows so Ctrl+O is a valid dialog \
		 shortcut. ",
	);

	fn question(prompt: &'static str) -> Question {
		Question {
			id:          Str::new_static("choice"),
			question:    Str::new_static(prompt),
			header:      Some(Str::new_static("Choice")),
			options:     vec![OptionItem {
				label:       Str::new_static("Default"),
				description: None,
				preview:     None,
			}],
			multi:       false,
			recommended: Some(0),
		}
	}

	fn dialog(prompt: &'static str, timeout: Option<Duration>) -> AskDialog {
		AskDialog::open(
			Str::new_static("call"),
			vec![question(prompt)],
			timeout,
			Duration::ZERO,
			VIEWPORT,
			&UiContext::default(),
		)
	}

	#[test]
	fn timeout_selects_recommended_and_falls_back_to_first_option() {
		let mut recommended = question("Choose");
		recommended.options.push(OptionItem {
			label:       Str::new_static("Second"),
			description: None,
			preview:     None,
		});
		recommended.recommended = Some(1);
		let mut fallback = recommended.clone();
		fallback.id = Str::new_static("fallback");
		fallback.recommended = None;
		let mut dialog = AskDialog::open(
			Str::new_static("call"),
			vec![recommended, fallback],
			Some(Duration::from_secs(5)),
			Duration::ZERO,
			VIEWPORT,
			&UiContext::default(),
		);
		let PanelEvent::Ask { answers: Some(selections), .. } = dialog.timed_out() else {
			panic!("timeout submits selections");
		};
		assert_eq!(selections[0].selected, [Str::new_static("Second")]);
		assert_eq!(selections[1].selected, [Str::new_static("Default")]);
		assert!(selections.iter().all(|selection| selection.timed_out));
	}

	#[test]
	fn multi_empty_and_single_freeform_are_valid_answers() {
		let mut multi = question("Pick any");
		multi.multi = true;
		let mut multi_dialog = AskDialog::open(
			Str::new_static("multi"),
			vec![multi],
			None,
			Duration::ZERO,
			VIEWPORT,
			&UiContext::default(),
		);
		let PanelEvent::Ask { answers: Some(selections), .. } = multi_dialog.finish(false) else {
			panic!("empty multi submits");
		};
		assert!(selections[0].selected.is_empty());
		assert!(selections[0].custom_input.is_none());

		let mut dialog = dialog("Name another", None);
		let PanelEvent::Ask { answers: Some(selections), .. } =
			dialog.committed(Str::new_static("Custom choice"))
		else {
			panic!("single freeform submits");
		};
		assert_eq!(selections[0].custom_input.as_deref(), Some("Custom choice"));
		assert!(selections[0].selected.is_empty());
		assert_eq!(dialog.cancel(), PanelEvent::Ask {
			id:      Str::new_static("call"),
			answers: None,
		});
	}

	#[test]
	fn paste_restarts_timeout_from_the_input_timestamp() {
		let mut dialog = dialog("Choose", Some(Duration::from_secs(5)));
		assert!(dialog.tick(Duration::from_secs(4)), "countdown reaches the one-second frame");
		dialog.touch(Duration::from_secs(4));
		assert_eq!(dialog.paste("late input"), PanelEvent::Consumed);
		assert!(
			dialog.tick(Duration::from_secs(8)),
			"the whole-second countdown repaints after late input"
		);
		assert!(dialog.settled().is_none());
		assert!(dialog.tick(Duration::from_secs(9)));
		assert!(matches!(dialog.settled(), Some(PanelEvent::Ask { .. })));
	}

	#[test]
	fn custom_editor_owns_dialog_shortcuts_until_it_closes() {
		let mut custom = question(LONG_QUESTION);
		custom.multi = true;
		let mut dialog = AskDialog::open(
			Str::new_static("call"),
			vec![custom],
			None,
			Duration::ZERO,
			VIEWPORT,
			&UiContext::default(),
		);
		assert_eq!(dialog.key(Key::Down), PanelEvent::Consumed);
		assert_eq!(dialog.key(Key::Space), PanelEvent::Consumed);
		assert!(dialog.custom_editing);

		assert_eq!(dialog.action(PanelAction::Expand), PanelEvent::Ignored);
		assert_eq!(dialog.key(Key::Ctrl('o')), PanelEvent::Consumed);
		assert!(!dialog.expanded);
		assert_eq!(dialog.key(Key::Tab), PanelEvent::Consumed);
		assert_eq!(dialog.tab, 0);
		assert_eq!(dialog.key(Key::Char('n')), PanelEvent::Consumed);
		assert!(dialog.note.is_none());
		assert_eq!(dialog.key(Key::Enter), PanelEvent::Consumed);
		assert_eq!(dialog.states[0].custom.as_deref(), Some("n"));
	}

	#[test]
	fn expanded_header_borrows_from_body_without_growing_dialog() {
		let prompt = "one two three four five six seven eight nine ten eleven twelve thirteen \
		              fourteen fifteen sixteen seventeen eighteen nineteen twenty "
			.repeat(8);
		let mut dialog = AskDialog::open(
			Str::new_static("call"),
			vec![Question { question: Str::new(prompt), ..question("placeholder") }],
			None,
			Duration::ZERO,
			VIEWPORT,
			&UiContext::default(),
		);
		let collapsed = dialog.frame(VIEWPORT).size().height;
		assert_eq!(dialog.action(PanelAction::Expand), PanelEvent::Consumed);
		let expanded = dialog.frame(VIEWPORT).size().height;
		let cap = (VIEWPORT.height * HEIGHT_RATIO.0 / HEIGHT_RATIO.1).max(MIN_DIALOG_ROWS);
		assert_eq!(expanded, collapsed);
		assert!(expanded <= cap, "expanded {expanded} rows exceeds {cap}-row cap");
	}
}
