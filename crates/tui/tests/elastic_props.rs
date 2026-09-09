//! Property checks mirroring the safety invariants in `ElasticSlots.tla`.

use omp_tui::{
	Size,
	slots::{BlockState, Delivered, Mode, ResizePolicy, Slots},
};
use proptest::prelude::*;

fn history(slots: &Slots) -> Vec<(u32, u32, String)> {
	slots
		.logical_history()
		.map(|row| (row.block().get(), row.ordinal(), row.text().to_owned()))
		.collect()
}

fn assert_prefix<T: PartialEq + core::fmt::Debug>(before: &[T], after: &[T]) {
	assert!(after.starts_with(before), "logical history lost or reordered a committed prefix");
}

proptest! {
	/// Mirrors `LifecycleShape`, `Capacity`, `ExactCommittedHistory`,
	/// `NoPrematureHistory`, `ScreenCapacity`, and the history action laws.
	#[test]
	fn inductive_invariant_capacity_and_history_prefix_monotonicity(
		width in 4_u16..40,
		height in 1_u16..8,
		mutable_updates in prop::collection::vec("[a-z]{0,18}", 1..12),
		append_lines in prop::collection::vec("[A-Z]{1,12}", 1..12),
		acks in prop::collection::vec(0_usize..5, 1..30),
	) {
		let mut slots = Slots::new(width, height, ResizePolicy::Rebuild);
		let mutable = slots.open(Mode::Mutable);

		// Mutable snapshots are viewport-only regardless of how often they change.
		for snapshot in &mutable_updates {
			slots.set(mutable, snapshot.as_str());
			let before = history(&slots);
			let plan = slots.plan();
			prop_assert_eq!(plan.viewport().size(), Size::new(width, height));
			prop_assert!(plan.rows().is_empty());
			slots.commit(plan, Delivered::All);
			prop_assert_eq!(history(&slots), before);
			prop_assert_eq!(slots.state(mutable), BlockState::Active);
		}

		slots.finalize(mutable);
		let mut ack = acks.iter().copied().cycle();
		while slots.state(mutable) != BlockState::Committed {
			let before = history(&slots);
			let plan = slots.plan();
			prop_assert_eq!(plan.viewport().size(), Size::new(width, height));
			let delivered = ack.next().unwrap().max(1).min(plan.rows().len());
			let delivered = if delivered == plan.rows().len() {
				Delivered::All
			} else {
				Delivered::Partial(delivered)
			};
			slots.commit(plan, delivered);
			let after = history(&slots);
			assert_prefix(&before, &after);
		}

		let streaming = slots.open(Mode::AppendOnly);
		for line in &append_lines {
			let before = history(&slots);
			slots.append(streaming, line);
			slots.append(streaming, "\n");
			let plan = slots.plan();
			prop_assert_eq!(plan.viewport().size(), Size::new(width, height));
			let delivered = ack.next().unwrap().min(plan.rows().len());
			slots.commit(plan, Delivered::Partial(delivered));
			let after = history(&slots);
			assert_prefix(&before, &after);
			prop_assert!(after.iter().all(|(owner, _, _)| *owner <= streaming.get()));
		}
		slots.finalize(streaming);
		while slots.state(streaming) != BlockState::Committed {
			let before = history(&slots);
			let plan = slots.plan();
			let delivered = ack.next().unwrap().max(1).min(plan.rows().len());
			slots.commit(plan, Delivered::Partial(delivered));
			assert_prefix(&before, &history(&slots));
		}

		let final_history = history(&slots);
		let mut last = (0_u32, 0_u32);
		for &(owner, ordinal, _) in &final_history {
			prop_assert!(owner > last.0 || (owner == last.0 && ordinal == last.1 + 1));
			last = (owner, ordinal);
		}
		prop_assert_eq!(slots.state(mutable), BlockState::Committed);
		prop_assert_eq!(slots.state(streaming), BlockState::Committed);
	}
}

#[test]
fn resize_is_logically_neutral_for_every_policy() {
	for policy in [ResizePolicy::Preserve, ResizePolicy::Append, ResizePolicy::Rebuild] {
		let mut slots = Slots::new(12, 3, policy);
		let id = slots.open(Mode::AppendOnly);
		slots.append(id, "first\nsecond\n");
		slots.finalize(id);
		let plan = slots.plan();
		slots.commit(plan, Delivered::All);
		let before = history(&slots);

		slots.resize(7, 2);
		assert_eq!(history(&slots), before);
		let plan = slots.plan();
		assert_eq!(plan.viewport().size(), Size::new(7, 2));
		assert_eq!(plan.rebuild(), policy == ResizePolicy::Rebuild);
		slots.commit(plan, Delivered::All);
		assert_eq!(history(&slots), before);
	}
}

#[test]
fn partial_delivery_restages_exact_undelivered_suffix() {
	let mut slots = Slots::new(20, 2, ResizePolicy::Rebuild);
	let id = slots.open(Mode::AppendOnly);
	slots.append(id, "one\ntwo\nthree\n");
	slots.finalize(id);

	let first = slots.plan();
	assert_eq!(first.rows().len(), 3);
	let suffix = first.rows()[1..]
		.iter()
		.map(|row| row.logical().clone())
		.collect::<Vec<_>>();
	slots.commit(first, Delivered::Partial(1));
	assert_eq!(slots.logical_history().count(), 1);

	let retry = slots.plan();
	assert_eq!(retry.rows().len(), 2);
	assert_eq!(
		retry
			.rows()
			.iter()
			.map(|row| row.logical().clone())
			.collect::<Vec<_>>(),
		suffix,
	);
	slots.commit(retry, Delivered::All);
	assert_eq!(slots.logical_history().count(), 3);
	assert_eq!(slots.state(id), BlockState::Committed);
}
