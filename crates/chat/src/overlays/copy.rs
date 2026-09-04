//! `/copy` picker: the transcript
//! itself, one message outlined, with `→` descending into that message's
//! inner blocks (fenced code, quotes, shell commands, tool output). Enter
//! copies and closes; the close rides the
//! panel's `settled` hook so the host writes the clipboard first.
//!
//! Links follow a message's blocks; `o` on a link block hands it to the
//! system opener.
//!
//! `/copy code`, `/copy cmd`, and `/copy link` are one-shot host calls over
//! the same transcript walk ([`last_code_block`], [`last_command`],
//! [`crate::markdown::last_link`]).

use std::time::Duration;

use omp_core::{Str, StrMut, sf};
use omp_dom::{Dom, KnownTag, Node, PropId, Tag, Value};
use omp_tui::{
	Frame, Icon, IntoComponent as _, Key, MouseReport, Prop, Size, Ui, UiContext, UiEvent, dom,
};

use super::{Panel, PanelAction, PanelAnchor, PanelEvent};
use crate::{
	cards::{Component, result_image},
	markdown::extract_links,
	notices::{
		custom,
		divider::{SummaryDivider, turn_compactions},
		file_mentions, irc, local, misc, skill,
	},
	project::{AssistantPart, assistant_parts},
	reaction, thinking,
};

/// Rows the frame chrome occupies: top rule, header, rule, footer hint,
/// bottom rule.
const CHROME_ROWS: u16 = 5;
/// Preview rows shown per block in the descended view; copy always takes
/// the full text.
const BLOCK_PREVIEW_LINES: usize = 12;
/// Result rows shown under a collapsed tool card.
const TOOL_PREVIEW_LINES: usize = 3;

/// One copyable inner block of a transcript message.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CopyBlock {
	/// Short kind label (`rust code`, `bash command`, `read result`, …).
	pub label:    Str,
	/// Exact text placed on the clipboard.
	pub content:  Str,
	/// Highlight language for the block preview.
	pub language: Option<Str>,
	/// Set for link blocks: the URL `o` opens. `content` is the same URL.
	pub href:     Option<Str>,
}

/// What kind of command a `/copy cmd` hit came from.
#[derive(Clone, Copy, Debug, Eq, PartialEq, strum::IntoStaticStr)]
pub enum CommandKind {
	/// A `bash` tool call.
	#[strum(serialize = "bash command")]
	Bash,
	/// An `eval` tool call.
	#[strum(serialize = "eval code")]
	Eval,
}

impl CommandKind {
	/// Status wording for the command kind.
	#[must_use]
	pub fn noun(self) -> &'static str {
		self.into()
	}
}

impl From<local::LocalKind> for CommandKind {
	fn from(value: local::LocalKind) -> Self {
		match value {
			local::LocalKind::Bash => Self::Bash,
			local::LocalKind::Eval => Self::Eval,
		}
	}
}

/// One rendered piece of a message.
#[derive(Clone, Debug, PartialEq)]
enum Segment {
	User {
		node:     Node,
		reaction: Option<Str>,
	},
	/// A journaled async-result row; the picker mirrors its compact transcript
	/// presentation while copying the full model-facing notice.
	AsyncResult(omp_journal::data::AsyncResult),
	/// A journaled supervised-process completion. It follows tool visibility
	/// and copies the full model-facing notice.
	LaunchCompletion(omp_journal::data::LaunchCompletion),
	/// Replay-stable incoming, autoreply, relay, or work-pool IRC traffic.
	IrcTraffic(omp_journal::data::IrcTraffic),
	/// Ordered auto-read file rows and their materialization states.
	FileMentions(omp_journal::data::FileMentions),
	/// User-invoked skill prompt with its typed source metadata.
	SkillPrompt(omp_journal::data::SkillPrompt),
	Thinking(Str),
	Assistant(Str),
	Tool {
		name:   Str,
		status: Str,
		output: Str,
	},
	/// A user-local `!`/`$` run, preserving its dedicated neutral card.
	Local(local::LocalExecution),
	/// A provider artifact attached to an assistant reply.
	Artifact {
		uri:  Str,
		mime: Str,
		kind: Str,
	},
	/// A journaled extension or hook message (`<notice kind=custom|hook>`).
	Message {
		name: Option<Str>,
		body: Str,
	},
	/// A custom-rendered notice (`advisor`, `diagnostics`, `tangent`): its
	/// card title over the text the card carries, lines preserved.
	Notice {
		title: Str,
		body:  Str,
	},
	/// A history-collapse divider (`<compaction>`), drawn expanded so the
	/// summary it would copy is in view.
	Summary(SummaryDivider),
}

/// One selectable transcript message: a user prompt,
/// or an assistant message with the tool results it folded.
#[derive(Clone, Debug, PartialEq)]
pub struct CopyTarget {
	/// Clipboard label for the whole message.
	pub label:   Str,
	/// Clipboard text for the whole message.
	pub content: Str,
	/// Inner blocks reached with `→`.
	pub blocks:  Vec<CopyBlock>,
	segments:    Vec<Segment>,
}

/// Retained `/copy` picker.
pub struct CopySelector {
	ui:             Ui,
	ctx:            UiContext,
	targets:        Vec<CopyTarget>,
	selected:       usize,
	block_selected: Option<usize>,
	expanded:       bool,
	closing:        bool,
	width:          u16,
	rows:           u16,
	/// System opener for `o` on a link block ([`omp_core::open::open_path`]
	/// outside tests).
	opener:         fn(&str),
}

impl CopySelector {
	/// Builds the picker over the session replica; `show_thinking` and
	/// `show_tools` mirror the transcript's reveal settings.
	#[must_use]
	pub fn open(
		dom: &Dom,
		show_thinking: bool,
		show_tools: bool,
		prose_only: bool,
		ctx: &UiContext,
	) -> Self {
		let targets = collect_targets(dom, show_thinking, show_tools, prose_only);
		let mut panel = Self {
			ui: Ui::from_root(dom! { <col/> }, 80, ctx.clone()),
			ctx: ctx.clone(),
			selected: targets.len().saturating_sub(1),
			targets,
			block_selected: None,
			expanded: false,
			closing: false,
			width: 0,
			rows: 0,
			opener: omp_core::open::open_path,
		};
		panel.rebuild(80, 20);
		panel
	}

	/// Number of copyable messages; hosts skip mounting when zero.
	#[must_use]
	pub fn target_count(&self) -> usize {
		self.targets.len()
	}

	/// Footer hint as shown.
	#[must_use]
	pub fn hint(&self) -> Str {
		match self.block_selected {
			Some(index) => {
				let target = self.targets.get(self.selected);
				let total = target.map_or(0, |target| target.blocks.len());
				let open = target
					.and_then(|target| target.blocks.get(index))
					.is_some_and(|block| block.href.is_some());
				sf!(
					"{}/{total}  ↑/↓ block  ←/esc back  enter copy{}",
					index + 1,
					if open { "  o open" } else { "" }
				)
			},
			None => {
				let blocks = self
					.targets
					.get(self.selected)
					.map_or(0, |target| target.blocks.len());
				let mut hint = StrMut::new("");
				if !self.targets.is_empty() {
					hint.push_str(sf!("{}/{}  ", self.selected + 1, self.targets.len()).as_str());
				}
				hint.push_str("↑/↓ step  ");
				if blocks > 0 {
					hint.push_str("→ blocks  ");
				}
				hint.push_str("enter copy  ctrl+o expand  esc close");
				hint.freeze()
			},
		}
	}

	fn move_vertical(&mut self, delta: isize) -> PanelEvent {
		match self.block_selected {
			Some(index) => {
				let total = self
					.targets
					.get(self.selected)
					.map_or(0, |target| target.blocks.len());
				if let Some(next) = index.checked_add_signed(delta).filter(|next| *next < total) {
					self.block_selected = Some(next);
					self.rebuild(self.width, self.rows);
				}
			},
			None => {
				if let Some(next) = self
					.selected
					.checked_add_signed(delta)
					.filter(|next| *next < self.targets.len())
				{
					self.selected = next;
					self.rebuild(self.width, self.rows);
				}
			},
		}
		PanelEvent::Consumed
	}

	fn descend(&mut self) -> PanelEvent {
		if self.block_selected.is_none()
			&& self
				.targets
				.get(self.selected)
				.is_some_and(|target| !target.blocks.is_empty())
		{
			self.block_selected = Some(0);
			self.rebuild(self.width, self.rows);
		}
		PanelEvent::Consumed
	}

	fn ascend(&mut self) -> PanelEvent {
		if self.block_selected.take().is_some() {
			self.rebuild(self.width, self.rows);
		}
		PanelEvent::Consumed
	}

	fn pick(&mut self) -> PanelEvent {
		let Some(target) = self.targets.get(self.selected) else {
			return PanelEvent::Consumed;
		};
		let content = match self.block_selected {
			Some(index) => match target.blocks.get(index) {
				Some(block) => block.content.clone(),
				None => return PanelEvent::Consumed,
			},
			None => target.content.clone(),
		};
		self.closing = true;
		PanelEvent::Copy(content)
	}

	/// `o` on a link block hands the URL to the system opener,
	/// report it, and close. On any other block the key is ignored.
	fn open_link(&mut self) -> PanelEvent {
		let Some(block) = self
			.block_selected
			.and_then(|index| self.targets.get(self.selected)?.blocks.get(index))
		else {
			return PanelEvent::Consumed;
		};
		let Some(href) = &block.href else {
			return PanelEvent::Consumed;
		};
		(self.opener)(href.as_str());
		self.closing = true;
		PanelEvent::Notice(sf!("Opening {}: {href}", block.label))
	}

	fn route(&mut self, event: UiEvent) -> PanelEvent {
		match event {
			UiEvent::Cancel => PanelEvent::Close,
			UiEvent::Pressed(id) => {
				if let Some(index) = id
					.as_str()
					.strip_prefix("turn-")
					.and_then(|index| index.parse::<usize>().ok())
					.filter(|index| *index < self.targets.len())
					&& index != self.selected
				{
					self.selected = index;
					self.block_selected = None;
					self.rebuild(self.width, self.rows);
				}
				PanelEvent::Consumed
			},
			_ => PanelEvent::Consumed,
		}
	}

	fn rebuild(&mut self, width: u16, rows: u16) {
		self.width = width;
		self.rows = rows;
		let dot = self.ctx.charset.icon(Icon::Dot);
		let hint = self.hint();
		let expanded = self.expanded;
		let selected = self.selected;
		let block_selected = self.block_selected;
		let entries = self
			.targets
			.iter()
			.enumerate()
			.map(|(index, target)| {
				let id = sf!("turn-{index}");
				let descended = index == selected && block_selected.is_some();
				let outlined = index == selected && block_selected.is_none();
				let caption = if outlined && !target.blocks.is_empty() {
					let count = target.blocks.len();
					sf!("{count} block{} →", if count == 1 { "" } else { "s" })
				} else {
					Str::default()
				};
				let cards = descended
					.then(|| {
						let block = block_selected.unwrap_or_default();
						target
							.blocks
							.iter()
							.enumerate()
							.map(|(position, item)| {
								block_card(item, position, target.blocks.len(), position == block, dot)
							})
							.collect::<Vec<_>>()
					})
					.unwrap_or_default();
				let segments = target
					.segments
					.iter()
					.map(|segment| segment_view(segment, expanded, &self.ctx))
					.collect::<Vec<_>>();
				(id, descended, outlined, caption, cards, segments)
			})
			.collect::<Vec<_>>();
		let tree = dom! {
			<box border=round pad-x=1>
				<col>
					<row gap=1>
						<icon name="copy"/>
						<text bold>{"Copy"}</text>
						<text fg=muted>{sf!("{dot}pick what to put on the clipboard")}</text>
					</row>
					<hr border=round/>
					<scroll id="copy" h={rows}>
						for (id, descended, outlined, caption, cards, segments) in entries {
							if descended {
								<col id={id} focus hover=muted>
									for card in cards { {card} }
								</col>
							} else if outlined {
								<box id={id} focus border=round bc=ok title={caption}>
									<col>
										for segment in segments { {segment} }
									</col>
								</box>
							} else {
								<col id={id} focus hover=muted pad-x=1>
									for segment in segments { {segment} }
								</col>
							}
						}
					</scroll>
					<text fg=muted truncate>{hint}</text>
				</col>
			</box>
		};
		self.ui = Ui::from_root(tree, width, self.ctx.clone());
		let _ = self.ui.focus_id(sf!("turn-{selected}").as_str());
	}
}

fn segment_view(segment: &Segment, expanded: bool, ui: &UiContext) -> Component {
	match segment {
		Segment::User { node, reaction } => {
			let raw = node.content.clone().unwrap_or_default();
			let text = crate::project::collapse_image_markers(&raw, ui.charset);
			let chips = crate::project::attachment_chips(node, raw.as_str(), ui.charset);
			if crate::notices::prop_bool(node, PropId::Synthetic) {
				crate::project::with_attachments(
					crate::notices::misc::synthetic_row(text.as_str(), expanded),
					&chips,
				)
			} else if let Some(author) = crate::notices::prop_text(node, PropId::Author) {
				crate::project::with_attachments(
					crate::notices::misc::guest_bubble(author.as_str(), text),
					&chips,
				)
			} else {
				copy_user_bubble(text, reaction.clone(), &chips)
			}
		},
		Segment::Thinking(text) => {
			let text = text.clone();
			dom! { <md fg=muted italic pad-x=1>{text}</md> }.into_component()
		},
		Segment::Assistant(text) => {
			let text = text.clone();
			dom! { <md pad-x=1>{text}</md> }.into_component()
		},
		Segment::Tool { name, status, output } => {
			let header = sf!("{name} {status}");
			let shown = if expanded {
				output.clone()
			} else {
				preview(output, TOOL_PREVIEW_LINES)
			};
			dom! {
				<col pad-x=1>
					<text fg=muted>{header}</text>
					if !shown.is_empty() { <pre fg=muted>{shown}</pre> }
				</col>
			}
			.into_component()
		},
		Segment::Local(run) => local::execution_block(run, expanded),
		Segment::AsyncResult(result) => misc::async_result_block(result),
		Segment::LaunchCompletion(completion) => misc::launch_completion_block(completion),
		Segment::IrcTraffic(traffic) => irc::traffic_card(traffic, expanded),
		Segment::FileMentions(mentions) => file_mentions::block(mentions),
		Segment::SkillPrompt(prompt) => skill::prompt_card(prompt, expanded),
		Segment::Artifact { uri, mime, kind } => {
			if kind.as_str() == "image" || mime.as_str().starts_with("image/") {
				result_image(uri, mime.as_str(), None, ui)
			} else {
				let uri = uri.clone();
				let label = sf!("[{}: {}]", kind, mime);
				dom! {
					<col pad-x=1><text fg=muted>{label}</text><a href={uri.clone()}>{uri}</a></col>
				}
				.into_component()
			}
		},
		Segment::Message { name, body } => {
			let name = name.clone();
			let body = body.clone();
			dom! {
				<col pad-x=1>
					if let Some(name) = name { <text bold fg=accent>{name}</text> }
					<md>{body}</md>
				</col>
			}
			.into_component()
		},
		Segment::Notice { title, body } => {
			let title = title.clone();
			let body = body.clone();
			dom! {
				<col pad-x=1>
					<text bold fg=accent>{title}</text>
					if !body.is_empty() { <pre>{body}</pre> }
				</col>
			}
			.into_component()
		},
		Segment::Summary(divider) => divider.clone().into_component(),
	}
}

/// User bubble inside the alternate-screen copy overlay. It mirrors the main
/// bubble but deliberately omits the OSC 133 prompt zone, keeping terminal
/// click-to-move state off the picker.
fn copy_user_bubble(text: Str, reaction: Option<Str>, chips: &[Str]) -> Component {
	if reaction.is_none() && chips.is_empty() {
		return dom! { <md bg=surface pad="1 1">{text}</md> }.into_component();
	}
	let chips = chips.to_vec();
	dom! {
		<col bg=surface>
			if let Some(reaction) = reaction {
				<row h=1 justify=end pad-x=1><text>{reaction}</text></row>
			} else {
				<spacer h=1/>
			}
			<md pad-x=1>{text}</md>
			if !chips.is_empty() {
				<row h=1 gap=2 pad-x=1>
					for chip in chips { <text bold fg=accent>{chip}</text> }
				</row>
			}
			<spacer h=1/>
		</col>
	}
	.into_component()
}

/// Notices rendered with their own cards (`advisor`, `diagnostics`, `tangent`)
/// copy their card title and shown text. `None` for controller kinds
/// (`error | warn | info | success`).
fn notice_copy(kind: &str, node: &Node) -> Option<(Str, Str)> {
	let content = node.content.as_deref().unwrap_or_default().trim();
	match kind {
		"advisor" => {
			let message = misc::advisor_message(node)?;
			let blockers = message
				.notes
				.iter()
				.filter(|entry| entry.severity == omp_journal::data::AdvisorSeverity::Blocker)
				.count();
			let title = if blockers == 0 {
				sf!(
					"Advisor · {} {}",
					message.notes.len(),
					if message.notes.len() == 1 {
						"note"
					} else {
						"notes"
					}
				)
			} else {
				sf!(
					"Advisor · {} {} · {blockers} {}",
					message.notes.len(),
					if message.notes.len() == 1 {
						"note"
					} else {
						"notes"
					},
					if blockers == 1 { "blocker" } else { "blockers" }
				)
			};
			Some((title, misc::advisor_message_text(&message)))
		},
		"diagnostics" => {
			let title = match prop_text(node, PropId::Name) {
				Some(server) => sf!("Late diagnostics · {server}"),
				None => Str::new_static("Late diagnostics"),
			};
			let body = omp_session::late_diagnostics::LateDiagnostics::from_node(node)
				.map_or_else(|| Str::new(content), |diagnostics| diagnostics.body());
			Some((title, body))
		},
		"tangent" => {
			let body = if content.is_empty() {
				let id = prop_text(node, PropId::Id).unwrap_or_else(|| Str::new_static("unknown"));
				match prop_text(node, PropId::Label) {
					Some(work) => sf!("Tangent dispatched [task] {id} — {work}"),
					None => sf!("Tangent dispatched [task] {id}"),
				}
			} else {
				Str::new(content)
			};
			Some((Str::new_static("Tangent"), body))
		},
		_ => None,
	}
}

fn block_card(
	block: &CopyBlock,
	index: usize,
	total: usize,
	selected: bool,
	dot: &str,
) -> Component {
	let lines = block.content.lines().count().max(1);
	let caption = sf!(
		"{}/{total}{dot}{}{dot}{lines} line{}",
		index + 1,
		block.label,
		if lines == 1 { "" } else { "s" }
	);
	let shown = preview(&block.content, BLOCK_PREVIEW_LINES);
	if selected {
		dom! {
			<box border=round bc=ok title={caption}>
				<pre>{shown}</pre>
			</box>
		}
		.into_component()
	} else {
		dom! {
			<col pad-x=1>
				<text fg=muted>{caption}</text>
				<pre>{shown}</pre>
			</col>
		}
		.into_component()
	}
}

/// The first `limit` lines of `text` plus an `… +N more lines` tail.
fn preview(text: &str, limit: usize) -> Str {
	let total = text.lines().count();
	if total <= limit {
		return Str::new(text);
	}
	let mut out = StrMut::new("");
	for line in text.lines().take(limit) {
		out.push_str(line);
		out.push_str("\n");
	}
	out.push_str(sf!("… +{} more lines", total - limit).as_str());
	out.freeze()
}

impl Panel for CopySelector {
	fn id(&self) -> &'static str {
		"copy"
	}

	fn anchor(&self) -> PanelAnchor {
		PanelAnchor::Full
	}

	fn action(&mut self, action: PanelAction) -> PanelEvent {
		match action {
			PanelAction::Expand => {
				self.expanded = !self.expanded;
				self.rebuild(self.width, self.rows);
				PanelEvent::Consumed
			},
			_ => PanelEvent::Ignored,
		}
	}

	fn key(&mut self, key: Key) -> PanelEvent {
		match key {
			Key::Esc => {
				if self.block_selected.is_some() {
					self.ascend()
				} else {
					PanelEvent::Close
				}
			},
			Key::Up | Key::Char('k') => self.move_vertical(-1),
			Key::Down | Key::Char('j') => self.move_vertical(1),
			Key::Right => self.descend(),
			Key::Left => self.ascend(),
			Key::Enter => self.pick(),
			Key::Char('o' | 'O') => self.open_link(),
			Key::PageUp | Key::PageDown | Key::Home | Key::End | Key::SelectUp | Key::SelectDown => {
				let event = self.ui.handle_key(key);
				self.route(event)
			},
			_ => PanelEvent::Consumed,
		}
	}

	fn mouse(&mut self, report: MouseReport) -> PanelEvent {
		let event = self
			.ui
			.handle_mouse_with_mods(report.col, report.row, report.kind, report.mods);
		if report.kind == omp_tui::Mouse::Click
			&& let Some(index) = self.ui.focused_id().and_then(|id| {
				id.strip_prefix("turn-")
					.and_then(|index| index.parse().ok())
			}) && index < self.targets.len()
			&& index != self.selected
		{
			self.selected = index;
			self.block_selected = None;
			self.rebuild(self.width, self.rows);
			return PanelEvent::Consumed;
		}
		self.route(event)
	}

	fn frame(&mut self, viewport: Size) -> &Frame {
		let rows = viewport.height.saturating_sub(CHROME_ROWS).max(3);
		if viewport.width != self.width {
			self.rebuild(viewport.width, rows);
		} else if rows != self.rows {
			self.rows = rows;
			self.ui.set_prop("copy", Prop::H, rows);
		}
		self.ui.frame()
	}

	fn tick(&mut self, _now: Duration) -> bool {
		self.closing
	}

	fn next_wake(&self) -> Option<Duration> {
		self.closing.then_some(Duration::ZERO)
	}

	fn settled(&mut self) -> Option<PanelEvent> {
		self.closing.then_some(PanelEvent::Close)
	}
}

/// Walks the replica into outline targets: every user prompt, every
/// assistant message with the visible tool results it folded, every displayed
/// notice (`message`), and every history-collapse divider (`summary`) after
/// the turn holding its boundary. Hidden tool activity is not selectable.
#[must_use]
pub fn collect_targets(
	dom: &Dom,
	show_thinking: bool,
	show_tools: bool,
	prose_only: bool,
) -> Vec<CopyTarget> {
	let mut targets = Vec::new();
	let mut reaction_target = None;
	for turn in dom.children(dom.body()) {
		if dom
			.get(*turn)
			.is_none_or(|node| node.tag != Tag::Known(KnownTag::Turn))
		{
			continue;
		}
		let mut open: Option<CopyTarget> = None;
		for handle in dom.children(*turn) {
			let Some(node) = dom.get(*handle) else {
				continue;
			};
			match &node.tag {
				Tag::Known(KnownTag::User) => {
					if let Some(mentions) = file_mentions::payload(node) {
						targets.extend(open.take());
						let content = file_mentions::text(&mentions);
						let blocks = mentions
							.files
							.iter()
							.map(|file| {
								let path = file.path.clone();
								CopyBlock {
									label:    Str::new_static("file"),
									content:  path.clone(),
									language: None,
									href:     Some(crate::cards::file_link(path.as_str())),
								}
							})
							.collect();
						targets.push(CopyTarget {
							label: Str::new_static("file mention"),
							content,
							blocks,
							segments: vec![Segment::FileMentions(mentions)],
						});
						continue;
					}
					if let Some(prompt) = skill::prompt(node) {
						reaction_target = None;
						targets.extend(open.take());
						let content = prompt.prompt_body.clone();
						let mut blocks = Vec::new();
						push_markdown_blocks(&mut blocks, content.as_str());
						targets.push(CopyTarget {
							label: Str::new_static("message"),
							content,
							blocks,
							segments: vec![Segment::SkillPrompt(prompt)],
						});
						continue;
					}
					if let Some(completion) = misc::launch_completion(node) {
						reaction_target = None;
						targets.extend(open.take());
						if !show_tools {
							continue;
						}
						let content = node.content.clone().unwrap_or_default();
						let mut blocks = Vec::new();
						push_markdown_blocks(&mut blocks, content.as_str());
						targets.push(CopyTarget {
							label: Str::new_static("message"),
							content,
							blocks,
							segments: vec![Segment::LaunchCompletion(completion)],
						});
						continue;
					}
					if let Some(result) = misc::async_result(node) {
						reaction_target = None;
						targets.extend(open.take());
						if !show_tools {
							continue;
						}
						let content = node.content.clone().unwrap_or_default();
						let mut blocks = Vec::new();
						push_markdown_blocks(&mut blocks, content.as_str());
						targets.push(CopyTarget {
							label: Str::new_static("message"),
							content,
							blocks,
							segments: vec![Segment::AsyncResult(result)],
						});
						continue;
					}
					targets.extend(open.take());
					let text = node.content.clone().unwrap_or_default();
					let mut blocks = Vec::new();
					push_markdown_blocks(&mut blocks, text.as_str());
					let accepts_reaction = node.prop(&PropId::Synthetic.into())
						!= Some(&Value::Bool(true))
						&& prop_text(node, PropId::Author).is_none();
					let target = CopyTarget {
						label: Str::new_static("user message"),
						content: text.clone(),
						blocks,
						segments: vec![Segment::User { node: node.clone(), reaction: None }],
					};
					if accepts_reaction {
						reaction_target = Some(targets.len());
					} else {
						reaction_target = None;
					}
					targets.push(target);
				},
				Tag::Known(KnownTag::Assistant) => {
					targets.extend(open.take());
					let mut text = StrMut::new("");
					let mut segments = Vec::new();
					let mut target = reaction_target.take();
					let mut opening_text_seen = false;
					for part in assistant_parts(dom, *handle, node) {
						match part {
							AssistantPart::Text { text: raw, .. } => {
								text.push_str(raw.as_str());
								let raw = Str::new(raw.trim());
								if raw.is_empty() {
									continue;
								}
								let display = if opening_text_seen {
									raw
								} else {
									opening_text_seen = true;
									match target.take() {
										Some(target_index) => {
											let split = reaction::split_reaction(raw.as_str());
											if let Some(emoji) = split.emoji {
												if let Some(CopyTarget { segments, .. }) =
													targets.get_mut(target_index)
													&& let Some(Segment::User { reaction, .. }) =
														segments.first_mut()
												{
													*reaction = Some(Str::new(emoji));
												}
												Str::new(split.body)
											} else {
												raw
											}
										},
										None => raw,
									}
								};
								if !display.is_empty() {
									segments.push(Segment::Assistant(display));
								}
							},
							AssistantPart::Thinking { text: raw, .. } if show_thinking => {
								let display = thinking::display_thinking(&raw, prose_only);
								let display = Str::new(display.trim());
								if thinking::is_displayable(raw.as_str(), display.as_str()) {
									segments.push(Segment::Thinking(display));
								}
							},
							AssistantPart::Thinking { .. } => {},
							AssistantPart::Artifact { uri, mime, kind, .. } => {
								segments.push(Segment::Artifact { uri, mime, kind });
							},
						}
					}
					let text = text.freeze();
					let mut blocks = Vec::new();
					push_markdown_blocks(&mut blocks, text.as_str());
					let trimmed = Str::new(text.trim());
					open = Some(CopyTarget {
						label: Str::new_static("assistant message"),
						content: trimmed,
						blocks,
						segments,
					});
				},
				Tag::Known(KnownTag::Notice)
					if prop_text(node, PropId::Kind).is_some_and(|kind| kind.as_str() == "irc") =>
				{
					reaction_target = None;
					targets.extend(open.take());
					if !show_tools {
						continue;
					}
					let Some(traffic) = irc::traffic(node) else {
						continue;
					};
					let body = traffic.body.clone();
					let mut blocks = Vec::new();
					push_markdown_blocks(&mut blocks, body.as_str());
					targets.push(CopyTarget {
						label: Str::new_static("message"),
						content: body,
						blocks,
						segments: vec![Segment::IrcTraffic(traffic)],
					});
				},
				// A framed message is
				// its own outline target labeled `message`.
				Tag::Known(KnownTag::Notice | KnownTag::Developer)
					if custom::message_kind(node).is_some() =>
				{
					if !custom::displayed(node) {
						continue;
					}
					targets.extend(open.take());
					let body = node.content.clone().unwrap_or_default();
					if body.trim().is_empty() {
						continue;
					}
					let mut blocks = Vec::new();
					push_markdown_blocks(&mut blocks, body.as_str());
					targets.push(CopyTarget {
						label: Str::new_static("message"),
						content: body.clone(),
						blocks,
						segments: vec![Segment::Message { name: prop_text(node, PropId::Name), body }],
					});
				},
				// Custom messages with their own cards (advisor notes,
				// late diagnostics, `/tan` breadcrumbs): outline targets
				// labeled `message` whose clipboard text is the card's text.
				Tag::Known(KnownTag::Notice | KnownTag::Developer) => {
					let Some((title, body)) =
						prop_text(node, PropId::Kind).and_then(|kind| notice_copy(kind.as_str(), node))
					else {
						continue;
					};
					if body.trim().is_empty() {
						continue;
					}
					targets.extend(open.take());
					let mut blocks = Vec::new();
					push_markdown_blocks(&mut blocks, body.as_str());
					targets.push(CopyTarget {
						label: Str::new_static("message"),
						content: body.clone(),
						blocks,
						segments: vec![Segment::Notice { title, body }],
					});
				},
				Tag::Custom(tool) => {
					if let Some(run) = local::execution(dom, *handle, node) {
						targets.extend(open.take());
						let command_kind = CommandKind::from(run.kind);
						let language = match command_kind {
							CommandKind::Bash => Str::new_static("bash"),
							CommandKind::Eval => Str::new_static("python"),
						};
						let mut blocks = vec![CopyBlock {
							label:    Str::new(command_kind.noun()),
							content:  run.command.clone(),
							language: Some(language),
							href:     None,
						}];
						if !run.output.trim().is_empty() {
							blocks.push(CopyBlock {
								label:    Str::new_static("output"),
								content:  run.output.clone(),
								language: None,
								href:     None,
							});
						}
						if let Some(artifact) = &run.artifact {
							blocks.push(CopyBlock {
								label:    Str::new_static("output artifact"),
								content:  artifact.clone(),
								language: None,
								href:     Some(artifact.clone()),
							});
						}
						let label: &'static str = run.kind.into();
						targets.push(CopyTarget {
							label: Str::new_static(label),
							content: run.copy_text(),
							blocks,
							segments: vec![Segment::Local(run)],
						});
						continue;
					}
					if !show_tools {
						continue;
					}
					let Some(input) = child(dom, *handle, KnownTag::Input) else {
						continue;
					};
					let status =
						prop_text(node, PropId::Status).unwrap_or_else(|| Str::new_static("running"));
					let result = child(dom, *handle, KnownTag::Result).and_then(result_text);
					let target = open.get_or_insert_with(|| CopyTarget {
						label:    Str::new_static("turn content"),
						content:  Str::default(),
						blocks:   Vec::new(),
						segments: Vec::new(),
					});
					if let Some((kind, code, language)) = command_of(tool.as_str(), input) {
						target.blocks.push(CopyBlock {
							label: Str::new_static(kind.noun()),
							content: code,
							language,
							href: None,
						});
					}
					if let Some(result) = &result {
						target.blocks.push(CopyBlock {
							label:    sf!("{tool} result"),
							content:  result.clone(),
							language: None,
							href:     None,
						});
					}
					target.segments.push(Segment::Tool {
						name:   tool.clone(),
						status: status.clone(),
						output: result.unwrap_or_default(),
					});
				},
				_ => {},
			}
		}
		targets.extend(open.take());
		// The compaction or branch-summary divider
		// after the turn is its own target, copying the raw summary.
		for compaction in turn_compactions(dom, *turn) {
			let Some(node) = dom.get(compaction) else {
				continue;
			};
			let summary = prop_text(node, PropId::Summary).unwrap_or_default();
			if summary.trim().is_empty() {
				continue;
			}
			targets.push(CopyTarget {
				label:    Str::new_static("summary"),
				content:  summary,
				blocks:   Vec::new(),
				segments: vec![Segment::Summary(SummaryDivider::compaction(node, true))],
			});
		}
	}
	for target in &mut targets {
		if target.content.is_empty() {
			// No direct prose (a pure tool turn): fall back to its blocks joined.
			let mut joined = StrMut::new("");
			for (index, block) in target.blocks.iter().enumerate() {
				if index > 0 {
					joined.push_str("\n\n");
				}
				joined.push_str(block.content.as_str());
			}
			target.content = joined.freeze();
			target.label = Str::new_static("turn content");
		}
	}
	targets.retain(|target| !target.segments.is_empty());
	targets
}

/// The last fenced code block of any assistant message.
#[must_use]
pub fn last_code_block(dom: &Dom) -> Option<CopyBlock> {
	let mut last = None;
	for turn in dom.children(dom.body()) {
		for handle in dom.children(*turn) {
			let Some(node) = dom.get(*handle) else {
				continue;
			};
			if node.tag != Tag::Known(KnownTag::Assistant) {
				continue;
			}
			for part in assistant_parts(dom, *handle, node) {
				let AssistantPart::Text { text, .. } = part else {
					continue;
				};
				let mut blocks = Vec::new();
				push_markdown_blocks(&mut blocks, text.as_str());
				if let Some(block) = blocks
					.into_iter()
					.rev()
					.find(|block| block.language.is_some() || block.label.ends_with("code"))
				{
					last = Some(block);
				}
			}
		}
	}
	last
}

/// The last `bash`/`eval` tool call's command text.
#[must_use]
pub fn last_command(dom: &Dom) -> Option<(CommandKind, Str)> {
	let mut last = None;
	for turn in dom.children(dom.body()) {
		for handle in dom.children(*turn) {
			let Some(node) = dom.get(*handle) else {
				continue;
			};
			let Tag::Custom(tool) = &node.tag else {
				continue;
			};
			let Some(input) = child(dom, *handle, KnownTag::Input) else {
				continue;
			};
			if let Some((kind, code, _)) = command_of(tool.as_str(), input) {
				last = Some((kind, code));
			}
		}
	}
	last
}

fn command_of(tool: &str, input: &Node) -> Option<(CommandKind, Str, Option<Str>)> {
	let args: serde_json::Value = serde_json::from_str(node_json(input)?).ok()?;
	match tool {
		"bash" => {
			let command = args.get("command")?.as_str()?;
			Some((CommandKind::Bash, Str::new(command), Some(Str::new_static("bash"))))
		},
		"eval" => {
			let (code, language) = eval_code(&args)?;
			Some((CommandKind::Eval, code, Some(language)))
		},
		_ => None,
	}
}

/// An `eval` call carries
/// either one `code` cell or a `cells` array; the non-empty cell bodies join
/// with a blank line, and the highlight language is the first cell's,
/// spelled out (`js` → `javascript`, `rb` → `ruby`, `jl` → `julia`, anything
/// else → `python`).
fn eval_code(args: &serde_json::Value) -> Option<(Str, Str)> {
	let single = std::slice::from_ref(args);
	let cells = match args.get("cells").and_then(serde_json::Value::as_array) {
		Some(cells) => cells.as_slice(),
		None if args.get("code").is_some_and(serde_json::Value::is_string) => single,
		None => return None,
	};
	let mut code = StrMut::new("");
	let mut language = None;
	for cell in cells {
		let Some(body) = cell.get("code").and_then(serde_json::Value::as_str) else {
			continue;
		};
		if body.is_empty() {
			continue;
		}
		if !code.is_empty() {
			code.push_str("\n\n");
		}
		code.push_str(body);
		language.get_or_insert_with(|| {
			match cell.get("language").and_then(serde_json::Value::as_str) {
				Some("js") => Str::new_static("javascript"),
				Some("rb") => Str::new_static("ruby"),
				Some("jl") => Str::new_static("julia"),
				_ => Str::new_static("python"),
			}
		});
	}
	let language = language?;
	Some((code.freeze(), language))
}

/// Model-facing text of a tool result: the settled `<result>` text (the
/// fold's prompt-parts projection) when there is one, else a JSON
/// `text`/`output` field of the journaled outcome, else the raw outcome.
fn result_text(node: &Node) -> Option<Str> {
	let projected = node
		.prop(&PropId::Text.into())
		.and_then(Value::as_str)
		.map(str::trim)
		.filter(|text| !text.is_empty());
	let raw = match (projected, node.prop(&PropId::Outcome.into())) {
		(Some(text), _) => text,
		(None, Some(Value::Json(value))) => value.get(),
		(None, _) => node_json(node)?,
	};
	let text = serde_json::from_str::<serde_json::Value>(raw)
		.ok()
		.and_then(|value| {
			let value = value.get("value").unwrap_or(&value);
			value
				.get("text")
				.or_else(|| value.get("output"))
				.and_then(serde_json::Value::as_str)
				.map(str::to_owned)
		})
		.unwrap_or_else(|| raw.to_owned());
	let text = text.trim();
	(!text.is_empty()).then(|| Str::new(text))
}

fn node_json(node: &Node) -> Option<&str> {
	match node.prop(&PropId::Data.into()) {
		Some(Value::Json(value)) => Some(value.get()),
		_ => node
			.prop(&PropId::Text.into())
			.and_then(Value::as_str)
			.filter(|text| !text.is_empty())
			.or(node.content.as_deref()),
	}
}

/// Fenced code blocks and blockquotes appear in order, followed by message
/// links. The
/// preview shows the whole URL on one row, so a link the transcript wrapped
/// is copied or opened intact.
fn push_markdown_blocks(blocks: &mut Vec<CopyBlock>, text: &str) {
	push_code_and_quotes(blocks, text);
	for link in extract_links(text) {
		let label = if link.text == link.href {
			Str::new_static("link")
		} else {
			sf!("link · {}", link.text)
		};
		blocks.push(CopyBlock {
			label,
			content: link.href.clone(),
			language: None,
			href: Some(link.href),
		});
	}
}

/// Fenced code blocks and blockquotes, in order. A
/// fence masks its body (a `>` line inside code is never a quote); an
/// unclosed fence is ordinary text, matching the fenced-block grammar.
fn push_code_and_quotes(blocks: &mut Vec<CopyBlock>, text: &str) {
	let lines: Vec<&str> = text.lines().collect();
	let mut quote: Option<StrMut> = None;
	let flush_quote = |quote: &mut Option<StrMut>, blocks: &mut Vec<CopyBlock>| {
		if let Some(quote) = quote.take() {
			let content = quote.freeze();
			if !content.trim().is_empty() {
				blocks.push(CopyBlock {
					label:    Str::new_static("quote"),
					content:  Str::new(content.trim_end()),
					language: None,
					href:     None,
				});
			}
		}
	};
	let mut index = 0;
	while index < lines.len() {
		let line = lines[index];
		index += 1;
		if let Some(rest) = line.strip_prefix("```")
			&& let Some(close) = lines[index..]
				.iter()
				.position(|line| line.starts_with("```"))
		{
			flush_quote(&mut quote, blocks);
			let language = rest.trim();
			let label = if language.is_empty() {
				Str::new_static("code")
			} else {
				sf!("{language} code")
			};
			blocks.push(CopyBlock {
				label,
				content: Str::new(lines[index..index + close].join("\n")),
				language: (!language.is_empty()).then(|| Str::new(language)),
				href: None,
			});
			index += close + 1;
			continue;
		}
		if let Some(rest) = line.strip_prefix('>') {
			let body = quote.get_or_insert_with(|| StrMut::new(""));
			body.push_str(rest.strip_prefix(' ').unwrap_or(rest));
			body.push_str("\n");
			continue;
		}
		flush_quote(&mut quote, blocks);
	}
	flush_quote(&mut quote, blocks);
}

fn child<'a>(dom: &'a Dom, parent: omp_dom::Handle, tag: KnownTag) -> Option<&'a Node> {
	dom.children(parent)
		.iter()
		.filter_map(|handle| dom.get(*handle))
		.find(|node| node.tag == Tag::Known(tag))
}

fn prop_text(node: &Node, prop: PropId) -> Option<Str> {
	node
		.prop(&prop.into())
		.and_then(Value::as_str)
		.map(Str::new)
}

#[cfg(test)]
mod tests {
	use omp_dom::{NodeSpec, Op, PropKey, Txn};
	use omp_session::{
		ASSISTANT_CONTENT_TAG, ComponentRegistry, PROVIDER_BLOCK_INDEX_PROP, Session,
	};
	use omp_tui::{Mods, Mouse, MouseButton, frame_text};
	use smallvec::smallvec;

	use super::*;

	const FENCE: &str = "fn main() {\n    println!(\"hi\");\n}";

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
			.unwrap_or_else(|| panic!("text point `{needle}` missing from:\n{text}"))
	}

	fn session(with_bash: bool) -> Session {
		let directory = tempfile::tempdir().expect("temp directory");
		let path = directory.keep().join("copy.oms");
		let mut session = Session::create(path, ComponentRegistry::standard()).expect("session");
		session.begin_turn().expect("turn");
		session.user("show me main", Vec::new()).expect("user");
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
		let text = session
			.stream_open(assistant, PropId::Text.into())
			.expect("text stream");
		session
			.stream_append(text, &format!("Here it is:\n\n```rust\n{FENCE}\n```\n"))
			.expect("text");
		session.stream_close(text).expect("close");
		session
			.assistant_end(if with_bash { "tool_calls" } else { "stop" })
			.expect("end");
		if with_bash {
			let args = serde_json::value::to_raw_value(&serde_json::json!({"command":"cargo test"}))
				.expect("args");
			let call = session
				.call("bash", 1, "call-1", Some("run tests".into()), Some(args), None)
				.expect("call");
			let outcome =
				serde_json::value::to_raw_value(&serde_json::json!({"output":"ok"})).expect("outcome");
			session.settle(call, outcome).expect("settle");
		}
		session
	}

	fn insert_mixed_part(
		session: &mut Session,
		assistant: omp_dom::Handle,
		index: i64,
		kind: &str,
		text: &str,
	) {
		let node = (if kind == "artifact" {
			NodeSpec::new(Tag::Custom(Str::new_static("artifact")))
				.with_prop(PropId::Blob, Value::Str(Str::new(text)))
				.with_prop(PropId::Mime, Value::Str(Str::new_static("image/png")))
				.with_prop(PropId::Kind, Value::Str(Str::new_static("image")))
		} else {
			NodeSpec::new(Tag::Custom(Str::new_static(ASSISTANT_CONTENT_TAG)))
				.with_prop(PropId::Kind, Value::Str(Str::new(kind)))
				.with_prop(PropId::Text, Value::Str(Str::new(text)))
		})
		.with_prop(PropKey::Custom(Str::new_static(PROVIDER_BLOCK_INDEX_PROP)), Value::Int(index));
		session
			.patch(Txn {
				cause: session.head().expect("head"),
				label: None,
				ops:   vec![Op::Ins {
					parent: assistant,
					after: session.dom().children(assistant).last().copied(),
					node,
				}],
			})
			.expect("mixed part");
	}

	#[test]
	fn authored_user_preview_and_copy_survive_hidden_tool_activity() {
		let directory = tempfile::tempdir().expect("temp directory");
		let mut session =
			Session::create(directory.path().join("authored-copy.oms"), ComponentRegistry::standard())
				.expect("session");
		session.begin_turn().expect("turn");
		let attachment = |byte: u8, size: u64| omp_journal::data::Attachment {
			blob: omp_journal::blob::BlobRef { hash: omp_core::Hash32::new([byte; 32]), size },
			mime: Str::new_static("image/png"),
		};
		session
			.user_authored("show me main", vec![attachment(1, 64), attachment(2, 2_048)], "Ada")
			.expect("authored user");

		let mut panel = CopySelector::open(session.dom(), true, false, false, &UiContext::default());
		let text = frame_text(panel.frame(Size { width: 80, height: 24 }));
		assert!(text.contains("«Ada» ›"), "copy preview retains author identity:\n{text}");
		assert!(text.contains("show me main"), "copy preview retains Markdown body:\n{text}");
		let first = text.find("#1 · 64B").expect("first attachment");
		let second = text.find("#2 · 2.0KB").expect("second attachment");
		assert!(first < second, "copy preview retains attachment order:\n{text}");
		assert_eq!(
			panel.key(Key::Enter),
			PanelEvent::Copy(Str::new_static("show me main")),
			"clipboard content remains the user-authored body"
		);
	}

	#[test]
	fn right_descends_into_the_code_block_and_enter_copies_it() {
		let session = session(false);
		let mut panel = CopySelector::open(session.dom(), true, true, true, &UiContext::default());
		assert_eq!(panel.id(), "copy");
		assert_eq!(panel.target_count(), 2);
		let text = frame_text(panel.frame(Size { width: 80, height: 24 }));
		assert!(text.contains("pick what to put on the"), "header missing:\n{text}");
		assert!(text.contains("clipboard"), "wrapped header tail missing:\n{text}");
		assert!(
			text.contains("2/2  ↑/↓ step  → blocks  enter copy  ctrl+o expand  esc close"),
			"hint:\n{text}"
		);
		assert_eq!(panel.key(Key::Right), PanelEvent::Consumed);
		let text = frame_text(panel.frame(Size { width: 80, height: 24 }));
		assert!(text.contains("1/1 · rust code · 3 lines"), "block caption missing:\n{text}");
		assert!(text.contains("1/1  ↑/↓ block  ←/esc back  enter copy"), "block hint:\n{text}");
		assert_eq!(panel.key(Key::Enter), PanelEvent::Copy(Str::new_static(FENCE)));
		assert_eq!(panel.next_wake(), Some(Duration::ZERO));
		assert!(panel.tick(Duration::from_millis(1)));
		assert_eq!(panel.settled(), Some(PanelEvent::Close));
	}

	#[test]
	fn click_selects_a_message_and_wheel_scrolls_the_copy_viewport() {
		let session = session(false);
		let mut panel = CopySelector::open(session.dom(), true, true, true, &UiContext::default());
		let full = Size { width: 80, height: 24 };
		let text = frame_text(panel.frame(full));
		let (col, row) = point(&text, "show me main");
		assert_eq!(
			panel.mouse(mouse(Mouse::Click, col, row, MouseButton::Left)),
			PanelEvent::Consumed
		);
		assert_eq!(panel.selected, 0);
		assert!(panel.hint().starts_with("1/2"), "clicked message must become the selection");

		let mut panel = CopySelector::open(session.dom(), true, true, true, &UiContext::default());
		let size = Size { width: 80, height: 8 };
		let before = frame_text(panel.frame(size));
		let (col, row) = point(&before, "show me main");
		assert_eq!(
			panel.mouse(mouse(Mouse::WheelDown, col, row, MouseButton::WheelDown)),
			PanelEvent::Consumed
		);
		let after = frame_text(panel.frame(size));
		assert_ne!(after, before, "wheel must move the transcript viewport");
	}

	#[test]
	fn copy_preview_keeps_mixed_assistant_parts_interleaved() {
		let directory = tempfile::tempdir().expect("temp directory");
		let mut session =
			Session::create(directory.path().join("mixed-copy.oms"), ComponentRegistry::standard())
				.expect("session");
		session.begin_turn().expect("turn");
		session.user("show the sequence", Vec::new()).expect("user");
		session
			.assistant_start("test/model", "test", "test/model")
			.expect("assistant");
		let turn = *session
			.dom()
			.children(session.dom().body())
			.last()
			.expect("turn");
		let assistant = *session.dom().children(turn).last().expect("assistant");
		insert_mixed_part(&mut session, assistant, 0, "text", "before");
		insert_mixed_part(
			&mut session,
			assistant,
			1,
			"artifact",
			"artifact://sha256/0101010101010101010101010101010101010101010101010101010101010101",
		);
		insert_mixed_part(&mut session, assistant, 2, "text", "after");
		insert_mixed_part(&mut session, assistant, 3, "thinking", "first thought");
		insert_mixed_part(
			&mut session,
			assistant,
			4,
			"artifact",
			"artifact://sha256/0202020202020202020202020202020202020202020202020202020202020202",
		);
		insert_mixed_part(&mut session, assistant, 5, "thinking", "second thought");
		insert_mixed_part(
			&mut session,
			assistant,
			6,
			"artifact",
			"artifact://sha256/0303030303030303030303030303030303030303030303030303030303030303",
		);

		let targets = collect_targets(session.dom(), true, true, false);
		let target = targets.last().expect("assistant target");
		assert_eq!(target.content, "beforeafter", "whole-message copy keeps the text contract");
		let order = target
			.segments
			.iter()
			.map(|segment| match segment {
				Segment::Assistant(text) => sf!("text:{text}"),
				Segment::Thinking(text) => sf!("thinking:{text}"),
				Segment::Artifact { uri, .. } => sf!("artifact:{uri}"),
				other => panic!("unexpected segment: {other:?}"),
			})
			.collect::<Vec<_>>();
		assert_eq!(order, [
			"text:before",
			"artifact:artifact://sha256/\
			 0101010101010101010101010101010101010101010101010101010101010101",
			"text:after",
			"thinking:first thought",
			"artifact:artifact://sha256/\
			 0202020202020202020202020202020202020202020202020202020202020202",
			"thinking:second thought",
			"artifact:artifact://sha256/\
			 0303030303030303030303030303030303030303030303030303030303030303",
		]);
	}

	#[test]
	fn whole_message_copy_and_escape_ladder() {
		let session = session(true);
		let mut panel = CopySelector::open(session.dom(), true, true, true, &UiContext::default());
		assert_eq!(panel.key(Key::Up), PanelEvent::Consumed);
		assert_eq!(panel.key(Key::Enter), PanelEvent::Copy(Str::new_static("show me main")));
		let mut panel = CopySelector::open(session.dom(), true, true, true, &UiContext::default());
		assert_eq!(panel.key(Key::Right), PanelEvent::Consumed);
		assert_eq!(panel.key(Key::Esc), PanelEvent::Consumed);
		assert_eq!(panel.key(Key::Esc), PanelEvent::Close);
		let blocks = &panel.targets[1].blocks;
		assert_eq!(blocks.len(), 3, "{blocks:?}");
		assert_eq!(blocks[1].label, "bash command");
		assert_eq!(blocks[1].content, "cargo test");
		assert_eq!(blocks[2].label, "bash result");
		assert_eq!(blocks[2].content, "ok");
	}

	#[test]
	fn last_code_block_and_last_command_scan_the_transcript() {
		let with = session(true);
		let block = last_code_block(with.dom()).expect("code block");
		assert_eq!(block.content, FENCE);
		assert_eq!(block.language.as_deref(), Some("rust"));
		let (kind, code) = last_command(with.dom()).expect("command");
		assert_eq!(kind, CommandKind::Bash);
		assert_eq!(code, "cargo test");
		let without = session(false);
		assert_eq!(last_command(without.dom()), None);
	}

	/// `cells: [{code}]` joins the non-empty bodies
	/// with a blank line and names the first cell's language; a bare `code`
	/// argument is one cell.
	#[test]
	fn eval_command_reads_code_from_cells_and_from_a_single_code_argument() {
		let cells = serde_json::json!({
			"cells": [
				{"language": "js", "code": "const a = 1;"},
				{"code": ""},
				{"language": "py", "code": "print(a)"}
			]
		});
		assert_eq!(
			eval_code(&cells),
			Some((Str::new_static("const a = 1;\n\nprint(a)"), Str::new_static("javascript")))
		);
		let single = serde_json::json!({"language": "py", "code": "x = 1"});
		assert_eq!(eval_code(&single), Some((Str::new_static("x = 1"), Str::new_static("python"))));
		assert_eq!(eval_code(&serde_json::json!({"cells": [{"code": ""}]})), None);
		assert_eq!(eval_code(&serde_json::json!({"language": "py"})), None);
	}

	/// Links follow a message's
	/// code and quote blocks, labeled `link · text` (or `link` for a bare
	/// URL) with the destination as content; a link block's hint offers `o`,
	/// which reports the opening and closes the picker, while `o` on a
	/// non-link block is inert.
	#[test]
	fn links_follow_the_blocks_and_o_opens_the_selected_one() {
		let mut session = session(false);
		session.begin_turn().expect("turn");
		session.user("where?", Vec::new()).expect("user");
		session
			.assistant_start("test/model", "test", "test/model")
			.expect("assistant");
		let turn = *session
			.dom()
			.children(session.dom().body())
			.last()
			.expect("turn");
		let assistant = *session.dom().children(turn).last().expect("assistant");
		let text = session
			.stream_open(assistant, PropId::Text.into())
			.expect("text stream");
		session
			.stream_append(
				text,
				"> quoted\n\nSee [the docs](https://example.com/docs) or https://plain.example/.",
			)
			.expect("text");
		session.stream_close(text).expect("close");
		session.assistant_end("stop").expect("end");

		let mut panel = CopySelector::open(session.dom(), true, true, true, &UiContext::default());
		panel.opener = record;
		let blocks = &panel.targets.last().expect("assistant target").blocks;
		assert_eq!(
			blocks
				.iter()
				.map(|block| (block.label.as_str(), block.content.as_str(), block.href.as_deref()))
				.collect::<Vec<_>>(),
			[
				("quote", "quoted", None),
				("link · the docs", "https://example.com/docs", Some("https://example.com/docs")),
				("link", "https://plain.example/", Some("https://plain.example/")),
			]
		);
		assert_eq!(panel.key(Key::Right), PanelEvent::Consumed);
		assert!(!panel.hint().contains("o open"), "a quote block offers no opener: {}", panel.hint());
		assert_eq!(panel.key(Key::Char('o')), PanelEvent::Consumed);
		assert!(!panel.tick(Duration::ZERO), "`o` on a quote block does not close");
		assert_eq!(panel.key(Key::Down), PanelEvent::Consumed);
		assert!(panel.hint().ends_with("enter copy  o open"), "{}", panel.hint());
		let text = frame_text(panel.frame(Size { width: 80, height: 24 }));
		assert!(text.contains("2/3 · link · the docs · 1 line"), "{text}");
		assert_eq!(
			panel.key(Key::Enter),
			PanelEvent::Copy(Str::new_static("https://example.com/docs"))
		);

		static OPENED: parking_lot::Mutex<Vec<String>> = parking_lot::Mutex::new(Vec::new());
		fn record(href: &str) {
			OPENED.lock().push(href.to_owned());
		}
		let mut panel = CopySelector::open(session.dom(), true, true, true, &UiContext::default());
		panel.opener = record;
		assert_eq!(panel.key(Key::Right), PanelEvent::Consumed);
		assert_eq!(panel.key(Key::Char('o')), PanelEvent::Consumed);
		assert_eq!(panel.key(Key::Down), PanelEvent::Consumed);
		assert_eq!(panel.key(Key::Down), PanelEvent::Consumed);
		assert_eq!(
			panel.key(Key::Char('O')),
			PanelEvent::Notice(Str::new_static("Opening link: https://plain.example/"))
		);
		assert_eq!(
			*OPENED.lock(),
			["https://plain.example/"],
			"only the link block reached the opener"
		);
		assert!(panel.tick(Duration::ZERO), "opening closes the picker through `settled`");
		assert_eq!(panel.settled(), Some(PanelEvent::Close));

		assert_eq!(
			crate::markdown::last_link(session.dom()).map(|link| link.href),
			Some(Str::new_static("https://plain.example/"))
		);
	}

	/// Compaction and branch summaries use `summary`; custom advisor, late
	/// diagnostics, and `/tan` notices use `message`. Every
	/// displayed transcript entry is an outline target the picker can reach
	/// and copy, in transcript order (the divider lands after its turn).
	#[test]
	fn typed_advisor_copy_preserves_every_note_and_attribution() {
		let message = omp_journal::data::AdvisorMessage {
			notes: vec![
				omp_journal::data::AdvisorNote {
					advisor:  Str::new_static("security"),
					severity: omp_journal::data::AdvisorSeverity::Blocker,
					note:     Str::new_static("Do not expose the token."),
				},
				omp_journal::data::AdvisorNote {
					advisor:  Str::new_static("performance"),
					severity: omp_journal::data::AdvisorSeverity::Concern,
					note:     Str::new_static("Keep append cost linear."),
				},
			],
		};
		let node = Node {
			tag:     Tag::Known(KnownTag::Notice),
			props:   smallvec![
				(PropId::Kind.into(), Value::Str(Str::new_static("advisor"))),
				(
					PropId::Data.into(),
					Value::Json(
						serde_json::value::to_raw_value(&message).expect("advisor payload serializes"),
					),
				),
			],
			kids:    Vec::new(),
			content: Some(Str::new_static("fallback")),
		};
		let (title, body) = notice_copy("advisor", &node).expect("advisor is copyable");
		assert_eq!(title, "Advisor · 2 notes · 1 blocker");
		assert_eq!(
			body,
			"[blocker] [security] Do not expose the token.\n[concern] [performance] Keep append cost \
			 linear."
		);
	}

	#[test]
	fn summary_dividers_and_custom_notices_are_copy_targets() {
		use omp_dom::{NodeSpec, Op, Txn};
		use omp_journal::{blob::BlobStore, data::Compaction};

		let directory = tempfile::tempdir().expect("temp directory");
		let store = BlobStore::open(directory.path()).expect("blob store");
		let summary = store
			.put(b"Earlier: wired the parser.")
			.expect("summary blob");
		let mut session =
			Session::create(directory.path().join("copy.oms"), ComponentRegistry::standard())
				.expect("session");
		session.begin_turn().expect("turn one");
		session.user("first", Vec::new()).expect("user one");
		let boundary = session
			.receipt(omp_journal::data::TurnReceipt::tokens(12, 7, 0))
			.expect("receipt");
		session.begin_turn().expect("turn two");
		session.user("second", Vec::new()).expect("user two");
		session
			.compaction(Compaction {
				summary,
				boundary,
				method: Some(Str::new_static("remote")),
				tokens_before: Some(256_000),
				tokens_after: Some(20_000),
				warning: None,
				frames: Vec::new(),
			})
			.expect("compaction");
		let mut notice = |kind: &'static str, props: &[(PropId, &str)], content: Option<&str>| {
			let turn = *session
				.dom()
				.children(session.dom().body())
				.last()
				.expect("turn");
			let mut node = NodeSpec::new(KnownTag::Notice)
				.with_prop(PropId::Kind, Value::Str(Str::new_static(kind)));
			for (prop, value) in props {
				node = node.with_prop(*prop, Value::Str(Str::new(*value)));
			}
			if let Some(content) = content {
				node = node.with_content(Str::new(content));
			}
			session
				.patch(Txn {
					cause: session.head().expect("head"),
					label: Some(Str::new_static("kernel.notice")),
					ops:   vec![Op::Ins {
						parent: turn,
						after: session.dom().children(turn).last().copied(),
						node,
					}],
				})
				.expect("notice");
		};
		notice(
			"advisor",
			&[(PropId::Severity, "concern"), (PropId::Label, "Tests are missing")],
			Some("The parser change has no coverage.\nSee [the plan](https://example.com/plan)."),
		);
		notice(
			"diagnostics",
			&[(PropId::Name, "rust-analyzer")],
			Some("src/lib.rs:3:5 [error] unused variable"),
		);
		notice("tangent", &[(PropId::Id, "tan-1"), (PropId::Label, "check the docs")], None);
		notice("info", &[], Some("controller chatter the picker never lists"));

		let targets = collect_targets(session.dom(), false, true, true);
		let labels = targets
			.iter()
			.map(|target| target.label.as_str())
			.collect::<Vec<_>>();
		assert_eq!(
			labels,
			["user message", "summary", "user message", "message", "message", "message"],
			"{targets:#?}"
		);
		assert_eq!(targets[1].content, "Earlier: wired the parser.", "raw summary text");
		assert!(targets[1].blocks.is_empty());
		assert_eq!(
			targets[3].content,
			"[concern] Tests are missing\nThe parser change has no coverage.\nSee [the \
			 plan](https://example.com/plan)."
		);
		assert_eq!(
			targets[3]
				.blocks
				.iter()
				.filter_map(|block| block.href.as_deref())
				.collect::<Vec<_>>(),
			["https://example.com/plan"],
			"links in a note stay reachable through the picker and /copy link"
		);
		assert_eq!(targets[4].content, "src/lib.rs:3:5 [error] unused variable");
		assert_eq!(targets[5].content, "Tangent dispatched [task] tan-1 — check the docs");

		let mut picker = CopySelector::open(session.dom(), false, true, true, &UiContext::default());
		for _ in 0..4 {
			assert_eq!(picker.key(Key::Up), PanelEvent::Consumed);
		}
		let text = frame_text(picker.frame(Size::new(80, 40)));
		assert!(text.contains("remote-compacted · 256K→20K"), "the divider is previewed:\n{text}");
		assert!(
			text.contains("Earlier: wired the parser."),
			"expanded so its summary shows:\n{text}"
		);
		assert_eq!(
			picker.key(Key::Enter),
			PanelEvent::Copy(Str::new_static("Earlier: wired the parser.")),
			"enter copies the outlined summary"
		);
	}

	#[test]
	fn normalized_legacy_handoff_is_copied_as_a_handoff_summary() {
		use omp_dom::{NodeSpec, Op, PropKey, Txn};

		let directory = tempfile::tempdir().expect("temp directory");
		let mut session =
			Session::create(directory.path().join("handoff.oms"), ComponentRegistry::standard())
				.expect("session");
		session.begin_turn().expect("turn starts");
		session
			.user("old context", Vec::new())
			.expect("user appends");
		let turn = *session
			.dom()
			.children(session.dom().body())
			.last()
			.expect("turn");
		session
			.patch(Txn {
				cause: session.head().expect("head"),
				label: Some(Str::new_static("legacy.custom-message")),
				ops:   vec![Op::Ins {
					parent: turn,
					after:  session.dom().children(turn).last().copied(),
					node:   NodeSpec::new(KnownTag::Developer)
						.with_prop(PropId::Kind, Value::Str(Str::new_static("custom")))
						.with_prop(PropId::Name, Value::Str(Str::new_static("handoff")))
						.with_prop(
							PropKey::Custom(Str::new_static(omp_session::custom_message::DISPLAY_PROP)),
							Value::Bool(true),
						)
						.with_content(
							"preamble<handoff-context>\n# Goal\nKeep the \
							 branch.\n</handoff-context>trailer",
						),
				}],
			})
			.expect("legacy handoff appends");

		let targets = collect_targets(session.dom(), false, true, true);
		let handoff = targets.last().expect("handoff target");
		assert_eq!(handoff.label, "summary");
		assert_eq!(handoff.content, "# Goal\nKeep the branch.");
		let Segment::Summary(divider) = &handoff.segments[0] else {
			panic!("handoff projects through the ordinary summary segment");
		};
		assert_eq!(divider.label, "handed-off");
		assert_eq!(divider.detail, "**Handoff context**\n\n# Goal\nKeep the branch.");
	}

	/// An unclosed fence is ordinary text — no phantom
	/// code block, and a `>` line after it is still a quote.
	#[test]
	fn unclosed_fence_is_ordinary_text() {
		let mut blocks = Vec::new();
		push_markdown_blocks(&mut blocks, "Run this:\n```sh\necho pong\n> quoted after");
		assert_eq!(
			blocks
				.iter()
				.map(|block| (block.label.as_str(), block.content.as_str()))
				.collect::<Vec<_>>(),
			[("quote", "quoted after")]
		);
		let mut blocks = Vec::new();
		push_markdown_blocks(&mut blocks, "```py\nx = 1\n```\n```\nnever closed");
		assert_eq!(
			blocks.len(),
			1,
			"a closed fence still extracts; the open tail does not: {blocks:?}"
		);
		assert_eq!(blocks[0].content, "x = 1");
	}

	#[test]
	fn markdown_blocks_extract_fences_and_quotes_in_order() {
		let mut blocks = Vec::new();
		push_markdown_blocks(&mut blocks, "> quoted\n> lines\n\n```\nplain\n```\n```py\nx = 1\n```");
		assert_eq!(
			blocks
				.iter()
				.map(|block| block.label.as_str())
				.collect::<Vec<_>>(),
			["quote", "code", "py code"]
		);
		assert_eq!(blocks[0].content, "quoted\nlines");
		assert_eq!(blocks[1].content, "plain");
		assert_eq!(blocks[2].content, "x = 1");
	}
}
