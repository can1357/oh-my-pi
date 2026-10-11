//! Login-session state (lock screen, display sleep) and the assertion that
//! keeps the display awake while the agent acts.

use objc2_core_foundation::{CFBoolean, CFDictionary, CFRetained, CFString, CFType};
use objc2_core_graphics::{
	CGDirectDisplayID, CGDisplayIsAsleep, CGGetOnlineDisplayList, CGSessionCopyCurrentDictionary,
};

use super::super::types::{DisplaySelector, ScreenState};
use crate::power::platform::{AssertionInner, AssertionKind};

/// Session dictionary key `WindowServer` sets to true while the lock screen is
/// up; absent while unlocked.
const SCREEN_LOCKED_KEY: &str = "CGSSessionScreenIsLocked";
/// Shown by `pmset -g assertions` next to the holding process.
const DISPLAY_AWAKE_REASON: &str = "oh-my-pi computer tool is operating the desktop";
const MAX_ONLINE_DISPLAYS: u32 = 32;

/// `display_asleep` covers the session's displays: the selected one for a
/// display id, otherwise every online display, since `active` and `all` can
/// capture any of them.
pub(in super::super) fn screen_state(selector: &DisplaySelector) -> ScreenState {
	ScreenState {
		locked:         screen_locked(),
		display_asleep: displays_asleep(selector, &online_displays(), |id| CGDisplayIsAsleep(id)),
	}
}

fn displays_asleep(
	selector: &DisplaySelector,
	online: &[CGDirectDisplayID],
	asleep: impl Fn(CGDirectDisplayID) -> bool,
) -> bool {
	if let DisplaySelector::Id(id) = selector
		&& let Ok(id) = id.trim().parse::<CGDirectDisplayID>()
		&& online.contains(&id)
	{
		return asleep(id);
	}
	!online.is_empty() && online.iter().all(|&id| asleep(id))
}

fn online_displays() -> Vec<CGDirectDisplayID> {
	let mut ids = [0; MAX_ONLINE_DISPLAYS as usize];
	let mut count = 0;
	// SAFETY: `ids` holds `MAX_ONLINE_DISPLAYS` writable entries and `count` is
	// a valid out-pointer for the synchronous call.
	let error =
		unsafe { CGGetOnlineDisplayList(MAX_ONLINE_DISPLAYS, ids.as_mut_ptr(), &raw mut count) };
	if error.0 != 0 {
		return Vec::new();
	}
	ids[..(count as usize).min(ids.len())].to_vec()
}

fn screen_locked() -> bool {
	let Some(session) = CGSessionCopyCurrentDictionary() else {
		// No GUI session (e.g. an SSH login): there is no lock screen to report.
		return false;
	};
	// SAFETY: the session dictionary's keys are CFStrings and its values
	// CFTypes; the copy is owned here and never mutated.
	let session = unsafe { CFRetained::cast_unchecked::<CFDictionary<CFString, CFType>>(session) };
	let key = CFString::from_static_str(SCREEN_LOCKED_KEY);
	// SAFETY: `session` is an immutable copy that outlives the borrow.
	unsafe { session.get_unchecked(&key) }
		.and_then(|value| value.downcast_ref::<CFBoolean>())
		.is_some_and(CFBoolean::value)
}

/// Prevent-idle-display-sleep assertion, held while `Some`.
#[derive(Default)]
pub(super) struct DisplayAwake(Option<AssertionInner>);

impl DisplayAwake {
	pub(super) fn set(&mut self, awake: bool) {
		match (awake, self.0.is_some()) {
			(true, false) => {
				// A refused assertion only means the display may sleep as it
				// would without the agent; screen-state reporting covers that.
				self.0 =
					AssertionInner::start(AssertionKind::PreventDisplaySleep, DISPLAY_AWAKE_REASON).ok();
			},
			(false, true) => self.0 = None,
			_ => {},
		}
	}
}

#[cfg(test)]
mod tests {
	use super::{DisplaySelector, displays_asleep};

	#[test]
	fn display_sleep_follows_the_sessions_displays_not_the_main_one() {
		// Display 1 is main and awake; secondary 2 sleeps.
		let asleep = |id| id == 2;
		let online = [1, 2];
		assert!(displays_asleep(&DisplaySelector::Id("2".into()), &online, asleep));
		assert!(!displays_asleep(&DisplaySelector::Id("1".into()), &online, asleep));
		assert!(!displays_asleep(&DisplaySelector::Active, &online, asleep));
		assert!(!displays_asleep(&DisplaySelector::All, &online, asleep));
		// Main asleep, secondary usable: not "nothing can be captured".
		assert!(!displays_asleep(&DisplaySelector::All, &online, |id| id == 1));
		assert!(displays_asleep(&DisplaySelector::All, &online, |_| true));
		// An id that is not online falls back to every display.
		assert!(!displays_asleep(&DisplaySelector::Id("9".into()), &online, asleep));
		assert!(!displays_asleep(&DisplaySelector::Active, &[], |_| true));
	}
}
