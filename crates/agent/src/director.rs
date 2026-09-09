//! DOM-backed Director stack and yield arbitration.

use std::{future, future::Future, pin::Pin, sync::Arc};

use omp_ai::{ChatRequest, ChatStream, ContentPart, Message, Role};
use omp_core::{FastHashMap, Str};
use omp_dom::{Dom, Handle, KnownTag, Node, NodeSpec, Op, PropId, PropKey, Tag, Txn, Value};
use omp_journal::blob::{BlobStore, Error as BlobError};
use omp_session::{Session, SessionError};
use strum::{Display, EnumString, IntoStaticStr, VariantArray};
use thiserror::Error;

use crate::Inference;

const STATUS: &str = "status";
const CLAIMS: &str = "claims";
const FAMILY: &str = "family";
const STATE_PREFIX: &str = "state/";
const BIND_PREFIX: &str = "bind/";
const ACTIVE: &str = "active";
const PAUSED: &str = "paused";
const QUEUED: &str = "queued";

/// One heap-pinned future at the cold, type-erased inference boundary.
pub type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// An exclusive resource claimed by a Director engagement.
#[derive(
	Clone,
	Copy,
	Debug,
	Display,
	EnumString,
	Eq,
	Hash,
	IntoStaticStr,
	Ord,
	PartialEq,
	PartialOrd,
	VariantArray,
)]
#[strum(serialize_all = "snake_case")]
pub enum Slot {
	/// The user-visible operating mode.
	Mode,
	/// Ownership of automatic continuation.
	Loop,
	/// Ownership of native tool selection.
	ToolChoice,
	/// Ownership of the worktree view.
	Worktree,
}

/// A scalar value installed by a Director engagement.
#[derive(Clone, Debug, PartialEq)]
pub enum BindValue {
	/// Boolean value.
	Bool(bool),
	/// Signed integer value.
	Int(i64),
	/// Text value.
	Str(Str),
	/// Finite floating-point value.
	Float(f64),
	/// Homogeneous text list (a `sv_tools` roster).
	List(Vec<Str>),
}

impl BindValue {
	/// Builds a text-list bind from static names.
	#[must_use]
	pub fn list(items: &[&'static str]) -> Self {
		Self::List(items.iter().map(|item| Str::new_static(item)).collect())
	}

	fn into_dom(self) -> Value {
		match self {
			Self::Bool(value) => Value::Bool(value),
			Self::Int(value) => Value::Int(value),
			Self::Str(value) => Value::Str(value),
			Self::Float(value) => Value::Float(value),
			Self::List(items) => {
				serde_json::value::to_raw_value(&items).map_or(Value::Null, Value::Json)
			},
		}
	}

	fn from_dom(value: &Value) -> Option<Self> {
		match value {
			Value::Bool(value) => Some(Self::Bool(*value)),
			Value::Int(value) => Some(Self::Int(*value)),
			Value::Str(value) => Some(Self::Str(value.clone())),
			Value::Float(value) => Some(Self::Float(*value)),
			Value::Json(raw) => serde_json::from_str::<Vec<Str>>(raw.get())
				.ok()
				.map(Self::List),
			Value::Null => None,
		}
	}
}

/// Catalog-derived facts for the selected inference route.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct RouteFacts {
	/// Native named tool choice has no declared route penalty.
	pub forced_choice_free: bool,
	/// Maximum context window for the resolved route.
	pub context_window:     u64,
	/// The route accepts image input (catalog input modalities).
	pub image_input:        bool,
	/// The route enforces per-tool strict JSON Schema (catalog
	/// `ToolFeatureBits::STRICT_SCHEMA`); tools lower to strict declarations
	/// only when affirmative.
	pub strict_schema:      bool,
	/// Grammar constraint languages the route accepts.
	pub grammar:            omp_catalog::GrammarBits,
	/// Maximum model-visible tool declarations, when the route bounds them.
	pub maximum_tools:      Option<u16>,
}

impl RouteFacts {
	/// Capabilities the tool registry needs to lower declarations for this
	/// route.
	#[must_use]
	pub const fn lowering_caps(&self) -> omp_tool::LoweringCaps {
		omp_tool::LoweringCaps {
			strict_schema:  self.strict_schema,
			grammar:        self.grammar,
			maximum_tools:  self.maximum_tools,
			maximum_strict: None,
		}
	}
}

/// The outcome of one Director inspecting a candidate yield.
pub enum Verdict {
	/// Offer the candidate yield to the next outer Director.
	Pass,
	/// Consume the yield and run another turn.
	Continue {
		/// Optional developer aside appended before the next turn.
		reminder: Option<Str>,
	},
	/// Consume the candidate and return it to the user.
	Yield,
	/// Engage a child on top and continue the loop.
	Push(Box<dyn Director>),
	/// Pop this Director and re-offer the same candidate to its parent.
	Done,
	/// Pop this Director, journal an error notice, and re-offer the candidate.
	Fail(Str),
}

/// Read-only facts available while preparing or judging one turn.
pub struct DirectorCx<'a> {
	/// Current `<turn>` element.
	pub turn:  Handle,
	/// Catalog facts for the resolved route.
	pub route: &'a RouteFacts,
	node:      Option<&'a Node>,
	director:  Option<Handle>,
}

impl<'a> DirectorCx<'a> {
	/// Creates context for a turn before the stack selects a Director.
	#[must_use]
	pub const fn new(turn: Handle, route: &'a RouteFacts) -> Self {
		Self { turn, route, node: None, director: None }
	}

	/// Returns the current Director element handle.
	#[must_use]
	pub const fn director(&self) -> Option<Handle> {
		self.director
	}

	/// Returns one durable state property from the current Director element.
	#[must_use]
	pub fn state(&self, key: &str) -> Option<&Value> {
		self
			.director_node()?
			.prop(&custom(&format!("{STATE_PREFIX}{key}")))
	}

	/// Returns the current Director element.
	#[must_use]
	pub const fn director_node(&self) -> Option<&Node> {
		self.node
	}

	const fn for_director<'b>(&'b self, director: Handle, node: &'b Node) -> DirectorCx<'b> {
		DirectorCx {
			turn:     self.turn,
			route:    self.route,
			node:     Some(node),
			director: Some(director),
		}
	}

	/// Constructs a child which requires one named tool call before yielding.
	#[must_use]
	pub fn force_tool(
		&self,
		name: impl Into<Str>,
		until: ForceUntil,
		reminder: Option<Str>,
		retries: u32,
	) -> Verdict {
		Verdict::Push(Box::new(crate::directors::force_tool::ForceTool::new(
			name, until, reminder, retries,
		)))
	}
}

/// Owned facts about the candidate turn.
#[derive(Clone, Debug)]
pub struct TurnView {
	/// Current `<turn>` element.
	pub turn:           Handle,
	/// Whether the model produced any executable tool call.
	pub had_tool_calls: bool,
	/// Complete visible assistant text.
	pub assistant_text: Str,
	/// Canonical completion reason.
	pub stop_reason:    Str,
}

/// Predicate which completes a [`crate::directors::force_tool::ForceTool`].
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ForceUntil {
	/// Any tool invocation satisfies the request.
	AnyToolCall,
	/// Only a call to this exact tool satisfies the request.
	ToolCalled(Str),
	/// A successful `yield` whose durable payload closes an incremental batch
	/// (`complete` or `failed`) satisfies the request.
	TerminalYield,
}

/// One durable Director property replacement.
#[derive(Clone, Debug, PartialEq)]
pub struct StateUpdate {
	/// State field name, without the DOM namespace prefix.
	pub key:   Str,
	/// Replacement scalar value.
	pub value: BindValue,
}

impl StateUpdate {
	/// Creates a durable property replacement.
	#[must_use]
	pub fn new(key: impl Into<Str>, value: BindValue) -> Self {
		Self { key: key.into(), value }
	}
}

/// A Director verdict plus state changes committed in the same tick.
pub struct DirectorEffect {
	/// Candidate-yield disposition.
	pub verdict:             Verdict,
	/// Durable state updates.
	pub updates:             Vec<StateUpdate>,
	/// Developer asides committed even when this tick exits the Director.
	pub asides:              Vec<Str>,
	/// Session-layer convar writes committed by the kernel after this tick
	/// (a plan handoff re-targeting `ai_model`); journaled through the
	/// console bridge like any other session write.
	pub writes:              Vec<(Str, BindValue)>,
	/// With [`Verdict::Done`]: after this Director exits, run another turn
	/// instead of re-offering the candidate yield, finalizing the plan and
	/// immediately starting implementation.
	pub continue_after_exit: bool,
}

impl DirectorEffect {
	/// Builds an effect with no state changes.
	#[must_use]
	pub const fn new(verdict: Verdict) -> Self {
		Self {
			verdict,
			updates: Vec::new(),
			asides: Vec::new(),
			writes: Vec::new(),
			continue_after_exit: false,
		}
	}

	/// Adds one session-layer convar write.
	#[must_use]
	pub fn with_write(mut self, name: impl Into<Str>, value: BindValue) -> Self {
		self.writes.push((name.into(), value));
		self
	}

	/// Continues the loop after a [`Verdict::Done`] exit.
	#[must_use]
	pub const fn continuing_after_exit(mut self) -> Self {
		self.continue_after_exit = true;
		self
	}

	/// Adds one state update.
	#[must_use]
	pub fn with_update(mut self, key: impl Into<Str>, value: BindValue) -> Self {
		self.updates.push(StateUpdate::new(key, value));
		self
	}

	/// Sets one durable state property on the current Director element.
	#[must_use]
	pub fn set_state(self, key: impl Into<Str>, value: BindValue) -> Self {
		self.with_update(key, value)
	}

	/// Adds one developer aside to the same atomic tick.
	#[must_use]
	pub fn with_aside(mut self, text: impl Into<Str>) -> Self {
		self.asides.push(text.into());
		self
	}
}

/// Whether an asynchronous Director hook changed the projected request inputs.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Prepared {
	/// Continue with the existing request.
	Unchanged,
	/// Re-project the request from the now-updated session tree.
	Rebuild,
}

/// Mutable cold-path capabilities for asynchronous pre-inference Directors.
pub struct MutDirectorCx<'a> {
	/// Authoritative session controller.
	pub session:   &'a mut Session,
	/// Type-erased inference service for isolated auxiliary calls.
	pub inference: &'a mut dyn ErasedInference,
	/// Content-addressed blob store.
	pub blobs:     &'a BlobStore,
	/// Catalog facts for the resolved route.
	pub route:     &'a RouteFacts,
	/// Current `<turn>` element.
	pub turn:      Handle,
	/// Current Director element, set by the stack while invoking a hook.
	pub director:  Option<Handle>,
	/// Observer notifications for progress that is not journaled (the
	/// compaction speculation pulse); `None` in headless tests.
	pub events:    Option<&'a crate::KernelEvents>,
	/// Effective control plane (archive, session, and engagement layers);
	/// `None` when the host composed no console.
	pub con:       Option<&'a omp_con::Ctx>,
	/// Extension lifecycle gates (`compaction`, `thread_projection`, …);
	/// `None` when no extension host is attached.
	pub hooks:     Option<&'a crate::LifecycleHooks>,
}

impl MutDirectorCx<'_> {
	/// Publishes an ephemeral observer notification when a sink is attached.
	pub fn notify(&self, event: crate::KernelEvent) {
		if let Some(events) = self.events {
			events.publish(event);
		}
	}

	/// Returns one durable state property from the current Director element.
	#[must_use]
	pub fn state(&self, key: &str) -> Option<&Value> {
		self
			.director_node()?
			.prop(&custom(&format!("{STATE_PREFIX}{key}")))
	}

	/// Returns the current Director element.
	#[must_use]
	pub fn director_node(&self) -> Option<&Node> {
		self.session.dom().get(self.director?)
	}
}

/// Cold-path inference capability used by asynchronous Directors.
pub trait ErasedInference: Send {
	/// Executes one isolated canonical chat request.
	fn execute(&mut self, request: ChatRequest) -> BoxFut<'_, Result<ChatStream, omp_ai::Error>>;

	/// Executes one isolated request on the model `selector` names (a
	/// catalog key or `@role`), leaving the live route untouched; stacks
	/// without a catalog run it on the live route.
	fn execute_on<'a>(
		&'a mut self,
		selector: &str,
		request: ChatRequest,
	) -> BoxFut<'a, Result<ChatStream, omp_ai::Error>> {
		let _ = selector;
		self.execute(request)
	}
}

impl<T> ErasedInference for T
where
	T: Inference,
{
	fn execute(&mut self, request: ChatRequest) -> BoxFut<'_, Result<ChatStream, omp_ai::Error>> {
		Box::pin(self.chat(request))
	}

	fn execute_on<'a>(
		&'a mut self,
		selector: &str,
		request: ChatRequest,
	) -> BoxFut<'a, Result<ChatStream, omp_ai::Error>> {
		let selector = Str::new(selector);
		Box::pin(async move { self.chat_on(selector.as_str(), request).await })
	}
}

/// A behavior which may keep ownership of candidate yields across turns.
pub trait Director: Send + Sync {
	/// Stable registry identity.
	fn id(&self) -> &str;

	/// Exclusive resources held while this engagement is active.
	fn claims(&self) -> &[Slot] {
		&[]
	}

	/// Scalar convar bindings derived while this engagement is active.
	fn binds(&self) -> &[(Str, BindValue)] {
		&[]
	}

	/// Adds this Director's durable constructor and state properties.
	fn state(&self) -> Vec<(Str, BindValue)> {
		Vec::new()
	}

	/// Runs a cold auxiliary operation before request projection.
	///
	/// This object-safe box is the sanctioned cold `dyn` quarantine: at most one
	/// allocation per network round trip, never per stream event or token.
	fn before_inference<'a>(
		&'a self,
		_cx: &'a mut MutDirectorCx<'_>,
		_req: &'a ChatRequest,
	) -> BoxFut<'a, Result<Prepared, DirectorError>> {
		Box::pin(future::ready(Ok(Prepared::Unchanged)))
	}

	/// Refines a request synchronously. The stack walks outermost to innermost.
	fn prepare_inference(&self, _cx: &DirectorCx<'_>, _req: &mut ChatRequest) {}

	/// Runs a cold auxiliary operation at a candidate yield, before the stack
	/// judges it (the advisor's second-model review). Same boxed cold-path
	/// shape as [`Director::before_inference`]; the kernel drops the future
	/// when the turn is interrupted, so a hook journals nothing it cannot
	/// finish atomically.
	fn before_yield<'a>(
		&'a self,
		_cx: &'a mut MutDirectorCx<'_>,
		_turn: &'a TurnView,
	) -> BoxFut<'a, Result<(), DirectorError>> {
		Box::pin(future::ready(Ok(())))
	}

	/// Observes every completed turn, including turns containing tool calls.
	fn observe_turn(&self, _dom: &Dom, _cx: &DirectorCx<'_>, _turn: &TurnView) -> Vec<StateUpdate> {
		Vec::new()
	}

	/// Returns a one-shot completion effect at a settled tool-turn boundary.
	///
	/// Most Directors only own candidate yields and return `None`. A Director
	/// whose contract hands control off immediately after a successful action
	/// may return a `Done` effect so the next inference uses the new state.
	fn after_settled_turn(
		&self,
		_dom: &Dom,
		_cx: &DirectorCx<'_>,
		_turn: &TurnView,
	) -> Option<DirectorEffect> {
		None
	}

	/// Inspects one candidate yield.
	fn on_yield(&self, _cx: &DirectorCx<'_>, _turn: &TurnView) -> Verdict {
		Verdict::Pass
	}

	/// Inspects one candidate with read-only access to the authoritative tree.
	fn evaluate(&self, _dom: &Dom, cx: &DirectorCx<'_>, turn: &TurnView) -> DirectorEffect {
		DirectorEffect::new(self.on_yield(cx, turn))
	}
}

/// Result returned to the kernel after the stack consumes a candidate yield.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LoopDecision {
	/// Run another model turn.
	Continue {
		/// Optional developer aside already journaled by the stack.
		reminder: Option<Str>,
	},
	/// Return the candidate turn to the caller.
	Yield,
}

/// Failure while reconstructing or mutating the Director subtree.
#[derive(Debug, Error)]
pub enum DirectorError {
	/// Session journaling or folding failed.
	#[error(transparent)]
	Session(#[from] SessionError),
	/// Inference planning or streaming failed.
	#[error(transparent)]
	Inference(#[from] omp_ai::Error),
	/// Blob persistence failed.
	#[error(transparent)]
	Blob(#[from] BlobError),
	/// A Director's session-layer convar write could not address `<meta><con>`.
	#[error(transparent)]
	ConWrite(#[from] omp_session::components::con::ConComponentError),
	/// An extension lifecycle hook failed.
	#[error(transparent)]
	Hook(#[from] crate::LifecycleHookError),
	/// Projecting hidden history into inference messages failed.
	#[error(transparent)]
	ThreadProjection(#[from] omp_ai::ThreadProjectionError),
	/// A typed Director payload could not be encoded for the session DOM.
	#[error(transparent)]
	Json(#[from] serde_json::Error),
	/// The canonical `<directors>` component is absent.
	#[error("session tree has no directors component")]
	MissingDirectors,
	/// A requested extension Director was not registered.
	#[error("extension Director is not registered")]
	UnknownDirector,
	/// A tick attempted to stage more than one control.
	#[error("a director tick may stage only one control")]
	MultipleControls,
	/// Compaction completed without producing summary text.
	#[error("compaction inference produced no summary text")]
	EmptyCompactionSummary,
	/// An extension Director callback failed or returned an invalid result.
	#[error("extension Director callback failed")]
	ExtensionCallback,
}

/// Object-safe constructor used to re-derive one Director from element props.
pub type DirectorConstructor = fn(&Node) -> Box<dyn Director>;

/// Registry of stateless constructors used during tree re-derivation.
#[derive(Clone, Default)]
pub struct DirectorRegistry {
	constructors: FastHashMap<&'static str, DirectorConstructor>,
	extensions:   FastHashMap<Str, Arc<dyn Director>>,
}

impl DirectorRegistry {
	/// Creates an empty registry.
	#[must_use]
	pub fn new() -> Self {
		Self::default()
	}

	/// Creates the built-in registry.
	#[must_use]
	pub fn standard() -> Self {
		let mut registry = Self::new();
		crate::directors::register_standard(&mut registry);
		registry
	}

	/// Registers or replaces one stable Director family.
	pub fn register(&mut self, id: &'static str, constructor: DirectorConstructor) {
		self.constructors.insert(id, constructor);
	}

	/// Registers an extension Director whose behavior is reconstructed from the
	/// authoritative DOM passed to each hook.
	pub fn register_extension(&mut self, director: Box<dyn Director>) {
		self
			.extensions
			.insert(Str::new(director.id()), Arc::from(director));
	}

	fn construct(&self, node: &Node) -> Option<Arc<dyn Director>> {
		let family = prop_str(node, FAMILY)?;
		self
			.constructors
			.get(family)
			.map(|constructor| Arc::from(constructor(node)))
			.or_else(|| self.extensions.get(family).cloned())
	}
}

struct Frame {
	handle:   Handle,
	director: Arc<dyn Director>,
}

/// A transient walk of the authoritative `<meta><directors>` subtree.
pub struct DirectorStack {
	registry: DirectorRegistry,
	active:   Vec<Frame>,
	queued:   Vec<Frame>,
}

impl DirectorStack {
	/// Re-derives the active chain and FIFO queue from the tree.
	#[must_use]
	pub fn from_dom(dom: &Dom, registry: &DirectorRegistry) -> Self {
		let Some(root) = directors_root(dom) else {
			return Self { registry: registry.clone(), active: Vec::new(), queued: Vec::new() };
		};
		let mut active = Vec::new();
		let mut parent = root;
		loop {
			let Some(handle) = dom.children(parent).iter().copied().find(|handle| {
				dom.get(*handle).is_some_and(|node| {
					node.tag == KnownTag::Director.into() && prop_str(node, STATUS) == Some(ACTIVE)
				})
			}) else {
				break;
			};
			let Some(node) = dom.get(handle) else { break };
			let Some(director) = registry.construct(node) else {
				break;
			};
			active.push(Frame { handle, director });
			parent = handle;
		}
		let queued = dom
			.children(root)
			.iter()
			.copied()
			.filter_map(|handle| {
				let node = dom.get(handle)?;
				(prop_str(node, STATUS) == Some(QUEUED))
					.then(|| {
						registry
							.construct(node)
							.map(|director| Frame { handle, director })
					})
					.flatten()
			})
			.collect();
		Self { registry: registry.clone(), active, queued }
	}

	/// Returns active Director identities from outermost to innermost.
	#[must_use]
	pub fn active_ids(&self) -> Vec<&str> {
		self
			.active
			.iter()
			.map(|frame| frame.director.id())
			.collect()
	}

	/// Returns queued Director identities in FIFO order.
	#[must_use]
	pub fn queued_ids(&self) -> Vec<&str> {
		self
			.queued
			.iter()
			.map(|frame| frame.director.id())
			.collect()
	}

	/// The convar engagement chain this stack projects, outermost first:
	/// one `(owner, binds)` entry per active `<director>` element, the
	/// owner being `<family>#<handle>` and the binds the element's `bind/*`
	/// props (ADR 0015: binds live on the element, so rewind, resume, and
	/// promotion re-derive them without an engage or exit call).
	#[must_use]
	pub fn con_chain(&self, dom: &Dom) -> Vec<(Str, Vec<(Str, omp_con::Value)>)> {
		self
			.active
			.iter()
			.filter_map(|frame| {
				let node = dom.get(frame.handle)?;
				let binds = node
					.props
					.iter()
					.filter_map(|(key, value)| {
						let PropKey::Custom(key) = key else {
							return None;
						};
						let name = key.strip_prefix(BIND_PREFIX)?;
						Some((Str::new(name), con_value(BindValue::from_dom(value)?)))
					})
					.collect();
				let mut owner = omp_core::StrMut::new(frame.director.id());
				owner.push('#');
				let _ = std::fmt::Write::write_fmt(&mut owner, format_args!("{}", frame.handle.get()));
				Some((owner.freeze(), binds))
			})
			.collect()
	}

	/// Derives the control-plane engagement layers from this stack
	/// ([`Ctx::derive_layers`](omp_con::Ctx::derive_layers)): a no-op when
	/// the chain is unchanged, so it is safe after every re-derivation.
	pub fn apply_binds(&self, dom: &Dom, con: &omp_con::Ctx) {
		con.derive_layers(&self.con_chain(dom));
	}

	/// Engages a Director through one `patch@1`, queueing on claim conflict.
	pub fn engage(
		&mut self,
		session: &mut Session,
		director: Box<dyn Director>,
	) -> Result<Handle, DirectorError> {
		let id = Str::new(director.id());
		self.registry.register_extension(director);
		self.engage_registered(session, id.as_str())
	}

	/// Engages a previously registered extension Director.
	pub fn engage_registered(
		&mut self,
		session: &mut Session,
		id: &str,
	) -> Result<Handle, DirectorError> {
		*self = Self::from_dom(session.dom(), &self.registry);
		let director = self
			.registry
			.extensions
			.get(id)
			.cloned()
			.ok_or(DirectorError::UnknownDirector)?;
		let root = directors_root(session.dom()).ok_or(DirectorError::MissingDirectors)?;
		let contested = director.claims().iter().any(|slot| {
			self
				.active
				.iter()
				.any(|frame| frame.director.claims().contains(slot))
		});
		let parent = if contested {
			root
		} else {
			self.active.last().map_or(root, |frame| frame.handle)
		};
		let after = session.dom().children(parent).last().copied();
		let node = director_node(director.as_ref(), if contested { QUEUED } else { ACTIVE });
		let previous_high = session.dom().high_water();
		session.patch(Txn {
			cause: session.head().ok_or(DirectorError::MissingDirectors)?,
			label: Some(Str::new_static("director.engage")),
			ops:   vec![Op::Ins { parent, after, node }],
		})?;
		let handle = Handle::new(previous_high + 1).ok_or(DirectorError::MissingDirectors)?;
		*self = Self::from_dom(session.dom(), &self.registry);
		Ok(handle)
	}

	/// Pauses one engagement in place.
	///
	/// Its subtree stays materialized, so resuming restores the exact Director
	/// and child state. Pausing releases its slots and promotes the oldest
	/// compatible queued engagement.
	pub fn pause(&mut self, session: &mut Session, family: &str) -> Result<bool, DirectorError> {
		let Some((handle, node)) = find_director(session.dom(), family) else {
			return Ok(false);
		};
		if director_status(node) == Some(PAUSED) {
			return Ok(false);
		}
		if director_status(node) != Some(ACTIVE) {
			return Ok(false);
		}
		patch(session, "director.pause", vec![Op::Set {
			h:     handle,
			prop:  custom(STATUS),
			value: Value::Str(Str::new_static(PAUSED)),
		}])?;
		self.promote(session)?;
		Ok(true)
	}

	/// Resumes one paused engagement, or queues it when an active Director
	/// currently owns one of its slots.
	pub fn resume(&mut self, session: &mut Session, family: &str) -> Result<bool, DirectorError> {
		*self = Self::from_dom(session.dom(), &self.registry);
		let Some((handle, node)) = find_director(session.dom(), family) else {
			return Ok(false);
		};
		if director_status(node) != Some(PAUSED) {
			return Ok(false);
		}
		let Some(director) = self.registry.construct(node) else {
			return Err(DirectorError::UnknownDirector);
		};
		let contested = director.claims().iter().any(|slot| {
			self
				.active
				.iter()
				.any(|frame| frame.director.claims().contains(slot))
		});
		let root = directors_root(session.dom()).ok_or(DirectorError::MissingDirectors)?;
		let parent = if contested {
			root
		} else {
			self.active.last().map_or(root, |frame| frame.handle)
		};
		let mut ops = Vec::with_capacity(2);
		if session.dom().parent(handle) != Some(parent) {
			ops.push(Op::Mv {
				h: handle,
				parent,
				after: session.dom().children(parent).last().copied(),
			});
		}
		ops.push(Op::Set {
			h:     handle,
			prop:  custom(STATUS),
			value: Value::Str(Str::new_static(if contested { QUEUED } else { ACTIVE })),
		});
		patch(session, "director.resume", ops)?;
		*self = Self::from_dom(session.dom(), &self.registry);
		Ok(true)
	}

	/// Removes one engagement and its nested members, then promotes the oldest
	/// compatible queued engagement.
	pub fn exit(&mut self, session: &mut Session, family: &str) -> Result<bool, DirectorError> {
		let Some((handle, _)) = find_director(session.dom(), family) else {
			return Ok(false);
		};
		patch(session, "director.exit", vec![Op::Rm(handle)])?;
		self.promote(session)?;
		Ok(true)
	}

	/// Runs asynchronous pre-inference hooks outermost to innermost.
	pub async fn before_inference(
		&self,
		cx: &mut MutDirectorCx<'_>,
		req: &ChatRequest,
	) -> Result<Prepared, DirectorError> {
		let mut prepared = Prepared::Unchanged;
		for frame in &self.active {
			cx.director = Some(frame.handle);
			if frame.director.before_inference(cx, req).await? == Prepared::Rebuild {
				prepared = Prepared::Rebuild;
			}
		}
		cx.director = None;
		Ok(prepared)
	}

	/// Runs asynchronous candidate-yield hooks innermost to outermost (the
	/// order [`DirectorStack::on_yield`] judges the same candidate).
	pub async fn before_yield(
		&self,
		cx: &mut MutDirectorCx<'_>,
		turn: &TurnView,
	) -> Result<(), DirectorError> {
		for frame in self.active.iter().rev() {
			cx.director = Some(frame.handle);
			frame.director.before_yield(cx, turn).await?;
		}
		cx.director = None;
		Ok(())
	}

	/// Refines an inference request outermost to innermost.
	pub fn prepare_inference(&self, dom: &Dom, cx: &DirectorCx<'_>, req: &mut ChatRequest) {
		for frame in &self.active {
			let Some(node) = dom.get(frame.handle) else {
				continue;
			};
			frame
				.director
				.prepare_inference(&cx.for_director(frame.handle, node), req);
		}
	}

	/// Commits observation-derived state for every completed turn.
	pub fn observe_turn(
		&mut self,
		session: &mut Session,
		cx: &DirectorCx<'_>,
		turn: &TurnView,
	) -> Result<(), DirectorError> {
		*self = Self::from_dom(session.dom(), &self.registry);
		let updates = self
			.active
			.iter()
			.map(|frame| {
				(
					frame.handle,
					frame.director.observe_turn(
						session.dom(),
						&cx.for_director(
							frame.handle,
							session
								.dom()
								.get(frame.handle)
								.expect("active Director handle must exist"),
						),
						turn,
					),
				)
			})
			.collect::<Vec<_>>();
		let ops = updates
			.into_iter()
			.flat_map(|(handle, updates)| update_ops(handle, updates))
			.collect::<Vec<_>>();
		if !ops.is_empty() {
			patch(session, "director.observe", ops)?;
			*self = Self::from_dom(session.dom(), &self.registry);
		}
		Ok(())
	}

	/// Applies one-shot Director handoffs immediately after a tool turn has
	/// settled, before the kernel projects another inference request.
	pub fn after_settled_turn(
		&mut self,
		session: &mut Session,
		cx: &DirectorCx<'_>,
		turn: &TurnView,
	) -> Result<bool, DirectorError> {
		*self = Self::from_dom(session.dom(), &self.registry);
		for index in (0..self.active.len()).rev() {
			let handle = self.active[index].handle;
			let Some(effect) = self.active[index].director.after_settled_turn(
				session.dom(),
				&cx.for_director(
					handle,
					session
						.dom()
						.get(handle)
						.expect("active Director handle must exist"),
				),
				turn,
			) else {
				continue;
			};
			let DirectorEffect { verdict, updates, asides, writes, continue_after_exit } = effect;
			if !matches!(verdict, Verdict::Done) || !continue_after_exit {
				continue;
			}
			let mut ops = update_ops(handle, updates);
			for text in asides {
				ops.push(developer_op(session.dom(), turn.turn, text));
			}
			ops.extend(con_write_ops(session, &writes)?);
			ops.push(Op::Rm(handle));
			patch(session, "director.turn-settled", ops)?;
			self.promote(session)?;
			return Ok(true);
		}
		Ok(false)
	}

	/// Walks candidate-yield ownership innermost to outermost.
	pub fn on_yield(
		&mut self,
		session: &mut Session,
		cx: &DirectorCx<'_>,
		turn: &TurnView,
	) -> Result<LoopDecision, DirectorError> {
		*self = Self::from_dom(session.dom(), &self.registry);
		let mut index = self.active.len();
		while index > 0 {
			index -= 1;
			let handle = self.active[index].handle;
			let DirectorEffect { verdict, updates, asides, writes, continue_after_exit } =
				self.active[index].director.evaluate(
					session.dom(),
					&cx.for_director(
						handle,
						session
							.dom()
							.get(handle)
							.expect("active Director handle must exist"),
					),
					turn,
				);
			let write_ops = con_write_ops(session, &writes)?;
			let effect_ops = |dom: &Dom, mut ops: Vec<Op>| {
				ops.extend(
					asides
						.iter()
						.cloned()
						.map(|text| developer_op(dom, turn.turn, text)),
				);
				ops.extend(write_ops.iter().cloned());
				ops
			};
			match verdict {
				Verdict::Pass => {
					let ops = effect_ops(session.dom(), update_ops(handle, updates));
					if !ops.is_empty() {
						patch(session, "director.pass", ops)?;
					}
				},
				Verdict::Continue { reminder } => {
					let mut ops = effect_ops(session.dom(), update_ops(handle, updates));
					if let Some(text) = reminder.clone() {
						ops.push(developer_op(session.dom(), turn.turn, text));
					}
					if !ops.is_empty() {
						patch(session, "director.continue", ops)?;
					}
					*self = Self::from_dom(session.dom(), &self.registry);
					return Ok(LoopDecision::Continue { reminder });
				},
				Verdict::Yield => {
					let ops = effect_ops(session.dom(), update_ops(handle, updates));
					if !ops.is_empty() {
						patch(session, "director.yield", ops)?;
					}
					*self = Self::from_dom(session.dom(), &self.registry);
					return Ok(LoopDecision::Yield);
				},
				Verdict::Push(child) => {
					let ops = effect_ops(session.dom(), update_ops(handle, updates));
					if !ops.is_empty() {
						patch(session, "director.push-state", ops)?;
					}
					self.engage(session, child)?;
					return Ok(LoopDecision::Continue { reminder: None });
				},
				Verdict::Done => {
					let mut ops = effect_ops(session.dom(), update_ops(handle, updates));
					ops.push(Op::Rm(handle));
					patch(session, "director.done", ops)?;
					self.promote(session)?;
					if continue_after_exit {
						*self = Self::from_dom(session.dom(), &self.registry);
						return Ok(LoopDecision::Continue { reminder: None });
					}
				},
				Verdict::Fail(reason) => {
					let mut ops = effect_ops(session.dom(), update_ops(handle, updates));
					ops.push(notice_op(session.dom(), turn.turn, reason));
					ops.push(Op::Rm(handle));
					patch(session, "director.fail", ops)?;
					self.promote(session)?;
				},
			}
		}
		*self = Self::from_dom(session.dom(), &self.registry);
		Ok(LoopDecision::Yield)
	}

	fn promote(&mut self, session: &mut Session) -> Result<(), DirectorError> {
		loop {
			*self = Self::from_dom(session.dom(), &self.registry);
			let Some(candidate) = self.queued.iter().find(|queued| {
				queued.director.claims().iter().all(|slot| {
					self
						.active
						.iter()
						.all(|active| !active.director.claims().contains(slot))
				})
			}) else {
				break;
			};
			let mut ops = Vec::with_capacity(2);
			if let Some(parent) = self.active.last() {
				ops.push(Op::Mv {
					h:      candidate.handle,
					parent: parent.handle,
					after:  session.dom().children(parent.handle).last().copied(),
				});
			}
			ops.push(Op::Set {
				h:     candidate.handle,
				prop:  custom(STATUS),
				value: Value::Str(Str::new_static(ACTIVE)),
			});
			patch(session, "director.promote", ops)?;
		}
		*self = Self::from_dom(session.dom(), &self.registry);
		Ok(())
	}
}

/// Fold control used by the deterministic arbitration helper.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Control {
	/// Abort the current fold immediately.
	Cut,
	/// Hold until external input arrives.
	Hold,
	/// Deny the proposed action.
	Deny,
	/// Force the named tool; the first proposal is the head.
	Force(Str),
	/// Continue the loop.
	Continue,
}

/// Selects one control with `Cut > Hold > Deny > Force(head) > Continue`.
#[must_use]
pub fn arbitrate(controls: impl IntoIterator<Item = Control>) -> Option<Control> {
	let mut winner = None;
	let mut rank = 0;
	for control in controls {
		let candidate = match control {
			Control::Cut => 5,
			Control::Hold => 4,
			Control::Deny => 3,
			Control::Force(_) => 2,
			Control::Continue => 1,
		};
		if candidate > rank {
			rank = candidate;
			winner = Some(control);
		}
	}
	winner
}

/// Enforces the one-control-per-tick law for dynamic handlers.
#[derive(Default)]
pub struct ControlDraft {
	control: Option<Control>,
}

impl ControlDraft {
	/// Creates an empty tick draft.
	#[must_use]
	pub const fn new() -> Self {
		Self { control: None }
	}

	/// Stages the tick's sole control.
	pub fn stage(&mut self, control: Control) -> Result<(), DirectorError> {
		if self.control.is_some() {
			return Err(DirectorError::MultipleControls);
		}
		self.control = Some(control);
		Ok(())
	}

	/// Returns the staged control.
	#[must_use]
	pub fn finish(self) -> Option<Control> {
		self.control
	}
}

/// Prepends one system-level instruction without changing other request fields.
pub fn prepend_system(req: &mut ChatRequest, text: Str) {
	let mut messages = Vec::with_capacity(req.messages.len() + 1);
	messages.push(Message {
		role:    Role::System,
		content: Arc::from([ContentPart::Text { text, proof: None }]),
		name:    None,
	});
	messages.extend(req.messages.iter().cloned());
	req.messages = messages.into();
}

/// Returns one namespaced scalar property.
#[must_use]
pub fn state_value(node: &Node, key: &str) -> Option<BindValue> {
	BindValue::from_dom(node.prop(&custom(&format!("{STATE_PREFIX}{key}")))?)
}

/// Returns a namespaced string property.
#[must_use]
pub fn state_str(node: &Node, key: &str) -> Option<Str> {
	match state_value(node, key) {
		Some(BindValue::Str(value)) => Some(value),
		Some(BindValue::Bool(_) | BindValue::Int(_) | BindValue::Float(_) | BindValue::List(_))
		| None => None,
	}
}

/// Returns a namespaced integer property.
#[must_use]
pub fn state_int(node: &Node, key: &str) -> Option<i64> {
	match state_value(node, key) {
		Some(BindValue::Int(value)) => Some(value),
		Some(BindValue::Bool(_) | BindValue::Str(_) | BindValue::Float(_) | BindValue::List(_))
		| None => None,
	}
}

/// Returns a namespaced Boolean property.
#[must_use]
pub fn state_bool(node: &Node, key: &str) -> Option<bool> {
	match state_value(node, key) {
		Some(BindValue::Bool(value)) => Some(value),
		Some(BindValue::Int(_) | BindValue::Str(_) | BindValue::Float(_) | BindValue::List(_))
		| None => None,
	}
}

/// Returns one materialized Director's lifecycle status.
#[must_use]
pub fn director_status(node: &Node) -> Option<&str> {
	prop_str(node, STATUS)
}

/// Finds the materialized node for one Director family.
#[must_use]
pub fn find_director<'a>(dom: &'a Dom, family: &str) -> Option<(Handle, &'a Node)> {
	dom.handles().find_map(|handle| {
		let node = dom.get(handle)?;
		(node.tag == KnownTag::Director.into() && prop_str(node, FAMILY) == Some(family))
			.then_some((handle, node))
	})
}

/// Returns whether a turn contains a call to `tool`.
#[must_use]
pub fn turn_called(dom: &Dom, turn: Handle, tool: &str) -> bool {
	dom.children(turn).iter().copied().any(|handle| {
		dom.get(handle)
			.is_some_and(|node| matches!(&node.tag, Tag::Custom(name) if name == tool))
	})
}

/// Returns whether the session fold authenticated and successfully settled a
/// call to `tool` in this turn.
///
/// This deliberately checks the typed tool-element shape and terminal status
/// produced by `tool.call@1` + `tool.result@1`; assistant text and streamed
/// argument fragments are never treated as evidence that an action ran.
#[must_use]
pub fn turn_settled_successfully(dom: &Dom, turn: Handle, tool: &str) -> bool {
	dom.children(turn).iter().copied().any(|handle| {
		let Some(node) = dom.get(handle) else {
			return false;
		};
		if !matches!(&node.tag, Tag::Custom(name) if name == tool)
			|| node
				.prop(&PropKey::from(PropId::Status))
				.and_then(Value::as_str)
				!= Some("ok")
			|| node
				.prop(&PropKey::from(PropId::Cause))
				.and_then(Value::as_str)
				.is_none_or(|cause| cause.parse::<omp_journal::EntryId>().is_err())
			|| node
				.prop(&PropKey::from(PropId::Id))
				.and_then(Value::as_str)
				.is_none_or(str::is_empty)
		{
			return false;
		}
		let mut input = false;
		let mut result = false;
		let mut usage = false;
		for child in dom
			.children(handle)
			.iter()
			.filter_map(|child| dom.get(*child))
		{
			match &child.tag {
				Tag::Known(KnownTag::Input) => input = true,
				Tag::Known(KnownTag::Result)
					if child.prop(&PropKey::from(PropId::Outcome)).is_some() =>
				{
					result = true;
				},
				Tag::Known(KnownTag::Usage) => usage = true,
				Tag::Known(_) | Tag::Custom(_) => {},
			}
		}
		input && result && usage
	})
}

/// Returns the JSON input text for calls to `tool` in a turn.
pub fn turn_call_inputs<'a>(
	dom: &'a Dom,
	turn: Handle,
	tool: &'a str,
) -> impl Iterator<Item = &'a str> {
	dom.children(turn)
		.iter()
		.copied()
		.filter_map(move |handle| {
			let node = dom.get(handle)?;
			if !matches!(&node.tag, Tag::Custom(name) if name == tool) {
				return None;
			}
			let input = dom.children(handle).iter().find_map(|child| {
				let node = dom.get(*child)?;
				(node.tag == KnownTag::Input.into()).then_some(node)
			})?;
			input
				.content
				.as_deref()
				.or_else(|| input.prop(&PropKey::from(PropId::Text))?.as_str())
		})
}

/// Sums token accounting projected under one turn.
#[must_use]
pub fn turn_tokens(dom: &Dom, turn: Handle) -> u64 {
	dom.children(turn)
		.iter()
		.filter_map(|handle| dom.get(*handle))
		.filter(|node| {
			node.tag == KnownTag::Usage.into()
				&& node
					.prop(&PropKey::from(PropId::Kind))
					.and_then(Value::as_str)
					!= Some("advisor")
		})
		.map(|node| {
			[PropId::TokensIn, PropId::TokensOut]
				.into_iter()
				.filter_map(|prop| match node.prop(&PropKey::from(prop)) {
					Some(Value::Int(value)) => u64::try_from(*value).ok(),
					_ => None,
				})
				.sum::<u64>()
		})
		.sum()
}

fn director_node(director: &dyn Director, status: &'static str) -> NodeSpec {
	let claims = director
		.claims()
		.iter()
		.map(|slot| <&'static str>::from(*slot))
		.collect::<Vec<_>>()
		.join(",");
	let mut node = NodeSpec::new(KnownTag::Director)
		.with_prop(custom(FAMILY), Value::Str(Str::new(director.id())))
		.with_prop(custom(STATUS), Value::Str(Str::new_static(status)))
		.with_prop(custom(CLAIMS), Value::Str(Str::new(claims)));
	for (key, value) in director.binds() {
		node = node.with_prop(custom(&format!("{BIND_PREFIX}{key}")), value.clone().into_dom());
	}
	for (key, value) in director.state() {
		node = node.with_prop(custom(&format!("{STATE_PREFIX}{key}")), value.into_dom());
	}
	node
}

/// Lowers a Director bind to the control plane's dynamic value.
fn con_value(value: BindValue) -> omp_con::Value {
	match value {
		BindValue::Bool(value) => omp_con::Value::Bool(value),
		BindValue::Int(value) => omp_con::Value::Int(value),
		BindValue::Str(value) => omp_con::Value::Str(value),
		BindValue::Float(value) => omp_con::Value::Float(value),
		BindValue::List(items) => {
			omp_con::Value::List(items.into_iter().map(omp_con::Value::Str).collect())
		},
	}
}

fn directors_root(dom: &Dom) -> Option<Handle> {
	dom.children(dom.meta()).iter().copied().find(|handle| {
		dom.get(*handle)
			.is_some_and(|node| node.tag == KnownTag::Directors.into())
	})
}

fn prop_str<'a>(node: &'a Node, key: &str) -> Option<&'a str> {
	node.prop(&custom(key)).and_then(Value::as_str)
}

fn custom(key: &str) -> PropKey {
	PropKey::Custom(Str::new(key))
}

pub(crate) fn update_ops(handle: Handle, updates: Vec<StateUpdate>) -> Vec<Op> {
	updates
		.into_iter()
		.map(|update| Op::Set {
			h:     handle,
			prop:  custom(&format!("{STATE_PREFIX}{}", update.key)),
			value: update.value.into_dom(),
		})
		.collect()
}

pub(crate) fn patch(
	session: &mut Session,
	label: &'static str,
	ops: Vec<Op>,
) -> Result<(), DirectorError> {
	session.patch(Txn {
		cause: session.head().ok_or(DirectorError::MissingDirectors)?,
		label: Some(Str::new_static(label)),
		ops,
	})?;
	Ok(())
}

/// `<meta><con>` operations journaling a Director's session-layer writes
/// (origin `director`); the console bridge re-hydrates the live context
/// from the tree, so the value is effective before the next request.
fn con_write_ops(session: &Session, writes: &[(Str, BindValue)]) -> Result<Vec<Op>, DirectorError> {
	let cause = session.head().ok_or(DirectorError::MissingDirectors)?;
	let mut ops = Vec::new();
	for (name, value) in writes {
		let write = omp_session::components::con::ConWrite {
			name:   name.clone(),
			value:  Str::new(con_value(value.clone()).to_string()),
			origin: Str::new_static("director"),
		};
		let txn = omp_session::components::con::con_write_txn(session.dom(), cause, &write)?;
		ops.extend(txn.ops);
	}
	Ok(ops)
}

fn developer_op(dom: &Dom, turn: Handle, text: Str) -> Op {
	Op::Ins {
		parent: turn,
		after:  dom.children(turn).last().copied(),
		node:   NodeSpec::new(KnownTag::Developer).with_content(text),
	}
}

fn notice_op(dom: &Dom, turn: Handle, reason: Str) -> Op {
	Op::Ins {
		parent: turn,
		after:  dom.children(turn).last().copied(),
		node:   NodeSpec::new(KnownTag::Notice)
			.with_prop(PropId::Kind, Value::Str(Str::new_static("error")))
			.with_content(reason),
	}
}
