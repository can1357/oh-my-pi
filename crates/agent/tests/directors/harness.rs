use omp_agent::{
	BindValue, Director, DirectorCx, DirectorRegistry, DirectorStack, LoopDecision, RouteFacts,
	TurnView, find_director, state_bool, state_int, state_str,
};
use omp_core::Str;
use omp_dom::{Handle, KnownTag, NodeSpec, Op, PropId, PropKey, Txn, Value};
use omp_session::{ComponentRegistry, Session};
use serde_json::value::RawValue;
use tempfile::TempDir;

pub struct Call<'a> {
	pub tool:    &'a str,
	pub args:    serde_json::Value,
	pub outcome: serde_json::Value,
}

impl<'a> Call<'a> {
	pub fn new(tool: &'a str, args: serde_json::Value) -> Self {
		Self { tool, args, outcome: serde_json::json!({}) }
	}

	pub fn with_outcome(mut self, outcome: serde_json::Value) -> Self {
		self.outcome = outcome;
		self
	}
}

pub struct Harness {
	_dir:         TempDir,
	pub session:  Session,
	pub stack:    DirectorStack,
	pub registry: DirectorRegistry,
	pub route:    RouteFacts,
	next_call:    u64,
}

impl Harness {
	pub fn new() -> Self {
		let dir = tempfile::tempdir().expect("tempdir");
		let registry = DirectorRegistry::standard();
		let session = Session::create(dir.path().join("director.oms"), ComponentRegistry::standard())
			.expect("session");
		let stack = DirectorStack::from_dom(session.dom(), &registry);
		Self {
			_dir: dir,
			session,
			stack,
			registry,
			route: RouteFacts {
				forced_choice_free: true,
				context_window: 128_000,
				image_input: false,
				..RouteFacts::default()
			},
			next_call: 0,
		}
	}

	pub fn register(&mut self, id: &'static str, constructor: omp_agent::DirectorConstructor) {
		self.registry.register(id, constructor);
		self.stack = DirectorStack::from_dom(self.session.dom(), &self.registry);
	}

	pub fn engage(&mut self, director: impl Director + 'static) -> Handle {
		self
			.stack
			.engage(&mut self.session, Box::new(director))
			.expect("engage")
	}

	pub fn turn(&mut self, text: &str, calls: &[Call<'_>], tokens: u64) -> LoopDecision {
		self.session.begin_turn().expect("turn");
		let turn = *self
			.session
			.dom()
			.children(self.session.dom().body())
			.last()
			.expect("turn handle");
		self
			.session
			.assistant_start("test-model", "test-provider", "test-route")
			.expect("assistant");
		for call in calls {
			self.next_call += 1;
			let args = RawValue::from_string(call.args.to_string()).expect("raw args");
			let id = self
				.session
				.call(call.tool, 1, format!("call-{}", self.next_call), None, Some(args), None)
				.expect("tool call");
			let outcome = RawValue::from_string(call.outcome.to_string()).expect("raw result");
			self.session.settle(id, outcome).expect("tool result");
		}
		self
			.session
			.receipt(omp_journal::data::TurnReceipt::tokens(0, tokens, 0))
			.expect("receipt");
		self.session.assistant_end("stop").expect("assistant end");
		let view = TurnView {
			turn,
			had_tool_calls: !calls.is_empty(),
			assistant_text: Str::new(text),
			stop_reason: Str::new_static("stop"),
		};
		let cx = DirectorCx::new(turn, &self.route);
		self
			.stack
			.observe_turn(&mut self.session, &cx, &view)
			.expect("observe");
		self
			.stack
			.on_yield(&mut self.session, &cx, &view)
			.expect("yield")
	}

	pub fn observe_only(&mut self, text: &str, calls: &[Call<'_>], tokens: u64) {
		self.session.begin_turn().expect("turn");
		let turn = *self
			.session
			.dom()
			.children(self.session.dom().body())
			.last()
			.expect("turn handle");
		self
			.session
			.assistant_start("test-model", "test-provider", "test-route")
			.expect("assistant");
		for call in calls {
			self.next_call += 1;
			let args = RawValue::from_string(call.args.to_string()).expect("raw args");
			let id = self
				.session
				.call(call.tool, 1, format!("call-{}", self.next_call), None, Some(args), None)
				.expect("tool call");
			let outcome = RawValue::from_string(call.outcome.to_string()).expect("raw result");
			self.session.settle(id, outcome).expect("tool result");
		}
		self
			.session
			.receipt(omp_journal::data::TurnReceipt::tokens(0, tokens, 0))
			.expect("receipt");
		self.session.assistant_end("stop").expect("assistant end");
		let view = TurnView {
			turn,
			had_tool_calls: !calls.is_empty(),
			assistant_text: Str::new(text),
			stop_reason: Str::new_static("stop"),
		};
		let cx = DirectorCx::new(turn, &self.route);
		self
			.stack
			.observe_turn(&mut self.session, &cx, &view)
			.expect("observe");
	}

	pub fn add_todo(&mut self, text: &str) -> Handle {
		let todo = child_tag(&self.session, self.session.dom().meta(), KnownTag::Todo);
		self.insert(
			todo,
			NodeSpec::new(KnownTag::Item)
				.with_prop(PropId::Status, Value::Str(Str::new_static("pending")))
				.with_content(text),
		)
	}

	pub fn complete_todos(&mut self) {
		let handles = self
			.session
			.dom()
			.select("todo item[status!=completed]")
			.expect("selector")
			.collect::<Vec<_>>();
		self.patch(
			"test.todo.complete",
			handles
				.into_iter()
				.map(|h| Op::Set {
					h,
					prop: PropId::Status.into(),
					value: Value::Str(Str::new_static("completed")),
				})
				.collect(),
		);
	}

	pub fn add_pending_ask(&mut self) -> Handle {
		let prompts = child_tag(&self.session, self.session.dom().queues(), KnownTag::Prompts);
		self.insert(
			prompts,
			NodeSpec::new(KnownTag::Prompt)
				.with_prop(PropId::Kind, Value::Str(Str::new_static("ask")))
				.with_prop(PropId::Status, Value::Str(Str::new_static("pending"))),
		)
	}

	pub fn add_pending_wake(&mut self) -> Handle {
		let jobs = child_tag(&self.session, self.session.dom().meta(), KnownTag::Jobs);
		self.insert(
			jobs,
			NodeSpec::new(KnownTag::Job)
				.with_prop(PropId::Id, Value::Str(Str::new_static("job-1")))
				.with_prop(PropId::Kind, Value::Str(Str::new_static("tool")))
				.with_prop(PropId::Status, Value::Str(Str::new_static("running"))),
		)
	}

	pub fn state_int(&self, id: &str, key: &str) -> Option<i64> {
		find_director(self.session.dom(), id).and_then(|(_, node)| state_int(node, key))
	}

	pub fn state_bool(&self, id: &str, key: &str) -> Option<bool> {
		find_director(self.session.dom(), id).and_then(|(_, node)| state_bool(node, key))
	}

	pub fn state_str(&self, id: &str, key: &str) -> Option<Str> {
		find_director(self.session.dom(), id).and_then(|(_, node)| state_str(node, key))
	}

	pub fn active(&self) -> Vec<&str> {
		self.director_ids_with_status("active")
	}

	pub fn queued(&self) -> Vec<&str> {
		self.director_ids_with_status("queued")
	}

	fn director_ids_with_status(&self, status: &str) -> Vec<&str> {
		self
			.session
			.dom()
			.handles()
			.filter_map(|handle| self.session.dom().get(handle))
			.filter(|node| {
				node.tag == KnownTag::Director.into()
					&& node
						.prop(&PropKey::Custom(Str::new_static("status")))
						.and_then(Value::as_str)
						== Some(status)
			})
			.filter_map(|node| {
				node
					.prop(&PropKey::Custom(Str::new_static("family")))
					.and_then(Value::as_str)
			})
			.collect()
	}

	pub fn developer_texts(&self) -> Vec<Str> {
		self
			.session
			.dom()
			.handles()
			.filter_map(|handle| self.session.dom().get(handle))
			.filter(|node| node.tag == KnownTag::Developer.into())
			.filter_map(|node| node.content.clone())
			.collect()
	}

	pub fn notices(&self) -> Vec<Str> {
		self
			.session
			.dom()
			.handles()
			.filter_map(|handle| self.session.dom().get(handle))
			.filter(|node| node.tag == KnownTag::Notice.into())
			.filter_map(|node| node.content.clone())
			.collect()
	}

	pub fn remove_director(&mut self, id: &str) {
		let (handle, _) = find_director(self.session.dom(), id).expect("director");
		self.patch("test.director.remove", vec![Op::Rm(handle)]);
		self.stack = DirectorStack::from_dom(self.session.dom(), &self.registry);
	}

	pub fn set_state(&mut self, id: &str, key: &str, value: BindValue) {
		let (handle, _) = find_director(self.session.dom(), id).expect("director");
		let value = match value {
			BindValue::Bool(value) => Value::Bool(value),
			BindValue::Int(value) => Value::Int(value),
			BindValue::Str(value) => Value::Str(value),
			BindValue::Float(value) => Value::Float(value),
			BindValue::List(items) => {
				Value::Json(serde_json::value::to_raw_value(&items).expect("list bind serializes"))
			},
		};
		self.patch("test.director.state", vec![Op::Set {
			h: handle,
			prop: omp_dom::PropKey::Custom(Str::new(format!("state/{key}"))),
			value,
		}]);
		self.stack = DirectorStack::from_dom(self.session.dom(), &self.registry);
	}

	fn insert(&mut self, parent: Handle, node: NodeSpec) -> Handle {
		let high = self.session.dom().high_water();
		let after = self.session.dom().children(parent).last().copied();
		self.patch("test.insert", vec![Op::Ins { parent, after, node }]);
		Handle::new(high + 1).expect("handle")
	}

	fn patch(&mut self, label: &'static str, ops: Vec<Op>) {
		if ops.is_empty() {
			return;
		}
		self
			.session
			.patch(Txn {
				cause: self.session.head().expect("head"),
				label: Some(Str::new_static(label)),
				ops,
			})
			.expect("patch");
	}
}

fn child_tag(session: &Session, parent: Handle, tag: KnownTag) -> Handle {
	session
		.dom()
		.children(parent)
		.iter()
		.copied()
		.find(|handle| {
			session
				.dom()
				.get(*handle)
				.is_some_and(|node| node.tag == tag.into())
		})
		.expect("component")
}
