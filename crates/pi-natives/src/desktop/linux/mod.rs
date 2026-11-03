pub mod ax;
mod menus;
pub mod wayland;
pub mod x11;

use std::time::Duration;

use super::{
	backend::Backend,
	control,
	error::{CoreResult, DesktopError},
	types::DisplaySelector,
};

/// How long each click's button stays down.
const CLICK_DELAY: Duration = Duration::from_millis(12);
/// Release → next press of a multi-click. Chromium synthesizes `dblclick` only
/// when the first pair reached it before the second, and Qt apps on KDE Plasma
/// saw libei presses a few microseconds apart as separate single clicks.
const MULTI_CLICK_GAP: Duration = Duration::from_millis(50);

/// Sends `count` clicks through `send(pressed)` for the `XTest` and libei
/// routes, holding each press for `CLICK_DELAY` and spacing the clicks
/// `MULTI_CLICK_GAP` apart. Every press attempt is released, even a failed
/// one; a cancel stops the next press, but not a click whose last press went
/// out.
fn pace_clicks(count: u32, mut send: impl FnMut(bool) -> CoreResult<()>) -> CoreResult<()> {
	let count = count.max(1);
	for index in 0..count {
		if index > 0 {
			control::wait(MULTI_CLICK_GAP)?;
		}
		control::check()?;
		let pressed =
			send(true).and_then(|()| control::sent_gap_wait(CLICK_DELAY, index + 1 == count));
		let released = control::cleanup(|| send(false));
		pressed.and(released)?;
	}
	Ok(())
}

pub fn new_backend(display: DisplaySelector) -> CoreResult<Box<dyn Backend>> {
	if std::env::var_os("WAYLAND_DISPLAY").is_some() {
		return Ok(Box::new(wayland::WaylandBackend::new(display)));
	}
	if std::env::var_os("DISPLAY").is_some() {
		return Ok(Box::new(x11::X11Backend::new(display)?));
	}
	Err(DesktopError::capture_failed(
		"no display server (neither WAYLAND_DISPLAY nor DISPLAY is set)",
	))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn multi_click_presses_are_held_and_spaced_for_event_consumers() {
		use std::time::Instant;

		let mut sent: Vec<(bool, Instant)> = Vec::new();
		pace_clicks(2, |pressed| {
			sent.push((pressed, Instant::now()));
			Ok(())
		})
		.unwrap();
		let order: Vec<bool> = sent.iter().map(|&(pressed, _)| pressed).collect();
		assert_eq!(order, [true, false, true, false]);
		assert!(sent[1].1.duration_since(sent[0].1) >= CLICK_DELAY, "first press must be held");
		assert!(
			sent[2].1.duration_since(sent[1].1) >= MULTI_CLICK_GAP,
			"second click must follow the first by a multi-click gap"
		);
		assert!(sent[3].1.duration_since(sent[2].1) >= CLICK_DELAY, "second press must be held");
	}

	#[test]
	fn cancellation_releases_the_held_press_and_spares_a_click_that_went_out() {
		let source = control::CancellationSource::default();
		let token = source.token();
		let mut sent = Vec::new();
		let result = control::with_token_for_test(&token, || {
			pace_clicks(2, |pressed| {
				sent.push(pressed);
				source.cancel();
				Ok(())
			})
		});
		assert!(result.is_err(), "a cancel before the last press stops the gesture");
		assert_eq!(sent, [true, false]);

		let source = control::CancellationSource::default();
		let token = source.token();
		let mut sent = Vec::new();
		let result = control::with_token_for_test(&token, || {
			pace_clicks(1, |pressed| {
				sent.push(pressed);
				if pressed {
					source.cancel();
				}
				Ok(())
			})
		});
		assert!(result.is_ok(), "a click whose last press went out must not report Cancelled");
		assert_eq!(sent, [true, false]);
	}

	#[test]
	fn a_failed_press_is_still_released_and_stops_the_gesture() {
		let mut sent = Vec::new();
		let result = pace_clicks(2, |pressed| {
			sent.push(pressed);
			if pressed {
				Err(DesktopError::input_failed("press flush failed"))
			} else {
				Ok(())
			}
		});
		assert!(result.is_err());
		assert_eq!(sent, [true, false]);
	}
}
