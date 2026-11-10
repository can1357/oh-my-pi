//! Confirmation of synchronous menu commands that enter a modal message loop.

#[derive(Clone, Copy, Debug)]
pub struct ModalPopup {
	pub id:              usize,
	pub owned_by_target: bool,
	pub same_thread:     bool,
	pub enabled:         bool,
	pub visible:         bool,
	pub responsive:      bool,
}

pub fn command_completed(
	sent: bool,
	owner_enabled: bool,
	before: Option<&[usize]>,
	popups: &[ModalPopup],
) -> bool {
	if sent {
		return true;
	}
	let Some(before) = before else {
		return false;
	};
	!owner_enabled
		&& popups.iter().any(|popup| {
			!before.contains(&popup.id)
				&& popup.owned_by_target
				&& popup.same_thread
				&& popup.enabled
				&& popup.visible
				&& popup.responsive
		})
}

#[cfg(test)]
mod tests {
	use super::*;

	const DIALOG: ModalPopup = ModalPopup {
		id:              2,
		owned_by_target: true,
		same_thread:     true,
		enabled:         true,
		visible:         true,
		responsive:      true,
	};

	#[test]
	fn modal_command_timeout_is_confirmed_by_new_responsive_dialog() {
		let popups = [ModalPopup { id: 1, ..DIALOG }, DIALOG];
		assert!(command_completed(false, false, Some(&[1]), &popups));
	}

	#[test]
	fn timeout_without_new_modal_evidence_stays_unconfirmed() {
		assert!(!command_completed(false, false, Some(&[1]), &[]));
		assert!(!command_completed(false, false, None, &[DIALOG]));
		assert!(!command_completed(false, true, Some(&[1]), &[DIALOG]));
		assert!(!command_completed(false, false, Some(&[1, 2]), &[DIALOG]));
		for popup in [
			ModalPopup { owned_by_target: false, ..DIALOG },
			ModalPopup { same_thread: false, ..DIALOG },
			ModalPopup { enabled: false, ..DIALOG },
			ModalPopup { visible: false, ..DIALOG },
			ModalPopup { responsive: false, ..DIALOG },
		] {
			assert!(!command_completed(false, false, Some(&[1]), &[popup]));
		}
	}

	#[test]
	fn completed_command_needs_no_dialog() {
		assert!(command_completed(true, true, None, &[]));
	}
}
