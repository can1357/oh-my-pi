//! Regression checks for sealed-band repair and delivery acknowledgement.

use std::time::Duration;

use omp_tui::{
	components::Pre,
	frame_text,
	slots::{BlockState, Delivered, Mode, ResizePolicy, Slots},
};

fn texts(slots: &Slots) -> Vec<String> {
	slots
		.logical_history()
		.map(|row| row.text().to_owned())
		.collect()
}

#[test]
fn mutation_landing_on_committed_band_forces_atomic_rebuild() {
	let mut slots = Slots::new(32, 3, ResizePolicy::Rebuild);
	let id = slots.open(Mode::Mutable);
	slots.set(id, Pre::new().text("old-a\nold-b"));
	slots.finalize(id);

	let first = slots.plan();
	assert_eq!(first.rows().len(), 2);
	slots.commit(first, Delivered::Partial(1));
	assert_eq!(texts(&slots), ["old-a"]);
	assert_eq!(slots.state(id), BlockState::Finalized);

	slots.set(id, Pre::new().text("new-a\nnew-b"));
	let repair = slots.plan();
	assert!(repair.rebuild());
	assert_eq!(repair.rows().len(), 2);
	slots.commit(repair, Delivered::Partial(1));

	// The replacement is an atomic logical transaction even if physical replay
	// is acknowledged in more than one delivery.
	assert_eq!(texts(&slots), ["old-a"]);
	assert_eq!(slots.state(id), BlockState::Finalized);
	let tail = slots.plan();
	assert!(!tail.rebuild(), "the epoch reset itself is never repeated");
	assert_eq!(tail.rows().len(), 1);
	slots.commit(tail, Delivered::All);

	assert_eq!(texts(&slots), ["new-a", "new-b"]);
	assert_eq!(slots.state(id), BlockState::Committed);
}

#[test]
fn append_only_reveal_retains_its_cursor_across_appends() {
	let mut slots = Slots::new(20, 2, ResizePolicy::Rebuild);
	let id = slots.open(Mode::AppendOnly);
	slots.append(id, "abcdef");
	let armed = slots.plan();
	assert_eq!(frame_text(armed.viewport()).trim(), "");
	slots.commit(armed, Delivered::All);

	assert!(slots.tick(Duration::from_millis(34)));
	let first = slots.plan();
	assert_eq!(frame_text(first.viewport()).trim(), "ab");
	slots.commit(first, Delivered::All);

	slots.append(id, "ghijkl");
	let retained = slots.plan();
	assert_eq!(
		frame_text(retained.viewport()).trim(),
		"ab",
		"append must not rebuild and reset the reveal cursor",
	);
	slots.commit(retained, Delivered::All);
	for millis in [68, 102, 136, 170, 204] {
		slots.tick(Duration::from_millis(millis));
	}
	let settled = slots.plan();
	assert_eq!(frame_text(settled.viewport()).trim(), "abcdefghijkl");
	slots.commit(settled, Delivered::All);
}

#[test]
fn mutable_active_snapshots_never_enter_history() {
	let mut slots = Slots::new(16, 2, ResizePolicy::Rebuild);
	let id = slots.open(Mode::Mutable);
	for value in ["one", "two\nthree", "final"] {
		slots.set(id, Pre::new().text(value));
		let plan = slots.plan();
		assert!(plan.rows().is_empty());
		slots.commit(plan, Delivered::All);
		assert_eq!(slots.logical_history().count(), 0);
	}
}
