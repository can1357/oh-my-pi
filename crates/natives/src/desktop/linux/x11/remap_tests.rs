//! Xlib translates at receipt, independently of the sender's planned symbols.
use std::{
	ffi::CString,
	io::{BufRead, BufReader},
	os::raw::{c_char, c_int, c_long, c_ulong, c_void},
	process::{Child, Command, Stdio},
	sync::Arc,
};

use x11rb::{connection::Connection, protocol::xproto::ConnectionExt as _};
use xkeysym::Keysym;

use super::{
	super::{
		keymap::{self, Keymap},
		text_mapping::TextMapping,
	},
	X11Input,
};
use crate::desktop::{backend::DeliveryMode, control, keys::KeyName, types::Target};

/// Declares the Xlib functions the receiver uses, resolved from `libX11.so.6`
/// at first use rather than linked: the hermetic Linux toolchains have no
/// libX11, and only these ignored tests need it.
macro_rules! xlib {
	($($name:ident($($arg:ident: $ty:ty),*) -> $ret:ty;)*) => {
		#[allow(non_snake_case)]
		struct Xlib {
			$($name: unsafe extern "C" fn($($ty),*) -> $ret,)*
		}
		fn xlib() -> &'static Xlib {
			static XLIB: std::sync::LazyLock<Xlib> = std::sync::LazyLock::new(|| {
				// SAFETY: the name is NUL-terminated; the handle stays open for the
				// process lifetime, as the resolved functions do.
				let handle =
					unsafe { libc::dlopen(c"libX11.so.6".as_ptr(), libc::RTLD_NOW | libc::RTLD_LOCAL) };
				assert!(!handle.is_null(), "libX11.so.6 loads");
				Xlib {
					$($name: {
						// SAFETY: `handle` is a live dlopen handle and the name is
						// NUL-terminated.
						let symbol = unsafe {
							libc::dlsym(handle, concat!(stringify!($name), "\0").as_ptr().cast())
						};
						assert!(!symbol.is_null(), concat!("libX11 exports ", stringify!($name)));
						// SAFETY: Xlib declares the function with this signature.
						unsafe {
							std::mem::transmute::<*mut c_void, unsafe extern "C" fn($($ty),*) -> $ret>(
								symbol,
							)
						}
					},)*
				}
			});
			&XLIB
		}
		$(
			#[allow(non_snake_case)]
			unsafe fn $name($($arg: $ty),*) -> $ret {
				// SAFETY: the caller upholds the Xlib function's contract.
				unsafe { (xlib().$name)($($arg),*) }
			}
		)*
	};
}
xlib! {
	XInitThreads() -> c_int;
	XOpenDisplay(name: *const c_char) -> *mut c_void;
	XCloseDisplay(display: *mut c_void) -> c_int;
	XDefaultRootWindow(display: *mut c_void) -> c_ulong;
	XCreateSimpleWindow(
		display: *mut c_void,
		parent: c_ulong,
		x: c_int,
		y: c_int,
		width: u32,
		height: u32,
		border_width: u32,
		border: c_ulong,
		background: c_ulong
	) -> c_ulong;
	XSelectInput(display: *mut c_void, window: c_ulong, mask: c_long) -> c_int;
	XMapWindow(display: *mut c_void, window: c_ulong) -> c_int;
	XSetInputFocus(display: *mut c_void, window: c_ulong, revert: c_int, time: c_ulong) -> c_int;
	XSync(display: *mut c_void, discard: c_int) -> c_int;
	XNextEvent(display: *mut c_void, event: *mut c_long) -> c_int;
	XRefreshKeyboardMapping(event: *mut c_long) -> c_int;
	XLookupString(
		event: *mut c_long,
		buffer: *mut c_char,
		size: c_int,
		symbol: *mut c_ulong,
		compose: *mut c_void
	) -> c_int;
}
struct Server(Child);
impl Drop for Server {
	fn drop(&mut self) {
		let _ = self.0.kill();
		let _ = self.0.wait();
	}
}
fn server() -> (Server, String) {
	let mut server = Server(
		Command::new("Xvfb")
			.args(["-displayfd", "1", "-screen", "0", "320x240x24", "-nolisten", "tcp"])
			.stdout(Stdio::piped())
			.stderr(Stdio::null())
			.spawn()
			.expect("Xvfb starts"),
	);
	let mut number = String::new();
	BufReader::new(server.0.stdout.take().unwrap())
		.read_line(&mut number)
		.unwrap();
	(server, format!(":{}", number.trim()))
}
fn core_symbols(conn: &x11rb::rust_connection::RustConnection) -> Vec<u32> {
	conn
		.get_keyboard_mapping(
			conn.setup().min_keycode,
			conn.setup().max_keycode - conn.setup().min_keycode + 1,
		)
		.unwrap()
		.reply()
		.unwrap()
		.keysyms
}
/// Types `text` while the receiver reads nothing until the call returned.
fn text_is_translated(mode: DeliveryMode, text: &str) {
	static XLIB: std::sync::Once = std::sync::Once::new();
	XLIB.call_once(|| {
		// SAFETY: this precedes both fixture threads' first Xlib call.
		assert_ne!(unsafe { XInitThreads() }, 0);
	});
	let (_server, display) = server();
	let receiver_display = CString::new(display.clone()).unwrap();
	let expected = text.chars().count();
	let (ready, started) = std::sync::mpsc::channel();
	let (resume, receive) = std::sync::mpsc::channel();
	let receiver = std::thread::spawn(move || {
		struct Display(*mut c_void);
		impl Drop for Display {
			fn drop(&mut self) {
				// SAFETY: this thread owns the Display.
				unsafe {
					XCloseDisplay(self.0);
				}
			}
		}
		// SAFETY: this thread owns the Display and its 24-long XEvent union.
		unsafe {
			let owner = Display(XOpenDisplay(receiver_display.as_ptr()));
			let display = owner.0;
			assert!(!display.is_null());
			let window =
				XCreateSimpleWindow(display, XDefaultRootWindow(display), 0, 0, 100, 100, 0, 0, 0);
			XSelectInput(display, window, 1);
			XMapWindow(display, window);
			XSetInputFocus(display, window, 1, 0);
			XSync(display, 0);
			ready.send(window as u32).unwrap();
			receive.recv().unwrap();
			let mut text = String::new();
			while text.chars().count() < expected {
				let mut event = [0 as c_long; 24];
				XNextEvent(display, event.as_mut_ptr());
				match event[0] as c_int {
					34 => {
						XRefreshKeyboardMapping(event.as_mut_ptr());
					},
					2 => {
						let mut symbol = 0;
						let mut buffer = [0; 32];
						XLookupString(
							event.as_mut_ptr(),
							buffer.as_mut_ptr(),
							32,
							&mut symbol,
							std::ptr::null_mut(),
						);
						text.push(
							Keysym::new(symbol as u32)
								.key_char()
								.expect("a text keysym"),
						);
					},
					33 => break,
					_ => {},
				}
			}
			text
		}
	});
	let window = started.recv().unwrap();
	let (conn, screen) = x11rb::connect(Some(&display)).unwrap();
	let root = conn.setup().roots[screen].root;
	let conn = Arc::new(conn);
	let before = core_symbols(&conn);
	let mut input = X11Input::new(Arc::clone(&conn), root, Some(display)).unwrap();
	let target = if mode == DeliveryMode::Background {
		input.mpx_unavailable = Some("XSendEvent fixture".into());
		Target::Window(window.to_string())
	} else {
		Target::Desktop
	};
	let result = input.type_text(&target, text, mode);
	if result.is_err() {
		use x11rb::protocol::xproto::{ClientMessageEvent, EventMask};
		conn
			.send_event(
				false,
				window,
				EventMask::NO_EVENT,
				ClientMessageEvent::new(32, window, 0u32, [0u32; 5]),
			)
			.unwrap()
			.check()
			.unwrap();
	}
	resume.send(()).unwrap();
	let received = receiver.join().unwrap();
	result.unwrap();
	assert_eq!(received, text);
	// The receiver's last lookup, not a clock, releases the session's map.
	input.text_mapping.finish().unwrap();
	assert_eq!(core_symbols(&conn), before);
	assert!(Keymap::xtest(&conn).unwrap().plan_text("✓").is_err());
}

#[test]
#[ignore = "starts Xvfb and uses Xlib"]
fn remapped_xtest_text_survives_a_receiver_stalled_until_after_send() {
	text_is_translated(DeliveryMode::Foreground, "héllo wörld ✓");
}
#[test]
#[ignore = "starts Xvfb and uses Xlib"]
fn remapped_send_event_text_survives_a_receiver_stalled_until_after_send() {
	text_is_translated(DeliveryMode::Background, "héllo wörld ✓");
}
#[test]
#[ignore = "starts Xvfb"]
fn text_beyond_the_spare_rows_is_refused_before_any_key() {
	let (_server, display) = server();
	let (conn, screen) = x11rb::connect(Some(&display)).unwrap();
	let root = conn.setup().roots[screen].root;
	let conn = Arc::new(conn);
	let before = core_symbols(&conn);
	let mut input = X11Input::new(Arc::clone(&conn), root, Some(display)).unwrap();
	// More distinct Cyrillic letters than Xvfb's layout has spare rows (19).
	let error = input
		.type_text(
			&Target::Desktop,
			"Съешь ещё этих мягких французских булок, да выпей чаю.",
			DeliveryMode::Foreground,
		)
		.unwrap_err();
	assert!(error.message.contains("no input was sent"), "{}", error.message);
	assert_eq!(input.text_mapping.presses(), 0, "a key went out before the refusal");
	assert_eq!(core_symbols(&conn), before, "the refusal left a binding");
}

#[test]
#[ignore = "starts Xvfb"]
fn refused_chords_and_no_spare_text_do_not_activate_the_target() {
	use x11rb::protocol::{
		Event,
		xproto::{CreateWindowAux, EventMask, InputFocus, WindowClass},
	};
	let (_server, display) = server();
	let (app, screen) = x11rb::connect(Some(&display)).unwrap();
	let root = app.setup().roots[screen].root;
	let window = app.generate_id().unwrap();
	app.create_window(
		0,
		window,
		root,
		0,
		0,
		100,
		100,
		0,
		WindowClass::INPUT_OUTPUT,
		0,
		&CreateWindowAux::new().event_mask(EventMask::FOCUS_CHANGE),
	)
	.unwrap()
	.check()
	.unwrap();
	app.map_window(window).unwrap().check().unwrap();
	app.set_input_focus(InputFocus::PARENT, root, 0u32)
		.unwrap()
		.check()
		.unwrap();
	let (conn, _) = x11rb::connect(Some(&display)).unwrap();
	let conn = Arc::new(conn);
	let mut input = X11Input::new(Arc::clone(&conn), root, Some(display)).unwrap();
	let target = Target::Window(window.to_string());
	let mut cached = Keymap::xtest(&conn).unwrap();
	input.text_mapping.bind(&mut cached, "é").unwrap();
	input
		.key_chord(&target, &[KeyName::Char('é')], DeliveryMode::Foreground)
		.unwrap_err();
	app.get_input_focus().unwrap().reply().unwrap();
	assert!(
		!std::iter::from_fn(|| app.poll_for_event().unwrap())
			.any(|event| matches!(event,Event::FocusIn(event) if event.event==window))
	);
	input.text_mapping.finish().unwrap();
	let count = conn.setup().max_keycode - conn.setup().min_keycode + 1;
	let mut map = conn
		.get_keyboard_mapping(conn.setup().min_keycode, count)
		.unwrap()
		.reply()
		.unwrap();
	for row in map.keysyms.chunks_mut(usize::from(map.keysyms_per_keycode)) {
		if row.iter().all(|&symbol| symbol == 0) {
			row.fill(Keysym::F35.raw());
		}
	}
	conn
		.change_keyboard_mapping(
			count,
			conn.setup().min_keycode,
			map.keysyms_per_keycode,
			&map.keysyms,
		)
		.unwrap()
		.check()
		.unwrap();
	let error = input
		.type_text(&target, "é✓", DeliveryMode::Foreground)
		.unwrap_err();
	assert!(error.message.contains("only 0"));
	app.get_input_focus().unwrap().reply().unwrap();
	assert!(
		!std::iter::from_fn(|| app.poll_for_event().unwrap())
			.any(|event| matches!(event,Event::FocusIn(event) if event.event==window))
	);
}

#[test]
#[ignore = "starts Xvfb"]
fn a_foreign_rebinding_survives_session_restore() {
	let (_server, display) = server();
	let (conn, _) = x11rb::connect(Some(&display)).unwrap();
	let conn = Arc::new(conn);
	let mut map = Keymap::xtest(&conn).unwrap();
	let mut mapping = TextMapping::new(Arc::clone(&conn));
	mapping.bind(&mut map, "✓").unwrap();
	let code = map.plan_text("✓").unwrap()[0].keycode;
	let (foreign, _) = x11rb::connect(Some(&display)).unwrap();
	let current = foreign
		.get_keyboard_mapping(code, 1)
		.unwrap()
		.reply()
		.unwrap();
	let row = vec![Keysym::eacute.raw(); usize::from(current.keysyms_per_keycode)];
	foreign
		.change_keyboard_mapping(1, code, current.keysyms_per_keycode, &row)
		.unwrap()
		.check()
		.unwrap();
	let rebound = foreign
		.get_keyboard_mapping(code, 1)
		.unwrap()
		.reply()
		.unwrap();
	mapping.finish().unwrap();
	let after = foreign
		.get_keyboard_mapping(code, 1)
		.unwrap()
		.reply()
		.unwrap();
	assert_eq!(after.keysyms, rebound.keysyms);
}

#[test]
#[ignore = "starts Xvfb"]
fn remapped_text_restores_on_session_unwind_after_cancellation() {
	use x11rb::protocol::xtest::ConnectionExt as _;
	let (_server, display) = server();
	let (conn, _) = x11rb::connect(Some(&display)).unwrap();
	let conn = Arc::new(conn);
	let before = core_symbols(&conn);
	let source = control::CancellationSource::default();
	let token = source.token();
	let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
		let mut map = Keymap::xtest(&conn).unwrap();
		let mut mapping = TextMapping::new(Arc::clone(&conn));
		mapping.bind(&mut map, "✓✓").unwrap();
		let steps = map.plan_text("✓✓").unwrap();
		let result = control::with_token_for_test(&token, || {
			keymap::run_steps(&steps, |step| {
				if step.press {
					mapping.pressed(step.keycode);
				}
				conn
					.xtest_fake_input(
						if step.press { 2 } else { 3 },
						step.keycode,
						0,
						conn.setup().roots[0].root,
						0,
						0,
						0,
					)
					.unwrap()
					.check()
					.unwrap();
				if step.press {
					source.cancel();
				}
				Ok(())
			})
		});
		assert!(result.is_err());
		panic!("unwind the cancelled session");
	}));
	assert!(result.is_err());
	assert_eq!(core_symbols(&conn), before);
	assert!(Keymap::xtest(&conn).unwrap().plan_text("✓").is_err());
}

#[test]
#[ignore = "starts Xvfb"]
fn failed_close_reports_sent_text_and_consumes_ownership() {
	use x11rb::protocol::xtest::ConnectionExt as _;
	let (mut server, display) = server();
	let (conn, _) = x11rb::connect(Some(&display)).unwrap();
	let conn = Arc::new(conn);
	let mut map = Keymap::xtest(&conn).unwrap();
	let mut mapping = TextMapping::new(Arc::clone(&conn));
	mapping.bind(&mut map, "✓").unwrap();
	let code = map.plan_text("✓").unwrap()[0].keycode;
	for event in [2, 3] {
		conn
			.xtest_fake_input(event, code, 0, conn.setup().roots[0].root, 0, 0, 0)
			.unwrap()
			.check()
			.unwrap();
	}
	mapping.pressed(code);
	server.0.kill().unwrap();
	server.0.wait().unwrap();
	let error = mapping.finish().unwrap_err();
	assert!(error.message.contains("the text was sent"));
	assert!(mapping.finish().is_ok());
}

#[test]
#[ignore = "starts Xvfb"]
fn remapped_device_text_restores_both_slave_and_master() {
	use x11rb::protocol::xinput::{
		ConnectionExt as _, Device, DeviceType, HierarchyChange, HierarchyChangeData,
		HierarchyChangeDataAddMaster,
	};
	let (_server, display) = server();
	let (conn, _) = x11rb::connect(Some(&display)).unwrap();
	let conn = Arc::new(conn);
	conn.xinput_xi_query_version(2, 0).unwrap().reply().unwrap();
	let name = b"remap fixture";
	conn
		.xinput_xi_change_hierarchy(&[HierarchyChange {
			len:  ((8 + name.len()).div_ceil(4)) as u16,
			data: HierarchyChangeData::AddMaster(HierarchyChangeDataAddMaster {
				name:      name.to_vec(),
				send_core: false,
				enable:    true,
			}),
		}])
		.unwrap()
		.check()
		.unwrap();
	let devices = conn
		.xinput_xi_query_device(Device::ALL)
		.unwrap()
		.reply()
		.unwrap();
	let master = devices
		.infos
		.iter()
		.find(|info| {
			info.name == b"remap fixture keyboard" && info.type_ == DeviceType::MASTER_KEYBOARD
		})
		.unwrap()
		.deviceid;
	let slave = devices
		.infos
		.iter()
		.find(|info| info.attachment == master && info.type_ == DeviceType::SLAVE_KEYBOARD)
		.unwrap()
		.deviceid;
	let mut map = Keymap::mpx(&conn, slave, master).unwrap();
	let mut mapping = TextMapping::new(Arc::clone(&conn));
	mapping.bind(&mut map, "✓").unwrap();
	assert!(Keymap::device(&conn, slave).unwrap().plan_text("✓").is_ok());
	assert!(
		Keymap::device(&conn, master)
			.unwrap()
			.plan_text("✓")
			.is_ok()
	);
	mapping.finish().unwrap();
	assert!(
		Keymap::device(&conn, slave)
			.unwrap()
			.plan_text("✓")
			.is_err()
	);
	assert!(
		Keymap::device(&conn, master)
			.unwrap()
			.plan_text("✓")
			.is_err()
	);
}

#[test]
#[ignore = "starts Xvfb"]
fn contiguous_bindings_are_batched_and_reused_without_mapping_notifications() {
	use x11rb::protocol::{Event, xproto::Mapping};
	let (_server, display) = server();
	let (conn, _) = x11rb::connect(Some(&display)).unwrap();
	let conn = Arc::new(conn);
	let count = conn.setup().max_keycode - conn.setup().min_keycode + 1;
	let current = conn
		.get_keyboard_mapping(conn.setup().min_keycode, count)
		.unwrap()
		.reply()
		.unwrap();
	conn
		.change_keyboard_mapping(
			count,
			conn.setup().min_keycode,
			current.keysyms_per_keycode,
			&vec![0; current.keysyms.len()],
		)
		.unwrap()
		.check()
		.unwrap();
	let (observer, _) = x11rb::connect(Some(&display)).unwrap();
	let notifications = || {
		observer.get_input_focus().unwrap().reply().unwrap();
		std::iter::from_fn(|| observer.poll_for_event().unwrap())
			.filter(
				|event| matches!(event, Event::MappingNotify(event) if event.request == Mapping::KEYBOARD),
			)
			.count()
	};
	notifications();
	let mut map = Keymap::core(&conn).unwrap();
	let mut mapping = TextMapping::new(Arc::clone(&conn));
	mapping.bind(&mut map, "éö✓").unwrap();
	assert_eq!(notifications(), 1, "one contiguous mapping request");
	mapping.bind(&mut map, "éö✓").unwrap();
	assert_eq!(notifications(), 0, "a later run reuses the cached rows");
	mapping.finish().unwrap();
}

#[test]
#[ignore = "starts Xvfb"]
fn another_sessions_row_is_neither_typed_through_nor_chorded() {
	let (_server, display) = server();
	let session = || Arc::new(x11rb::connect(Some(&display)).unwrap().0);
	let (a, b) = (session(), session());
	let check = keymap::keysym_for_key(KeyName::Char('✓'));
	let mut a_map = Keymap::core(&a).unwrap();
	let mut a_mapping = TextMapping::new(Arc::clone(&a));
	a_mapping.bind(&mut a_map, "✓").unwrap();
	let mut chord = Keymap::core(&b).unwrap();
	let mut b_mapping = TextMapping::new(Arc::clone(&b));
	b_mapping.hide(&mut chord).unwrap();
	assert!(chord.lookup(check).is_none(), "B could chord ✓ through A's row");
	let mut b_map = Keymap::core(&b).unwrap();
	b_mapping.bind(&mut b_map, "✓").unwrap();
	let (b_code, _) = b_map.lookup(check).unwrap();
	a_mapping.finish().unwrap();
	assert_eq!(
		Keymap::core(&b)
			.unwrap()
			.lookup(check)
			.map(|(code, _)| code),
		Some(b_code),
		"B's ✓ lost its row when A closed"
	);
	b_mapping.finish().unwrap();
}

#[test]
#[ignore = "starts Xvfb and runs setxkbmap"]
fn a_row_another_session_took_after_a_reload_is_left_to_it() {
	let (_server, display) = server();
	let session = || Arc::new(x11rb::connect(Some(&display)).unwrap().0);
	let (a, b) = (session(), session());
	let check = keymap::keysym_for_key(KeyName::Char('✓'));
	let mut a_mapping = TextMapping::new(Arc::clone(&a));
	a_mapping.bind(&mut Keymap::core(&a).unwrap(), "✓").unwrap();
	reload(&display);
	let mut b_mapping = TextMapping::new(Arc::clone(&b));
	let mut b_map = Keymap::core(&b).unwrap();
	b_mapping.bind(&mut b_map, "✓").unwrap();
	let b_code = b_map.lookup(check).map(|(code, _)| code);
	a_mapping.bind(&mut Keymap::core(&a).unwrap(), "✓").unwrap();
	a_mapping.finish().unwrap();
	assert_eq!(
		Keymap::core(&b)
			.unwrap()
			.lookup(check)
			.map(|(code, _)| code),
		b_code,
		"A's restore cleared B's ✓"
	);
	b_mapping.finish().unwrap();
}

/// Writes `symbol` into row `code` of the core keyboard's master only, as a
/// device switch can: the core map shows it, the `XTest` keyboard does not.
fn set_master_row(conn: &x11rb::rust_connection::RustConnection, code: u8, symbol: u32) {
	use x11rb::protocol::xinput::{ConnectionExt as _, Device, DeviceType};
	let master = conn
		.xinput_xi_query_device(Device::ALL_MASTER)
		.unwrap()
		.reply()
		.unwrap()
		.infos
		.into_iter()
		.find(|info| info.type_ == DeviceType::MASTER_KEYBOARD)
		.unwrap()
		.deviceid;
	let width = Keymap::device(conn, master).unwrap().keysyms_per_keycode;
	conn
		.xinput_change_device_key_mapping(
			u8::try_from(master).unwrap(),
			code,
			width,
			1,
			&vec![symbol; usize::from(width)],
		)
		.unwrap()
		.check()
		.unwrap();
}

/// Reloads the US layout as a user would, into the core map and every keyboard.
fn reload(display: &str) {
	let status = Command::new("setxkbmap")
		.args(["-display", display, "us"])
		.status()
		.unwrap();
	assert!(status.success());
}

#[test]
#[ignore = "starts Xvfb and runs setxkbmap"]
fn split_maps_refuse_text_on_another_sessions_row_until_a_reload() {
	let (_server, display) = server();
	let session = || Arc::new(x11rb::connect(Some(&display)).unwrap().0);
	let (a, b, other) = (session(), session(), session());
	let (check, e_acute) = (keymap::keysym_for_key(KeyName::Char('✓')), 0xe9);
	let xtest_row = |symbol| {
		Keymap::xtest(&other)
			.unwrap()
			.lookup(symbol)
			.map(|(row, _)| row)
	};
	let refused = |result: crate::desktop::error::CoreResult<()>| {
		result.is_err_and(|error| error.message.contains("disagree"))
	};
	let mut a_mapping = TextMapping::new(Arc::clone(&a));
	a_mapping.bind(&mut Keymap::core(&a).unwrap(), "✓").unwrap();
	let code = xtest_row(check).unwrap();
	// The core map loses A's ✓; the `XTest` keyboard keeps it.
	set_master_row(&other, code, 0);
	let mut b_mapping = TextMapping::new(Arc::clone(&b));
	assert!(refused(b_mapping.bind(&mut Keymap::core(&b).unwrap(), "é")), "B bound é");
	assert_eq!(xtest_row(check), Some(code), "B's refused bind took A's XTest row");
	// A reload clears the row in both maps and B takes it; then the core map
	// shows A's old ✓ while the `XTest` keyboard keeps B's é.
	reload(&display);
	b_mapping.bind(&mut Keymap::core(&b).unwrap(), "é").unwrap();
	assert_eq!(xtest_row(e_acute), Some(code), "B took another row");
	set_master_row(&other, code, check);
	assert!(refused(a_mapping.bind(&mut Keymap::core(&a).unwrap(), "✓")), "A bound ✓");
	assert!(refused(a_mapping.hide(&mut Keymap::core(&a).unwrap())), "A planned a chord");
	a_mapping.finish().unwrap();
	assert_eq!(xtest_row(e_acute), Some(code), "A's restore cleared B's XTest row");
	// Once a reload makes the two maps agree, text binds again.
	reload(&display);
	a_mapping.bind(&mut Keymap::core(&a).unwrap(), "✓").unwrap();
	// A restore that leaves A's row in the `XTest` keyboard keeps it marked.
	set_master_row(&other, xtest_row(check).unwrap(), 0);
	a_mapping.finish().unwrap();
	assert!(refused(b_mapping.hide(&mut Keymap::core(&b).unwrap())), "A unmarked its XTest row");
	b_mapping.finish().unwrap();
}

#[test]
#[ignore = "starts Xvfb"]
fn a_dead_sessions_mark_on_a_row_we_hold_leaves_it_typeable() {
	use x11rb::{
		protocol::xproto::{AtomEnum, PropMode},
		wrapper::ConnectionExt as _,
	};
	let (_server, display) = server();
	let session = || Arc::new(x11rb::connect(Some(&display)).unwrap().0);
	let (a, other) = (session(), session());
	let check = keymap::keysym_for_key(KeyName::Char('✓'));
	let mut map = Keymap::core(&a).unwrap();
	let mut mapping = TextMapping::new(Arc::clone(&a));
	mapping.bind(&mut map, "✓").unwrap();
	let (code, _) = map.lookup(check).unwrap();
	// A killed session's mark on the same row and keysym: its window is gone.
	let atom = other
		.intern_atom(false, b"_OMP_TEXT_KEYCODES")
		.unwrap()
		.reply()
		.unwrap()
		.atom;
	let (root, dead) = (other.setup().roots[0].root, other.generate_id().unwrap());
	let mark = [dead, code.into(), check];
	other
		.change_property32(PropMode::APPEND, root, atom, AtomEnum::CARDINAL, &mark)
		.unwrap()
		.check()
		.unwrap();
	mapping.bind(&mut map, "✓").unwrap();
	assert_eq!(map.lookup(check).map(|(row, _)| row), Some(code));
	mapping.finish().unwrap();
}

#[test]
#[ignore = "starts Xvfb and runs setxkbmap"]
fn a_row_a_layout_reload_cleared_is_bound_again() {
	let (_server, display) = server();
	let (conn, _) = x11rb::connect(Some(&display)).unwrap();
	let conn = Arc::new(conn);
	let mut map = Keymap::core(&conn).unwrap();
	let mut mapping = TextMapping::new(Arc::clone(&conn));
	mapping.bind(&mut map, "é").unwrap();
	reload(&display);
	assert!(Keymap::core(&conn).unwrap().lookup(0xe9).is_none(), "the reload kept é");
	mapping.bind(&mut map, "é").unwrap();
	assert!(map.lookup(0xe9).is_some());
	mapping.finish().unwrap();
}
