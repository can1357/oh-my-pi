//! Deterministic intervention at the two asynchronous focus boundaries.
use std::{
	cell::RefCell,
	io::{BufRead, BufReader},
	process::{Child, Command, Stdio},
};

use x11rb::{
	protocol::{
		Event,
		xproto::{CreateWindowAux, PropMode, WindowClass},
	},
	wrapper::ConnectionExt as _,
};

use super::*;

thread_local! {
	static AFTER_TIME: RefCell<Option<Box<dyn FnOnce()>>> = RefCell::new(None);
	static BEFORE_BODY: RefCell<Option<Box<dyn FnOnce()>>> = RefCell::new(None);
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
		let mut input = X11Input::new(conn, root, Some(display)).expect("input");
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
		Self { _server: server, input, user, target: windows[0], previous: windows[1] }
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
