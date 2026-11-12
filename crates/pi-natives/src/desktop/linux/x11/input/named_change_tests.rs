//! Deterministic intervention at the two asynchronous focus boundaries.
use std::{
	cell::RefCell,
	io::{BufRead, BufReader},
	process::{Child, Command, Stdio},
	sync::{
		atomic::{AtomicBool, Ordering},
		mpsc,
	},
	thread,
};

use x11rb::{
	protocol::{
		Event,
		xproto::{Atom, CreateWindowAux, PropMode, WindowClass},
	},
	wrapper::ConnectionExt as _,
};

use super::*;

thread_local! {
	static AFTER_TIME: RefCell<Option<Box<dyn FnOnce()>>> = RefCell::new(None);
	static BEFORE_BODY: RefCell<Option<Box<dyn FnOnce()>>> = RefCell::new(None);
	static AFTER_SEND: RefCell<Option<Box<dyn FnOnce()>>> = RefCell::new(None);
}

pub(crate) fn after_server_time() {
	let hook = AFTER_TIME.with(|hook| hook.borrow_mut().take());
	if let Some(hook) = hook {
		hook();
	}
}

pub(crate) fn before_body() {
	let hook = BEFORE_BODY.with(|hook| hook.borrow_mut().take());
	if let Some(hook) = hook {
		hook();
	}
}

pub(crate) fn after_send() {
	let hook = AFTER_SEND.with(|hook| hook.borrow_mut().take());
	if let Some(hook) = hook {
		hook();
	}
}

struct Server(Child);
impl Drop for Server {
	fn drop(&mut self) {
		let _ = self.0.kill();
		let _ = self.0.wait();
	}
}

struct Fixture {
	_server:  Server,
	input:    X11Input,
	user:     Arc<RustConnection>,
	target:   Window,
	previous: Window,
	display:  String,
}

impl Fixture {
	fn new() -> Self {
		let mut server = Server(
			Command::new("Xvfb")
				.args(["-displayfd", "1", "-screen", "0", "320x240x24", "-nolisten", "tcp"])
				.stdout(Stdio::piped())
				.stderr(Stdio::null())
				.spawn()
				.expect("Xvfb"),
		);
		let mut number = String::new();
		BufReader::new(server.0.stdout.take().expect("stdout"))
			.read_line(&mut number)
			.expect("display");
		let display = format!(":{}", number.trim());
		let user = Arc::new(x11rb::connect(Some(&display)).expect("user connection").0);
		let conn = Arc::new(x11rb::connect(Some(&display)).expect("OMP connection").0);
		let root = conn.setup().roots[0].root;
		let mut input = X11Input::new(conn, root, Some(display.clone())).expect("input");
		let mut windows = [0; 2];
		for (i, window) in windows.iter_mut().enumerate() {
			*window = user.generate_id().expect("window id");
			user
				.create_window(
					x11rb::COPY_DEPTH_FROM_PARENT,
					*window,
					root,
					(i * 110) as i16,
					0,
					100,
					100,
					0,
					WindowClass::INPUT_OUTPUT,
					x11rb::COPY_FROM_PARENT,
					&CreateWindowAux::new(),
				)
				.expect("create");
			user.map_window(*window).expect("map");
		}
		user
			.set_input_focus(InputFocus::PARENT, windows[1], CURRENT_TIME)
			.expect("focus user");
		user.sync().expect("mapped");
		input.watch_user().expect("watch");
		// Admission is not under test: no input has been sent on this server.
		input.admitted = Some(0);
		Self { _server: server, input, user, target: windows[0], previous: windows[1], display }
	}

	fn press(user: &RustConnection, root: Window, release: bool) {
		user
			.xtest_fake_input(BUTTON_PRESS_EVENT, 1, CURRENT_TIME, root, 0, 0, 0)
			.expect("user button press")
			.check()
			.expect("press handled");
		if release {
			user
				.xtest_fake_input(BUTTON_RELEASE_EVENT, 1, CURRENT_TIME, root, 0, 0, 0)
				.expect("user button release")
				.check()
				.expect("release handled");
		}
	}
}

#[test]
#[ignore = "starts Xvfb"]
fn named_change_handback_always_asks_the_wm_when_core_focus_is_in_target() {
	let f = Fixture::new();
	f.user
		.change_window_attributes(
			f.input.root,
			&x11rb::protocol::xproto::ChangeWindowAttributesAux::new()
				.event_mask(EventMask::SUBSTRUCTURE_NOTIFY),
		)
		.expect("observe WM requests");
	f.user
		.change_property32(
			PropMode::REPLACE,
			f.input.root,
			f.input.atoms.net_active_window,
			AtomEnum::WINDOW,
			&[f.previous],
		)
		.expect("lagging property");
	f.user
		.set_input_focus(InputFocus::PARENT, f.target, CURRENT_TIME)
		.expect("core focus target");
	f.user.sync().expect("split focus state");
	while f.user.poll_for_event().expect("drain").is_some() {}
	f.input.restore_activation(
		f.target,
		true,
		Some(f.previous),
		Some((f.previous, InputFocus::PARENT)),
	);
	f.user.sync().expect("restore processed");
	let requested = std::iter::from_fn(|| f.user.poll_for_event().expect("event")).any(|event| {
		matches!(event, Event::ClientMessage(event)
			if event.type_ == f.input.atoms.net_active_window && event.window == f.previous)
	});
	assert!(requested, "hand-back must ask the WM even while its active property lags");
	assert_eq!(f.input.wm().input_focus().map(|(window, _)| window), Some(f.previous));
}

#[test]
#[ignore = "starts Xvfb"]
fn named_change_focus_acts_recheck_the_user_after_timestamp_and_before_element_prepare() {
	let mut f = Fixture::new();
	let user = Arc::clone(&f.user);
	let root = f.input.root;
	AFTER_TIME
		.with(|hook| *hook.borrow_mut() = Some(Box::new(move || Fixture::press(&user, root, true))));
	f.input.takeover_presses = Some(0);
	let error = f
		.input
		.activate_confirmed(f.target, false, Some(f.previous), Duration::ZERO)
		.expect_err("press during timestamp acquisition refuses activation");
	assert_eq!(error.code, ErrorCode::UserIntervened);
	assert_eq!(
		f.input.wm().input_focus().map(|(window, _)| window),
		Some(f.previous),
		"no forward focus request after the user's timestamp-phase press"
	);

	let mut f = Fixture::new();
	let user = Arc::clone(&f.user);
	let root = f.input.root;
	BEFORE_BODY
		.with(|hook| *hook.borrow_mut() = Some(Box::new(move || Fixture::press(&user, root, true))));
	let prepared = Cell::new(false);
	let error = f
		.input
		.foreground_keys_after(f.target, &ElementInput::Text(String::new()), || {
			prepared.set(true);
			Ok(())
		})
		.expect_err("press before element focus refuses the request");
	assert_eq!(error.code, ErrorCode::UserIntervened);
	assert!(!prepared.get(), "AT-SPI focus preparation must not run after intervention");
}

#[test]
#[ignore = "starts Xvfb"]
fn named_change_pointer_is_not_warped_after_a_user_button_press() {
	// A released press and a still-held button both give the pointer back.
	for release in [true, false] {
		let mut f = Fixture::new();
		let root = f.input.root;
		f.user
			.warp_pointer(NONE, root, 0, 0, 0, 0, 200, 180)
			.expect("initial pointer")
			.check()
			.expect("positioned");
		let user = Arc::clone(&f.user);
		let error = f
			.input
			.with_foreground(f.target, Duration::from_secs(1), |input| {
				input.xtest_motion(30, 40)?;
				Fixture::press(&user, root, release);
				Ok(())
			})
			.expect_err("user owns the pointer after pressing");
		assert_eq!(error.code, ErrorCode::UserIntervened);
		assert_eq!(f.input.core_pointer(), Some((30, 40)), "no warp while the user owns the pointer");
	}
}

/// A WM that applies `_NET_ACTIVE_WINDOW` requests, the first one only after
/// the user has pressed.
fn late_wm(
	wm: RustConnection,
	root: Window,
	active: Atom,
	stop: &AtomicBool,
	pressed: &mpsc::Receiver<()>,
) {
	let mut forward = true;
	while !stop.load(Ordering::Acquire) {
		let Some(event) = wm.poll_for_event().expect("WM event") else {
			thread::sleep(Duration::from_millis(1));
			continue;
		};
		let Event::ClientMessage(event) = event else {
			continue;
		};
		if event.type_ != active {
			continue;
		}
		if forward {
			forward = false;
			pressed
				.recv_timeout(Duration::from_secs(5))
				.expect("user pressed");
			thread::sleep(Duration::from_millis(50));
		}
		let window = event.window;
		wm.change_property32(PropMode::REPLACE, root, active, AtomEnum::WINDOW, &[window])
			.expect("activate");
		wm.set_input_focus(InputFocus::PARENT, window, CURRENT_TIME)
			.expect("focus");
		wm.sync().expect("WM applied");
	}
}

/// Runs a takeover against [`late_wm`], with `between` run after the forward
/// request is sent and before the WM acts on it. Asserts the user's window
/// holds focus once the WM has had time to act; returns the takeover's error.
fn takeover_before_late_wm(
	between: impl FnOnce(Arc<RustConnection>, Window, control::CancellationSource) + 'static,
) -> ErrorCode {
	let mut f = Fixture::new();
	let root = f.input.root;
	let active = f.input.atoms.net_active_window;
	f.user
		.change_property32(PropMode::REPLACE, root, active, AtomEnum::WINDOW, &[f.previous])
		.expect("user's window active");
	f.user.sync().expect("EWMH state");
	let wm = x11rb::connect(Some(&f.display)).expect("WM connection").0;
	wm.change_window_attributes(
		root,
		&x11rb::protocol::xproto::ChangeWindowAttributesAux::new()
			.event_mask(EventMask::SUBSTRUCTURE_REDIRECT),
	)
	.expect("select redirect")
	.check()
	.expect("sole WM");
	let (pressed, user_pressed) = mpsc::channel();
	let stop = Arc::new(AtomicBool::new(false));
	let wm_stop = Arc::clone(&stop);
	let wm_thread = thread::spawn(move || late_wm(wm, root, active, &wm_stop, &user_pressed));
	let source = control::CancellationSource::default();
	let user = Arc::clone(&f.user);
	let hook_source = source.clone();
	AFTER_SEND.with(|hook| {
		*hook.borrow_mut() = Some(Box::new(move || {
			between(user, root, hook_source);
			pressed.send(()).expect("WM waiting");
		}));
	});
	let error = control::with_token_for_test(&source.token(), || {
		f.input
			.with_foreground(f.target, Duration::from_secs(1), |_| Ok(()))
			.expect_err("the user's press or Escape after the request is sent stops the takeover")
	});
	thread::sleep(Duration::from_millis(500));
	stop.store(true, Ordering::Release);
	wm_thread.join().expect("WM thread");
	let wm_state = f.input.wm();
	assert_eq!(
		wm_state.input_focus().map(|(window, _)| window),
		Some(f.previous),
		"the WM's late activation must be handed back"
	);
	assert_eq!(wm_state.active_window(), Some(f.previous));
	error.code
}

#[test]
#[ignore = "starts Xvfb"]
fn named_change_handback_undoes_an_activation_the_wm_takes_after_a_post_send_press() {
	let code = takeover_before_late_wm(|user, root, _| Fixture::press(&user, root, true));
	assert_eq!(code, ErrorCode::UserIntervened);
}

#[test]
#[ignore = "starts Xvfb"]
fn named_change_handback_undoes_a_late_activation_after_escape_cancels_the_wait() {
	// The press starts the wait for the WM; the cancel lands during it.
	let code = takeover_before_late_wm(|user, root, source| {
		Fixture::press(&user, root, true);
		thread::spawn(move || {
			thread::sleep(Duration::from_millis(20));
			source.cancel();
		});
	});
	assert_eq!(code, ErrorCode::UserIntervened);
}

#[test]
#[ignore = "starts Xvfb"]
fn named_change_handback_undoes_a_late_activation_after_escape_cancels_before_the_user_check() {
	let code = takeover_before_late_wm(|_, _, source| source.cancel());
	assert_eq!(code, ErrorCode::Cancelled);
}
