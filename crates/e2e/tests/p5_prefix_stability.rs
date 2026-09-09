//! P5: semantic prompt bands keep stable prefixes cacheable.

use std::sync::Arc;

use omp_agent::prompt::{
	PromptError, PromptOut, SlotAssembler, SlotClass, SlotDecl, SlotId, SlotRegistration, SlotSource,
};
use omp_core::Str;
use omp_scribe::Props;
use omp_session::{ComponentRegistry, Session};

struct Text(&'static str);

impl SlotSource for Text {
	fn render(
		&self,
		_dom: &omp_dom::Dom,
		_props: &Props,
		out: &mut dyn PromptOut,
	) -> Result<(), PromptError> {
		out.write_str(self.0);
		Ok(())
	}
}

fn source(
	slot: SlotId,
	class: SlotClass,
	owner: &'static str,
	text: &'static str,
) -> SlotRegistration {
	SlotRegistration {
		decl:   SlotDecl { slot, class, owner: Str::new_static(owner), priority: 0 },
		source: Arc::new(Text(text)),
	}
}

fn render(
	session: &Session,
	volatile: &'static str,
	dynamic: &'static str,
) -> omp_agent::prompt::RenderedPrompt {
	SlotAssembler::new(vec![
		source(SlotId::Conventions, SlotClass::Frozen, "frozen", "FROZEN\n"),
		source(SlotId::Tools, SlotClass::Stable, "stable", "STABLE\n"),
		source(SlotId::Memory, SlotClass::Dynamic, "dynamic", dynamic),
		source(SlotId::Status, SlotClass::Volatile, "volatile", volatile),
	])
	.render_banded(session.dom(), &Props::default())
	.expect("banded prompt")
}

#[test]
fn p5_volatile_changes_do_not_invalidate_stable_prompt_prefix_hashes() {
	let temp = tempfile::tempdir().expect("P5 scratch");
	let session = Session::create(temp.path().join("prefix.oms"), ComponentRegistry::standard())
		.expect("session");
	let before = render(&session, "STATUS A\n", "MEMORY A\n");
	let volatile_changed = render(&session, "STATUS B\n", "MEMORY A\n");
	assert_eq!(
		before.bands[SlotClass::Frozen as usize],
		volatile_changed.bands[SlotClass::Frozen as usize]
	);
	assert_eq!(
		before.bands[SlotClass::Stable as usize],
		volatile_changed.bands[SlotClass::Stable as usize]
	);
	assert_eq!(
		before.bands[SlotClass::Dynamic as usize],
		volatile_changed.bands[SlotClass::Dynamic as usize]
	);
	assert_ne!(
		before.bands[SlotClass::Volatile as usize],
		volatile_changed.bands[SlotClass::Volatile as usize]
	);
}

#[test]
fn p5_dynamic_changes_preserve_frozen_and_stable_band_hashes() {
	let temp = tempfile::tempdir().expect("P5 scratch");
	let session = Session::create(temp.path().join("dynamic.oms"), ComponentRegistry::standard())
		.expect("session");
	let before = render(&session, "STATUS\n", "MEMORY A\n");
	let after = render(&session, "STATUS\n", "MEMORY B\n");
	assert_eq!(before.bands[SlotClass::Frozen as usize], after.bands[SlotClass::Frozen as usize]);
	assert_eq!(before.bands[SlotClass::Stable as usize], after.bands[SlotClass::Stable as usize]);
	assert_ne!(before.bands[SlotClass::Dynamic as usize], after.bands[SlotClass::Dynamic as usize]);
	assert_eq!(
		before.bands[SlotClass::Volatile as usize],
		after.bands[SlotClass::Volatile as usize]
	);
	assert_eq!(before.items.len(), after.items.len());
}
