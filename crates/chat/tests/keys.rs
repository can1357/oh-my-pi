//! Key semantics of the interactive actor: Escape ladder, Ctrl+C,
//! dequeue, clipboard chords, panel routing, gestures, and Esc hooks.

use std::{
	sync::{
		Arc,
		atomic::{AtomicUsize, Ordering},
	},
	time::{Duration, Instant},
};

use omp_agent::Up;
use omp_chat::{
	HostAction, HostCommand, HostOptions, NativeEffect, NativeHost,
	actions::{EscapeHook, EscapeRung, SttUiEvent},
	composer::{SPACE_HOLD_RELEASE, SpaceHold, SpaceHoldEvent},
	overlays::{
		NoServices, Panel, PanelAction, PanelAnchor, PanelCall, PanelEvent, PanelOpener,
		live::LiveControl,
	},
};
use omp_core::Str;
use omp_dom::{KnownTag, NodeSpec, Op, PropId, Tag, Txn, Value};
use omp_session::{ComponentRegistry, Session};
use omp_tui::{
	Chord, Frame, InputDecoder, InputEvent, Key, KeyEvent, Mods, Mouse, MouseButton, MouseReport,
	Size, UiContext,
	paste::{Clipboard, ClipboardRead, ClipboardReadOutcome, ClipboardWriteOutcome},
	slots::ResizePolicy,
};
use tempfile::tempdir;

const BINDS: &str = r#"
bind escape cl_interrupt
bind ctrl+c cl_clear
bind alt+up cl_dequeue
bind shift+up cl_dequeue
bind alt+shift+l cl_copy_line
bind alt+shift+c cl_copy_prompt
bind ctrl+v cl_paste_image
bind ctrl+shift+v cl_paste_raw
bind ctrl+shift+d debug
bind ctrl+p panel_toggle_path
bind ctrl+s panel_toggle_sort
bind ctrl+r panel_rename
bind ctrl+d "panel_delete; cl_exit; ed_delete"
bind ctrl+w panel_delete_fast
bind ctrl+left panel_fold_up
bind ctrl+right panel_unfold_down
bind ctrl+o panel_expand
bind ctrl+q cl_followup
bind ctrl+enter cl_followup
bind alt+r cl_retry
"#;

struct Harness {
	host:     NativeHost,
	commands: flume::Receiver<HostCommand>,
	up:       flume::Receiver<Up>,
	session:  Session,
	con:      Arc<omp_con::Ctx>,
}

fn idle_session() -> Session {
	let directory = tempdir().expect("temp directory");
	let path = directory.keep().join("keys.oms");
	let mut session = Session::create(path, ComponentRegistry::standard()).expect("create session");
	session.begin_turn().expect("begin turn");
	session.user("earlier prompt", Vec::new()).expect("user");
	session
		.assistant_start("test/model", "test", "test/model")
		.expect("assistant start");
	session.assistant_end("stop").expect("assistant end");
	session
		.receipt(omp_journal::data::TurnReceipt::tokens(1, 1, 0))
		.expect("receipt");
	session
}

fn harness(mut session: Session) -> Harness {
	let (snapshot, dom_events) = session.subscribe();
	let (_, kernel_events) = flume::unbounded();
	let (commands, command_rx) = flume::unbounded();
	let (up, up_rx) = flume::unbounded();
	let con = Arc::new(
		omp_chat::HostMailbox::new()
			.attach(omp_con::Ctx::builder())
			.build(),
	);
	con.run(BINDS).expect("binds");
	let host = NativeHost::new(
		HostOptions {
			model: omp_chat::ModelBadge::from_identifier("test/model"),
			snapshot,
			dom_events,
			kernel_events,
			commands,
			up,
			con: Arc::clone(&con),
			models: Vec::new(),
			cycle: Vec::new(),
			resize_policy: ResizePolicy::Rebuild,
			project: std::path::PathBuf::new(),
			welcome: omp_chat::welcome::WelcomeFacts::default(),
			ui: UiContext::default(),
			services: Arc::new(NoServices),
			speech: None,
			resuming: false,
			initial_panel: None,
		},
		Size::new(100, 30),
	);
	Harness { host, commands: command_rx, up: up_rx, session, con }
}

fn open_turn(session: &mut Session) {
	session.begin_turn().expect("begin turn");
	session.user("streaming", Vec::new()).expect("user");
	session
		.assistant_start("test/model", "test", "test/model")
		.expect("assistant start");
}

fn type_text(host: &mut NativeHost, text: &str) {
	for character in text.chars() {
		host.key(Key::Char(character)).expect("type");
	}
}

fn real_png(width: u32, height: u32) -> Vec<u8> {
	let image = image::DynamicImage::new_rgba8(width, height);
	let mut output = std::io::Cursor::new(Vec::new());
	image
		.write_to(&mut output, image::ImageFormat::Png)
		.expect("encode png");
	output.into_inner()
}

fn engage_director(session: &mut Session, family: &'static str) {
	let dom = session.dom();
	let directors = dom
		.children(dom.meta())
		.iter()
		.copied()
		.find(|handle| {
			dom.get(*handle)
				.is_some_and(|node| node.tag == Tag::Known(KnownTag::Directors))
		})
		.expect("directors component");
	let cause = session.head().expect("head");
	session
		.patch(Txn {
			cause,
			label: None,
			ops: vec![Op::Ins {
				parent: directors,
				after:  None,
				node:   NodeSpec::new(KnownTag::Director)
					.with_prop(
						omp_dom::PropKey::Custom(Str::new_static("family")),
						Value::Str(Str::new_static(family)),
					)
					.with_prop(
						omp_dom::PropKey::Custom(Str::new_static("status")),
						Value::Str(Str::new_static("active")),
					),
			}],
		})
		.expect("engage director");
}

fn queue_prompt(session: &mut Session, id: &'static str, text: &'static str) {
	let dom = session.dom();
	let prompts = dom
		.children(dom.queues())
		.iter()
		.copied()
		.find(|handle| {
			dom.get(*handle)
				.is_some_and(|node| node.tag == Tag::Known(KnownTag::Prompts))
		})
		.expect("prompts queue");
	let cause = session.head().expect("head");
	session
		.patch(Txn {
			cause,
			label: None,
			ops: vec![Op::Ins {
				parent: prompts,
				after:  session.dom().children(prompts).last().copied(),
				node:   NodeSpec::new(KnownTag::Prompt)
					.with_prop(PropId::Id, Value::Str(Str::new_static(id)))
					.with_prop(PropId::Kind, Value::Str(Str::new_static("queued")))
					.with_prop(PropId::Status, Value::Str(Str::new_static("pending")))
					.with_content(Str::new_static(text)),
			}],
		})
		.expect("queue prompt");
}

// ---------------------------------------------------------------- escape
// ladder

#[test]
fn escape_preserves_a_draft_and_never_interrupts_an_idle_session() {
	let mut h = harness(idle_session());
	type_text(&mut h.host, "draft");
	h.host.key(Key::Esc).expect("esc");
	assert_eq!(h.host.composer_text(), "draft");
	assert!(h.commands.try_recv().is_err(), "an idle session has nothing to interrupt");
}

#[test]
fn escape_interrupts_a_streaming_turn_and_restores_queued_prompts() {
	let mut session = idle_session();
	open_turn(&mut session);
	queue_prompt(&mut session, "q1", "queued one");
	let mut h = harness(session);
	// The kernel answers the unqueue with one undelivered steer.
	let up = h.up.clone();
	std::thread::spawn(move || {
		if let Ok(Up::Unqueue(reply)) = up.recv_timeout(Duration::from_secs(2)) {
			let _ = reply.send(vec![Str::new_static("steer one")]);
		}
	});
	type_text(&mut h.host, "draft");
	h.host.key(Key::Esc).expect("esc");
	assert_eq!(h.host.composer_text(), "steer one\n\nqueued one\n\ndraft");
	let mut saw_dequeue = false;
	let mut saw_interrupt = false;
	while let Ok(command) = h.commands.try_recv() {
		match command {
			HostCommand::Dequeue { prompts } => {
				assert_eq!(prompts, [Str::new_static("q1")]);
				saw_dequeue = true;
			},
			HostCommand::Interrupt => saw_interrupt = true,
			other => panic!("unexpected {other:?}"),
		}
	}
	assert!(saw_dequeue && saw_interrupt);
}

#[test]
fn double_escape_within_500ms_on_an_empty_composer_runs_the_selector_line() {
	let mut h = harness(idle_session());
	// What the configured `branch` line does when run directly.
	h.host.console("branch").expect("console");
	let expected = (h.host.overlay_id(), h.host.notice().map(str::to_owned));
	while h.host.overlay_id().is_some() {
		h.host.key(Key::Esc).expect("close");
	}
	h.host.key(Key::Char('x')).expect("clear notice");
	h.host.key(Key::Backspace).expect("clear notice");

	// A lone Esc, then a late second one: nothing.
	h.host.key(Key::Esc).expect("esc");
	assert_eq!(h.host.overlay_id(), None);
	std::thread::sleep(Duration::from_millis(600));
	h.host.key(Key::Esc).expect("esc");
	assert_eq!(h.host.overlay_id(), None);
	// Two within the window: the `branch` line runs.
	h.host.key(Key::Esc).expect("esc");
	assert_eq!((h.host.overlay_id(), h.host.notice().map(str::to_owned)), expected);
	assert!(expected.0.is_some() || expected.1.is_some(), "double escape must reach the console");
	// `none` disables it.
	h.con.run("cl_double_escape none").expect("set");
	while h.host.overlay_id().is_some() {
		h.host.key(Key::Esc).expect("close");
	}
	h.host.key(Key::Esc).expect("esc");
	h.host.key(Key::Esc).expect("esc");
	assert_eq!(h.host.overlay_id(), None);
}

#[test]
fn buffered_double_escape_burst_reaches_the_host_as_two_press_edges() {
	let mut h = harness(idle_session());
	let start = Instant::now();
	let mut decoder = InputDecoder::new();
	decoder.keymap_mut().set_chord_events(true);
	let mut events = Vec::new();
	decoder.feed(b"\x1b\x1b", start, &mut events);
	assert!(events.is_empty(), "the ambiguous burst waits for the framing deadline");
	decoder.tick(start + Duration::from_millis(100), &mut events);
	assert_eq!(events.len(), 2);
	for event in events {
		let InputEvent::Chord(event) = event else {
			panic!("double Escape must preserve physical chord events");
		};
		h.host.chord(event).expect("route buffered Escape");
	}
	assert!(
		h.host.overlay_id().is_some() || h.host.notice().is_some(),
		"the second Escape runs the configured branch selector"
	);
}

#[test]
fn double_escape_never_fires_while_a_draft_exists() {
	let mut h = harness(idle_session());
	type_text(&mut h.host, "keep me");
	h.host.key(Key::Esc).expect("esc");
	h.host.key(Key::Esc).expect("esc");
	assert_eq!(h.host.overlay_id(), None);
	assert_eq!(h.host.composer_text(), "keep me");
}

#[test]
fn escape_in_bash_or_eval_prefix_mode_clears_the_draft_instead_of_interrupting() {
	let mut session = idle_session();
	open_turn(&mut session);
	let mut h = harness(session);
	type_text(&mut h.host, "!ls -la");
	h.host.key(Key::Esc).expect("esc");
	assert_eq!(h.host.composer_text(), "");
	assert!(h.commands.try_recv().is_err(), "prefix mode wins over the streaming rung");
	type_text(&mut h.host, "$ 1+1");
	h.host.key(Key::Esc).expect("esc");
	assert_eq!(h.host.composer_text(), "");
}

#[test]
fn escape_preserves_dollar_prefixed_prose() {
	for draft in ["$HOME", "${x}"] {
		let mut h = harness(idle_session());
		type_text(&mut h.host, draft);
		h.host.key(Key::Esc).expect("esc");
		assert_eq!(h.host.composer_text(), draft);
		assert!(h.commands.try_recv().is_err());
	}
}

#[test]
fn escape_cancel_hooks_fire_once_and_silence_hooks_stay() {
	let mut session = idle_session();
	open_turn(&mut session);
	let mut h = harness(session);
	let cancelled = Arc::new(AtomicUsize::new(0));
	let silenced = Arc::new(AtomicUsize::new(0));
	let speaking = Arc::new(AtomicUsize::new(1));
	{
		let cancelled = Arc::clone(&cancelled);
		h.host
			.act(HostAction::EscapeHook(EscapeHook::new("mcp-test", EscapeRung::Cancel, move || {
				cancelled.fetch_add(1, Ordering::SeqCst);
				true
			})))
			.expect("hook");
	}
	{
		let silenced = Arc::clone(&silenced);
		let speaking = Arc::clone(&speaking);
		h.host
			.act(HostAction::EscapeHook(EscapeHook::new(
				"vocalizer",
				EscapeRung::Silence,
				move || {
					if speaking.swap(0, Ordering::SeqCst) == 1 {
						silenced.fetch_add(1, Ordering::SeqCst);
						true
					} else {
						false
					}
				},
			)))
			.expect("hook");
	}
	assert_eq!(h.host.escape_hooks(), ["mcp-test", "vocalizer"]);
	// Rung 1: the cancel hook fires and is forgotten; nothing else happens.
	h.host.key(Key::Esc).expect("esc");
	assert_eq!(cancelled.load(Ordering::SeqCst), 1);
	assert_eq!(silenced.load(Ordering::SeqCst), 0);
	assert_eq!(h.host.escape_hooks(), ["vocalizer"]);
	assert!(h.commands.try_recv().is_err());
	// Rung 4: the vocalizer is silenced before the turn is touched.
	h.host.key(Key::Esc).expect("esc");
	assert_eq!(silenced.load(Ordering::SeqCst), 1);
	assert!(h.commands.try_recv().is_err());
	// Nothing left to silence: the streaming turn is interrupted.
	h.host.key(Key::Esc).expect("esc");
	assert!(matches!(h.commands.try_recv(), Ok(HostCommand::Interrupt)));
	assert_eq!(h.host.escape_hooks(), ["vocalizer"], "silence hooks persist");
}

#[test]
fn escape_in_loop_mode_pauses_when_idle_and_interrupts_when_streaming() {
	let mut session = idle_session();
	engage_director(&mut session, "loop_mode");
	let mut h = harness(session);
	h.host.key(Key::Esc).expect("esc");
	// `pause` is the console line; whatever it does, it never reaches
	// Interrupt and never opens a selector.
	assert!(!matches!(h.commands.try_recv(), Ok(HostCommand::Interrupt)));
	assert!(!matches!(h.host.overlay_id(), Some("rewind" | "tree")));
	while h.host.overlay_id().is_some() {
		h.host.key(Key::Esc).expect("close");
	}
	open_turn(&mut h.session);
	h.host.poll().expect("apply");
	h.host.key(Key::Esc).expect("esc");
	assert!(
		h.commands
			.try_iter()
			.any(|command| matches!(command, HostCommand::Interrupt))
	);
}

#[test]
fn escape_in_a_subagent_view_clears_text_then_returns_to_main() {
	let mut session = idle_session();
	open_turn(&mut session);
	let mut h = harness(session);
	h.host
		.act(HostAction::FocusAgent(Some(Str::new_static("worker-1"))))
		.expect("focus");
	assert_eq!(h.host.focused_agent(), Some("worker-1"));
	assert!(matches!(h.commands.try_recv(), Ok(HostCommand::Overlay { open: true, .. })));
	type_text(&mut h.host, "note");
	h.host.key(Key::Esc).expect("esc");
	assert_eq!(h.host.composer_text(), "");
	assert_eq!(h.host.focused_agent(), Some("worker-1"), "first Esc only clears text");
	h.host.key(Key::Esc).expect("esc");
	assert_eq!(h.host.focused_agent(), None, "second Esc returns to main");
	assert!(matches!(h.commands.try_recv(), Ok(HostCommand::Overlay { open: false, .. })));
	assert!(h.commands.try_recv().is_err(), "the focused subagent's turn is never interrupted");
}

#[test]
fn double_left_on_an_empty_composer_unfocuses_the_subagent() {
	let mut h = harness(idle_session());
	h.host
		.act(HostAction::FocusAgent(Some(Str::new_static("worker-1"))))
		.expect("focus");
	// A synthesized burst (no gap) never counts.
	h.host.key(Key::Left).expect("left");
	h.host.key(Key::Left).expect("left");
	assert_eq!(h.host.focused_agent(), Some("worker-1"));
	std::thread::sleep(Duration::from_millis(600));
	h.host.key(Key::Left).expect("left");
	std::thread::sleep(Duration::from_millis(80));
	h.host.key(Key::Left).expect("left");
	assert_eq!(h.host.focused_agent(), None);
}

#[test]
fn collab_guest_escape_forwards_an_interrupt_and_stops_there() {
	let mut session = idle_session();
	open_turn(&mut session);
	let mut h = harness(session);
	h.host.act(HostAction::CollabGuest(true)).expect("guest");
	type_text(&mut h.host, "draft");
	h.host.key(Key::Esc).expect("esc");
	assert!(matches!(h.commands.try_recv(), Ok(HostCommand::Interrupt)));
	assert_eq!(h.host.composer_text(), "draft", "guest Esc never touches the draft");
}

#[test]
fn escape_cancels_main_session_maintenance_but_not_from_a_subagent_view() {
	let mut session = idle_session();
	open_turn(&mut session);
	engage_director(&mut session, "compaction");
	let mut h = harness(session);
	h.host.key(Key::Esc).expect("esc");
	assert!(matches!(h.commands.try_recv(), Ok(HostCommand::Interrupt)));
	h.host
		.act(HostAction::FocusAgent(Some(Str::new_static("worker-1"))))
		.expect("focus");
	let _ = h.commands.try_recv();
	h.host.key(Key::Esc).expect("esc");
	assert_eq!(h.host.focused_agent(), None);
	assert!(
		!h.commands
			.try_iter()
			.any(|command| matches!(command, HostCommand::Interrupt)),
		"Esc from a focused subagent returns to main instead of cancelling maintenance"
	);
}

// ---------------------------------------------------------------- ctrl+c

#[test]
fn ctrl_c_clears_the_draft_and_a_fresh_first_press_stops_recording() {
	let mut h = harness(idle_session());
	type_text(&mut h.host, "draft");
	h.host.key(Key::Ctrl('c')).expect("ctrl+c");
	assert_eq!(h.host.composer_text(), "");

	let mut h = harness(idle_session());
	h.host.act(HostAction::SttToggle).expect("record");
	assert!(h.host.recording());
	assert!(matches!(h.commands.try_recv(), Ok(HostCommand::PushToTalk { active: true })));
	h.host.key(Key::Ctrl('c')).expect("ctrl+c");
	assert!(!h.host.recording());
	assert!(matches!(h.commands.try_recv(), Ok(HostCommand::PushToTalk { active: false })));
}

#[test]
fn first_ctrl_c_with_an_empty_active_composer_is_non_destructive_then_repeat_quits() {
	let mut session = idle_session();
	open_turn(&mut session);
	let mut h = harness(session);
	assert_ne!(h.host.key(Key::Ctrl('c')).expect("first ctrl+c"), NativeEffect::Quit);
	assert!(
		!h.commands
			.try_iter()
			.any(|command| matches!(command, HostCommand::Interrupt)),
		"the first Ctrl+C clears; it does not interrupt solely because a turn is active"
	);
	assert_eq!(h.host.key(Key::Ctrl('c')).expect("second ctrl+c"), NativeEffect::Quit);
}

#[test]
fn ctrl_d_exits_without_editing_the_draft() {
	let mut h = harness(idle_session());
	type_text(&mut h.host, "save this draft");
	assert_eq!(h.host.key(Key::Ctrl('d')).expect("ctrl+d"), NativeEffect::Quit);
	assert_eq!(h.host.composer_text(), "save this draft");
}

// ---------------------------------------------------------------- dequeue

#[test]
fn shipped_shift_up_dequeues_unless_an_explicit_bind_claims_it() {
	let mut session = idle_session();
	queue_prompt(&mut session, "q1", "queued");
	let mut h = harness(session);
	let chord = Chord::parse("shift+up").expect("shift up");
	h.host
		.chord(KeyEvent { chord, key: Some(Key::RestoreQueue), pressed: true })
		.expect("shipped dequeue");
	assert_eq!(h.host.composer_text(), "queued");
	assert!(matches!(h.commands.try_recv(), Ok(HostCommand::Dequeue { .. })));

	let mut session = idle_session();
	queue_prompt(&mut session, "q1", "stay queued");
	let mut h = harness(session);
	h.con
		.run("bind shift+up ed_up")
		.expect("explicit editor bind");
	h.host
		.chord(KeyEvent { chord, key: Some(Key::RestoreQueue), pressed: true })
		.expect("custom shift up");
	assert!(
		!h.commands
			.try_iter()
			.any(|command| matches!(command, HostCommand::Dequeue { .. })),
		"the explicit binding steals Shift+Up from the shipped dequeue fallback"
	);
	assert_ne!(h.host.composer_text(), "stay queued");
}

#[test]
fn alt_up_restores_queued_prompts_ahead_of_the_draft() {
	let mut session = idle_session();
	queue_prompt(&mut session, "q1", "first");
	queue_prompt(&mut session, "q2", "second");
	let mut h = harness(session);
	type_text(&mut h.host, "draft");
	h.host.key(Key::RestoreQueue).expect("alt+up");
	assert_eq!(h.host.composer_text(), "first\n\nsecond\n\ndraft");
	assert_eq!(h.host.notice(), Some("Restored 2 queued messages to editor"));
	assert!(matches!(
		h.commands.try_recv(),
		Ok(HostCommand::Dequeue { prompts }) if prompts == [Str::new_static("q1"), Str::new_static("q2")]
	));
	assert!(h.up.try_recv().is_err(), "no turn: the kernel is not asked");
}

// ---------------------------------------------------------------- follow-up

/// While a turn streams, the draft is queued behind it, never sent
/// as mid-turn steering; idle, it starts a turn like Enter.
#[test]
fn follow_up_queues_behind_a_streaming_turn_and_submits_when_idle() {
	let mut session = idle_session();
	open_turn(&mut session);
	let mut h = harness(session);
	assert!(h.host.turn_active());
	type_text(&mut h.host, "after this");
	h.host.console("cl_followup").expect("follow up");
	assert_eq!(h.host.composer_text(), "");
	assert!(matches!(
		h.commands.try_recv(),
		Ok(HostCommand::Queue { prompt, attachments }) if prompt == "after this" && attachments.is_empty()
	));
	assert!(h.commands.try_recv().is_err(), "queued once, never also submitted or steered");
	assert!(h.up.try_recv().is_err(), "the host never steers the kernel directly");
	assert_eq!(h.host.notice(), Some("Queued message for when the agent yields"));
	// Up recalls the queued line like any submission.
	h.host.key(Key::Up).expect("history");
	assert_eq!(h.host.composer_text(), "after this");

	let mut h = harness(idle_session());
	type_text(&mut h.host, "right away");
	h.host.console("cl_followup").expect("follow up");
	assert!(matches!(
		h.commands.try_recv(),
		Ok(HostCommand::Submit(text)) if text == "right away"
	));
	assert!(h.host.turn_active(), "idle follow-up is an ordinary submission");

	// `/` lines still run as console statements through the follow-up chord.
	let mut session = idle_session();
	open_turn(&mut session);
	let mut h = harness(session);
	type_text(&mut h.host, "/help");
	h.host.console("cl_followup").expect("follow up");
	assert!(h.commands.try_recv().is_err(), "a slash command never queues");
	assert_eq!(h.host.composer_text(), "");
}

/// The keymap's decoded `Key::FollowUp` (Ctrl+Enter or Alt+Enter on the
/// wire) lowers to the primary `ctrl+enter` chord,
/// so a decoded-key caller (headless, RPC, debug injection) reaches the
/// same `cl_followup` bind as the physical chord.
#[test]
fn decoded_follow_up_key_runs_the_ctrl_enter_bind() {
	let mut session = idle_session();
	open_turn(&mut session);
	let mut h = harness(session);
	type_text(&mut h.host, "after this");
	h.host.key(Key::FollowUp).expect("follow up key");
	assert_eq!(h.host.composer_text(), "", "the bind queued the draft");
	assert!(matches!(
		h.commands.try_recv(),
		Ok(HostCommand::Queue { prompt, .. }) if prompt == "after this"
	));
	assert_eq!(h.host.notice(), Some("Queued message for when the agent yields"));
}

/// Both the semantic key emitted by legacy input routing and the exact Kitty /
/// modifyOtherKeys chord run the literal debug bind.
#[test]
fn ctrl_shift_d_opens_the_debug_selector() {
	let mut h = harness(idle_session());
	h.host.key(Key::DebugMenu).expect("semantic debug key");
	assert_eq!(h.host.overlay_id(), Some("debug"));
	h.host.key(Key::Esc).expect("close debug");

	let chord = Chord::parse("ctrl+shift+d").expect("debug chord");
	h.host
		.chord(KeyEvent { chord, key: Some(Key::DebugMenu), pressed: true })
		.expect("physical debug chord");
	assert_eq!(h.host.overlay_id(), Some("debug"));
}

/// `-> body` starts at once
/// when the agent is idle with an empty queue, otherwise queues behind the
/// stream / earlier follow-ups.
#[test]
fn queue_shorthand_starts_immediately_when_idle_else_queues() {
	let mut h = harness(idle_session());
	type_text(&mut h.host, "-> run tests");
	h.host.key(Key::Enter).expect("submit");
	assert!(matches!(
		h.commands.try_recv(),
		Ok(HostCommand::Submit(text)) if text == "run tests"
	));
	assert_eq!(h.host.notice(), Some("Sent queued message"));

	let mut session = idle_session();
	queue_prompt(&mut session, "q1", "earlier");
	let mut h = harness(session);
	type_text(&mut h.host, "=> then this");
	h.host.key(Key::Enter).expect("submit");
	assert!(matches!(
		h.commands.try_recv(),
		Ok(HostCommand::Queue { prompt, .. }) if prompt == "then this"
	));
	assert!(!h.host.turn_active(), "queueing behind an existing queue starts no turn");

	let mut session = idle_session();
	open_turn(&mut session);
	let mut h = harness(session);
	type_text(&mut h.host, "-> while streaming");
	h.host.key(Key::Enter).expect("submit");
	assert!(matches!(
		h.commands.try_recv(),
		Ok(HostCommand::Queue { prompt, .. }) if prompt == "while streaming"
	));
	assert!(h.up.try_recv().is_err());
}

/// An image chip
/// in the draft goes with the text — queued behind the stream through the
/// follow-up chord and the `->` shorthand (never steered), and submitted
/// with its attachments when the agent is idle.
#[test]
fn follow_up_and_queue_shorthand_keep_image_attachments() {
	let png = real_png(200, 200);
	let dir = tempdir().expect("image directory");
	let path = dir.path().join("shot.png");
	std::fs::write(&path, &png).expect("write png");
	let source = path.to_str().expect("utf-8 path");

	// Both configured follow-up chords while streaming: queued with the
	// image, not steered. `Key::FollowUp` is decoded Ctrl+Enter.
	for key in [Key::Ctrl('q'), Key::FollowUp] {
		let mut session = idle_session();
		open_turn(&mut session);
		let mut h = harness(session);
		assert_eq!(h.host.paste(source), NativeEffect::Consumed);
		type_text(&mut h.host, "what is this?");
		h.host.key(key).expect("follow up");
		let (prompt, attachments) = match h.commands.try_recv() {
			Ok(HostCommand::Queue { prompt, attachments }) => (prompt, attachments),
			other => panic!("follow-up with an image chip queues it, got {other:?}"),
		};
		assert_eq!(prompt, "[Image #1, 200x200] what is this?");
		assert_eq!(attachments.len(), 1);
		assert_eq!(attachments[0].mime, "image/png");
		assert_eq!(attachments[0].bytes.as_ref(), png.as_slice());
		assert!(h.commands.try_recv().is_err(), "queued once, never also steered");
		assert!(h.up.try_recv().is_err());
		assert_eq!(h.host.notice(), Some("Queued message for when the agent yields"));
	}

	// `->` shorthand while streaming: same queue, same image.
	let mut session = idle_session();
	open_turn(&mut session);
	let mut h = harness(session);
	type_text(&mut h.host, "-> ");
	assert_eq!(h.host.paste(source), NativeEffect::Consumed);
	type_text(&mut h.host, "and this");
	h.host.key(Key::Enter).expect("submit");
	assert!(matches!(
		h.commands.try_recv(),
		Ok(HostCommand::Queue { prompt, attachments })
			if prompt == "[Image #1, 200x200] and this" && attachments.len() == 1
	));

	// Idle with an empty queue: the shorthand submits with the image.
	let mut h = harness(idle_session());
	type_text(&mut h.host, "-> ");
	assert_eq!(h.host.paste(source), NativeEffect::Consumed);
	type_text(&mut h.host, "now");
	h.host.key(Key::Enter).expect("submit");
	assert!(matches!(
		h.commands.try_recv(),
		Ok(HostCommand::SubmitWithAttachments { text, attachments })
			if text == "[Image #1, 200x200] now" && attachments.len() == 1
	));
	assert!(h.host.turn_active());
	assert_eq!(h.host.notice(), Some("Sent queued message"));
}

#[test]
fn compaction_follow_up_keeps_normalized_media_and_exact_marker() {
	let png = real_png(200, 200);
	let dir = tempdir().expect("image directory");
	let path = dir.path().join("shot.png");
	std::fs::write(&path, &png).expect("write png");

	let mut session = idle_session();
	open_turn(&mut session);
	engage_director(&mut session, "compaction");
	let mut h = harness(session);
	h.host.paste(path.to_str().expect("utf-8 path"));
	type_text(&mut h.host, "after compaction");
	h.host.key(Key::FollowUp).expect("follow up");
	let (prompt, attachments) = match h.commands.try_recv() {
		Ok(HostCommand::Queue { prompt, attachments }) => (prompt, attachments),
		other => panic!("compaction follow-up should queue, got {other:?}"),
	};
	assert_eq!(prompt, "[Image #1, 200x200] after compaction");
	assert_eq!(attachments.len(), 1);
	assert_eq!(attachments[0].mime, "image/png");
	assert_eq!(attachments[0].bytes.as_ref(), png.as_slice());
}

#[test]
fn commands_with_media_refuse_without_losing_draft_or_chip() {
	let png = real_png(200, 200);
	let dir = tempdir().expect("image directory");
	let path = dir.path().join("shot.png");
	std::fs::write(&path, png).expect("write png");
	let source = path.to_str().expect("utf-8 path");

	let mut goal = harness(idle_session());
	type_text(&mut goal.host, "/goal inspect ");
	goal.host.paste(source);
	goal.host.key(Key::Enter).expect("submit goal with media");
	assert!(matches!(
		goal.commands.recv().expect("goal engagement"),
		HostCommand::Director { id, engage: true, .. } if id == "goal"
	));
	let (text, attachments) = match goal.commands.recv().expect("goal prompt") {
		HostCommand::SubmitWithAttachments { text, attachments } => (text, attachments),
		other => panic!("goal media becomes the objective prompt, got {other:?}"),
	};
	assert_eq!(text, "inspect [Image #1, 200x200]");
	assert_eq!(attachments.len(), 1);
	assert!(goal.host.composer_text().is_empty());

	// The Python command grammar requires ASCII whitespace after `$`;
	// `$print(...)` is prose and must remain eligible for ordinary media
	// submission.
	for draft in ["!echo hi ", "$ print('hi') "] {
		let mut h = harness(idle_session());
		type_text(&mut h.host, draft);
		h.host.paste(source);
		let before = h.host.composer_text();
		let before_caret = h.host.composer_cursor();
		let image = omp_tui::Charset::default().icon(omp_tui::Icon::Image);
		let chip = format!("{image} #1");
		assert!(omp_tui::frame_text(h.host.frame()).contains(&chip), "media chip is staged");

		h.host.key(Key::Enter).expect("submit command with media");

		assert_eq!(
			h.host.notice(),
			Some("Local commands do not accept media attachments"),
			"{draft:?} must take the local-command refusal path"
		);
		assert_eq!(h.host.composer_text(), before, "{draft:?} keeps the exact wire-marker draft");
		assert_eq!(h.host.composer_cursor(), before_caret, "{draft:?} keeps the caret");
		assert!(
			omp_tui::frame_text(h.host.frame()).contains(&chip),
			"{draft:?} keeps the staged media chip"
		);
		assert!(h.commands.try_recv().is_err(), "refused command emits nothing");
	}
}

#[test]
fn alt_up_with_nothing_queued_reports_and_keeps_the_draft() {
	let mut h = harness(idle_session());
	type_text(&mut h.host, "draft");
	h.host.key(Key::RestoreQueue).expect("alt+up");
	assert_eq!(h.host.composer_text(), "draft");
	assert_eq!(h.host.notice(), Some("No queued messages to restore"));
}

// ---------------------------------------------------------------- clipboard

#[test]
fn copy_line_and_copy_prompt_hand_text_to_the_clipboard() {
	let mut h = harness(idle_session());
	type_text(&mut h.host, "one");
	h.host.key(Key::ShiftEnter).expect("newline");
	type_text(&mut h.host, "two");
	h.host.key(Key::CopyLine).expect("alt+shift+l");
	assert_eq!(h.host.take_clipboard().as_deref(), Some("two"));
	assert_eq!(h.host.notice(), Some("Copied line"));
	h.host.key(Key::CopyPrompt).expect("alt+shift+c");
	assert_eq!(h.host.take_clipboard().as_deref(), Some("one\ntwo"));
	assert_eq!(h.host.notice(), Some("Copied prompt"));
}

#[test]
fn live_bind_changes_apply_to_the_next_physical_edge() {
	let mut h = harness(idle_session());
	let f6 = Chord::parse("f6").expect("chord");
	h.con
		.run("bind f6 cl_paste_image")
		.expect("bind smart paste");
	h.host
		.chord(KeyEvent { chord: f6, key: Some(Key::Function(6)), pressed: true })
		.expect("smart paste chord");
	assert_eq!(h.host.take_clipboard_read(), Some(ClipboardRead::Smart));

	h.con.run("bind f6 cl_paste_raw").expect("replace bind");
	h.host
		.chord(KeyEvent { chord: f6, key: Some(Key::Function(6)), pressed: true })
		.expect("raw paste chord");
	assert_eq!(h.host.take_clipboard_read(), Some(ClipboardRead::Text));

	h.con.run("unbind f6").expect("unbind");
	assert_eq!(
		h.host
			.chord(KeyEvent { chord: f6, key: Some(Key::Function(6)), pressed: true })
			.expect("unbound chord"),
		NativeEffect::Ignored
	);
	assert_eq!(h.host.take_clipboard_read(), None);
}

#[test]
fn configured_tool_visibility_chord_routes_through_the_command_stream() {
	let mut h = harness(idle_session());
	assert!(omp_chat::actions::CL_SHOWTOOLS.get(&h.con));
	h.con
		.run("bind alt+h \"toggle cl_showtools\"")
		.expect("visibility remap");
	h.host.key(Key::Alt('h')).expect("visibility chord");
	assert!(!omp_chat::actions::CL_SHOWTOOLS.get(&h.con));
}

#[test]
fn user_remap_precedes_the_shipped_action_and_unbind_removes_it() {
	let mut h = harness(idle_session());
	type_text(&mut h.host, "draft");
	h.con
		.run("bind option+r cl_copy_prompt")
		.expect("remap retry chord by canonical alias");
	h.host.key(Key::Alt('r')).expect("remapped chord");
	assert_eq!(h.host.take_clipboard().as_deref(), Some("draft"));
	assert!(h.commands.try_recv().is_err(), "the replaced retry action never runs");

	h.con.run("unbind alt+r").expect("remove remap");
	h.host.key(Key::Alt('r')).expect("removed chord");
	assert_eq!(h.host.take_clipboard(), None);
	assert!(h.commands.try_recv().is_err(), "removed custom binding has no fallback");
}

#[test]
fn shifted_symbol_wire_alias_reaches_the_same_custom_binding() {
	let mut h = harness(idle_session());
	type_text(&mut h.host, "draft");
	h.con
		.run(r#"bind "!" cl_copy_prompt"#)
		.expect("symbol bind");
	let chord = Chord::parse("shift+!").expect("shifted symbol chord");
	h.host
		.chord(KeyEvent { chord, key: None, pressed: true })
		.expect("shifted symbol press");
	assert_eq!(h.host.take_clipboard().as_deref(), Some("draft"));
}

#[test]
fn submit_and_newline_are_live_remappable_commands() {
	let mut h = harness(idle_session());
	h.con.run("bind enter ed_newline").expect("remap enter");
	type_text(&mut h.host, "hello");
	h.host.key(Key::Enter).expect("newline");
	assert_eq!(h.host.composer_text(), "hello\n");
	assert!(h.commands.try_recv().is_err());

	h.con.run("bind ctrl+enter ed_enter").expect("remap submit");
	let chord = Chord::parse("ctrl+enter").expect("ctrl enter");
	h.host
		.chord(KeyEvent { chord, key: Some(Key::FollowUp), pressed: true })
		.expect("submit chord");
	assert!(matches!(
		h.commands.try_recv(),
		Ok(HostCommand::Submit(text)) if text == "hello\n"
	));
}

#[test]
fn physical_release_runs_the_minus_action_from_the_latched_bind() {
	let mut h = harness(idle_session());
	h.con
		.run(r#"alias +peek "cl_showthinking 1"; alias -peek "cl_showthinking 0"; bind ctrl+h +peek"#)
		.expect("hold action");
	let chord = Chord::parse("ctrl+h").expect("chord");
	h.host
		.chord(KeyEvent { chord, key: Some(Key::Ctrl('h')), pressed: true })
		.expect("press");
	assert!(omp_chat::settings::CL_SHOWTHINKING.get(&h.con));
	h.con.run("unbind ctrl+h").expect("remove while held");
	h.host
		.chord(KeyEvent { chord, key: Some(Key::Ctrl('h')), pressed: false })
		.expect("release");
	assert!(!omp_chat::settings::CL_SHOWTHINKING.get(&h.con));
}

#[test]
fn semantic_key_calls_close_a_held_action_edge_immediately() {
	let mut h = harness(idle_session());
	h.con
		.run(r#"alias +peek "cl_showthinking 1"; alias -peek "cl_showthinking 0"; bind ctrl+h +peek"#)
		.expect("hold action");
	h.host.key(Key::Ctrl('h')).expect("semantic key");
	assert!(
		!omp_chat::settings::CL_SHOWTHINKING.get(&h.con),
		"press-only callers synthesize release rather than stranding +actions"
	);
}

#[test]
fn paste_chords_request_the_matching_clipboard_read_and_deliver_it() {
	let mut h = harness(idle_session());
	h.host.key(Key::Paste).expect("ctrl+v");
	assert_eq!(h.host.take_clipboard_read(), Some(ClipboardRead::Smart));
	h.host.key(Key::PasteRaw).expect("ctrl+shift+v");
	assert_eq!(h.host.take_clipboard_read(), Some(ClipboardRead::Text));
	// Raw text keeps its newlines verbatim.
	h.host
		.deliver_clipboard(ClipboardReadOutcome::Payload(Clipboard::Text("a\nb".into())), true);
	assert_eq!(h.host.composer_text(), "a\nb");
	// An image persists to a temp file and lands as an attachment chip whose
	// submitted form is the positional marker (the file travels as the
	// chip's source on submit, never as draft text).
	// A 1x1 PNG: signature, IHDR, IDAT, IEND.
	let png = omp_tui::PastedImage::from_bytes(vec![
		0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
		0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f,
		0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0xf8,
		0xff, 0xff, 0x3f, 0x00, 0x05, 0xfe, 0x02, 0xfe, 0xa7, 0x35, 0x81, 0x84, 0x00, 0x00, 0x00,
		0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
	])
	.expect("png header");
	h.host.key(Key::Ctrl('c')).expect("clear");
	h.host
		.deliver_clipboard(ClipboardReadOutcome::Payload(Clipboard::Image(png)), false);
	let text = h.host.composer_text();
	assert_eq!(text, "[Image #1, 1x1] ", "chip expands to the wire marker: {text:?}");
	let image = omp_tui::Charset::default().icon(omp_tui::Icon::Image);
	assert!(
		omp_tui::frame_text(h.host.frame()).contains(&format!("{image} #1")),
		"the composer shows the chip"
	);
	h.host.key(Key::Ctrl('c')).expect("clear");
	h.host.deliver_clipboard(ClipboardReadOutcome::Empty, false);
	assert_eq!(h.host.notice(), Some("Clipboard is empty"));
}

#[test]
fn typed_clipboard_writes_report_the_final_backend_outcome() {
	let cases = [
		(ClipboardWriteOutcome::Success, "Copied to clipboard"),
		(ClipboardWriteOutcome::PermissionDenied, "Clipboard write access was denied"),
		(ClipboardWriteOutcome::Unavailable, "Clipboard is unavailable"),
		(ClipboardWriteOutcome::WriteFailure, "Failed to write clipboard"),
	];
	for (outcome, notice) in cases {
		let mut h = harness(idle_session());
		type_text(&mut h.host, "draft");
		h.host.deliver_clipboard_write(outcome);
		assert_eq!(h.host.composer_text(), "draft");
		assert_eq!(h.host.notice(), Some(notice));
	}
}

#[test]
fn typed_clipboard_misses_report_exactly_without_mutating_the_composer() {
	let cases = [
		(ClipboardReadOutcome::Empty, false, "Clipboard is empty"),
		(ClipboardReadOutcome::Empty, true, "No text in clipboard to paste raw"),
		(ClipboardReadOutcome::PermissionDenied, false, "Clipboard access was denied"),
		(ClipboardReadOutcome::UnsupportedFormat, false, "Clipboard format is not supported"),
		(ClipboardReadOutcome::ReadFailure, false, "Failed to read clipboard"),
		(ClipboardReadOutcome::ReadFailure, true, "Failed to paste raw text from clipboard"),
	];
	for (outcome, raw, notice) in cases {
		let mut h = harness(idle_session());
		type_text(&mut h.host, "draft");
		h.host.deliver_clipboard(outcome, raw);
		assert_eq!(h.host.composer_text(), "draft");
		assert_eq!(h.host.notice(), Some(notice));
	}
}

#[test]
fn extension_status_actions_project_sorted_hide_by_config_and_reset() {
	let mut h = harness(idle_session());
	for (key, text) in [("z", "zed-hook"), ("a", "alpha-hook")] {
		h.host
			.act(HostAction::ExtensionStatus(omp_chat::ExtensionStatus::Set {
				key:  Str::new(key),
				text: Str::new(text),
			}))
			.expect("extension status");
	}
	let shown = omp_tui::frame_text(h.host.frame());
	let alpha = shown.find("alpha-hook").expect("alpha status");
	let zed = shown.find("zed-hook").expect("zed status");
	assert!(alpha < zed, "status contributions stay key-sorted: {shown}");

	h.con
		.run("cl_status_line_show_hook_status 0")
		.expect("hide extension status");
	h.host.tick(Duration::ZERO);
	let hidden = omp_tui::frame_text(h.host.frame());
	assert!(!hidden.contains("alpha-hook") && !hidden.contains("zed-hook"), "{hidden}");

	h.con
		.run("cl_status_line_show_hook_status 1")
		.expect("show extension status");
	h.host.tick(Duration::ZERO);
	assert!(omp_tui::frame_text(h.host.frame()).contains("alpha-hook"));
	let head = h.session.head().expect("session head");
	h.session.rewind(head).expect("publish DOM reset");
	h.host.poll().expect("apply DOM reset");
	let reset = omp_tui::frame_text(h.host.frame());
	assert!(!reset.contains("alpha-hook") && !reset.contains("zed-hook"), "{reset}");
}

// ---------------------------------------------------------------- panels

struct Probe {
	id:      &'static str,
	anchor:  PanelAnchor,
	actions: Arc<parking_lot::Mutex<Vec<PanelAction>>>,
	frame:   Frame,
	/// Escapes the panel consumes itself (an inline editor cancelling)
	/// before it ignores the key and lets the host dismiss it.
	escapes: u8,
}

impl Panel for Probe {
	fn id(&self) -> &'static str {
		self.id
	}

	fn anchor(&self) -> PanelAnchor {
		self.anchor
	}

	fn action(&mut self, action: PanelAction) -> PanelEvent {
		self.actions.lock().push(action);
		PanelEvent::Consumed
	}

	fn key(&mut self, key: Key) -> PanelEvent {
		match key {
			Key::Enter => PanelEvent::Finish(Str::new_static("echo picked")),
			Key::Char('r') => PanelEvent::Recall(Str::new_static("recalled")),
			Key::Char('c') => PanelEvent::Copy(Str::new_static("copied")),
			Key::Esc if self.escapes > 0 => {
				self.escapes -= 1;
				PanelEvent::Consumed
			},
			_ => PanelEvent::Ignored,
		}
	}

	fn paste(&mut self, text: &str) -> PanelEvent {
		PanelEvent::Copy(Str::new(format!("pasted:{text}")))
	}

	fn mouse(&mut self, report: MouseReport) -> PanelEvent {
		if report.kind == Mouse::Click {
			PanelEvent::Copy(Str::new(format!("clicked:{},{}", report.col, report.row)))
		} else {
			PanelEvent::Ignored
		}
	}

	fn frame(&mut self, _viewport: Size) -> &Frame {
		&self.frame
	}
}

fn open_probe(
	host: &mut NativeHost,
	id: &'static str,
	anchor: PanelAnchor,
) -> Arc<parking_lot::Mutex<Vec<PanelAction>>> {
	open_probe_absorbing(host, id, anchor, 0)
}

fn open_probe_absorbing(
	host: &mut NativeHost,
	id: &'static str,
	anchor: PanelAnchor,
	escapes: u8,
) -> Arc<parking_lot::Mutex<Vec<PanelAction>>> {
	let actions = Arc::new(parking_lot::Mutex::new(Vec::new()));
	let seen = Arc::clone(&actions);
	host
		.act(HostAction::Open(PanelOpener::new(move |_cx| {
			Ok(Box::new(Probe {
				id,
				anchor,
				actions: Arc::clone(&seen),
				frame: Frame::new(Size::new(10, 1)),
				escapes,
			}) as Box<dyn Panel>)
		})))
		.expect("open");
	actions
}

/// Escape bound to `cl_interrupt` reaches a modal panel's own key handler
/// first (an inline editor or search cancels itself); the host dismisses
/// the panel only once it ignores the key.
#[test]
fn interrupt_bind_offers_escape_to_a_modal_panel_before_dismissing_it() {
	let mut h = harness(idle_session());
	open_probe_absorbing(&mut h.host, "git", PanelAnchor::Center, 1);
	h.host.key(Key::Esc).expect("esc");
	assert_eq!(h.host.overlay_id(), Some("git"), "the panel consumed its first Escape");
	h.host
		.chord(KeyEvent { chord: Chord::plain(Key::Esc), key: Some(Key::Esc), pressed: true })
		.expect("physical esc");
	assert_eq!(h.host.overlay_id(), None, "an ignored Escape dismisses the panel");
	assert!(
		h.commands
			.try_iter()
			.any(|command| matches!(command, HostCommand::Overlay { open: false, .. }))
	);
}

/// A marker-sized paste of at least
/// `cl_paste_large_menu_threshold` lines opens the large-paste menu instead
/// of landing; each choice lands it differently, Esc keeps the chip, and a
/// threshold of 0 disables the menu.
#[test]
fn large_paste_menu_gates_on_the_threshold_and_lands_the_choice() {
	let big = (0..120)
		.map(|n| format!("row {n}"))
		.collect::<Vec<_>>()
		.join("\n");
	let mut h = harness(idle_session());
	h.host.paste(&big);
	assert_eq!(h.host.overlay_id(), Some("paste-menu"), "120 lines >= default 100");
	assert_eq!(h.host.composer_text(), "", "the menu holds the paste");
	assert!(matches!(
		h.commands.try_recv(),
		Ok(HostCommand::Overlay { ref id, open: true }) if id == "paste-menu"
	));
	// Enter on the first row: wrapped block.
	h.host.key(Key::Enter).expect("choose wrapped");
	assert_eq!(h.host.overlay_id(), None);
	assert_eq!(h.host.composer_text().trim_end(), format!("<attachment>\n{big}\n</attachment>"));
	assert!(matches!(
		h.commands.try_recv(),
		Ok(HostCommand::Overlay { ref id, open: false }) if id == "paste-menu"
	));

	// Esc: default chip, nothing lost.
	let mut h = harness(idle_session());
	h.host.paste(&big);
	h.host.key(Key::Esc).expect("cancel menu");
	assert_eq!(h.host.overlay_id(), None);
	assert_eq!(h.host.composer_text().trim_end(), big);

	// Local file without a session store: falls back to the chip and says so.
	let mut h = harness(idle_session());
	h.host.paste(&big);
	h.host.key(Key::Char('2')).expect("choose local file");
	assert_eq!(h.host.composer_text().trim_end(), big);
	assert!(
		h.host
			.notice()
			.is_some_and(|notice| notice.starts_with("Failed to save paste to a file")),
		"{:?}",
		h.host.notice()
	);

	// Raise the threshold above the paste: the ordinary chip path.
	let mut h = harness(idle_session());
	h.host
		.console("cl_paste_large_menu_threshold 200")
		.expect("set threshold");
	h.host.paste(&big);
	assert_eq!(h.host.overlay_id(), None);
	assert_eq!(h.host.composer_text().trim_end(), big);

	// Disabled entirely.
	let mut h = harness(idle_session());
	h.host
		.console("cl_paste_large_menu_threshold 0")
		.expect("disable menu");
	h.host.paste(&big);
	assert_eq!(h.host.overlay_id(), None);
	assert_eq!(h.host.composer_text().trim_end(), big);
}

/// Pasted text goes to the active side panel instead of leaking into the
/// composer behind it.
#[test]
fn paste_reaches_the_active_side_panel_before_the_composer() {
	let mut h = harness(idle_session());
	open_probe(&mut h.host, "btw", PanelAnchor::Side);
	h.host.paste("hello");
	assert_eq!(h.host.take_clipboard().as_deref(), Some("pasted:hello"));
	assert_eq!(h.host.composer_text(), "", "the composer never sees the paste");
}

#[test]
fn clipboard_payload_keeps_focused_panel_routing_and_refuses_hidden_media_mutation() {
	let mut h = harness(idle_session());
	open_probe(&mut h.host, "btw", PanelAnchor::Side);
	h.host
		.deliver_clipboard(ClipboardReadOutcome::Payload(Clipboard::Text("hello".into())), true);
	assert_eq!(h.host.take_clipboard().as_deref(), Some("pasted:hello"));
	assert_eq!(h.host.composer_text(), "", "raw text stays in the focused panel");

	h.host.deliver_clipboard(
		ClipboardReadOutcome::Payload(Clipboard::Paths(vec![Str::new_static("/tmp/a.png")])),
		false,
	);
	assert_eq!(h.host.notice(), Some("Close the current panel before pasting images or files"));
	assert_eq!(h.host.composer_text(), "", "media refusal cannot mutate the hidden composer");
}

/// Terminal mouse tracking follows every stacked overlay, side panels
/// included, so their scroll and click handlers actually receive reports.
#[test]
fn side_panels_keep_terminal_mouse_tracking_on() {
	let mut h = harness(idle_session());
	assert!(!h.host.mouse_tracking(), "no overlay: the terminal owns the pointer");
	open_probe(&mut h.host, "btw", PanelAnchor::Side);
	assert!(!h.host.overlay_open(), "a side panel is not modal");
	assert!(h.host.mouse_tracking(), "a side panel still takes pointer reports");
	let band = h.host.picker_band().expect("side panel band");
	assert_eq!(band.rows, 1);
	assert!(band.y < 30 && band.y > 20, "a side panel sits directly above the composer: {band:?}");
	h.host.mouse(click(band.x + 1, band.y)).expect("mouse");
	assert_eq!(h.host.take_clipboard().as_deref(), Some("clicked:1,0"));
	h.host.key(Key::Esc).expect("close");
	assert!(!h.host.mouse_tracking());
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
fn panels_receive_lowered_session_and_tree_chords_before_raw_keys() {
	let mut h = harness(idle_session());
	let actions = open_probe(&mut h.host, "sessions", PanelAnchor::Bottom);
	assert_eq!(h.host.overlay_id(), Some("sessions"));
	assert!(matches!(h.commands.try_recv(), Ok(HostCommand::Overlay { open: true, .. })));
	for key in [
		Key::Ctrl('p'),
		Key::Ctrl('s'),
		Key::Ctrl('r'),
		Key::Ctrl('d'),
		Key::Ctrl('w'),
		Key::WordLeft,
		Key::WordRight,
		Key::Ctrl('o'),
	] {
		h.host.key(key).expect("panel key");
	}
	assert_eq!(&*actions.lock(), &[
		PanelAction::TogglePath,
		PanelAction::ToggleSort,
		PanelAction::Rename,
		PanelAction::Delete,
		PanelAction::DeleteFast,
		PanelAction::FoldUp,
		PanelAction::UnfoldDown,
		PanelAction::Expand,
	]);
	// Esc closes a panel that ignores it.
	h.host.key(Key::Esc).expect("esc");
	assert_eq!(h.host.overlay_id(), None);
	assert!(matches!(h.commands.try_recv(), Ok(HostCommand::Overlay { open: false, .. })));
}

/// Pointer reports arrive in terminal cells; the host resolves the
/// overlay's composited band exactly as it paints it and hands the panel
/// its own frame coordinates, so a click lands on the row it was painted
/// on. Reports outside the band never reach the panel.
#[test]
fn pointer_reports_reach_the_active_panel_in_its_own_frame_cells() {
	let mut h = harness(idle_session());
	open_probe(&mut h.host, "probe", PanelAnchor::Center);
	// A 10x1 frame centered on 100x30: column 45, row 14.
	let band = h.host.picker_band().expect("centered band");
	assert_eq!((band.x, band.y, band.rows), (45, 14, 1));
	h.host.mouse(click(47, 14)).expect("mouse");
	assert_eq!(h.host.take_clipboard().as_deref(), Some("clicked:2,0"));
	h.host.mouse(click(2, 1)).expect("mouse outside");
	assert_eq!(h.host.take_clipboard(), None, "a click outside the band is not the panel's");
	h.host.key(Key::Esc).expect("close");

	// Bottom pickers replace the composer slot: the last rows of the viewport.
	open_probe(&mut h.host, "sessions", PanelAnchor::Bottom);
	let band = h.host.picker_band().expect("bottom band");
	assert_eq!((band.x, band.y, band.rows), (0, 29, 1));
	h.host.mouse(click(3, 29)).expect("mouse");
	assert_eq!(h.host.take_clipboard().as_deref(), Some("clicked:3,0"));
	h.host.mouse(click(3, 0)).expect("mouse above");
	assert_eq!(h.host.take_clipboard(), None);
	h.host.key(Key::Esc).expect("close");

	// Full dashboards cover the viewport from the origin.
	open_probe(&mut h.host, "usage", PanelAnchor::Full);
	let band = h.host.picker_band().expect("full band");
	assert_eq!((band.x, band.y), (0, 0));
	h.host.mouse(click(4, 0)).expect("mouse");
	assert_eq!(h.host.take_clipboard().as_deref(), Some("clicked:4,0"));
}

#[test]
fn panel_events_run_console_lines_recall_text_and_copy() {
	let mut h = harness(idle_session());
	open_probe(&mut h.host, "probe", PanelAnchor::Center);
	h.host.key(Key::Char('c')).expect("copy");
	assert_eq!(h.host.take_clipboard().as_deref(), Some("copied"));
	assert_eq!(h.host.overlay_id(), Some("probe"), "copy keeps the panel open");
	h.host.key(Key::Enter).expect("finish");
	assert_eq!(h.host.overlay_id(), None);
	assert_eq!(h.host.notice(), Some("picked"), "Finish closes, then runs the line");
	open_probe(&mut h.host, "probe", PanelAnchor::Center);
	h.host.key(Key::Char('r')).expect("recall");
	assert_eq!(h.host.overlay_id(), None);
	assert_eq!(h.host.composer_text(), "recalled");
}

#[test]
fn side_panels_leave_the_composer_live_and_close_at_escape_rung_two() {
	let mut session = idle_session();
	open_turn(&mut session);
	let mut h = harness(session);
	open_probe(&mut h.host, "btw", PanelAnchor::Side);
	assert!(!h.host.overlay_open(), "a side panel is not modal");
	h.host.key(Key::Char('c')).expect("side-panel copy");
	assert_eq!(
		h.host.take_clipboard().as_deref(),
		Some("copied"),
		"reserved side-panel keys win while the composer is empty"
	);
	type_text(&mut h.host, "typed");
	assert_eq!(h.host.composer_text(), "typed");
	h.host.key(Key::Esc).expect("esc");
	assert_eq!(h.host.overlay_depth(), 0, "rung 2 closes the side panel");
	assert!(
		!h.commands
			.try_iter()
			.any(|command| matches!(command, HostCommand::Interrupt)),
		"the streaming turn survives the side-panel Esc"
	);
	assert_eq!(h.host.composer_text(), "typed");
}

#[test]
fn a_panel_call_feeds_its_event_through_the_same_path() {
	let mut h = harness(idle_session());
	h.host
		.act(HostAction::Call(PanelCall::new(|cx| {
			PanelEvent::Notice(Str::new(format!("width {}", cx.viewport.width)))
		})))
		.expect("call");
	assert_eq!(h.host.notice(), Some("width 100"));
	h.host
		.act(HostAction::Open(PanelOpener::new(|_cx| Err(Str::new_static("nope")))))
		.expect("open");
	assert_eq!(h.host.notice(), Some("nope"));
	assert_eq!(h.host.overlay_id(), None);
}

// ---------------------------------------------------------------- push-to-talk

#[test]
fn space_hold_recognizes_a_metronomic_repeat_and_tracks_back_typed_spaces() {
	let mut hold = SpaceHold::default();
	let ms = Duration::from_millis;
	// Two deliberate spaces: typed.
	assert_eq!(hold.observe(Key::Space, ms(0), true), SpaceHoldEvent::Pass);
	assert_eq!(hold.observe(Key::Space, ms(400), true), SpaceHoldEvent::Pass);
	// A held bar: 33ms repeat. The first repeat gap is not yet a pattern.
	assert_eq!(hold.observe(Key::Space, ms(433), true), SpaceHoldEvent::Pass);
	assert_eq!(hold.observe(Key::Space, ms(466), true), SpaceHoldEvent::Swallow);
	assert_eq!(hold.observe(Key::Space, ms(499), true), SpaceHoldEvent::Begin { track_back: 3 });
	assert!(hold.active());
	assert_eq!(hold.observe(Key::Space, ms(532), true), SpaceHoldEvent::Swallow);
	assert_eq!(hold.next_wake(), Some(ms(532) + SPACE_HOLD_RELEASE));
	assert!(!hold.release_due(ms(700)));
	assert!(hold.release_due(ms(532) + SPACE_HOLD_RELEASE));
	assert!(!hold.active());
	// Jittery smashing never escalates.
	let mut smash = SpaceHold::default();
	for at in [0, 60, 150, 200, 300] {
		assert_eq!(smash.observe(Key::Space, ms(at), true), SpaceHoldEvent::Pass);
	}
	// A non-space during a hold ends it and passes through.
	let mut hold = SpaceHold::default();
	for at in [0, 33, 66] {
		hold.observe(Key::Space, ms(at), true);
	}
	hold.observe(Key::Space, ms(99), true);
	assert!(hold.active());
	assert_eq!(hold.observe(Key::Char('a'), ms(120), true), SpaceHoldEvent::EndThenPass);
	// Disabled: plain spaces.
	let mut off = SpaceHold::default();
	for at in [0, 33, 66, 99] {
		assert_eq!(off.observe(Key::Space, ms(at), false), SpaceHoldEvent::Pass);
	}
}

#[test]
fn a_held_space_bar_starts_recording_and_release_stops_it() {
	let mut h = harness(idle_session());
	type_text(&mut h.host, "hi");
	// Feed the gesture on the real clock: repeats 30ms apart.
	for _ in 0..5 {
		h.host.key(Key::Space).expect("space");
		std::thread::sleep(Duration::from_millis(30));
	}
	assert!(h.host.recording(), "metronomic repeat begins push-to-talk");
	assert_eq!(h.host.composer_text(), "hi", "pre-burst spaces are tracked back");
	assert!(matches!(h.commands.try_recv(), Ok(HostCommand::PushToTalk { active: true })));
	// Release: native polling advances the same presentation-clock deadline
	// as the terminal host even when no controller event wakes the actor.
	std::thread::sleep(SPACE_HOLD_RELEASE + Duration::from_millis(20));
	assert_eq!(h.host.poll().expect("poll release"), NativeEffect::Consumed);
	assert!(!h.host.recording());
	assert!(matches!(h.commands.try_recv(), Ok(HostCommand::PushToTalk { active: false })));
	// The recognizer's text lands at the caret.
	h.host
		.act(HostAction::SttEvent(SttUiEvent::Segment(Str::new_static(" there"))))
		.expect("insert");
	assert_eq!(h.host.composer_text(), "hi there");
}

#[test]
fn stt_preview_replaces_commits_and_cancels_without_moving_surrounding_text() {
	let mut h = harness(idle_session());
	type_text(&mut h.host, "note: tail");
	for _ in 0..4 {
		h.host.key(Key::Left).expect("left");
	}

	h.host
		.act(HostAction::SttEvent(SttUiEvent::Partial(Str::new_static("hel"))))
		.expect("partial");
	assert_eq!(h.host.composer_text(), "note: heltail");
	h.host
		.act(HostAction::SttEvent(SttUiEvent::Partial(Str::new_static("hello"))))
		.expect("replace partial");
	assert_eq!(h.host.composer_text(), "note: hellotail");
	h.host
		.act(HostAction::SttEvent(SttUiEvent::Cancelled))
		.expect("cancel");
	assert_eq!(h.host.composer_text(), "note: tail");

	h.host
		.act(HostAction::SttEvent(SttUiEvent::Partial(Str::new_static("hello"))))
		.expect("partial");
	h.host
		.act(HostAction::SttEvent(SttUiEvent::Segment(Str::new_static("hello"))))
		.expect("segment");
	h.host
		.act(HostAction::SttEvent(SttUiEvent::Partial(Str::new_static(" wor"))))
		.expect("next partial");
	assert_eq!(h.host.composer_text(), "note: hello wortail");
	h.host
		.act(HostAction::SttEvent(SttUiEvent::Finished {
			had_speech:    true,
			trim_trailing: 0,
			submit:        false,
		}))
		.expect("finish");
	assert_eq!(h.host.composer_text(), "note: hellotail");
}

#[test]
fn live_toggle_flips_the_session_and_stops_push_to_talk_first() {
	let mut h = harness(idle_session());
	h.host.act(HostAction::SttToggle).expect("record");
	let _ = h.commands.try_recv();
	h.host.act(HostAction::LiveToggle).expect("live");
	assert!(!h.host.recording());
	assert!(matches!(h.commands.try_recv(), Ok(HostCommand::PushToTalk { active: false })));
	assert!(matches!(
		h.commands.try_recv(),
		Ok(HostCommand::Overlay { ref id, open: true }) if id == "live"
	));
	assert_eq!(h.host.overlay_id(), Some("live"));
	assert!(h.host.tick(h.host.clock().elapsed()));
	assert!(matches!(h.commands.try_recv(), Ok(HostCommand::LiveVoice(LiveControl::Start))));
	h.host.act(HostAction::LiveToggle).expect("live");
	assert!(matches!(h.commands.try_recv(), Ok(HostCommand::LiveVoice(LiveControl::Stop))));
	assert_eq!(h.host.overlay_id(), None);
}

// ---------------------------------------------------------------- console
// words

#[test]
fn every_key_command_is_registered_on_the_console() {
	let h = harness(idle_session());
	let registered = h
		.con
		.items()
		.filter_map(|item| match item {
			omp_con::RegItem::Cmd(spec) => Some(spec.name),
			_ => None,
		})
		.collect::<Vec<_>>();
	for word in [
		"cl_dequeue",
		"cl_paste_image",
		"cl_paste_raw",
		"cl_copy_line",
		"cl_copy_prompt",
		"cl_agent_focus",
		"cl_collab_guest",
		"cl_stt_toggle",
		"cl_live_toggle",
		"cl_escape_unhook",
	] {
		assert!(registered.contains(&word), "{word} missing from the console");
	}
	assert_eq!(
		h.con.get("cl_double_escape").expect("var"),
		omp_con::Value::Str(Str::new_static("branch"))
	);
	assert!(h.session.head().is_some());
}

#[test]
fn console_words_drive_focus_and_guest_state() {
	let mut h = harness(idle_session());
	assert_eq!(h.host.console("cl_agent_focus worker-9").expect("console"), NativeEffect::Consumed);
	assert_eq!(h.host.focused_agent(), Some("worker-9"));
	h.host.console("cl_agent_focus").expect("console");
	assert_eq!(h.host.focused_agent(), None);
	h.host.console("cl_collab_guest on").expect("console");
	h.host.console("cl_escape_unhook nothing").expect("console");
	assert!(h.host.escape_hooks().is_empty());
}
