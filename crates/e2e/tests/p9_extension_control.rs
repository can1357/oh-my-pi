//! P9: Python extensions register only engine Directors and DOM Components.

use std::fs;

use omp_agent::{
	BindValue, Director, DirectorCx, DirectorEffect, DirectorRegistry, DirectorStack,
	ExtensionRegistrar, LoopDecision, Slot, TurnView, Verdict,
};
use omp_core::Str;
use omp_dom::{NodeSpec, Tag, Value};
use omp_journal::{Entry, Kind};
use omp_session::{Component, ComponentRegistry, Draft, Session};

struct ContinueOnce;

impl Director for ContinueOnce {
	fn id(&self) -> &'static str {
		"e2e.continue-once"
	}

	fn claims(&self) -> &'static [Slot] {
		&[Slot::Loop]
	}

	fn state(&self) -> Vec<(Str, BindValue)> {
		vec![(Str::new_static("continued"), BindValue::Bool(false))]
	}

	fn evaluate(&self, _: &omp_dom::Dom, cx: &DirectorCx<'_>, _: &TurnView) -> DirectorEffect {
		if matches!(cx.state("continued"), Some(Value::Bool(true))) {
			DirectorEffect::new(Verdict::Yield)
		} else {
			DirectorEffect::new(Verdict::Continue { reminder: None })
				.set_state("continued", BindValue::Bool(true))
		}
	}
}

struct ExtState;

impl Component for ExtState {
	fn interested(&self, kind: &Kind) -> bool {
		kind.name.as_str() == "turn.start"
	}

	fn apply(&mut self, _: &Entry, dom: &omp_dom::Dom, draft: &mut Draft) {
		if dom.handles().any(|handle| {
			dom.get(handle)
				.is_some_and(|node| node.tag.as_str() == "ext-state")
		}) {
			return;
		}
		let meta = dom.meta();
		draft.insert(
			meta,
			dom.children(meta).last().copied(),
			NodeSpec::new(Tag::Custom(Str::new_static("ext-state"))),
		);
	}
}

#[test]
fn extension_registrar_materializes_component_and_directs_yield() {
	let scratch = tempfile::tempdir().expect("scratch directory");
	let journal = scratch.path().join("extension.oms");

	let mut registrar = ExtensionRegistrar::new();
	registrar.director(Box::new(ContinueOnce));
	registrar.component(Box::new(ExtState));

	let mut directors = DirectorRegistry::standard();
	let mut components = ComponentRegistry::standard();
	let installed = registrar.install(&mut directors, &mut components);
	assert_eq!(installed.director_ids, ["e2e.continue-once"]);
	assert!(installed.tool_specs.is_empty());

	let mut session = Session::create(&journal, components).expect("create journal-first session");
	session.begin_turn().expect("begin turn");
	assert!(
		session
			.dom()
			.select("ext-state")
			.expect("selector")
			.next()
			.is_some()
	);

	let turn = session
		.dom()
		.select("turn")
		.expect("turn selector")
		.next()
		.expect("current turn");
	let route = omp_agent::RouteFacts::default();
	let cx = DirectorCx::new(turn, &route);
	let view = TurnView {
		turn,
		had_tool_calls: false,
		assistant_text: Str::new_static("candidate"),
		stop_reason: Str::new_static("stop"),
	};
	let mut stack = DirectorStack::from_dom(session.dom(), &directors);
	stack
		.engage_registered(&mut session, "e2e.continue-once")
		.expect("engage registered Director");
	assert_eq!(
		stack
			.on_yield(&mut session, &cx, &view)
			.expect("first yield"),
		LoopDecision::Continue { reminder: None }
	);
	assert_eq!(
		stack
			.on_yield(&mut session, &cx, &view)
			.expect("second yield"),
		LoopDecision::Yield
	);

	let bytes = fs::read_to_string(&journal).expect("read .oms journal");
	assert!(bytes.contains("event: turn.start@1"));
	assert!(bytes.contains(": director.continue"));
	assert!(bytes.contains("state/continued"));

	drop(session);
	let mut replay_components = ComponentRegistry::standard();
	replay_components.register(ExtState);
	let replayed = Session::open(&journal, replay_components).expect("replay extension session");
	assert!(
		replayed
			.dom()
			.select("ext-state")
			.expect("selector")
			.next()
			.is_some()
	);
}
