//! Pure projection from an actor-owned session DOM replica to transcript
//! blocks.

use omp_core::{Str, StrMut, sf};
use omp_dom::{Dom, Handle, KnownTag, Node, PropId, PropKey, Tag, Value};
use omp_journal::data::Attachment;
use omp_session::{ASSISTANT_CONTENT_TAG, PROVIDER_BLOCK_INDEX_PROP};
use omp_tui::{Charset, Icon, IntoComponent, UiContext, dom, slots::Mode};
use smallvec::SmallVec;

use crate::{
	cards::{CardRegistry, CardStatus, CardView, Component, result_image},
	notices::{
		cache, custom, divider, error, file_mentions, irc, local, misc, session_exit, skill, update,
		usage,
	},
	reaction, thinking,
	transcript::{Banner, Local, REVEAL_HORIZON, StreamHead, UpdateBanner},
};

/// Semantic transcript block class.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BlockKind {
	/// Host-owned welcome banner shown before the first turn.
	Welcome,
	/// User-authored message.
	User,
	/// Assistant reasoning, controlled by the observer-local reveal setting.
	Thinking,
	/// Visible assistant answer.
	Assistant,
	/// User-local `!` or `$` execution, never a model tool card.
	Local,
	/// Tool element rendered by the card registry.
	Tool,
	/// Controller notice.
	Notice,
	/// Turn receipt.
	Usage,
	/// Maintenance divider: compaction, handoff, branch summary, or a
	/// prompt-cache miss marker.
	Divider,
}

/// Test- and status-facing description of one projected block.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BlockView {
	/// Stable observer-local identity derived from the DOM handle and block
	/// kind.
	pub key:       u64,
	/// Semantic block class.
	pub kind:      BlockKind,
	/// Plain semantic text represented by this block.
	pub text:      Str,
	/// Slot update mode.
	pub mode:      Mode,
	/// Whether the block may retire into history.
	pub finalized: bool,
}

/// One rendered block ready for admission to the slot engine.
pub(crate) struct RenderedBlock {
	pub view:      BlockView,
	pub component: Component,
	/// Streamed text owned by the component's [`omp_tui::slots::STREAM_ID`]
	/// child. A later projection whose stream extends this one is applied in
	/// place, keeping the reveal cursor and animation phase.
	pub stream:    Option<Str>,
}

/// Observer-local switches the projection reads (never DOM state).
#[derive(Clone, Copy)]
pub struct Options<'a> {
	/// Reveal reasoning text (`cl_showthinking`).
	pub show_thinking: bool,
	/// Reveal model-initiated tool activity and its delivery notices
	/// (`cl_showtools`).
	pub show_tools:    bool,
	/// Expand tool cards (`cl_tools_expanded`).
	pub expanded:      bool,
	/// Type streamed text out at the reveal cadence (`cl_smooth_streaming`).
	pub smooth:        bool,
	/// Collapse fenced code in reasoning to an ellipsis
	/// (`cl_thinking_prose_only`).
	pub prose_only:    bool,
	/// Show token and timing telemetry (`cl_display_show_token_usage` /
	/// `cl_display_show_turn_time`).
	pub show_usage:    bool,
	/// Tool start instants, speed gauge, and reset banner.
	pub local:         &'a Local,
}

impl<'a> Options<'a> {
	///  defaults: thinking shown, cards collapsed, smooth streaming and
	/// prose-only reasoning on.
	#[must_use]
	pub const fn new(local: &'a Local) -> Self {
		Self {
			show_thinking: true,
			show_tools: true,
			expanded: false,
			smooth: true,
			prose_only: true,
			show_usage: false,
			local,
		}
	}
}

/// Projects descriptors without constructing terminal components.
#[must_use]
pub fn block_views(dom: &Dom, show_thinking: bool) -> Vec<BlockView> {
	let local = Local::default();
	let options = Options { show_thinking, ..Options::new(&local) };
	project(dom, &CardRegistry::standard(), &UiContext::default(), &options)
		.into_iter()
		.map(|block| block.view)
		.collect()
}

pub(crate) fn project(
	dom: &Dom,
	cards: &CardRegistry,
	ui: &UiContext,
	options: &Options<'_>,
) -> Vec<RenderedBlock> {
	let mut blocks = Vec::new();
	if let Some(banner) = options.local.banner() {
		blocks.push(banner_block(banner));
	}
	if let Some(update) = options.local.update() {
		blocks.push(update_block(update, options.expanded));
	}
	let turns = dom.children(dom.body());
	let cache_misses = cache::cache_invalidations(dom);
	// `pickReactionTarget`: the nearest preceding user bubble, looking
	// past notices and tool cards but never past an earlier reply.
	let mut reaction_target: Option<ReactionTarget> = None;
	for (index, turn) in turns.iter().enumerate() {
		let Some(turn_node) = dom.get(*turn) else {
			continue;
		};
		if turn_node.tag != Tag::Known(KnownTag::Turn) {
			continue;
		}
		let start = blocks.len();
		let last_turn = index + 1 == turns.len();
		let mut interleaved_tools = Vec::new();
		for handle in dom.children(*turn) {
			let Some(node) = dom.get(*handle) else {
				continue;
			};
			match &node.tag {
				Tag::Known(KnownTag::User) => {
					if let Some(mentions) = file_mentions::payload(node) {
						let text = file_mentions::text(&mentions);
						let component = file_mentions::block(&mentions);
						blocks.push(rendered(
							*handle,
							BlockKind::Notice,
							text,
							Mode::Mutable,
							true,
							component,
						));
						continue;
					}
					if let Some(prompt) = skill::prompt(node) {
						reaction_target = None;
						let text = skill::prompt_text(&prompt);
						let component = skill::prompt_card(&prompt, options.expanded);
						blocks.push(rendered(
							*handle,
							BlockKind::Notice,
							text,
							Mode::Mutable,
							true,
							component,
						));
						continue;
					}
					if let Some(completion) = misc::launch_completion(node) {
						reaction_target = None;
						if options.show_tools {
							let text = misc::launch_completion_text(&completion);
							let component = misc::launch_completion_block(&completion);
							blocks.push(rendered(
								*handle,
								BlockKind::Notice,
								text,
								Mode::Mutable,
								true,
								component,
							));
						}
						continue;
					}
					if let Some(result) = misc::async_result(node) {
						reaction_target = None;
						if options.show_tools {
							let text = misc::async_result_text(&result);
							let component = misc::async_result_block(&result);
							blocks.push(rendered(
								*handle,
								BlockKind::Notice,
								text,
								Mode::Mutable,
								true,
								component,
							));
						}
						continue;
					}
					let raw = node.content.clone().unwrap_or_default();
					// Display-only collapse before any branch: guest and synthetic
					// rows show the same chips as the plain bubble.
					let text = collapse_image_markers(&raw, ui.charset);
					let chips = attachment_chips(node, raw.as_str(), ui.charset);
					let component: Component = if crate::notices::prop_bool(node, PropId::Synthetic) {
						reaction_target = None;
						with_attachments(misc::synthetic_row(text.as_str(), options.expanded), &chips)
					} else if let Some(author) = crate::notices::prop_text(node, PropId::Author) {
						reaction_target = None;
						with_attachments(misc::guest_bubble(author.as_str(), text.clone()), &chips)
					} else {
						reaction_target = Some(ReactionTarget {
							key:   block_key(*handle, BlockKind::User),
							text:  text.clone(),
							chips: chips.clone(),
						});
						user_bubble(text, None, &chips)
					};
					blocks.push(rendered(*handle, BlockKind::User, raw, Mode::Mutable, true, component));
				},
				Tag::Known(KnownTag::Assistant) => {
					let ordered_start = blocks.len();
					assistant_blocks(dom, *handle, node, ui, options, &mut blocks, &mut reaction_target);
					let siblings = dom.children(*turn);
					let Some(position) = siblings.iter().position(|candidate| candidate == handle)
					else {
						continue;
					};
					for tool_handle in siblings.iter().skip(position + 1) {
						let Some(tool_node) = dom.get(*tool_handle) else {
							continue;
						};
						if tool_node.tag == Tag::Known(KnownTag::Assistant) {
							break;
						}
						let Tag::Custom(tool) = &tool_node.tag else {
							continue;
						};
						if provider_block_index_opt(tool_node).is_none() {
							continue;
						}
						interleaved_tools.push(*tool_handle);
						let block = if local::is_local(tool_node) {
							local_block(dom, *tool_handle, tool_node, options)
						} else if options.show_tools {
							tool_block(dom, *tool_handle, tool_node, tool, cards, ui, options)
						} else {
							None
						};
						if let Some(block) = block {
							blocks.push(block);
						}
					}
					blocks[ordered_start..].sort_by_key(|block| {
						Handle::new(block.view.key / 8)
							.and_then(|handle| dom.get(handle))
							.and_then(provider_block_index_opt)
							.unwrap_or(i64::MAX)
					});
				},
				Tag::Known(KnownTag::Developer) => {
					if prop_text(node, PropId::Kind).as_deref()
						== Some(omp_session::late_diagnostics::KIND)
					{
						reaction_target = None;
						let text = node.content.clone().unwrap_or_default();
						blocks.push(rendered(
							*handle,
							BlockKind::Notice,
							text,
							Mode::Mutable,
							true,
							misc::diagnostics_card(node, options.expanded),
						));
					} else if let Some(block) = custom_message_block(*handle, node, ui, options) {
						reaction_target = None;
						blocks.push(block);
					}
				},
				Tag::Known(KnownTag::Notice) => {
					if let Some(traffic) = irc::traffic(node) {
						reaction_target = None;
						if options.show_tools {
							let text = irc::traffic_text(&traffic);
							let component = irc::traffic_card(&traffic, options.expanded);
							blocks.push(rendered(
								*handle,
								BlockKind::Notice,
								text,
								Mode::Mutable,
								true,
								component,
							));
						}
						continue;
					}
					let kind = prop_text(node, PropId::Kind).unwrap_or_else(|| Str::new_static("info"));
					// Older journals stored custom messages as notices. They use
					// the same visibility, replacement, and fallback projection.
					if custom::message_kind(node).is_some() {
						if let Some(block) = custom_message_block(*handle, node, ui, options) {
							blocks.push(block);
						}
						continue;
					}
					let text = if kind == "advisor" {
						misc::advisor_message(node)
							.map(|message| misc::advisor_message_text(&message))
							.unwrap_or_default()
					} else {
						node.content.clone().unwrap_or_default()
					};
					// ERR-06: while the identical error is pinned above the editor the
					// inline copy is suppressed; ctrl+o draws it in full anyway.
					if !options.expanded && error::suppressed_inline(dom, *handle) {
						continue;
					}
					let component = misc::custom_notice(kind.as_str(), node, options.expanded)
						.unwrap_or_else(|| {
							error::notice_card(kind.as_str(), text.clone(), options.expanded)
						});
					blocks.push(rendered(
						*handle,
						BlockKind::Notice,
						text,
						Mode::Mutable,
						true,
						component,
					));
				},
				Tag::Known(KnownTag::Usage) => {
					if !options.show_usage {
						continue;
					}
					if node.prop(&PropId::Kind.into()).and_then(Value::as_str) == Some("advisor") {
						continue;
					}
					let facts = usage::usage_facts(dom, *handle);
					let text = usage::usage_line(&facts, ui);
					blocks.push(rendered(
						*handle,
						BlockKind::Usage,
						text,
						Mode::Mutable,
						true,
						usage::usage_block(&facts, ui),
					));
					// CSH-01: the cache-miss marker trails the turn whose request
					// lost the prompt cache.
					if let Some((_, miss)) = cache_misses.iter().find(|(usage, _)| usage == handle) {
						blocks.push(rendered(
							*handle,
							BlockKind::Divider,
							Str::new(format!("cache miss · {} tokens", miss.reprocessed_tokens)),
							Mode::Mutable,
							true,
							cache::cache_miss_marker(miss),
						));
					}
				},
				Tag::Custom(tool) => {
					if interleaved_tools.contains(handle) {
						continue;
					}
					let block = if local::is_local(node) {
						local_block(dom, *handle, node, options)
					} else if options.show_tools {
						tool_block(dom, *handle, node, tool, cards, ui, options)
					} else {
						None
					};
					if let Some(block) = block {
						blocks.push(block);
					}
				},
				_ => {},
			}
		}
		displace_cards(dom, &mut blocks, start, last_turn);
		group_reads(dom, cards, ui, options, &mut blocks, start);
		// CMP-01..06: maintenance dividers land after the turn holding their
		// boundary entry.
		for (compaction, component) in divider::compaction_dividers(dom, *turn, options.expanded) {
			let label = dom
				.get(compaction)
				.map(|node| divider::SummaryDivider::compaction(node, options.expanded).label)
				.unwrap_or_default();
			blocks.push(rendered(
				compaction,
				BlockKind::Divider,
				label,
				Mode::Mutable,
				true,
				component,
			));
		}
	}
	if let Some((handle, exit)) = omp_session::latest_session_exit(dom)
		&& let (Some(text), Some(component)) = (session_exit::text(&exit), session_exit::block(&exit))
	{
		blocks.push(rendered(handle, BlockKind::Notice, text, Mode::Mutable, true, component));
	}
	blocks
}

fn custom_message_block(
	handle: Handle,
	node: &Node,
	ui: &UiContext,
	options: &Options<'_>,
) -> Option<RenderedBlock> {
	let kind = custom::message_kind(node)?;
	if !custom::displayed(node) {
		return None;
	}
	Some(rendered(
		handle,
		BlockKind::Notice,
		custom::framed_text(node),
		Mode::Mutable,
		true,
		custom::custom_message_card(kind, node, options.expanded, ui),
	))
}

/// One assistant content-array entry retained in provider order.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum AssistantPart {
	/// Visible answer prose.
	Text { handle: Handle, text: Str },
	/// Model reasoning prose.
	Thinking { handle: Handle, text: Str },
	/// Provider artifact stored by URI.
	Artifact { handle: Handle, uri: Str, mime: Str, kind: Str },
}

/// Reads ordered assistant content children. Sessions written before the
/// ordered-child contract retain their historical thinking → text → artifact
/// projection.
pub(crate) fn assistant_parts(
	dom: &Dom,
	assistant: Handle,
	node: &Node,
) -> SmallVec<AssistantPart, 8> {
	let children = dom.children(assistant);
	let ordered = children
		.iter()
		.any(|handle| dom.get(*handle).is_some_and(is_assistant_content));
	let mut parts = SmallVec::new();
	if !ordered {
		if let Some(text) = live_text(dom, assistant, node, PropId::Thinking) {
			parts.push(AssistantPart::Thinking { handle: assistant, text });
		}
		if let Some(text) = live_text(dom, assistant, node, PropId::Text) {
			parts.push(AssistantPart::Text { handle: assistant, text });
		}
	}
	let mut content = SmallVec::<(i64, usize, Handle), 8>::new();
	for (position, handle) in children.iter().enumerate() {
		let Some(child) = dom.get(*handle) else {
			continue;
		};
		if ordered && is_assistant_content(child) || is_artifact(child) {
			content.push((provider_block_index(child), position, *handle));
		}
	}
	content.sort_by_key(|(index, position, _)| (*index, *position));
	for (_, _, handle) in content {
		let Some(child) = dom.get(handle) else {
			continue;
		};
		if is_assistant_content(child) {
			let Some(text) = live_text(dom, handle, child, PropId::Text) else {
				continue;
			};
			match prop_text(child, PropId::Kind).as_deref() {
				Some("text") => parts.push(AssistantPart::Text { handle, text }),
				Some("thinking") => parts.push(AssistantPart::Thinking { handle, text }),
				_ => {},
			}
		} else {
			let Some(uri) = prop_text(child, PropId::Blob) else {
				continue;
			};
			parts.push(AssistantPart::Artifact {
				handle,
				uri,
				mime: prop_text(child, PropId::Mime)
					.unwrap_or_else(|| Str::new_static("application/octet-stream")),
				kind: prop_text(child, PropId::Kind).unwrap_or_else(|| Str::new_static("file")),
			});
		}
	}
	parts
}

fn is_assistant_content(node: &Node) -> bool {
	matches!(&node.tag, Tag::Custom(tag) if tag.as_str() == ASSISTANT_CONTENT_TAG)
}

fn is_artifact(node: &Node) -> bool {
	matches!(&node.tag, Tag::Custom(tag) if tag.as_str() == "artifact")
}

fn provider_block_index(node: &Node) -> i64 {
	provider_block_index_opt(node).unwrap_or(i64::MAX)
}

fn provider_block_index_opt(node: &Node) -> Option<i64> {
	node
		.prop(&PropKey::Custom(Str::new_static(PROVIDER_BLOCK_INDEX_PROP)))
		.and_then(|value| match value {
			Value::Int(index) => Some(*index),
			_ => None,
		})
}

/// Assistant reasoning, answer, and artifact blocks in exact provider order.
///
/// Every streamed text/thinking child owns its own append-only slot identity.
/// Once a later provider block exists, an earlier stream's projection is final
/// even before the enclosing assistant completes, so its stable rows can
/// retire without a later artifact crossing them.
fn assistant_blocks(
	dom: &Dom,
	handle: Handle,
	node: &Node,
	ui: &UiContext,
	options: &Options<'_>,
	blocks: &mut Vec<RenderedBlock>,
	reaction_target: &mut Option<ReactionTarget>,
) {
	let assistant_finalized = node.prop(&PropId::StopReason.into()).is_some();
	let tool_started = has_tool_calls(dom, handle);
	let ordered = dom
		.children(handle)
		.iter()
		.any(|child| dom.get(*child).is_some_and(is_assistant_content));
	let parts = assistant_parts(dom, handle, node);
	let tail = parts.last();
	let tail_is_thinking = matches!(tail, Some(AssistantPart::Thinking { .. }));
	let mut target = reaction_target.take();
	let mut opening_text_seen = false;
	for (position, part) in parts.iter().enumerate() {
		let is_tail = position + 1 == parts.len();
		match part {
			AssistantPart::Thinking { handle, text: raw } => {
				let thinking = thinking::display_thinking(raw, options.prose_only);
				let thinking = Str::new(thinking.trim());
				if !options.show_thinking || !thinking::is_displayable(raw.as_str(), thinking.as_str())
				{
					continue;
				}
				let finalized = assistant_finalized || !is_tail || tool_started;
				let reveal = options.smooth && !finalized;
				let component = if reveal {
					dom! { <md id={omp_tui::slots::STREAM_ID} reveal={REVEAL_HORIZON_PROP} fg=muted italic pad-x=1>{thinking.clone()}</md> }
				} else {
					dom! { <md id={omp_tui::slots::STREAM_ID} fg=muted italic pad-x=1>{thinking.clone()}</md> }
				};
				let mut block = rendered(
					*handle,
					BlockKind::Thinking,
					thinking.clone(),
					Mode::AppendOnly,
					finalized,
					component,
				);
				block.stream = Some(thinking);
				blocks.push(block);
			},
			AssistantPart::Text { handle, text } => {
				// Leading padding is presentation-only, but the live stream's
				// trailing newline is semantic append state: dropping it makes
				// the next delta replace rows instead of extending their prefix.
				let text = Str::new(text.trim_start());
				if text.is_empty() {
					continue;
				}
				let text = if opening_text_seen {
					text
				} else {
					opening_text_seen = true;
					apply_reaction(&text, assistant_finalized, target.take(), blocks)
				};
				if text.is_empty() {
					continue;
				}
				let finalized = assistant_finalized || !is_tail || tool_started;
				let reveal = options.smooth && !finalized;
				let component = if reveal {
					dom! { <md id={omp_tui::slots::STREAM_ID} reveal={REVEAL_HORIZON_PROP} pad-x=1>{text.clone()}</md> }
				} else {
					dom! { <md id={omp_tui::slots::STREAM_ID} pad-x=1>{text.clone()}</md> }
				};
				let mut block = rendered(
					*handle,
					BlockKind::Assistant,
					text.clone(),
					Mode::AppendOnly,
					finalized,
					component,
				);
				block.stream = Some(text);
				blocks.push(block);
			},
			AssistantPart::Artifact { handle, uri, mime, kind } => {
				let component = if kind.as_str() == "image" || mime.as_str().starts_with("image/") {
					result_image(uri, mime.as_str(), None, ui)
				} else {
					dom! {
						<col pad-x=1>
							<text fg=muted>{sf!("[{}: {}]", kind, mime)}</text>
							<a href={uri.clone()}>{uri.clone()}</a>
						</col>
					}
					.into_component()
				};
				blocks.push(rendered(
					*handle,
					BlockKind::Assistant,
					uri.clone(),
					Mode::Mutable,
					true,
					component,
				));
			},
		}
	}
	if !options.show_thinking
		&& !assistant_finalized
		&& !tool_started
		&& reasoning_is_head(options.local, ordered, tail_is_thinking)
	{
		let local = options.local;
		let pulse = omp_tui::components::Pulse::new()
			.label(" Thinking")
			.count(local.thinking_tokens())
			.gauge(local.gauge().clone(), "toks/s")
			.with(omp_tui::Prop::Fg, "secondary");
		blocks.push(rendered(
			handle,
			BlockKind::Thinking,
			Str::new_static("Thinking"),
			Mode::Mutable,
			false,
			dom! { <row pad-x=1>{pulse}</row> },
		));
	}
}

/// The user bubble a reply may react to: its block
/// key plus the facts needed to redraw it with the badge.
struct ReactionTarget {
	key:   u64,
	text:  Str,
	chips: Vec<Str>,
}

/// `#displayMessage`: the reply's display text with the reaction line
/// handled — stripped and badged onto the target bubble once resolved,
/// withheld entirely while a streaming prefix could still become one, and
/// left verbatim when there is no target. A reply consumes the target
/// either way: a continuation after tool calls has nothing to react to.
fn apply_reaction(
	text: &Str,
	finalized: bool,
	target: Option<ReactionTarget>,
	blocks: &mut [RenderedBlock],
) -> Str {
	let Some(target) = target else {
		return text.clone();
	};
	let split = reaction::split_reaction(text.as_str());
	match split.emoji {
		Some(emoji) => {
			if let Some(block) = blocks
				.iter_mut()
				.rev()
				.find(|block| block.view.key == target.key)
			{
				block.component = user_bubble(target.text, Some(Str::new(emoji)), &target.chips);
			}
			Str::new(split.body)
		},
		None if split.pending && !finalized => Str::default(),
		None => text.clone(),
	}
}

/// `#shouldAnimateThinking`: the pulse shows while the model is reasoning
/// right now — the newest delta was reasoning — so a second reasoning phase
/// after visible text pulses again. Ordered children give replicas the tail
/// kind; legacy live actors use their kernel-event stream head.
fn reasoning_is_head(local: &Local, ordered: bool, tail_is_thinking: bool) -> bool {
	if ordered {
		return tail_is_thinking;
	}
	match local.stream_head() {
		Some(head) => head == StreamHead::Thinking,
		None => tail_is_thinking,
	}
}

/// `reveal` prop spelling of [`REVEAL_HORIZON`].
const REVEAL_HORIZON_PROP: &str = "264ms";
const _: () = assert!(REVEAL_HORIZON.as_millis() == 264);

/// Whether a tool element follows this assistant message in its turn.
fn has_tool_calls(dom: &Dom, assistant: Handle) -> bool {
	let Some(turn) = dom.parent(assistant) else {
		return false;
	};
	let siblings = dom.children(turn);
	let Some(position) = siblings.iter().position(|handle| *handle == assistant) else {
		return false;
	};
	siblings[position + 1..]
		.iter()
		.filter_map(|handle| dom.get(*handle))
		.any(|node| matches!(node.tag, Tag::Custom(_)))
}

/// Observer-local session-lifecycle transcript row.
fn banner_block(banner: &Banner) -> RenderedBlock {
	let component = dom! {
		<row gap=1 pad-x=1 fg=accent><icon name="success"/><text>{banner.text.clone()}</text></row>
	};
	RenderedBlock {
		view:      BlockView {
			key:       banner.key,
			kind:      BlockKind::Notice,
			text:      banner.text.clone(),
			mode:      Mode::Mutable,
			finalized: true,
		},
		component: component.into_component(),
		stream:    None,
	}
}

/// Observer-local typed update-availability card.
fn update_block(update: &UpdateBanner, expanded: bool) -> RenderedBlock {
	RenderedBlock {
		view:      BlockView {
			key:       update.key,
			kind:      BlockKind::Notice,
			text:      update.notice.text(),
			mode:      Mode::Mutable,
			finalized: true,
		},
		component: update::card(&update.notice, expanded),
		stream:    None,
	}
}

/// `displaceableByToolName`: a waiting `hub` poll card is displaced by
/// the next `hub` call, and a `todo` snapshot card by the next `todo` call
/// or the next user prompt, so the transcript keeps one live copy.
fn displace_cards(dom: &Dom, blocks: &mut Vec<RenderedBlock>, start: usize, last_turn: bool) {
	let displaceable = |block: &RenderedBlock| -> Option<&'static str> {
		if block.view.kind != BlockKind::Tool {
			return None;
		}
		let handle = Handle::new(block.view.key / 8)?;
		let node = dom.get(handle)?;
		let Tag::Custom(tool) = &node.tag else {
			return None;
		};
		if matches!(
			node.prop(&PropId::Status.into()).and_then(Value::as_str),
			Some("error" | "cancelled" | "aborted")
		) {
			return None;
		}
		match tool.as_str() {
			"todo" => Some("todo"),
			"hub" if hub_is_wait(dom, handle, node) => Some("hub"),
			_ => None,
		}
	};
	let mut keep = vec![true; blocks.len()];
	let mut latest: [Option<usize>; 2] = [None, None];
	for index in start..blocks.len() {
		let Some(name) = displaceable(&blocks[index]) else {
			continue;
		};
		let slot = usize::from(name == "hub");
		if let Some(previous) = latest[slot].replace(index) {
			keep[previous] = false;
		}
	}
	// A todo snapshot is also displaced by the next user prompt: only the
	// newest turn keeps its last one.
	if !last_turn && let Some(index) = latest[0] {
		keep[index] = false;
	}
	let mut position = 0;
	blocks.retain(|_| {
		let kept = keep[position];
		position += 1;
		kept
	});
}

/// Whether a `hub` call is a waiting poll (`op` = `wait`).
fn hub_is_wait(dom: &Dom, handle: Handle, _node: &Node) -> bool {
	child(dom, handle, KnownTag::Input)
		.and_then(|input| {
			let raw = match input.prop(&PropId::Data.into()) {
				Some(Value::Json(value)) => value.get().to_owned(),
				_ => input
					.prop(&PropId::Text.into())
					.and_then(Value::as_str)?
					.to_owned(),
			};
			serde_json::from_str::<serde_json::Value>(&raw).ok()
		})
		.and_then(|args| {
			args
				.get("op")
				.and_then(serde_json::Value::as_str)
				.map(str::to_owned)
		})
		.is_some_and(|op| op == "wait")
}

/// `read-tool-group.ts`: consecutive `read` calls in one turn collapse
/// into one compact tree block, and when the turn contains only reads the
/// turn's usage row attaches to the group instead of standing alone.
fn group_reads(
	dom: &Dom,
	cards: &CardRegistry,
	ui: &UiContext,
	options: &Options<'_>,
	blocks: &mut Vec<RenderedBlock>,
	start: usize,
) {
	let is_read = |block: &RenderedBlock| {
		block.view.kind == BlockKind::Tool
			&& Handle::new(block.view.key / 8).is_some_and(|handle| read_is_groupable(dom, handle))
	};
	let reads_only = blocks[start..]
		.iter()
		.all(|block| is_read(block) || matches!(block.view.kind, BlockKind::User | BlockKind::Usage));
	let mut index = start;
	while index < blocks.len() {
		if !is_read(&blocks[index]) {
			index += 1;
			continue;
		}
		let mut end = index + 1;
		while end < blocks.len() && is_read(&blocks[end]) {
			end += 1;
		}
		if end - index < 2 {
			index = end;
			continue;
		}
		let handles = blocks[index..end]
			.iter()
			.filter_map(|block| Handle::new(block.view.key / 8))
			.collect::<Vec<_>>();
		let usage = if reads_only {
			blocks[end..]
				.iter()
				.position(|block| block.view.kind == BlockKind::Usage)
				.map(|offset| end + offset)
		} else {
			None
		};
		let usage_line = usage.map(|at| blocks[at].view.text.clone());
		let group = read_group_block(dom, cards, ui, options, &handles, usage_line);
		let mut text = StrMut::new("");
		for block in &blocks[index..end] {
			text.push_str(block.view.text.as_str());
			text.push_str("\n");
		}
		let finalized = blocks[index..end].iter().all(|block| block.view.finalized);
		let view = BlockView {
			key: blocks[index].view.key,
			kind: BlockKind::Tool,
			text: text.freeze(),
			mode: Mode::Mutable,
			finalized,
		};
		if let Some(at) = usage {
			blocks.remove(at);
		}
		blocks.splice(index..end, [RenderedBlock { view, component: group, stream: None }]);
		index += 1;
	}
}

/// Only ordinary local-file reads collapse into a compact group. Internal
/// resources (`artifact://`, `skill://`, `agent://`, URLs, and other schemes)
/// keep their full card because their result body is the useful surface.
fn read_is_groupable(dom: &Dom, handle: Handle) -> bool {
	let Some(node) = dom.get(handle) else {
		return false;
	};
	if !matches!(&node.tag, Tag::Custom(tool) if tool.as_str() == "read") {
		return false;
	}
	let Some(input) = child(dom, handle, KnownTag::Input) else {
		return false;
	};
	let raw = match input.prop(&PropId::Data.into()) {
		Some(Value::Json(value)) => value.get(),
		_ => input
			.prop(&PropId::Text.into())
			.and_then(Value::as_str)
			.or(input.content.as_deref())
			.unwrap_or_default(),
	};
	let Ok(args) = serde_json::from_str::<serde_json::Value>(raw) else {
		return true;
	};
	args
		.get("path")
		.and_then(serde_json::Value::as_str)
		.is_some_and(|path| !path.contains("://"))
}

fn read_group_block(
	dom: &Dom,
	cards: &CardRegistry,
	ui: &UiContext,
	options: &Options<'_>,
	handles: &[Handle],
	usage: Option<Str>,
) -> Component {
	let views = handles
		.iter()
		.filter_map(|handle| {
			let node = dom.get(*handle)?;
			card_view(dom, *handle, node, options)
		})
		.collect::<Vec<_>>();
	let _ = cards;
	crate::cards::read::render_calls_group(&views, options.expanded, usage, ui)
}

fn card_view<'a>(
	dom: &'a Dom,
	handle: Handle,
	node: &'a Node,
	options: &Options<'_>,
) -> Option<CardView<'a>> {
	let input = child(dom, handle, KnownTag::Input)?;
	let status = node
		.prop(&PropId::Status.into())
		.and_then(Value::as_str)
		.unwrap_or("running");
	let card_status = CardStatus::from_dom(status);
	let started = (card_status == CardStatus::InProgress)
		.then(|| options.local.started(block_key(handle, BlockKind::Tool)))
		.flatten();
	let result = dom.children(handle).iter().copied().find(|child| {
		dom.get(*child)
			.is_some_and(|node| node.tag == Tag::Known(KnownTag::Result))
	});
	let mut diag = None;
	let mut notices = smallvec::SmallVec::<&Node, 2>::new();
	for child in dom.children(handle) {
		let Some(node) = dom.get(*child) else {
			continue;
		};
		if node.tag != Tag::Known(KnownTag::Diag) {
			continue;
		}
		let is_error = node.prop(&PropId::Fault.into()).is_some()
			|| node.prop(&PropId::Severity.into()).and_then(Value::as_str) == Some("error");
		if is_error {
			diag = Some(node);
		} else {
			notices.push(node);
		}
	}
	Some(CardView {
		input,
		result: result.and_then(|handle| dom.get(handle)),
		diag,
		notices,
		usage: child(dom, handle, KnownTag::Usage),
		status: card_status,
		output: result.and_then(|handle| dom.stream_text(handle, &PropId::Text.into())),
		started,
	})
}

/// User message: the text renders as Markdown on the `userMessageBg` tint
/// with one cell of padding on every side and a tinted blank row above and
/// below, with no
/// border; the chrome brackets an OSC 133 prompt zone. An agent reaction
/// replaces the top padding row with the emoji right-aligned inside the
/// horizontal padding (`#reactionRow`); journaled attachments the text does
/// not already reference add a chip row under the prose.
fn user_bubble(text: Str, reaction: Option<Str>, chips: &[Str]) -> Component {
	if reaction.is_none() && chips.is_empty() {
		return dom! { <md zone=prompt bg=surface pad="1 1">{text}</md> }.into_component();
	}
	let chips = chips.to_vec();
	dom! {
		<col zone=prompt bg=surface>
			if let Some(emoji) = reaction {
				<row h=1 justify=end pad-x=1><text>{emoji}</text></row>
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

/// A guest or synthetic user row followed by its attachment chip row, when
/// the journaled attachment set has entries the text does not reference.
pub(crate) fn with_attachments(component: Component, chips: &[Str]) -> Component {
	if chips.is_empty() {
		return component;
	}
	let chips = chips.to_vec();
	dom! {
		<col>
			{component}
			<row h=1 gap=2 pad-x=1 bg=surface>
				for chip in chips { <text bold fg=accent>{chip}</text> }
			</row>
		</col>
	}
	.into_component()
}

/// Chips for the user node's journaled attachments (`data` = the fold's
/// `Vec<Attachment>`, addressed as `attachment://N` by ordinal) that the
/// text does not already carry as a `[Image #N]` / `[Video #N]` marker or
/// an `attachment://N` reference: `<paperclip> #N · <size>`. A reference
/// knows only its digest, size, and MIME, so the chip names the ordinal the
/// model and the `read` tool use.
pub(crate) fn attachment_chips(node: &Node, text: &str, charset: Charset) -> Vec<Str> {
	let Some(Value::Json(raw)) = node.prop(&PropId::Data.into()) else {
		return Vec::new();
	};
	let Ok(attachments) = serde_json::from_str::<Vec<Attachment>>(raw.get()) else {
		return Vec::new();
	};
	let icon = charset.icon(Icon::Paperclip);
	attachments
		.iter()
		.enumerate()
		.filter_map(|(index, attachment)| {
			let ordinal = index + 1;
			(!text_references_attachment(text, ordinal)).then(|| {
				sf!(
					"{icon} #{ordinal} · {}",
					misc::format_bytes(usize::try_from(attachment.blob.size).unwrap_or(usize::MAX))
				)
			})
		})
		.collect()
}

/// Whether `text` already shows attachment `ordinal`: a vision marker
/// (`[Image #N`, `[Video #N`) or an `attachment://N` reference.
fn text_references_attachment(text: &str, ordinal: usize) -> bool {
	let digits = ordinal.to_string();
	let follows = |prefix: &str| {
		text.match_indices(prefix).any(|(at, _)| {
			text[at + prefix.len()..]
				.strip_prefix(digits.as_str())
				.is_some_and(|rest| !rest.starts_with(|c: char| c.is_ascii_digit()))
		})
	};
	follows("[Image #") || follows("[Video #") || follows("attachment://")
}

/// `collapseImageMarkers` (`composer-attachments.ts`, called with an
/// unbounded image count from `user-message.ts`): the stored text carries
/// bracketed `[Image #N, WxH]` / `[Video #N]` markers, optionally followed
/// by their ` attachment://N` reference, but the transcript shows the same
/// compact `<icon> #N` chip the composer used. Runs before Markdown layout
/// so wrapping and bubble padding are computed on the visible text.
pub(crate) fn collapse_image_markers(text: &Str, charset: Charset) -> Str {
	if !text.contains("[Image #") && !text.contains("[Video #") {
		return text.clone();
	}
	let mut out = StrMut::with_capacity(text.len());
	let mut rest = text.as_str();
	while let Some(start) = rest.find('[') {
		out.push_str(&rest[..start]);
		let candidate = &rest[start..];
		match parse_vision_marker(candidate) {
			Some((icon, ordinal, consumed)) => {
				out.push_str(charset.icon(icon));
				out.push_str(" #");
				out.push_str(ordinal);
				rest = &candidate[consumed..];
			},
			None => {
				out.push_str("[");
				rest = &candidate[1..];
			},
		}
	}
	out.push_str(rest);
	out.freeze()
}

/// Parses one leading vision marker: `[Image #N]`, `[Image #N, WxH]`, or
/// `[Video #N…]`, each optionally followed by ` attachment://N` naming the
/// same ordinal. Returns the chip icon, the ordinal digits, and the byte
/// length consumed.
fn parse_vision_marker(candidate: &str) -> Option<(Icon, &str, usize)> {
	let (icon, body) = if let Some(body) = candidate.strip_prefix("[Image #") {
		(Icon::Image, body)
	} else {
		(Icon::Video, candidate.strip_prefix("[Video #")?)
	};
	let digits = body.bytes().take_while(u8::is_ascii_digit).count();
	if digits == 0 || body.as_bytes()[0] == b'0' {
		return None;
	}
	let ordinal = &body[..digits];
	let tail = &body[digits..];
	let close = match *tail.as_bytes().first()? {
		b']' => 0,
		b',' => tail
			.find(|c: char| c == ']' || c == '\n')
			.filter(|at| tail.as_bytes()[*at] == b']')?,
		_ => return None,
	};
	let mut consumed = candidate.len() - tail.len() + close + 1;
	let reference = &candidate[consumed..];
	if let Some(after) = reference.strip_prefix(" attachment://")
		&& after
			.strip_prefix(ordinal)
			.is_some_and(|next| !next.starts_with(|c: char| c.is_ascii_digit()))
	{
		consumed += " attachment://".len() + ordinal.len();
	}
	Some((icon, ordinal, consumed))
}

fn rendered(
	handle: Handle,
	kind: BlockKind,
	text: Str,
	mode: Mode,
	finalized: bool,
	component: impl IntoComponent,
) -> RenderedBlock {
	RenderedBlock {
		view:      BlockView { key: block_key(handle, kind), kind, text, mode, finalized },
		component: component.into_component(),
		stream:    None,
	}
}

/// Stable observer-local block identity: the DOM handle times eight plus a
/// kind suffix, so the handle is recoverable as `key / 8`.
pub(crate) const fn block_key(handle: Handle, kind: BlockKind) -> u64 {
	let suffix = match kind {
		BlockKind::Welcome | BlockKind::User => 0,
		BlockKind::Thinking => 1,
		BlockKind::Assistant => 2,
		BlockKind::Tool => 3,
		BlockKind::Local => 7,
		BlockKind::Notice => 4,
		BlockKind::Usage => 5,
		BlockKind::Divider => 6,
	};
	handle.get().saturating_mul(8).saturating_add(suffix)
}

/// Dedicated user-local execution projection. The block remains mutable while
/// its tail-window output streams and finalizes only at the dispatcher
/// terminal.
fn local_block(
	dom: &Dom,
	handle: Handle,
	node: &Node,
	options: &Options<'_>,
) -> Option<RenderedBlock> {
	let run = local::execution(dom, handle, node)?;
	Some(rendered(
		handle,
		BlockKind::Local,
		run.transcript_text(),
		Mode::Mutable,
		run.finalized(),
		local::execution_block(&run, options.expanded),
	))
}

fn tool_block(
	dom: &Dom,
	handle: Handle,
	node: &Node,
	tool: &Str,
	cards: &CardRegistry,
	ui: &UiContext,
	options: &Options<'_>,
) -> Option<RenderedBlock> {
	let view = card_view(dom, handle, node, options)?;
	let status = prop_text(node, PropId::Status).unwrap_or_else(|| Str::new_static("running"));
	let component = cards.render(tool.as_str(), &view, options.expanded, ui);
	let mut text = StrMut::new(tool.as_str());
	text.push_str(" ");
	text.push_str(status.as_str());
	if let Some(result) = view
		.result
		.and_then(node_text)
		.filter(|text| !text.is_empty())
	{
		text.push_str("\n");
		text.push_str(result.as_str());
	}
	if let Some(diag) = view
		.diag
		.and_then(node_text)
		.filter(|text| !text.is_empty())
	{
		text.push_str("\n");
		text.push_str(diag.as_str());
	}
	let finalized = matches!(status.as_str(), "ok" | "error" | "cancelled" | "aborted");
	Some(rendered(handle, BlockKind::Tool, text.freeze(), Mode::Mutable, finalized, component))
}

fn child(dom: &Dom, parent: Handle, tag: KnownTag) -> Option<&Node> {
	dom.children(parent)
		.iter()
		.filter_map(|handle| dom.get(*handle))
		.find(|node| node.tag == Tag::Known(tag))
}

/// The property's text, preferring an open stream buffer so streaming
/// content projects before the stream closes.
fn live_text(dom: &Dom, handle: Handle, node: &Node, prop: PropId) -> Option<Str> {
	let key: omp_dom::PropKey = prop.into();
	match dom.stream_text(handle, &key) {
		Some(text) => Some(Str::new(text)),
		None => prop_text(node, prop),
	}
}

fn prop_text(node: &Node, prop: PropId) -> Option<Str> {
	node
		.prop(&prop.into())
		.and_then(Value::as_str)
		.map(Str::new)
}

fn node_text(node: &Node) -> Option<Str> {
	node
		.content
		.clone()
		.or_else(|| prop_text(node, PropId::Text))
}

#[cfg(test)]
mod tests {
	use std::time::Duration;

	use omp_agent::KernelEvent;
	use omp_session::{ComponentRegistry, Session};
	use omp_tui::{Ui, frame_text};

	use super::*;

	fn empty_session() -> Session {
		let directory = tempfile::tempdir().expect("temp directory");
		let path = directory.keep().join("project.oms");
		Session::create(path, ComponentRegistry::standard()).expect("session")
	}

	#[test]
	fn abnormal_exit_projects_after_replay_while_clean_exit_is_silent() {
		let mut clean = empty_session();
		clean
			.record_exit(omp_session::ExitCause::Normal)
			.expect("clean exit");
		assert!(block_views(clean.dom(), true).is_empty());

		let mut interrupted = empty_session();
		let path = interrupted.journal_path().to_path_buf();
		interrupted
			.record_exit(omp_session::ExitCause::Signal {
				signal: omp_session::ExitSignal::new("SIGTERM", Some(15)),
			})
			.expect("signal exit");
		drop(interrupted);
		let replayed =
			Session::open(path, ComponentRegistry::standard()).expect("exit journal replays");
		let views = block_views(replayed.dom(), true);
		assert_eq!(views.len(), 1);
		assert_eq!(views[0].kind, BlockKind::Notice);
		assert!(views[0].text.contains("SIGTERM"));
	}

	/// A session whose newest assistant is still streaming: reasoning, then
	/// answer text when `text` is non-empty — none of it finalized.
	fn streaming(thinking: &str, text: &str) -> Session {
		let mut session = empty_session();
		session.begin_turn().expect("turn");
		session.user("hi", Vec::new()).expect("user");
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
		let sid = session
			.stream_open(assistant, PropId::Thinking.into())
			.expect("thinking stream");
		session
			.stream_append(sid, thinking)
			.expect("thinking delta");
		if !text.is_empty() {
			let sid = session
				.stream_open(assistant, PropId::Text.into())
				.expect("text stream");
			session.stream_append(sid, text).expect("text delta");
		}
		session
	}

	fn insert_assistant_part(
		session: &mut Session,
		assistant: Handle,
		index: i64,
		kind: &str,
	) -> Handle {
		session
			.patch(omp_dom::Txn {
				cause: session.head().expect("head"),
				label: Some(Str::new_static("assistant.block")),
				ops:   vec![omp_dom::Op::Ins {
					parent: assistant,
					after:  session.dom().children(assistant).last().copied(),
					node:   omp_dom::NodeSpec::new(Tag::Custom(Str::new_static(ASSISTANT_CONTENT_TAG)))
						.with_prop(PropId::Kind, Value::Str(Str::new(kind)))
						.with_prop(
							PropKey::Custom(Str::new_static(PROVIDER_BLOCK_INDEX_PROP)),
							Value::Int(index),
						),
				}],
			})
			.expect("assistant part");
		*session
			.dom()
			.children(assistant)
			.last()
			.expect("inserted assistant part")
	}

	fn insert_artifact(session: &mut Session, assistant: Handle, index: i64, byte: u8) -> Handle {
		let uri = Str::new(format!("artifact://sha256/{}", format!("{byte:02x}").repeat(32)));
		session
			.patch(omp_dom::Txn {
				cause: session.head().expect("head"),
				label: Some(Str::new_static("assistant.artifact")),
				ops:   vec![omp_dom::Op::Ins {
					parent: assistant,
					after:  session.dom().children(assistant).last().copied(),
					node:   omp_dom::NodeSpec::new(Tag::Custom(Str::new_static("artifact")))
						.with_prop(PropId::Blob, Value::Str(uri))
						.with_prop(PropId::Mime, Value::Str(Str::new_static("image/png")))
						.with_prop(PropId::Kind, Value::Str(Str::new_static("image")))
						.with_prop(
							PropKey::Custom(Str::new_static(PROVIDER_BLOCK_INDEX_PROP)),
							Value::Int(index),
						),
				}],
			})
			.expect("artifact");
		*session
			.dom()
			.children(assistant)
			.last()
			.expect("inserted artifact")
	}

	fn render(component: Component, width: u16) -> String {
		let ui = Ui::from_root(component, width, UiContext::default());
		frame_text(ui.frame())
	}

	fn projected(session: &Session, options: &Options<'_>) -> Vec<RenderedBlock> {
		project(session.dom(), &CardRegistry::standard(), &UiContext::default(), options)
	}

	#[test]
	fn advisor_receipts_feed_status_without_rendering_a_second_usage_row() {
		use omp_journal::data::{ReceiptIdentity, ReceiptRole, TurnReceipt};

		let mut session = empty_session();
		session.begin_turn().expect("turn");
		session.user("review this", Vec::new()).expect("user");
		session
			.receipt(TurnReceipt::tokens(1_000, 200, 120_000_000))
			.expect("primary receipt");
		session
			.receipt(TurnReceipt {
				tokens_in: 700,
				tokens_out: 80,
				cost_nano_usd: 80_000_000,
				identity: Some(ReceiptIdentity {
					role:     ReceiptRole::Advisor,
					provider: Str::new_static("anthropic"),
					model:    Str::new_static("claude-sonnet-4-5"),
				}),
				..TurnReceipt::default()
			})
			.expect("advisor receipt");

		let local = Local::default();
		let options = Options { smooth: false, ..Options::new(&local) };
		let status = crate::status_line::StatusLine::from_dom(session.dom());
		assert_eq!(status.cost_nano_usd, 120_000_000);
		assert_eq!(
			status.advisor.as_ref().map(|advisor| advisor.cost_nano_usd),
			Some(80_000_000),
			"advisor accounting remains available to the status projection",
		);

		let blocks = projected(&session, &options);
		assert_eq!(
			blocks
				.iter()
				.filter(|block| block.view.kind == BlockKind::Usage)
				.count(),
			0,
			"default transcript projection does not append primary or advisor telemetry rows",
		);
	}

	#[test]
	fn skill_prompt_replays_expands_copies_and_stays_visible_without_tool_activity() {
		use omp_journal::data::SkillPrompt;

		let directory = tempfile::tempdir().expect("temp directory");
		let path = directory.path().join("skill-prompt.oms");
		let mut session =
			Session::create(&path, ComponentRegistry::standard()).expect("session creates");
		session.begin_turn().expect("turn starts");
		let prompt_body = Str::new_static("Use **atomic** commits.\n\n- Verify each hunk");
		session
			.skill_prompt(SkillPrompt {
				name:        Str::new_static("atomic-commit"),
				args:        Some(Str::new_static("stage all\nthen split")),
				path:        Str::new_static("/Users/example/.o2/skills/atomic-commit/SKILL.md"),
				prompt_body: prompt_body.clone(),
				line_count:  88,
			})
			.expect("skill prompt journals");

		let local = Local::default();
		let collapsed = projected(&session, &Options { show_tools: true, ..Options::new(&local) });
		let block = collapsed
			.into_iter()
			.find(|block| block.view.text.starts_with("skill atomic-commit"))
			.expect("skill card");
		assert_eq!(block.view.kind, BlockKind::Notice);
		let collapsed = render(block.component, 120);
		assert!(collapsed.contains("skill atomic-commit stage all then split"), "{collapsed:?}");
		assert!(collapsed.contains("88 lines"), "{collapsed:?}");
		assert!(!collapsed.contains("Use atomic commits"), "{collapsed:?}");

		let expanded =
			projected(&session, &Options { expanded: true, show_tools: true, ..Options::new(&local) });
		let block = expanded
			.into_iter()
			.find(|block| block.view.text.starts_with("skill atomic-commit"))
			.expect("expanded skill card");
		assert!(render(block.component, 120).contains("Use atomic commits"));

		let tools_hidden =
			projected(&session, &Options { show_tools: false, ..Options::new(&local) });
		assert!(
			tools_hidden
				.iter()
				.any(|block| block.view.text.starts_with("skill atomic-commit")),
			"a user-invoked skill is user context, not hideable tool activity"
		);

		let copied = crate::overlays::copy::collect_targets(session.dom(), true, false, false);
		let copied = copied.last().expect("skill copy target");
		assert_eq!(copied.label, "message");
		assert_eq!(copied.content, prompt_body);

		let turn = *session
			.dom()
			.children(session.dom().body())
			.last()
			.expect("turn");
		let user = *session.dom().children(turn).last().expect("skill user");
		assert_eq!(
			session
				.dom()
				.get(user)
				.and_then(|node| node.content.as_deref()),
			Some("Use **atomic** commits.\n\n- Verify each hunk"),
			"the typed card body remains the ordinary model-facing user content"
		);

		drop(session);
		let restored = Session::open(&path, ComponentRegistry::standard()).expect("session replays");
		let replayed = projected(&restored, &Options { show_tools: false, ..Options::new(&local) });
		assert_eq!(
			replayed
				.iter()
				.filter(|block| block.view.text.starts_with("skill atomic-commit"))
				.count(),
			1,
			"one typed skill card survives replay"
		);
	}

	#[test]
	fn late_diagnostics_replay_expand_copy_and_ignore_tool_visibility() {
		use omp_session::late_diagnostics::{LateDiagnostics, LateDiagnosticsFile};

		let directory = tempfile::tempdir().expect("temp directory");
		let path = directory.path().join("late-diagnostics.oms");
		let mut session =
			Session::create(&path, ComponentRegistry::standard()).expect("session creates");
		session.begin_turn().expect("turn starts");
		let turn = *session
			.dom()
			.children(session.dom().body())
			.last()
			.expect("turn");
		let diagnostics = LateDiagnostics {
			files: vec![LateDiagnosticsFile {
				path:     Str::new_static("src/lib.rs"),
				summary:  Str::new_static("6 error(s)"),
				errored:  true,
				messages: (1..=6)
					.map(|line| Str::new(format!("src/lib.rs:{line}:1 [error] [rustc] failure {line}")))
					.collect(),
			}],
		};
		let body = diagnostics.body();
		session
			.patch(omp_dom::Txn {
				cause: session.head().expect("journal head"),
				label: Some(Str::new_static("test.late-diagnostics")),
				ops:   vec![omp_dom::Op::Ins {
					parent: turn,
					after:  None,
					node:   diagnostics.into_node().expect("diagnostics serialize"),
				}],
			})
			.expect("diagnostics journal");

		let local = Local::default();
		let hidden = projected(&session, &Options { show_tools: false, ..Options::new(&local) });
		let collapsed = hidden
			.into_iter()
			.find(|block| block.view.text == body)
			.expect("late diagnostics remain visible without tool activity");
		let collapsed = render(collapsed.component, 100);
		assert!(collapsed.contains("src/lib.rs"));
		assert!(collapsed.contains("… 1 more ⟨Ctrl+O: Expand⟩"));
		assert!(!collapsed.contains("failure 6"));

		let expanded = projected(&session, &Options {
			expanded: true,
			show_tools: false,
			..Options::new(&local)
		})
		.into_iter()
		.find(|block| block.view.text == body)
		.expect("expanded diagnostics");
		assert!(render(expanded.component, 100).contains("failure 6"));

		let copied = crate::overlays::copy::collect_targets(session.dom(), true, false, false);
		let copied = copied.last().expect("diagnostics copy target");
		assert_eq!(copied.label, "message");
		assert_eq!(copied.content, body);

		drop(session);
		let restored = Session::open(&path, ComponentRegistry::standard()).expect("session replays");
		assert!(
			projected(&restored, &Options { show_tools: false, ..Options::new(&local) })
				.iter()
				.any(|block| block.view.text == body),
			"the typed files payload and semantic body survive replay"
		);
	}

	#[test]
	fn custom_renderer_metadata_replays_while_copy_and_visibility_use_the_semantic_body() {
		use omp_session::custom_message::{CustomMessage, MessageRendererIdentity};

		let directory = tempfile::tempdir().expect("temp directory");
		let path = directory.path().join("custom-message.oms");
		let mut session =
			Session::create(&path, ComponentRegistry::standard()).expect("session creates");
		session.begin_turn().expect("turn starts");
		let turn = *session
			.dom()
			.children(session.dom().body())
			.last()
			.expect("turn");
		let cause = session.head().expect("journal head");
		let visible = CustomMessage::new("audit", "semantic **body**").with_rendered(
			MessageRendererIdentity {
				extension:   Str::new_static("dev.example"),
				declaration: Str::new_static("dev.example/audit"),
				generation:  3,
			},
			"<callout kind=success>runtime replacement</callout>",
		);
		let hidden = CustomMessage::new("private", "hidden context").with_display(false);
		session
			.patch(omp_dom::Txn {
				cause,
				label: Some(Str::new_static("test.custom-messages")),
				ops: vec![
					omp_dom::Op::Ins { parent: turn, after: None, node: visible.into_node() },
					omp_dom::Op::Ins { parent: turn, after: None, node: hidden.into_node() },
				],
			})
			.expect("custom messages journal");

		let local = Local::default();
		let blocks = projected(&session, &Options { show_tools: false, ..Options::new(&local) });
		let custom = blocks
			.into_iter()
			.find(|block| block.view.text == "[audit]\nsemantic **body**")
			.expect("visible custom message");
		assert!(render(custom.component, 80).contains("runtime replacement"));
		let copies = crate::overlays::copy::collect_targets(session.dom(), true, false, false);
		assert_eq!(
			copies
				.iter()
				.filter(|target| target.content == "semantic **body**")
				.count(),
			1
		);
		assert!(
			!copies
				.iter()
				.any(|target| target.content == "hidden context")
		);

		drop(session);
		let restored = Session::open(&path, ComponentRegistry::standard()).expect("session replays");
		let replayed = projected(&restored, &Options { show_tools: false, ..Options::new(&local) });
		assert!(
			!replayed
				.iter()
				.any(|block| block.view.text.contains("hidden context"))
		);
		let replayed = replayed
			.into_iter()
			.find(|block| block.view.text == "[audit]\nsemantic **body**")
			.expect("one custom message survives replay");
		assert!(
			render(replayed.component, 80).contains("runtime replacement"),
			"renderer identity and replacement survive replay"
		);
	}

	/// Authenticated collaboration prompts are ordinary authored user rows:
	/// Markdown and attachment order survive replay and copy projection, and
	/// observer-local tool hiding never suppresses user input.
	#[test]
	fn collaboration_prompt_replays_copies_and_stays_visible_without_tool_activity() {
		let directory = tempfile::tempdir().expect("temp directory");
		let path = directory.path().join("collaboration-prompt.oms");
		let mut session =
			Session::create(&path, ComponentRegistry::standard()).expect("session creates");
		let blob = |byte: u8, size: u64| Attachment {
			blob: omp_journal::blob::BlobRef { hash: omp_core::Hash32::new([byte; 32]), size },
			mime: Str::new_static("image/png"),
		};

		session.begin_turn().expect("first turn starts");
		session.user("host before", Vec::new()).expect("first user");
		session.begin_turn().expect("collaboration turn starts");
		let guest_text = "## Deploy\n\nPlease inspect **both** images.";
		session
			.user_authored(guest_text, vec![blob(7, 128), blob(8, 2_048)], "Ada Lovelace")
			.expect("collaboration user");
		session.begin_turn().expect("last turn starts");
		session.user("host after", Vec::new()).expect("last user");

		let local = Local::default();
		let hidden = projected(&session, &Options { show_tools: false, ..Options::new(&local) });
		let users: Vec<&RenderedBlock> = hidden
			.iter()
			.filter(|block| block.view.kind == BlockKind::User)
			.collect();
		assert_eq!(
			users
				.iter()
				.map(|block| block.view.text.as_str())
				.collect::<Vec<_>>(),
			["host before", guest_text, "host after"],
			"authored input retains transcript order"
		);
		let guest_rendered = render(
			projected(&session, &Options { show_tools: false, ..Options::new(&local) })
				.into_iter()
				.find(|block| block.view.text == guest_text)
				.expect("collaboration row")
				.component,
			80,
		);
		assert!(guest_rendered.starts_with(" «Ada Lovelace» ›\n"), "{guest_rendered:?}");
		assert!(guest_rendered.contains("\n Deploy\n"), "body is Markdown:\n{guest_rendered}");
		assert!(
			!guest_rendered.contains("## Deploy"),
			"Markdown source does not leak:\n{guest_rendered}"
		);
		let first = guest_rendered.find("#1 · 128B").expect("first attachment");
		let second = guest_rendered
			.find("#2 · 2.0KB")
			.expect("second attachment");
		assert!(first < second, "attachment ordinal order is stable:\n{guest_rendered}");

		let copied = crate::overlays::copy::collect_targets(session.dom(), true, false, false);
		assert_eq!(
			copied
				.iter()
				.map(|target| target.content.as_str())
				.collect::<Vec<_>>(),
			["host before", guest_text, "host after"],
			"copy projection retains the authored row even with tool activity hidden"
		);

		drop(session);
		let restored = Session::open(&path, ComponentRegistry::standard()).expect("session replays");
		let replayed = projected(&restored, &Options { show_tools: false, ..Options::new(&local) });
		assert_eq!(
			replayed
				.iter()
				.filter(|block| block.view.text == guest_text)
				.count(),
			1,
			"one collaboration prompt survives replay"
		);
		let replayed_rendered = render(
			replayed
				.into_iter()
				.find(|block| block.view.text == guest_text)
				.expect("replayed collaboration row")
				.component,
			80,
		);
		assert!(
			replayed_rendered.contains("«Ada Lovelace» ›"),
			"replay retains authenticated author identity"
		);
		let first = replayed_rendered
			.find("#1 · 128B")
			.expect("replayed first attachment");
		let second = replayed_rendered
			.find("#2 · 2.0KB")
			.expect("replayed second attachment");
		assert!(first < second, "replay retains attachment order:\n{replayed_rendered}");
	}

	#[test]
	fn file_mentions_replay_stay_visible_and_copy_linked_rows_in_order() {
		use omp_core::Hash32;
		use omp_journal::{
			blob::BlobRef,
			data::{FileMentions, MentionedFile, MentionedFileState},
		};

		let directory = tempfile::tempdir().expect("temp directory");
		let path = directory.path().join("file-mentions.oms");
		let mut session =
			Session::create(&path, ComponentRegistry::standard()).expect("session creates");
		session.begin_turn().expect("turn starts");
		session.user("inspect these", Vec::new()).expect("user");
		session
			.file_mentions(FileMentions {
				files: vec![
					MentionedFile {
						path:    Str::new_static("src/main.rs"),
						content: Str::new_static("fn main() {}"),
						state:   MentionedFileState::Lines { line_count: Some(1) },
					},
					MentionedFile {
						path:    Str::new_static("screen.png"),
						content: Str::default(),
						state:   MentionedFileState::Image {
							attachment: Attachment {
								blob: BlobRef { hash: Hash32::new([3; 32]), size: 640 },
								mime: Str::new_static("image/png"),
							},
						},
					},
					MentionedFile {
						path:    Str::new_static("vendor.bin"),
						content: Str::default(),
						state:   MentionedFileState::SkippedBinary { byte_size: Some(3_072) },
					},
					MentionedFile {
						path:    Str::new_static("dump.log"),
						content: Str::default(),
						state:   MentionedFileState::TooLarge { byte_size: Some(2_621_440) },
					},
				],
			})
			.expect("mentions append");

		let local = Local::default();
		let visible = projected(&session, &Options { show_tools: false, ..Options::new(&local) });
		let mention = visible
			.iter()
			.find(|block| block.view.text.starts_with("Read src/main.rs"))
			.expect("mention block remains visible with tools hidden");
		assert_eq!(
			mention.view.text.as_str(),
			concat!(
				"Read src/main.rs (1 lines)\n",
				"Read screen.png (image)\n",
				"Read vendor.bin (skipped: binary, 3.0KB)\n",
				"Read dump.log (skipped: 2.5MB)"
			)
		);
		let rendered = render(
			projected(&session, &Options { show_tools: false, ..Options::new(&local) })
				.into_iter()
				.find(|block| block.view.text.starts_with("Read src/main.rs"))
				.expect("rendered mention")
				.component,
			100,
		);
		let positions = ["src/main.rs", "screen.png", "vendor.bin", "dump.log"]
			.map(|name| rendered.find(name).expect("rendered path"));
		assert!(positions.windows(2).all(|pair| pair[0] < pair[1]));

		let copied = crate::overlays::copy::collect_targets(session.dom(), true, false, false);
		let target = copied
			.iter()
			.find(|target| target.label == "file mention")
			.expect("copy target");
		assert_eq!(target.content, mention.view.text);
		assert_eq!(
			target
				.blocks
				.iter()
				.map(|block| block.content.as_str())
				.collect::<Vec<_>>(),
			["src/main.rs", "screen.png", "vendor.bin", "dump.log"]
		);
		assert!(target.blocks.iter().all(|block| {
			block
				.href
				.as_ref()
				.is_some_and(|href| href.starts_with("file://"))
		}));

		let live = visible
			.iter()
			.map(|block| block.view.clone())
			.collect::<Vec<_>>();
		drop(session);
		let restored = Session::open(&path, ComponentRegistry::standard()).expect("session replays");
		let replayed = projected(&restored, &Options { show_tools: false, ..Options::new(&local) })
			.into_iter()
			.map(|block| block.view)
			.collect::<Vec<_>>();
		assert_eq!(replayed, live, "replay reproduces exact visible order and text");
	}

	#[test]
	fn workpool_traffic_replays_copies_and_renders_ordered_states() {
		use omp_journal::data::{IrcDirection, IrcTraffic, WorkpoolMode, WorkpoolObservation};

		let directory = tempfile::tempdir().expect("temp directory");
		let path = directory.path().join("workpool-traffic.oms");
		let mut session =
			Session::create(&path, ComponentRegistry::standard()).expect("session creates");
		session.begin_turn().expect("turn starts");
		let turn = *session
			.dom()
			.children(session.dom().body())
			.last()
			.expect("turn");
		let transitions = [
			(WorkpoolMode::Spawned, "Worker Scout admitted", None),
			(WorkpoolMode::Dispatched, "[audit#1] inspect parser", Some("spawn")),
			(WorkpoolMode::Queued, "[audit#2] report risks", Some("dispatch")),
			(
				WorkpoolMode::Batch,
				"[audit#2] report risks\n[audit#3] inspect lexer\n[audit#4] inspect \
				 recovery\n[audit#5] inspect tests",
				Some("queued"),
			),
		];
		for (mode, body, reply_to) in transitions {
			let traffic = IrcTraffic::from(WorkpoolObservation {
				pool: Str::new_static("audit"),
				from: Str::new_static("pool:audit"),
				to: Str::new_static("Scout"),
				body: Str::new(body),
				mode,
				reply_to: reply_to.map(Str::new_static),
				timestamp_ms: u64::MAX,
			});
			omp_agent::append_irc_traffic(&mut session, turn, &traffic)
				.expect("workpool transition journals");
		}
		omp_agent::append_irc_traffic(&mut session, turn, &IrcTraffic {
			direction:    IrcDirection::Incoming,
			from:         Some(Str::new_static("Scout")),
			to:           Some(Str::new_static("Main")),
			body:         Str::new_static("Batch Scout-b1 failed\nparser fixture missing"),
			reply_to:     Some(Str::new_static("batch")),
			pool:         None,
			mode:         None,
			timestamp_ms: u64::MAX,
		})
		.expect("worker result journals");
		let cancelled = IrcTraffic::from(WorkpoolObservation {
			pool:         Str::new_static("audit"),
			from:         Str::new_static("pool:audit"),
			to:           Str::new_static("Main"),
			body:         Str::new_static("Pool `audit` cancelled"),
			mode:         WorkpoolMode::Cancelled,
			reply_to:     Some(Str::new_static("result")),
			timestamp_ms: u64::MAX,
		});
		omp_agent::append_irc_traffic(&mut session, turn, &cancelled)
			.expect("workpool cancellation journals");

		let local = Local::default();
		let visible = projected(&session, &Options { show_tools: true, ..Options::new(&local) });
		assert_eq!(visible.len(), transitions.len() + 2);
		let rendered = visible
			.into_iter()
			.map(|block| {
				assert_eq!(block.view.kind, BlockKind::Notice);
				render(block.component, 120)
			})
			.collect::<Vec<_>>();
		assert!(rendered[0].contains("Pool audit ➤ Scout ⟨spawned⟩"), "{:?}", rendered[0]);
		assert!(rendered[1].contains("audit#1 inspect parser ⟨running⟩"), "{:?}", rendered[1]);
		assert!(rendered[2].contains("audit#2 report risks ⟨queued⟩"), "{:?}", rendered[2]);
		assert!(rendered[3].contains("… 1 more items"), "{:?}", rendered[3]);
		assert!(rendered[4].contains("Batch Scout-b1 ⟨failed⟩ ⟨Scout⟩"), "{:?}", rendered[4]);
		assert!(rendered[4].contains("Error"), "{:?}", rendered[4]);
		assert!(rendered[4].contains("parser fixture missing"), "{:?}", rendered[4]);
		assert!(rendered[5].contains("Pool audit ⟨cancelled⟩"), "{:?}", rendered[5]);
		let expanded = crate::notices::irc::traffic_card(
			&IrcTraffic::from(WorkpoolObservation {
				pool:         Str::new_static("audit"),
				from:         Str::new_static("pool:audit"),
				to:           Str::new_static("Scout"),
				body:         Str::new_static(transitions[3].1),
				mode:         WorkpoolMode::Batch,
				reply_to:     Some(Str::new_static("queued")),
				timestamp_ms: u64::MAX,
			}),
			true,
		);
		assert!(render(expanded, 120).contains("audit#5 inspect tests"));

		let hidden = projected(&session, &Options { show_tools: false, ..Options::new(&local) });
		assert!(hidden.is_empty(), "workpool traffic follows tool-activity visibility");

		let copied = crate::overlays::copy::collect_targets(session.dom(), true, true, false);
		assert_eq!(
			copied
				.iter()
				.map(|target| target.content.as_str())
				.collect::<Vec<_>>(),
			[
				"Worker Scout admitted",
				"[audit#1] inspect parser",
				"[audit#2] report risks",
				transitions[3].1,
				"Batch Scout-b1 failed\nparser fixture missing",
				"Pool `audit` cancelled",
			],
			"copy keeps producer order and exact bodies"
		);
		let hidden_copy = crate::overlays::copy::collect_targets(session.dom(), true, false, false);
		assert!(hidden_copy.is_empty(), "hidden workpool traffic is not copied");

		let live = projected(&session, &Options { show_tools: true, ..Options::new(&local) })
			.into_iter()
			.map(|block| block.view)
			.collect::<Vec<_>>();
		drop(session);
		let restored = Session::open(&path, ComponentRegistry::standard()).expect("session replays");
		let replayed = projected(&restored, &Options { show_tools: true, ..Options::new(&local) })
			.into_iter()
			.map(|block| block.view)
			.collect::<Vec<_>>();
		assert_eq!(replayed, live, "replay preserves ordered workpool updates exactly");
	}

	#[test]
	fn launch_completion_replays_copies_and_follows_tool_visibility() {
		use omp_journal::data::{
			LaunchCompletion, LaunchDaemonCompletion, LaunchDaemonFault, LaunchDaemonFaultKind,
			LaunchDaemonStatus,
		};

		let directory = tempfile::tempdir().expect("temp directory");
		let path = directory.path().join("launch-completion.oms");
		let mut session =
			Session::create(&path, ComponentRegistry::standard()).expect("session creates");
		session.begin_turn().expect("turn starts");
		let turn = *session
			.dom()
			.children(session.dom().body())
			.last()
			.expect("turn");
		let completion = LaunchCompletion {
			daemons: vec![LaunchDaemonCompletion {
				name:        Str::new_static("web"),
				status:      LaunchDaemonStatus::Failed,
				exit_code:   Some(17),
				duration_ms: 2_500,
				fault:       Some(LaunchDaemonFault {
					kind:    LaunchDaemonFaultKind::Failed,
					message: Some(Str::new_static("readiness process exited")),
					signal:  None,
				}),
			}],
		};
		let data = serde_json::value::to_raw_value(&completion).expect("completion serializes");
		session
			.patch(omp_dom::Txn {
				cause: session.head().expect("journal head"),
				label: Some(Str::new_static("jobs.settle")),
				ops:   vec![omp_dom::Op::Ins {
					parent: turn,
					after:  session.dom().children(turn).last().copied(),
					node:   omp_dom::NodeSpec::new(KnownTag::User)
						.with_prop(
							PropKey::Custom(Str::new_static("launch_completion")),
							Value::Bool(true),
						)
						.with_prop(PropId::Data, Value::Json(data))
						.with_content(Str::new_static(
							"Supervised process web failed with exit code 17.",
						)),
				}],
			})
			.expect("completion journals");

		let local = Local::default();
		let visible = projected(&session, &Options { show_tools: true, ..Options::new(&local) });
		let row = visible
			.into_iter()
			.find(|block| block.view.text.contains("Supervised process failed web"))
			.expect("completion row");
		assert_eq!(row.view.kind, BlockKind::Notice);
		assert!(render(row.component, 80).contains("(exit 17) (2.5s)"));
		let hidden = projected(&session, &Options { show_tools: false, ..Options::new(&local) });
		assert!(
			hidden
				.iter()
				.all(|block| !block.view.text.contains("Supervised process")),
			"launch completion follows tool-activity visibility"
		);

		let copied = crate::overlays::copy::collect_targets(session.dom(), true, true, false);
		assert_eq!(
			copied.last().expect("completion copy target").content,
			"Supervised process web failed with exit code 17."
		);
		let hidden_copy = crate::overlays::copy::collect_targets(session.dom(), true, false, false);
		assert!(hidden_copy.is_empty(), "hidden tool activity is not copied");

		drop(session);
		let restored = Session::open(&path, ComponentRegistry::standard()).expect("session replays");
		let replayed = projected(&restored, &Options { show_tools: true, ..Options::new(&local) });
		assert_eq!(
			replayed
				.iter()
				.filter(|block| block.view.text.contains("Supervised process failed web"))
				.count(),
			1,
			"one compact completion row survives replay"
		);
	}

	/// `user-message.ts`: `new Markdown(text, 1, 1, …)` on the tinted
	/// background — inline emphasis renders, fences render as code, and a
	/// padded blank row sits above and below the text.
	#[test]
	fn user_bubble_renders_markdown_with_padding_rows() {
		let local = Local::default();
		let options = Options::new(&local);
		let mut session = empty_session();
		session.begin_turn().expect("turn");
		session
			.user("run **exactly** this:\n\n```sh\necho pong\n```", Vec::new())
			.expect("user");
		let block = projected(&session, &options)
			.into_iter()
			.find(|block| block.view.kind == BlockKind::User)
			.expect("user block");
		let text = render(block.component, 40);
		let rows: Vec<&str> = text.split('\n').collect();
		assert!(rows.len() > 2, "{text}");
		assert!(rows.first().is_some_and(|row| row.trim().is_empty()), "top pad row:\n{text}");
		assert!(rows.last().is_some_and(|row| row.trim().is_empty()), "bottom pad row:\n{text}");
		assert!(text.contains("run exactly this:"), "emphasis markers must not leak:\n{text}");
		assert!(!text.contains("**"), "{text}");
		assert!(
			text.contains("  echo pong"),
			"fenced code renders as an indented code block:\n{text}"
		);
		assert!(
			rows
				.iter()
				.all(|row| row.is_empty() || row.starts_with(' ')),
			"one cell of left padding:\n{text}"
		);
	}

	/// `assistant-message.ts`: the reasoning trace is a Markdown block
	/// (`new Markdown(text, 1, 0, …, { italic: true })`), so list bullets and
	/// emphasis in the trace render instead of leaking their markers.
	#[test]
	fn reasoning_trace_renders_as_markdown() {
		let local = Local::default();
		let options = Options { smooth: false, ..Options::new(&local) };
		let session = streaming("- **first** step\n- second step", "");
		let block = projected(&session, &options)
			.into_iter()
			.find(|block| block.view.kind == BlockKind::Thinking)
			.expect("thinking block");
		assert_eq!(block.view.mode, Mode::AppendOnly);
		assert_eq!(block.stream.as_deref(), Some("- **first** step\n- second step"));
		let text = render(block.component, 40);
		assert!(!text.contains("**"), "emphasis markers must not leak:\n{text}");
		assert!(text.contains("- first step") && text.contains("- second step"), "{text}");
	}

	/// ADR 0034 §Decision: streaming text is append-only, so the answer's
	/// stable prefix may retire into native scrollback while the reply still
	/// streams. A mutable answer block would pin every row on screen until
	/// the message ended (`Projection::retire_under_pressure` never retires
	/// an unfinalized block and `Slots::append` is only driven for
	/// append-only heads).
	#[test]
	fn streaming_answer_is_an_append_only_head() {
		let local = Local::default();
		let options = Options { smooth: false, ..Options::new(&local) };
		let session = streaming("", "first paragraph\n\nsecond paragraph");
		let block = projected(&session, &options)
			.into_iter()
			.find(|block| block.view.kind == BlockKind::Assistant)
			.expect("assistant block");
		assert_eq!(block.view.mode, Mode::AppendOnly);
		assert!(!block.view.finalized);
		assert_eq!(block.stream.as_deref(), Some("first paragraph\n\nsecond paragraph"));
	}

	#[test]
	fn mixed_assistant_parts_preserve_provider_order_and_stream_identity() {
		let local = Local::default();
		let options = Options { smooth: false, ..Options::new(&local) };
		let mut session = empty_session();
		session.begin_turn().expect("turn");
		session.user("mix them", Vec::new()).expect("user");
		session
			.assistant_start("test/model", "test", "test/model")
			.expect("assistant");
		let turn = *session
			.dom()
			.children(session.dom().body())
			.last()
			.expect("turn");
		let assistant = *session.dom().children(turn).last().expect("assistant");

		let first = insert_assistant_part(&mut session, assistant, 0, "text");
		let sid = session
			.stream_open(first, PropId::Text.into())
			.expect("first text stream");
		session.stream_append(sid, "before").expect("first text");
		session.stream_close(sid).expect("first text close");
		let image_one = insert_artifact(&mut session, assistant, 1, 1);
		let last = insert_assistant_part(&mut session, assistant, 2, "text");
		let sid = session
			.stream_open(last, PropId::Text.into())
			.expect("last text stream");
		session.stream_append(sid, "aft").expect("last text prefix");

		let before = projected(&session, &options);
		let tail = before
			.iter()
			.find(|block| block.view.key == block_key(last, BlockKind::Assistant))
			.expect("streamed tail");
		assert_eq!(tail.stream.as_deref(), Some("aft"));
		assert!(!tail.view.finalized);
		assert_eq!(
			before
				.iter()
				.filter(|block| {
					matches!(block.view.kind, BlockKind::Assistant | BlockKind::Thinking)
				})
				.map(|block| (block.view.key, block.view.text.as_str()))
				.collect::<Vec<_>>(),
			[
				(block_key(first, BlockKind::Assistant), "before"),
				(
					block_key(image_one, BlockKind::Assistant),
					"artifact://sha256/0101010101010101010101010101010101010101010101010101010101010101"
				),
				(block_key(last, BlockKind::Assistant), "aft"),
			]
		);
		session.stream_append(sid, "er").expect("last text suffix");
		let after = projected(&session, &options);
		let tail = after
			.iter()
			.find(|block| block.view.key == block_key(last, BlockKind::Assistant))
			.expect("same streamed tail");
		assert_eq!(tail.stream.as_deref(), Some("after"));
		assert_eq!(
			tail.view.key,
			block_key(last, BlockKind::Assistant),
			"stream updates keep one slot identity"
		);
		session.stream_close(sid).expect("last text close");

		let thought_one = insert_assistant_part(&mut session, assistant, 3, "thinking");
		let sid = session
			.stream_open(thought_one, PropId::Text.into())
			.expect("thinking stream");
		session
			.stream_append(sid, "first thought")
			.expect("thinking");
		session.stream_close(sid).expect("thinking close");
		let image_two = insert_artifact(&mut session, assistant, 4, 2);
		let thought_two = insert_assistant_part(&mut session, assistant, 5, "thinking");
		let sid = session
			.stream_open(thought_two, PropId::Text.into())
			.expect("second thinking stream");
		session
			.stream_append(sid, "second thought")
			.expect("thinking");
		session.stream_close(sid).expect("thinking close");
		let image_three = insert_artifact(&mut session, assistant, 6, 3);
		let image_four = insert_artifact(&mut session, assistant, 7, 4);

		let ordered = projected(&session, &options)
			.into_iter()
			.filter(|block| matches!(block.view.kind, BlockKind::Assistant | BlockKind::Thinking))
			.map(|block| (block.view.key, block.view.text))
			.collect::<Vec<_>>();
		assert_eq!(
			ordered
				.iter()
				.map(|(key, text)| (*key, text.as_str()))
				.collect::<Vec<_>>(),
			[
				(block_key(first, BlockKind::Assistant), "before"),
				(
					block_key(image_one, BlockKind::Assistant),
					"artifact://sha256/0101010101010101010101010101010101010101010101010101010101010101"
				),
				(block_key(last, BlockKind::Assistant), "after"),
				(block_key(thought_one, BlockKind::Thinking), "first thought"),
				(
					block_key(image_two, BlockKind::Assistant),
					"artifact://sha256/0202020202020202020202020202020202020202020202020202020202020202"
				),
				(block_key(thought_two, BlockKind::Thinking), "second thought"),
				(
					block_key(image_three, BlockKind::Assistant),
					"artifact://sha256/0303030303030303030303030303030303030303030303030303030303030303"
				),
				(
					block_key(image_four, BlockKind::Assistant),
					"artifact://sha256/0404040404040404040404040404040404040404040404040404040404040404"
				),
			]
		);
	}

	#[test]
	fn tool_cards_preserve_interleaved_provider_order_after_replay() {
		let local = Local::default();
		let options = Options { smooth: false, ..Options::new(&local) };
		let mut session = empty_session();
		let path = session.journal_path().to_path_buf();
		session.begin_turn().expect("turn");
		session.user("mix tools", Vec::new()).expect("user");
		session
			.assistant_start("test/model", "test", "test/model")
			.expect("assistant");
		let turn = *session
			.dom()
			.children(session.dom().body())
			.last()
			.expect("turn");
		let assistant = *session.dom().children(turn).last().expect("assistant");

		let before = insert_assistant_part(&mut session, assistant, 0, "text");
		let sid = session
			.stream_open(before, PropId::Text.into())
			.expect("before stream");
		session.stream_append(sid, "before").expect("before text");
		session.stream_close(sid).expect("before close");
		let call = session
			.call(
				"read",
				1,
				"call-ordered",
				None,
				Some(
					serde_json::value::RawValue::from_string(r#"{"path":"README.md"}"#.to_owned())
						.expect("arguments"),
				),
				None,
			)
			.expect("ordered call");
		let tool = session.call_handle(call).expect("tool handle");
		session
			.patch(omp_dom::Txn {
				cause: call,
				label: Some(Str::new_static("tool.provider-order")),
				ops:   vec![omp_dom::Op::Set {
					h:     tool,
					prop:  PropKey::Custom(Str::new_static(PROVIDER_BLOCK_INDEX_PROP)),
					value: Value::Int(1),
				}],
			})
			.expect("provider order");
		session
			.settle(
				call,
				serde_json::value::RawValue::from_string(
					r#"{"content":[{"type":"text","text":"ok"}]}"#.to_owned(),
				)
				.expect("outcome"),
			)
			.expect("settle");
		let after = insert_assistant_part(&mut session, assistant, 2, "text");
		let sid = session
			.stream_open(after, PropId::Text.into())
			.expect("after stream");
		session.stream_append(sid, "after").expect("after text");
		session.stream_close(sid).expect("after close");
		session.assistant_end("stop").expect("assistant end");
		drop(session);

		let replayed = Session::open(path, ComponentRegistry::standard()).expect("replay");
		let ordered = projected(&replayed, &options)
			.into_iter()
			.filter(|block| matches!(block.view.kind, BlockKind::Assistant | BlockKind::Tool))
			.map(|block| block.view.kind)
			.collect::<Vec<_>>();
		assert_eq!(ordered, [BlockKind::Assistant, BlockKind::Tool, BlockKind::Assistant],);
	}

	/// `#shouldAnimateThinking`: with reasoning hidden, the pulse shows
	/// while the model's newest delta is reasoning — including a second
	/// reasoning phase after visible text — and ends once text is the tail.
	#[test]
	fn hidden_thinking_pulse_follows_the_streaming_head_not_prior_text() {
		let session = streaming("considering", "partial answer");
		let has_pulse = |local: &Local| {
			let options = Options { show_thinking: false, ..Options::new(local) };
			projected(&session, &options)
				.iter()
				.any(|block| block.view.kind == BlockKind::Thinking && block.view.text == "Thinking")
		};
		let mut local = Local::default();
		assert!(!local.on_kernel_event(&KernelEvent::InferenceStarted, Duration::ZERO));
		assert!(local.on_kernel_event(&KernelEvent::ThinkingDelta("c".into()), Duration::ZERO));
		assert!(!local.on_kernel_event(&KernelEvent::ThinkingDelta("o".into()), Duration::ZERO));
		assert!(has_pulse(&local), "reasoning is the head");
		assert!(local.on_kernel_event(&KernelEvent::TextDelta("p".into()), Duration::ZERO));
		assert!(!has_pulse(&local), "text is the head");
		assert!(local.on_kernel_event(&KernelEvent::ThinkingDelta("more".into()), Duration::ZERO));
		assert!(has_pulse(&local), "a later reasoning phase pulses again despite prior text");
		assert!(!local.on_kernel_event(&KernelEvent::InferenceStarted, Duration::ZERO));
		assert_eq!(local.stream_head(), None);
		assert!(!has_pulse(&local), "without a delta observed, started text means reasoning stopped");
		let fresh = streaming("considering", "");
		let options = Options { show_thinking: false, ..Options::new(&local) };
		assert!(
			projected(&fresh, &options)
				.iter()
				.any(|block| block.view.text == "Thinking"),
			"without a delta observed, reasoning with no text pulses"
		);
	}

	/// The handle of the last `<user>` in the newest turn.
	fn last_user(session: &Session) -> Handle {
		let turn = *session
			.dom()
			.children(session.dom().body())
			.last()
			.expect("turn");
		session
			.dom()
			.children(turn)
			.iter()
			.copied()
			.rev()
			.find(|handle| {
				session
					.dom()
					.get(*handle)
					.is_some_and(|node| node.tag == Tag::Known(KnownTag::User))
			})
			.expect("user handle")
	}

	fn set_prop(session: &mut Session, handle: Handle, prop: PropId, value: Value) {
		session
			.patch(omp_dom::Txn {
				cause: session.head().expect("head"),
				label: None,
				ops:   vec![omp_dom::Op::Set { h: handle, prop: prop.into(), value }],
			})
			.expect("patch");
	}

	/// A finalized reply of `text` after the user prompt in the newest turn.
	fn reply(session: &mut Session, text: &str) {
		session
			.assistant_start("test/model", "test", "test/model")
			.expect("assistant");
		let turn = *session
			.dom()
			.children(session.dom().body())
			.last()
			.expect("turn");
		let assistant = *session.dom().children(turn).last().expect("assistant");
		let sid = session
			.stream_open(assistant, PropId::Text.into())
			.expect("text stream");
		session.stream_append(sid, text).expect("text delta");
		session.stream_close(sid).expect("close");
		session.assistant_end("stop").expect("end");
	}

	/// The rendered user row and the first reply block, consumed from a
	/// projection.
	fn user_and_assistant(blocks: Vec<RenderedBlock>) -> (String, Option<RenderedBlock>) {
		let mut user = None;
		let mut assistant = None;
		for block in blocks {
			match block.view.kind {
				BlockKind::User if user.is_none() => user = Some(block),
				BlockKind::Assistant if assistant.is_none() => assistant = Some(block),
				_ => {},
			}
		}
		let user = user.expect("user block");
		(render(user.component, 40), assistant)
	}

	fn user_and_assistant_text(blocks: Vec<RenderedBlock>) -> (String, Option<Str>) {
		let (user, assistant) = user_and_assistant(blocks);
		(user, assistant.map(|block| block.view.text))
	}

	/// Journaled attachments (`<user data=[BlobRef…]>`) the text does not
	/// reference render as `<paperclip> #N · size` chips under the prompt,
	/// while an attachment the text already shows as a vision marker is not
	/// repeated; the chips ride guest and synthetic rows too.
	#[test]
	fn journaled_attachments_render_as_chips_under_the_prompt() {
		let local = Local::default();
		let options = Options::new(&local);
		let blob = |size: u64| Attachment {
			blob: omp_journal::blob::BlobRef { hash: omp_core::Hash32::new([7; 32]), size },
			mime: Str::new_static("image/png"),
		};
		let mut session = empty_session();
		session.begin_turn().expect("turn");
		session
			.user("look at [Image #1, 640x480] attachment://1 please", vec![blob(2048), blob(300)])
			.expect("user");
		let (text, _) = user_and_assistant_text(projected(&session, &options));
		let clip = Charset::default().icon(Icon::Paperclip);
		let image = Charset::default().icon(Icon::Image);
		assert!(text.contains(&format!("{image} #1")), "vision marker collapses:\n{text}");
		assert!(text.contains(&format!("{clip} #2 · 300B")), "unreferenced attachment chip:\n{text}");
		assert!(
			!text.contains(&format!("{clip} #1")),
			"referenced attachment is not repeated:\n{text}"
		);

		let user = last_user(&session);
		set_prop(&mut session, user, PropId::Author, Value::Str(Str::new_static("ada")));
		let (guest, _) = user_and_assistant_text(projected(&session, &options));
		assert!(guest.contains("«ada» ›"), "{guest}");
		assert!(guest.contains(&format!("{image} #1")), "guest bubble collapses markers:\n{guest}");
		assert!(guest.contains(&format!("{clip} #2 · 300B")), "guest bubble keeps chips:\n{guest}");

		set_prop(&mut session, user, PropId::Author, Value::Null);
		set_prop(&mut session, user, PropId::Synthetic, Value::Bool(true));
		let (synthetic, _) =
			user_and_assistant_text(projected(&session, &Options { expanded: true, ..options }));
		assert!(synthetic.contains("Synthetic input"), "{synthetic}");
		assert!(
			synthetic.contains(&format!("{image} #1")),
			"synthetic row collapses markers:\n{synthetic}"
		);
		assert!(!synthetic.contains("[Image #1"), "{synthetic}");
		assert!(
			synthetic.contains(&format!("{clip} #2 · 300B")),
			"synthetic row keeps chips:\n{synthetic}"
		);
	}

	/// `reaction.ts` + `#reactionRow`: a reply opening with a lone emoji
	/// line badges the preceding user bubble (right-aligned in its top
	/// padding row) and the emoji leaves the prose; the badge survives a
	/// re-projection because it derives from the journaled text.
	#[test]
	fn leading_emoji_line_badges_the_user_bubble_and_leaves_the_prose() {
		let local = Local::default();
		let options = Options { smooth: false, ..Options::new(&local) };
		let mut session = empty_session();
		session.begin_turn().expect("turn");
		session.user("ship it", Vec::new()).expect("user");
		reply(&mut session, "🎉\nShipped.");
		let (user, assistant) = user_and_assistant(projected(&session, &options));
		let rows: Vec<&str> = user.split('\n').collect();
		assert!(rows[0].trim_end().ends_with("🎉"), "badge in the top padding row:\n{user}");
		assert!(rows[0].starts_with(' '), "badge sits inside the horizontal padding:\n{user}");
		assert!(user.contains("ship it"), "{user}");
		assert!(rows.last().is_some_and(|row| row.trim().is_empty()), "bottom pad row:\n{user}");
		let assistant = assistant.expect("assistant block");
		assert_eq!(assistant.view.text, "Shipped.", "the emoji line leaves the prose");
		assert_eq!(assistant.stream.as_deref(), Some("Shipped."));
		assert!(!render(assistant.component, 40).contains("🎉"));
	}

	/// No target, no reaction: a reply after tool calls (a continuation)
	/// keeps a leading emoji line verbatim, and a synthetic prompt takes no
	/// badge. While streaming, an emoji-only opening run is withheld until
	/// it proves to be a reaction or ordinary text.
	#[test]
	fn reactions_need_a_user_bubble_target_and_are_withheld_while_pending() {
		let local = Local::default();
		let options = Options { smooth: false, ..Options::new(&local) };
		let mut session = empty_session();
		session.begin_turn().expect("turn");
		session.user("do two things", Vec::new()).expect("user");
		reply(&mut session, "First.");
		reply(&mut session, "👍\nSecond.");
		let blocks = projected(&session, &options);
		let second = blocks
			.iter()
			.filter(|block| block.view.kind == BlockKind::Assistant)
			.nth(1)
			.expect("second reply");
		assert_eq!(second.view.text, "👍\nSecond.", "a continuation has nothing to react to");
		let (user, _) = user_and_assistant_text(blocks);
		assert!(!user.contains("👍"), "{user}");

		let mut session = empty_session();
		session.begin_turn().expect("turn");
		session
			.user("# Session update\nstate", Vec::new())
			.expect("user");
		let user = last_user(&session);
		set_prop(&mut session, user, PropId::Synthetic, Value::Bool(true));
		reply(&mut session, "👍\nNoted.");
		let (row, assistant) = user_and_assistant_text(projected(&session, &options));
		assert!(!row.contains("👍"), "synthetic rows take no badge:\n{row}");
		assert_eq!(assistant.as_deref(), Some("👍\nNoted."), "left verbatim without a target");

		let live = streaming("", "👍");
		let blocks = projected(&live, &options);
		assert!(
			!blocks
				.iter()
				.any(|block| block.view.kind == BlockKind::Assistant),
			"an emoji-only opening run is withheld while it may still become a reaction"
		);
		let live = streaming("", "👍 sure");
		let (user, assistant) = user_and_assistant_text(projected(&live, &options));
		assert!(user.contains("👍"), "complete opening emoji becomes the reaction:\n{user}");
		assert_eq!(assistant.as_deref(), Some("sure"), "remaining prose streams through");
	}

	/// `collapseImageMarkers`: bracketed vision markers (and their paired
	/// `attachment://N` reference) become the composer's `<icon> #N` chip;
	/// malformed markers and ordinary brackets stay verbatim.
	#[test]
	fn image_markers_collapse_into_attachment_chips() {
		let image = Charset::Unicode.icon(Icon::Image);
		let video = Charset::Unicode.icon(Icon::Video);
		let collapse = |text: &str| collapse_image_markers(&Str::new(text), Charset::Unicode);
		assert_eq!(
			collapse("see [Image #1, 640x480] attachment://1 and [Video #12] now"),
			format!("see {image} #1 and {video} #12 now")
		);
		assert_eq!(collapse("[Image #2] attachment://21"), format!("{image} #2 attachment://21"));
		assert_eq!(
			collapse("[Image #0] [Image #] [Image #1, a\nb] [x] [Image #3"),
			"[Image #0] [Image #] [Image #1, a\nb] [x] [Image #3"
		);
		assert_eq!(collapse("plain [brackets]"), "plain [brackets]");
		assert_eq!(collapse("[Image #1]"), format!("{image} #1"));
		assert_eq!(
			collapse_image_markers(&Str::new("[Image #1]"), Charset::Ascii),
			format!("{} #1", Charset::Ascii.icon(Icon::Image))
		);
	}
}
