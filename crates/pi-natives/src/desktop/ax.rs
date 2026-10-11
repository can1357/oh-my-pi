use std::{
	collections::HashMap,
	fmt::Write as _,
	hash::{DefaultHasher, Hash, Hasher},
};

use super::{
	backend::AxBackend,
	error::{CoreResult, DesktopError},
	types::{AxNode, AxQuery, AxSnapshot, AxSnapshotOptions, DesktopWindow},
};

#[derive(Clone)]
pub enum AxHandle {
	#[cfg(target_os = "macos")]
	Mac(objc2_core_foundation::CFRetained<objc2_application_services::AXUIElement>),
	/// The element and its `RuntimeId`, read once when the handle is made;
	/// `None` when the element reports none.
	#[cfg(target_os = "windows")]
	Uia(uiautomation::UIElement, Option<Box<[i32]>>),
	#[cfg(target_os = "linux")]
	AtSpi(atspi::ObjectRefOwned),
	#[cfg(test)]
	Test(u64),
	/// A test element without an identity, like a UIA element whose
	/// `RuntimeId` cannot be read: all of them compare equal.
	#[cfg(test)]
	TestUnidentified(u64),
}

impl AxHandle {
	/// Whether the handle carries an identity naming its element across reads.
	/// Handles without one all compare equal, so they never enter the ref
	/// index.
	const fn identified(&self) -> bool {
		match self {
			#[cfg(target_os = "macos")]
			Self::Mac(_) => true,
			#[cfg(target_os = "windows")]
			Self::Uia(_, runtime_id) => runtime_id.is_some(),
			#[cfg(target_os = "linux")]
			Self::AtSpi(_) => true,
			#[cfg(test)]
			Self::Test(_) => true,
			#[cfg(test)]
			Self::TestUnidentified(_) => false,
		}
	}
}

/// Two handles are equal when they name the same live element, however many
/// reads produced them: `CFEqual` on macOS, the `RuntimeId` on Windows, the bus
/// name and object path on Linux.
impl PartialEq for AxHandle {
	fn eq(&self, other: &Self) -> bool {
		match (self, other) {
			#[cfg(target_os = "macos")]
			(Self::Mac(a), Self::Mac(b)) => **a == **b,
			#[cfg(target_os = "windows")]
			(Self::Uia(_, a), Self::Uia(_, b)) => a == b,
			#[cfg(target_os = "linux")]
			(Self::AtSpi(a), Self::AtSpi(b)) => a == b,
			#[cfg(test)]
			(Self::Test(a), Self::Test(b)) => a == b,
			#[cfg(test)]
			(Self::TestUnidentified(_), Self::TestUnidentified(_)) => true,
			#[cfg(test)]
			_ => false,
		}
	}
}

impl Eq for AxHandle {}

impl Hash for AxHandle {
	fn hash<H: Hasher>(&self, state: &mut H) {
		match self {
			#[cfg(target_os = "macos")]
			Self::Mac(element) => (**element).hash(state),
			#[cfg(target_os = "windows")]
			Self::Uia(_, runtime_id) => runtime_id.hash(state),
			#[cfg(target_os = "linux")]
			Self::AtSpi(object) => object.hash(state),
			#[cfg(test)]
			Self::Test(id) => id.hash(state),
			#[cfg(test)]
			Self::TestUnidentified(_) => {},
		}
	}
}

#[derive(Debug, Clone)]
pub struct AxProps {
	pub role:        String,
	pub native_role: String,
	pub title:       Option<String>,
	pub value:       Option<String>,
	pub description: Option<String>,
	pub enabled:     bool,
	pub focused:     bool,
	pub bounds:      Option<AxBounds>,
	pub actions:     Vec<String>,
	pub child_count: u32,
	/// Whether a row, cell, button or file icon reports itself selected.
	pub selected:    bool,
	/// A name the platform derives when the element has neither title nor
	/// description, such as a window's close button.
	pub role_name:   Option<String>,
}

#[derive(Debug, Clone, Copy)]
pub struct AxBounds {
	pub x:      f64,
	pub y:      f64,
	pub width:  f64,
	pub height: f64,
}

/// Whether a tree walk reads each element's bounds: `ax()` renders none,
/// while `find()` returns them on its nodes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WalkBounds {
	Read,
	Skip,
}

struct Registered {
	handle:      AxHandle,
	target_key:  String,
	generation:  u64,
	/// Role and label at registration. An identity read again with another
	/// role or label gets a new ref.
	fingerprint: u64,
}

pub struct AxRegistry {
	next_ref:    u64,
	generations: HashMap<String, u64>,
	entries:     HashMap<u64, Registered>,
	/// Ref of each element registered under each target, so an element read
	/// again keeps its ref.
	refs:        HashMap<String, HashMap<AxHandle, u64>>,
}

impl Default for AxRegistry {
	fn default() -> Self {
		Self {
			next_ref:    1,
			generations: HashMap::new(),
			entries:     HashMap::new(),
			refs:        HashMap::new(),
		}
	}
}

impl AxRegistry {
	/// Starts a snapshot of `target`, returning its generation.
	pub(crate) fn begin_snapshot(&mut self, target: &str) -> u64 {
		let generation = self.generations.entry(target.to_string()).or_default();
		*generation = generation.saturating_add(1);
		*generation
	}

	/// Ends `target`'s snapshot `generation` once it has registered its
	/// elements: refs that neither it nor the previous snapshot registered
	/// expire, so an element missing from a single snapshot keeps its ref.
	pub(crate) fn end_snapshot(&mut self, target: &str, generation: u64) {
		self.evict(|entry| {
			entry.target_key == target && entry.generation.saturating_add(1) < generation
		});
	}

	pub(crate) fn current_generation(&mut self, target: &str) -> u64 {
		*self.generations.entry(target.to_string()).or_insert(1)
	}

	/// Returns the element's ref under `target`, minting one the first time it
	/// is seen there, and renews it for `target`'s `generation`. An identity
	/// read again with another role or label, or whose element from the last
	/// read is gone, gets a new ref; the old ref keeps the element it was read
	/// from until it expires like any ref not read again. An element without an
	/// identity gets a new ref on every read.
	pub(crate) fn register(
		&mut self,
		backend: &mut dyn AxBackend,
		target: &str,
		generation: u64,
		handle: AxHandle,
		props: &AxProps,
	) -> String {
		let mut hasher = DefaultHasher::new();
		props.role.hash(&mut hasher);
		label(props).hash(&mut hasher);
		let fingerprint = hasher.finish();
		let identified = handle.identified();
		let known = if identified {
			self
				.refs
				.get(target)
				.and_then(|refs| refs.get(&handle))
				.copied()
		} else {
			None
		};
		let renewed = known.filter(|id| {
			self
				.entries
				.get(id)
				.is_some_and(|entry| entry.fingerprint == fingerprint && backend.alive(&entry.handle))
		});
		let id = renewed.unwrap_or_else(|| {
			let id = self.next_ref;
			self.next_ref = self.next_ref.saturating_add(1);
			if identified {
				self
					.refs
					.entry(target.to_string())
					.or_default()
					.insert(handle.clone(), id);
			}
			id
		});
		self.entries.insert(id, Registered {
			handle,
			target_key: target.to_string(),
			generation,
			fingerprint,
		});
		self.enforce_cap();
		format!("e{id}")
	}

	pub(crate) fn resolve(&self, reference: &str) -> CoreResult<AxHandle> {
		let id = reference
			.strip_prefix('e')
			.and_then(|id| id.parse::<u64>().ok());
		id.and_then(|id| self.entries.get(&id))
			.map(|entry| entry.handle.clone())
			.ok_or_else(|| DesktopError::stale_ref(format!("{reference} expired; re-run ax()/find()")))
	}

	pub(crate) fn target(&self, reference: &str) -> CoreResult<String> {
		let id = reference
			.strip_prefix('e')
			.and_then(|id| id.parse::<u64>().ok());
		id.and_then(|id| self.entries.get(&id))
			.map(|entry| entry.target_key.clone())
			.ok_or_else(|| DesktopError::stale_ref(format!("{reference} expired; re-run ax()/find()")))
	}

	/// Drops expired refs. An identity a newer ref took over keeps pointing at
	/// that one.
	fn evict(&mut self, mut expired: impl FnMut(&Registered) -> bool) {
		let refs = &mut self.refs;
		self.entries.retain(|id, entry| {
			let expired = expired(entry);
			if expired
				&& let Some(target_refs) = refs.get_mut(&entry.target_key)
				&& target_refs.get(&entry.handle) == Some(id)
			{
				target_refs.remove(&entry.handle);
			}
			!expired
		});
	}

	fn enforce_cap(&mut self) {
		while self.entries.len() > 5_000 {
			let mut target_sizes: HashMap<&str, usize> = HashMap::new();
			for entry in self.entries.values() {
				*target_sizes.entry(&entry.target_key).or_default() += 1;
			}
			let Some(target) = target_sizes
				.into_iter()
				.max_by_key(|(_, count)| *count)
				.map(|(target, _)| target.to_string())
			else {
				break;
			};
			let Some(oldest) = self
				.entries
				.values()
				.filter(|entry| entry.target_key == target)
				.map(|entry| entry.generation)
				.min()
			else {
				break;
			};
			self.evict(|entry| entry.target_key == target && entry.generation == oldest);
		}
	}
}

#[derive(Clone)]
struct WalkNode {
	handle:   AxHandle,
	props:    AxProps,
	settable: bool,
	children: Vec<Self>,
}

struct WalkState {
	visited:     u32,
	skipped:     u32,
	max_nodes:   u32,
	max_depth:   u32,
	truncated:   bool,
	bounds:      WalkBounds,
	/// Whether the walk reads which values `setValue` can write, a state only
	/// `ax()` lines print.
	line_states: bool,
}

fn walk_raw(
	backend: &mut dyn AxBackend,
	handle: AxHandle,
	depth: u32,
	in_web: bool,
	state: &mut WalkState,
) -> CoreResult<Option<WalkNode>> {
	if depth > state.max_depth || state.visited >= state.max_nodes {
		state.truncated = true;
		return Ok(None);
	}
	state.visited += 1;
	let (props, child_handles) = match backend.walk_node(&handle, state.bounds) {
		Ok(node) => node,
		Err(_) if depth > 0 => {
			state.skipped = state.skipped.saturating_add(1);
			return Ok(None);
		},
		Err(error) => return Err(error),
	};
	// `setValue` refuses web content, whose echo it cannot verify.
	let in_web = in_web || props.role == "webarea";
	let settable = state.line_states
		&& !in_web
		&& keeps_set_value(&props.role)
		&& backend.value_settable(&handle);
	let mut children = Vec::new();
	for child in child_handles {
		if let Some(child) = walk_raw(backend, child, depth + 1, in_web, state)? {
			children.push(child);
		}
		if state.truncated && state.visited >= state.max_nodes {
			break;
		}
	}
	Ok(Some(WalkNode { handle, props, settable, children }))
}

/// Roles whose `setValue` write the app keeps: dates. A text field's `AXValue`
/// write reads back but often never reaches the app: System Settings keeps
/// the computer name unless the field is focused and confirmed, Reminders the
/// list's name, Finder the file's. Sliders, steppers and color wells hold
/// numbers or colors `setValue` cannot write.
fn keeps_set_value(role: &str) -> bool {
	matches!(role, "datetimearea" | "datefield" | "timefield")
}

fn named(props: &AxProps) -> bool {
	[&props.title, &props.value, &props.description]
		.into_iter()
		.flatten()
		.any(|value| !value.trim().is_empty())
}
/// Display and match name for a node. Many toolbar controls — Chrome's
/// Back/Forward/Reload among them — carry no `AXTitle` and name themselves
/// through `AXDescription` alone.
fn label(props: &AxProps) -> Option<&str> {
	labelled(props).map(|(label, _)| label)
}
/// The label and the element field that holds it in full. A name derived
/// from a window control's subrole is a word or two and never cut, so its
/// field never shows in a note.
fn labelled(props: &AxProps) -> Option<(&str, &'static str)> {
	[
		(props.title.as_deref(), "title"),
		(props.description.as_deref(), "description"),
		(props.role_name.as_deref(), "role"),
	]
	.into_iter()
	.filter_map(|(label, field)| Some((label?.trim(), field)))
	.find(|(label, _)| !label.is_empty())
}
fn interactable(props: &AxProps) -> bool {
	!props.actions.is_empty()
		|| matches!(
			props.role.as_str(),
			"button"
				| "checkbox"
				| "radio"
				| "textfield"
				| "textarea"
				| "link"
				| "menuitem"
				| "tab"
				| "slider"
				| "combobox"
				| "popupbutton"
				| "listitem"
				| "outlineitem"
				| "cell"
		)
}
/// Containers that keep their own line even around a single survivor: the role
/// itself tells the model where the child sits (a list, a toolbar, a scroll
/// area).
fn structural(role: &str) -> bool {
	matches!(
		role,
		"window"
			| "webarea"
			| "list"
			| "table"
			| "row"
			| "menu"
			| "menubar"
			| "tabgroup"
			| "toolbar"
			| "scrollarea"
			| "outline"
	)
}

/// Drops unnamed, inactionable nodes that carry nothing, while keeping every
/// survivor below them: a container with no survivors disappears, one wrapping
/// a single survivor (any role outside [`structural`], `group` included) gives
/// way to it, and one grouping several survivors stays. A container's role
/// never decides whether its content is shown; `AXSplitGroup`, which holds the
/// list and detail panes of Reminders, Contacts and Notes, is on no role list.
fn filter_node(mut node: WalkNode, all: bool) -> Option<WalkNode> {
	node.children = node
		.children
		.into_iter()
		.filter_map(|child| filter_node(child, all))
		.collect();
	if all || interactable(&node.props) || named(&node.props) {
		return Some(node);
	}
	match node.children.len() {
		0 => None,
		1 if !structural(&node.props.role) => node.children.pop(),
		_ => Some(node),
	}
}

/// Characters of a label or value a line shows before cutting it.
const SHOWN_CHARS: usize = 200;

/// Writes `text` quoted, with escapes that keep its newlines and quotes
/// readable. Past [`SHOWN_CHARS`] the line shows the start, how much it cut and
/// the call that reads the whole text, unless that note would be longer than
/// what it replaces.
fn push_quoted(line: &mut String, text: &str, reference: &str, accessor: &str) {
	let total = text.chars().count();
	let cut = total.checked_sub(SHOWN_CHARS).and_then(|hidden| {
		let note = format!(
			"… (+{} chars; (await computer.ref(\"{reference}\")).{accessor})",
			grouped(hidden)
		);
		(note.chars().count() < hidden).then_some(note)
	});
	line.push('"');
	let shown = if cut.is_some() { SHOWN_CHARS } else { total };
	for ch in text.chars().take(shown) {
		match ch {
			'"' => line.push_str("\\\""),
			'\\' => line.push_str("\\\\"),
			'\n' => line.push_str("\\n"),
			'\r' => line.push_str("\\r"),
			'\t' => line.push_str("\\t"),
			ch if ch.is_control() => {
				let _ = write!(line, "\\u{:04x}", u32::from(ch));
			},
			ch => line.push(ch),
		}
	}
	line.push('"');
	if let Some(note) = cut {
		line.push_str(&note);
	}
}

/// `14230` as `14,230`.
fn grouped(count: usize) -> String {
	let digits = count.to_string();
	let mut out = String::with_capacity(digits.len() + digits.len() / 3);
	for (index, digit) in digits.chars().enumerate() {
		if index > 0 && (digits.len() - index).is_multiple_of(3) {
			out.push(',');
		}
		out.push(digit);
	}
	out
}

/// Controls whose own action is a press, so a line never lists it.
fn pressable(role: &str) -> bool {
	matches!(
		role,
		"button"
			| "checkbox"
			| "radio"
			| "link"
			| "menuitem"
			| "menubaritem"
			| "menubutton"
			| "popupbutton"
			| "tab"
			| "disclosuretriangle"
	)
}

/// What a line lists after `actions=`: the macOS actions an element offers
/// beyond what its role implies. A control's press, a text field's confirm
/// and cancel, and the actions nearly every element has (scroll into view,
/// context menu, raise, page scrolls, hover variants) go unlisted, except on a
/// control without press, which lists all it has. App-defined custom actions
/// cannot be performed by name and stay unlisted, as does any other
/// platform's vocabulary.
fn shown_actions(props: &AxProps) -> Option<String> {
	let role = props.role.as_str();
	let mut names = Vec::with_capacity(props.actions.len());
	for action in &props.actions {
		let Some(name) = action.strip_prefix("AX") else {
			continue;
		};
		names.push(name);
	}
	if !pressable(role) || names.contains(&"Press") {
		names.retain(|name| {
			let implied = match *name {
				"Press" => pressable(role),
				"Confirm" | "Cancel" => matches!(role, "textfield" | "textarea" | "combobox"),
				"ScrollToVisible" | "ShowMenu" | "Raise" | "ShowAlternateUI" | "ShowDefaultUI"
				| "ZoomWindow" | "ScrollUpByPage" | "ScrollDownByPage" | "ScrollLeftByPage"
				| "ScrollRightByPage" => true,
				_ => false,
			};
			!implied
		});
	}
	(!names.is_empty()).then(|| names.join(",").to_ascii_lowercase())
}

pub fn node_to_napi(reference: String, props: AxProps) -> AxNode {
	let (x, y, width, height) = props
		.bounds
		.map_or((None, None, None, None), |b| (Some(b.x), Some(b.y), Some(b.width), Some(b.height)));
	AxNode {
		ref_: reference,
		role: props.role,
		native_role: props.native_role,
		title: props.title,
		value: props.value,
		description: props.description,
		enabled: props.enabled,
		focused: props.focused,
		x,
		y,
		width,
		height,
		actions: (!props.actions.is_empty()).then_some(props.actions),
		child_count: props.child_count,
	}
}

fn format_tree(
	node: WalkNode,
	depth: usize,
	window: &DesktopWindow,
	focus: Option<&AxHandle>,
	backend: &mut dyn AxBackend,
	registry: &mut AxRegistry,
	target: &str,
	generation: u64,
	text: &mut String,
	nodes: &mut u32,
) {
	// The root's own focus only reflects app-local focus; report the global
	// roster flag instead.
	let focused = if depth == 0 {
		window.focused
	} else {
		focused_in(focus, &node.handle, node.props.focused)
	};
	let reference = registry.register(backend, target, generation, node.handle, &node.props);
	if !text.is_empty() {
		text.push('\n');
	}
	text.push_str(&"  ".repeat(depth));
	text.push_str("- ");
	text.push_str(&node.props.role);
	if let Some((label, field)) = labelled(&node.props) {
		text.push(' ');
		push_quoted(text, label, &reference, field);
	}
	let _ = write!(text, " [ref={reference}]");
	if depth == 0 {
		let _ = write!(text, " app={}", window.app);
	}
	if let Some(value) = node
		.props
		.value
		.as_deref()
		.filter(|value| !value.is_empty())
	{
		text.push_str(": ");
		push_quoted(text, value, &reference, "value()");
	}
	if !node.props.enabled {
		text.push_str(" (disabled)");
	}
	if node.props.selected {
		text.push_str(" (selected)");
	}
	if node.settable {
		text.push_str(" (settable)");
	}
	if focused {
		text.push_str(" (focused)");
	}
	if let Some(actions) = shown_actions(&node.props) {
		let _ = write!(text, " actions={actions}");
	}
	*nodes += 1;
	for child in node.children {
		format_tree(
			child,
			depth + 1,
			window,
			focus,
			backend,
			registry,
			target,
			generation,
			text,
			nodes,
		);
	}
}

pub fn snapshot(
	backend: &mut dyn AxBackend,
	registry: &mut AxRegistry,
	window: &DesktopWindow,
	options: &AxSnapshotOptions,
) -> CoreResult<AxSnapshot> {
	let target = &window.id;
	let generation = registry.begin_snapshot(target);
	let root = backend.window_root(window)?;
	// Per-element focus flags also hold on every cell of a focused table, so
	// `(focused)` marks only the application's own focused element where the
	// backend reports one.
	let focus = backend.focused_within(&root);
	let mut state = WalkState {
		visited:     0,
		skipped:     0,
		max_nodes:   options.max_nodes.unwrap_or(800).max(1),
		max_depth:   options.max_depth.unwrap_or(24),
		truncated:   false,
		bounds:      WalkBounds::Skip,
		line_states: true,
	};
	let root = walk_raw(backend, root, 0, false, &mut state)?
		.and_then(|node| filter_node(node, options.all.unwrap_or(false)));
	let mut text = String::new();
	let mut node_count = 0;
	if let Some(root) = root {
		format_tree(
			root,
			0,
			window,
			focus.as_ref(),
			backend,
			registry,
			target,
			generation,
			&mut text,
			&mut node_count,
		);
	}
	registry.end_snapshot(target, generation);
	if state.truncated {
		if !text.is_empty() {
			text.push('\n');
		}
		let _ = write!(text, "… truncated ({} nodes)", state.visited);
	}
	if state.skipped > 0 {
		if !text.is_empty() {
			text.push('\n');
		}
		let _ = write!(text, "… skipped {} unreadable nodes", state.skipped);
	}
	Ok(AxSnapshot { text, node_count, truncated: state.truncated })
}

pub fn query(
	backend: &mut dyn AxBackend,
	registry: &mut AxRegistry,
	window: &DesktopWindow,
	query: &AxQuery,
) -> CoreResult<Vec<AxNode>> {
	let target = &window.id;
	let generation = registry.current_generation(target);
	let root = backend.window_root(window)?;
	let focus = backend.focused_within(&root);
	let mut state = WalkState {
		visited:     0,
		skipped:     0,
		max_nodes:   5_000,
		max_depth:   24,
		truncated:   false,
		bounds:      WalkBounds::Read,
		line_states: false,
	};
	let Some(root) = walk_raw(backend, root, 0, false, &mut state)? else {
		return Ok(Vec::new());
	};
	let role = query.role.as_deref().map(str::to_lowercase);
	let title = query.title.as_deref().map(str::to_lowercase);
	let value = query.value.as_deref().map(str::to_lowercase);
	let limit = query.limit.unwrap_or(100).min(5_000) as usize;
	let mut result = Vec::new();
	let mut stack = vec![root];
	while let Some(node) = stack.pop() {
		stack.extend(node.children.iter().rev().cloned());
		let contains = |actual: Option<&str>, expected: Option<&String>| {
			expected
				.is_none_or(|needle| actual.is_some_and(|text| text.to_lowercase().contains(needle)))
		};
		if contains(Some(&node.props.role), role.as_ref())
			&& contains(label(&node.props), title.as_ref())
			&& contains(node.props.value.as_deref(), value.as_ref())
		{
			let mut props = node.props;
			props.focused = focused_in(focus.as_ref(), &node.handle, props.focused);
			let reference = registry.register(backend, target, generation, node.handle, &props);
			result.push(node_to_napi(reference, props));
			if result.len() >= limit {
				break;
			}
		}
	}
	Ok(result)
}

pub fn register_node(
	backend: &mut dyn AxBackend,
	registry: &mut AxRegistry,
	target: &str,
	handle: AxHandle,
	focus: &mut AppFocus,
) -> CoreResult<AxNode> {
	let props = node_props(backend, &handle, focus)?;
	let generation = registry.current_generation(target);
	let reference = registry.register(backend, target, generation, handle, &props);
	Ok(node_to_napi(reference, props))
}

/// Whether `handle` holds focus: its own flag says so and, when the backend
/// reports the application's focused element, it is that element. A focused
/// table reports every cell focused.
fn focused_in(focus: Option<&AxHandle>, handle: &AxHandle, own: bool) -> bool {
	own && focus.is_none_or(|focus| focus == handle)
}

/// The application's focused element for one request: read once, and only
/// when an element reports itself focused, so reads of unfocused elements
/// cost no extra round trip to the app.
#[derive(Default)]
pub struct AppFocus(Option<Option<AxHandle>>);

impl AppFocus {
	fn get(&mut self, backend: &mut dyn AxBackend, handle: &AxHandle) -> Option<&AxHandle> {
		self.0.get_or_insert_with(|| backend.focused_within(handle)).as_ref()
	}
}

/// An element's props, its `focused` decided by [`focused_in`].
pub fn node_props(
	backend: &mut dyn AxBackend,
	handle: &AxHandle,
	focus: &mut AppFocus,
) -> CoreResult<AxProps> {
	let mut props = backend.props(handle)?;
	if props.focused {
		let focus = focus.get(backend, handle).cloned();
		props.focused = focused_in(focus.as_ref(), handle, true);
	}
	Ok(props)
}
pub fn element_at_node(
	backend: &mut dyn AxBackend,
	registry: &mut AxRegistry,
	target: &str,
	x: f64,
	y: f64,
) -> CoreResult<Option<AxNode>> {
	let Some(handle) = backend.element_at(x, y)? else {
		return Ok(None);
	};
	register_node(backend, registry, target, handle, &mut AppFocus::default()).map(Some)
}

pub fn ax_press(backend: &mut dyn AxBackend, handle: &AxHandle) -> CoreResult<()> {
	backend.perform(handle, "press")
}

/// Maps a raw `AX*` macOS accessibility role onto the cross-platform role
/// vocabulary. Compiled only where it has a caller (macOS backend + tests).
#[cfg(any(target_os = "macos", test))]
pub fn normalize_role_macos(native: &str) -> String {
	match native {
		"AXTextArea" => "textarea",
		"AXTextField" => "textfield",
		"AXPopUpButton" => "popupbutton",
		"AXRadioButton" => "radio",
		"AXCheckBox" => "checkbox",
		"AXStaticText" => "statictext",
		"AXScrollArea" => "scrollarea",
		"AXTabGroup" => "tabgroup",
		"AXWebArea" => "webarea",
		"AXRow" => "row",
		"AXCell" => "cell",
		"AXOutline" => "outline",
		_ => native.strip_prefix("AX").unwrap_or(native),
	}
	.to_ascii_lowercase()
}
#[cfg(any(target_os = "windows", test))]
pub fn normalize_role_uia(native: &str) -> String {
	match native {
		"Edit" => "textfield",
		"Document" => "textarea",
		"Text" => "statictext",
		"Hyperlink" => "link",
		"Pane" => "group",
		"TabItem" => "tab",
		"Tab" => "tabgroup",
		"DataItem" => "listitem",
		"DataGrid" => "table",
		"SplitButton" => "popupbutton",
		other => return other.to_ascii_lowercase(),
	}
	.to_string()
}
#[cfg(any(target_os = "linux", test))]
pub fn normalize_role_atspi(native: &str, multiline: bool) -> String {
	match native.to_ascii_lowercase().as_str() {
		"push button" | "toggle button" => "button".into(),
		"entry" | "text" if multiline => "textarea".into(),
		"entry" | "text" => "textfield".into(),
		"label" => "statictext".into(),
		"page tab" => "tab".into(),
		"page tab list" => "tabgroup".into(),
		"table cell" => "cell".into(),
		"tree" => "outline".into(),
		"tree item" => "outlineitem".into(),
		"frame" | "dialog" => "window".into(),
		other => other.replace(' ', ""),
	}
}

#[cfg(test)]
mod tests {
	use std::collections::{HashMap, HashSet};

	use super::{super::error::ErrorCode, *};

	#[derive(Default)]
	struct Mock {
		props:          HashMap<u64, AxProps>,
		children:       HashMap<u64, Vec<u64>>,
		/// Nodes read without an identity.
		unidentified:   HashSet<u64>,
		/// Nodes whose earlier reads are gone, their identity taken over.
		gone:           HashSet<u64>,
		/// Bounds read by tree walks.
		bounds_reads:   u32,
		/// The application's focused element.
		focus:          Option<u64>,
		/// Application-focus reads made.
		focus_reads:    u32,
		/// Nodes whose value `setValue` can write.
		settable:       HashSet<u64>,
		/// Settability checks made.
		settable_reads: u32,
	}
	impl Mock {
		fn handle(&self, id: u64) -> AxHandle {
			if self.unidentified.contains(&id) {
				AxHandle::TestUnidentified(id)
			} else {
				AxHandle::Test(id)
			}
		}
	}
	fn node(h: &AxHandle) -> u64 {
		match h {
			AxHandle::Test(id) | AxHandle::TestUnidentified(id) => *id,
			_ => unreachable!(),
		}
	}
	impl AxBackend for Mock {
		fn window_root(&mut self, _: &DesktopWindow) -> CoreResult<AxHandle> {
			Ok(self.handle(1))
		}

		fn window_id(&mut self, _: &AxHandle, _: &[DesktopWindow]) -> CoreResult<String> {
			unreachable!("window ownership is not exercised by tree traversal tests")
		}

		fn props(&mut self, h: &AxHandle) -> CoreResult<AxProps> {
			let id = node(h);
			self
				.props
				.get(&id)
				.cloned()
				.ok_or_else(|| DesktopError::ax_failed(format!("unreadable test node {id}")))
		}

		fn children(&mut self, h: &AxHandle) -> CoreResult<Vec<AxHandle>> {
			Ok(self
				.children
				.get(&node(h))
				.into_iter()
				.flatten()
				.map(|id| self.handle(*id))
				.collect())
		}

		fn walk_node(
			&mut self,
			h: &AxHandle,
			bounds: WalkBounds,
		) -> CoreResult<(AxProps, Vec<AxHandle>)> {
			let mut props = self.props(h)?;
			match bounds {
				WalkBounds::Read => self.bounds_reads += u32::from(props.bounds.is_some()),
				WalkBounds::Skip => props.bounds = None,
			}
			Ok((props, self.children(h)?))
		}

		fn parent(&mut self, _: &AxHandle) -> CoreResult<Option<AxHandle>> {
			Ok(None)
		}

		fn perform(&mut self, _: &AxHandle, _: &str) -> CoreResult<()> {
			Ok(())
		}

		fn set_value(&mut self, _: &AxHandle, _: &str) -> CoreResult<()> {
			Ok(())
		}

		fn focus(&mut self, _: &AxHandle) -> CoreResult<()> {
			Ok(())
		}

		fn element_at(&mut self, x: f64, y: f64) -> CoreResult<Option<AxHandle>> {
			Ok(self.props.iter().find_map(|(id, props)| {
				props
					.bounds
					.filter(|bounds| {
						x >= bounds.x
							&& x < bounds.x + bounds.width
							&& y >= bounds.y
							&& y < bounds.y + bounds.height
					})
					.map(|_| self.handle(*id))
			}))
		}

		fn focused_element(&mut self) -> CoreResult<Option<AxHandle>> {
			Ok(None)
		}

		fn attributes(&mut self, _: &AxHandle) -> CoreResult<Vec<(String, String)>> {
			Ok(Vec::new())
		}

		fn alive(&mut self, h: &AxHandle) -> bool {
			!self.gone.contains(&node(h))
		}

		fn focused_within(&mut self, _: &AxHandle) -> Option<AxHandle> {
			self.focus_reads += 1;
			self.focus.map(|id| self.handle(id))
		}

		fn value_settable(&mut self, h: &AxHandle) -> bool {
			self.settable_reads += 1;
			self.settable.contains(&node(h))
		}
	}
	fn p(role: &str, title: Option<&str>) -> AxProps {
		AxProps {
			role:        role.into(),
			native_role: role.into(),
			title:       title.map(str::to_string),
			value:       None,
			description: None,
			enabled:     true,
			focused:     false,
			bounds:      None,
			actions:     Vec::new(),
			child_count: 0,
			selected:    false,
			role_name:   None,
		}
	}
	fn window() -> DesktopWindow {
		DesktopWindow {
			id:      "7".into(),
			title:   "Title".into(),
			app:     "Safari".into(),
			pid:     None,
			x:       0,
			y:       0,
			width:   100,
			height:  100,
			focused: true,
		}
	}
	#[test]
	fn generations_keep_current_and_previous() {
		let mut m = Mock::default();
		let mut r = AxRegistry::default();
		for g in 1..=3 {
			let generation = r.begin_snapshot("x");
			r.register(&mut m, "x", generation, AxHandle::Test(g), &p("button", None));
			r.end_snapshot("x", generation);
		}
		assert!(r.resolve("e1").is_err());
		assert!(r.resolve("e2").is_ok());
		assert!(r.resolve("e3").is_ok());
	}
	#[test]
	fn reread_elements_keep_their_ref_and_removed_ones_expire() {
		let mut m = Mock {
			props: [
				(1, p("window", Some("Title"))),
				(2, p("button", Some("Keep"))),
				(3, p("button", Some("Gone"))),
			]
			.into(),
			children: [(1, vec![2, 3])].into(),
			..Default::default()
		};
		let mut registry = AxRegistry::default();
		let first =
			snapshot(&mut m, &mut registry, &window(), &AxSnapshotOptions::default()).unwrap();
		assert_eq!(
			first.text,
			"- window \"Title\" [ref=e1] app=Safari (focused)\n  - button \"Keep\" [ref=e2]\n  - \
			 button \"Gone\" [ref=e3]"
		);
		m.children.insert(1, vec![2]);
		for _ in 0..2 {
			let reread =
				snapshot(&mut m, &mut registry, &window(), &AxSnapshotOptions::default()).unwrap();
			assert_eq!(
				reread.text,
				"- window \"Title\" [ref=e1] app=Safari (focused)\n  - button \"Keep\" [ref=e2]"
			);
		}
		let found = query(&mut m, &mut registry, &window(), &AxQuery {
			role:  Some("button".into()),
			title: Some("keep".into()),
			value: None,
			limit: None,
		})
		.unwrap();
		assert_eq!(found[0].ref_, "e2");
		assert!(matches!(registry.resolve("e2").unwrap(), AxHandle::Test(2)));
		assert_eq!(registry.resolve("e3").err().map(|error| error.code), Some(ErrorCode::StaleRef));
	}
	#[test]
	fn ax_reads_no_bounds_while_find_returns_them() {
		let mut button = p("button", Some("Go"));
		button.bounds = Some(AxBounds { x: 10.0, y: 20.0, width: 30.0, height: 40.0 });
		let mut m = Mock {
			props: [(1, p("window", Some("Title"))), (2, button)].into(),
			children: [(1, vec![2])].into(),
			..Default::default()
		};
		let mut registry = AxRegistry::default();
		snapshot(&mut m, &mut registry, &window(), &AxSnapshotOptions::default()).unwrap();
		assert_eq!(m.bounds_reads, 0);
		let found = query(&mut m, &mut registry, &window(), &AxQuery {
			role:  Some("button".into()),
			title: None,
			value: None,
			limit: None,
		})
		.unwrap();
		assert_eq!(
			(found[0].x, found[0].y, found[0].width, found[0].height),
			(Some(10.0), Some(20.0), Some(30.0), Some(40.0))
		);
	}
	#[test]
	fn a_relabelled_element_keeps_its_old_ref_until_it_expires() {
		let mut m = Mock {
			props: [(1, p("window", Some("Title"))), (2, p("button", Some("Play")))].into(),
			children: [(1, vec![2])].into(),
			..Default::default()
		};
		let mut registry = AxRegistry::default();
		let options = AxSnapshotOptions::default();
		snapshot(&mut m, &mut registry, &window(), &options).unwrap();
		m.props.insert(2, p("button", Some("Pause")));
		let relabelled = snapshot(&mut m, &mut registry, &window(), &options).unwrap();
		assert_eq!(
			relabelled.text,
			"- window \"Title\" [ref=e1] app=Safari (focused)\n  - button \"Pause\" [ref=e3]"
		);
		let found = query(&mut m, &mut registry, &window(), &AxQuery {
			role:  Some("button".into()),
			title: None,
			value: None,
			limit: None,
		})
		.unwrap();
		assert_eq!(found[0].ref_, "e3");
		assert!(matches!(registry.resolve("e2").unwrap(), AxHandle::Test(2)));
		for _ in 0..2 {
			let reread = snapshot(&mut m, &mut registry, &window(), &options).unwrap();
			assert_eq!(reread.text, relabelled.text);
		}
		assert_eq!(registry.resolve("e2").err().map(|error| error.code), Some(ErrorCode::StaleRef));
		assert!(matches!(registry.resolve("e3").unwrap(), AxHandle::Test(2)));
	}
	#[test]
	fn an_element_missing_from_one_snapshot_keeps_its_ref() {
		let mut m = Mock {
			props: [
				(1, p("window", Some("Title"))),
				(2, p("button", Some("Keep"))),
				(3, p("button", Some("Flicker"))),
			]
			.into(),
			children: [(1, vec![2, 3])].into(),
			..Default::default()
		};
		let mut registry = AxRegistry::default();
		let options = AxSnapshotOptions::default();
		let first = snapshot(&mut m, &mut registry, &window(), &options).unwrap();
		m.children.insert(1, vec![2]);
		snapshot(&mut m, &mut registry, &window(), &options).unwrap();
		m.children.insert(1, vec![2, 3]);
		let back = snapshot(&mut m, &mut registry, &window(), &options).unwrap();
		assert_eq!(back.text, first.text);
		assert!(back.text.ends_with("button \"Flicker\" [ref=e3]"));
	}
	#[test]
	fn an_identity_whose_element_is_gone_gets_a_new_ref() {
		let mut m = Mock {
			props: [(1, p("window", Some("Title"))), (2, p("button", Some("Go")))].into(),
			children: [(1, vec![2])].into(),
			..Default::default()
		};
		let mut registry = AxRegistry::default();
		let options = AxSnapshotOptions::default();
		snapshot(&mut m, &mut registry, &window(), &options).unwrap();
		m.gone.insert(2);
		let replaced = snapshot(&mut m, &mut registry, &window(), &options).unwrap();
		assert_eq!(
			replaced.text,
			"- window \"Title\" [ref=e1] app=Safari (focused)\n  - button \"Go\" [ref=e3]"
		);
		m.gone.clear();
		let reread = snapshot(&mut m, &mut registry, &window(), &options).unwrap();
		assert_eq!(reread.text, replaced.text);
	}
	#[test]
	fn elements_without_an_identity_get_a_new_ref_on_every_read() {
		let mut m = Mock {
			props: [
				(1, p("window", Some("Title"))),
				(2, p("button", Some("Go"))),
				(3, p("button", Some("Go"))),
			]
			.into(),
			children: [(1, vec![2, 3])].into(),
			unidentified: [1, 2, 3].into(),
			..Default::default()
		};
		let mut registry = AxRegistry::default();
		let options = AxSnapshotOptions::default();
		let first = snapshot(&mut m, &mut registry, &window(), &options).unwrap();
		assert_eq!(
			first.text,
			"- window \"Title\" [ref=e1] app=Safari (focused)\n  - button \"Go\" [ref=e2]\n  - \
			 button \"Go\" [ref=e3]"
		);
		let second = snapshot(&mut m, &mut registry, &window(), &options).unwrap();
		assert_eq!(
			second.text,
			"- window \"Title\" [ref=e4] app=Safari (focused)\n  - button \"Go\" [ref=e5]\n  - \
			 button \"Go\" [ref=e6]"
		);
		assert!(matches!(registry.resolve("e3").unwrap(), AxHandle::TestUnidentified(3)));
		snapshot(&mut m, &mut registry, &window(), &options).unwrap();
		assert_eq!(registry.resolve("e3").err().map(|error| error.code), Some(ErrorCode::StaleRef));
	}
	#[test]
	fn refs_are_per_target() {
		let mut m = Mock::default();
		let mut r = AxRegistry::default();
		let go = p("button", Some("Go"));
		let desktop = r.current_generation("desktop");
		assert_eq!(r.register(&mut m, "desktop", desktop, AxHandle::Test(5), &go), "e1");
		for _ in 0..2 {
			let generation = r.begin_snapshot("7");
			assert_eq!(r.register(&mut m, "7", generation, AxHandle::Test(5), &go), "e2");
			r.end_snapshot("7", generation);
		}
		for _ in 0..2 {
			let generation = r.begin_snapshot("7");
			r.end_snapshot("7", generation);
		}
		assert!(r.resolve("e2").is_err());
		assert!(r.resolve("e1").is_ok());
	}
	#[test]
	fn hard_cap_evicts_oldest_generation_of_largest_target() {
		let mut m = Mock::default();
		let mut r = AxRegistry::default();
		let g = r.current_generation("x");
		for n in 0..5_001 {
			r.register(&mut m, "x", g, AxHandle::Test(n), &p("button", None));
		}
		assert!(r.entries.len() <= 5_000);
		assert!(r.resolve("e1").is_err());
	}
	#[test]
	fn snapshot_text_and_filter_are_exact() {
		let mut m = Mock {
			props: [
				(1, p("window", Some("Title"))),
				(2, p("group", None)),
				(3, p("button", Some("Go"))),
			]
			.into(),
			children: [(1, vec![2]), (2, vec![3])].into(),
			..Default::default()
		};
		m.props.get_mut(&3).unwrap().actions.push("press".into());
		let s =
			snapshot(&mut m, &mut AxRegistry::default(), &window(), &AxSnapshotOptions::default())
				.unwrap();
		assert_eq!(
			s.text,
			"- window \"Title\" [ref=e1] app=Safari (focused)\n  - button \"Go\" [ref=e2]"
		);
		assert_eq!(s.node_count, 2);
	}
	#[test]
	fn unnamed_containers_keep_their_surviving_content() {
		// A Reminders-shaped window: an unnamed split group holding a list pane
		// and a detail pane, an unnamed splitter, and an empty wrapper.
		let mut m = Mock {
			props: [
				(1, p("window", Some("Title"))),
				(2, p("splitgroup", None)),
				(3, p("scrollarea", None)),
				(4, p("button", Some("Groceries"))),
				(5, p("splitter", None)),
				(6, p("layoutarea", None)),
				(7, p("textfield", Some("Notes"))),
				(8, p("group", None)),
			]
			.into(),
			children: [(1, vec![2]), (2, vec![3, 5, 6, 8]), (3, vec![4]), (6, vec![7])].into(),
			..Default::default()
		};
		let s =
			snapshot(&mut m, &mut AxRegistry::default(), &window(), &AxSnapshotOptions::default())
				.unwrap();
		assert_eq!(
			s.text,
			"- window \"Title\" [ref=e1] app=Safari (focused)\n  - splitgroup [ref=e2]\n    - \
			 scrollarea [ref=e3]\n      - button \"Groceries\" [ref=e4]\n    - textfield \"Notes\" \
			 [ref=e5]"
		);
		assert_eq!(s.node_count, 5);
	}
	#[test]
	fn description_labels_unnamed_controls_without_changing_raw_title() {
		let mut reload = p("button", None);
		reload.description = Some("Reload".into());
		reload.actions.push("press".into());
		let mut m = Mock {
			props: [(1, p("window", Some("Title"))), (2, reload)].into(),
			children: [(1, vec![2])].into(),
			..Default::default()
		};
		let snapshot =
			snapshot(&mut m, &mut AxRegistry::default(), &window(), &AxSnapshotOptions::default())
				.unwrap();
		assert!(snapshot.text.contains("- button \"Reload\""));

		let nodes = query(&mut m, &mut AxRegistry::default(), &window(), &AxQuery {
			role:  Some("button".into()),
			title: Some("reload".into()),
			value: None,
			limit: None,
		})
		.unwrap();
		assert_eq!(nodes.len(), 1);
		assert_eq!(nodes[0].title, None);
		assert_eq!(nodes[0].description.as_deref(), Some("Reload"));
	}
	fn tree(m: &mut Mock) -> String {
		snapshot(m, &mut AxRegistry::default(), &window(), &AxSnapshotOptions::default())
			.unwrap()
			.text
	}
	#[test]
	fn a_long_value_shows_its_start_and_names_the_call_that_reads_it_whole() {
		let whole = format!("line one\n\"two\"\t{}", "x".repeat(14_415));
		let mut note = p("textarea", None);
		note.value = Some(whole.clone());
		note.focused = true;
		let mut field = p("textfield", None);
		field.value = Some("y".repeat(SHOWN_CHARS + 30));
		let mut m = Mock {
			props: [(1, p("window", Some("Title"))), (2, note), (3, field)].into(),
			children: [(1, vec![2, 3])].into(),
			..Default::default()
		};
		let text = tree(&mut m);
		assert_eq!(
			text,
			format!(
				"- window \"Title\" [ref=e1] app=Safari (focused)\n  - textarea [ref=e2]: \"line \
				 one\\n\\\"two\\\"\\t{}\"… (+14,230 chars; (await computer.ref(\"e2\")).value()) \
				 (focused)\n  - textfield [ref=e3]: \"{}\"",
				"x".repeat(SHOWN_CHARS - 15),
				"y".repeat(SHOWN_CHARS + 30),
			)
		);
		let found = query(&mut m, &mut AxRegistry::default(), &window(), &AxQuery {
			role:  Some("textarea".into()),
			title: None,
			value: None,
			limit: None,
		})
		.unwrap();
		assert_eq!(found[0].value.as_deref(), Some(whole.as_str()));
	}
	/// The tree line of `reference`, without its indent.
	fn line<'a>(text: &'a str, reference: &str) -> &'a str {
		let tag = format!("[ref={reference}]");
		text
			.lines()
			.find(|line| line.contains(&tag))
			.unwrap_or_else(|| panic!("no {tag} in\n{text}"))
			.trim_start()
	}
	#[test]
	fn only_the_applications_focused_element_is_marked_focused() {
		// A focused table reports every cell focused.
		let cell = |title| {
			let mut cell = p("cell", Some(title));
			cell.focused = true;
			cell
		};
		let mut m = Mock {
			props: [
				(1, p("window", Some("Title"))),
				(2, p("outline", Some("Files"))),
				(3, cell("a.txt")),
				(4, cell("b.txt")),
			]
			.into(),
			children: [(1, vec![2]), (2, vec![3, 4])].into(),
			focus: Some(4),
			..Default::default()
		};
		let text = tree(&mut m);
		assert_eq!(line(&text, "e3"), "- cell \"a.txt\" [ref=e3]");
		assert_eq!(line(&text, "e4"), "- cell \"b.txt\" [ref=e4] (focused)");
		let found = query(&mut m, &mut AxRegistry::default(), &window(), &AxQuery {
			role:  Some("cell".into()),
			title: None,
			value: None,
			limit: None,
		})
		.unwrap();
		assert_eq!(found.iter().map(|node| node.focused).collect::<Vec<_>>(), [false, true]);
		// Single-element reads share one app-focus read per request, and an
		// element that does not report itself focused needs none.
		let mut registry = AxRegistry::default();
		let (a, b, outline) = (m.handle(3), m.handle(4), m.handle(2));
		m.focus_reads = 0;
		let mut focus = AppFocus::default();
		let a = register_node(&mut m, &mut registry, "w", a, &mut focus).unwrap();
		let b = register_node(&mut m, &mut registry, "w", b, &mut focus).unwrap();
		assert_eq!((a.focused, b.focused), (false, true));
		assert_eq!(m.focus_reads, 1);
		let outline =
			register_node(&mut m, &mut registry, "w", outline, &mut AppFocus::default()).unwrap();
		assert!(!outline.focused);
		assert_eq!(m.focus_reads, 1);
		// Without an application focus, an element's own flag stands.
		m.focus = None;
		let text = tree(&mut m);
		assert!(line(&text, "e3").ends_with("(focused)"), "{text}");
	}
	#[test]
	fn only_dates_outside_web_content_are_marked_settable() {
		let mut due = p("datetimearea", Some("Due"));
		due.value = Some("2026-10-16T09:00:00-04:00".into());
		let mut volume = p("slider", Some("Volume"));
		volume.value = Some("0.5".into());
		let mut name = p("textfield", Some("Name"));
		name.value = Some("Bench".into());
		let mut m = Mock {
			props: [
				(1, p("window", Some("Title"))),
				(2, due),
				(3, p("webarea", Some("Page"))),
				(4, p("datetimearea", Some("Arrival"))),
				(5, p("button", Some("Go"))),
				(6, volume),
				(7, name),
			]
			.into(),
			children: [(1, vec![2, 3, 5, 6, 7]), (3, vec![4])].into(),
			settable: [2, 4, 5, 6, 7].into(),
			..Default::default()
		};
		let text = tree(&mut m);
		assert!(line(&text, "e2").ends_with("(settable)"), "{text}");
		for unsettable in ["e4", "e5", "e6", "e7"] {
			assert!(!line(&text, unsettable).contains("(settable)"), "{text}");
		}
		assert_eq!(m.settable_reads, 1);
	}
	#[test]
	fn selected_rows_and_items_are_marked() {
		let mut inbox = p("row", Some("Inbox"));
		inbox.selected = true;
		let mut b_pdf = p("image", Some("b.pdf"));
		b_pdf.selected = true;
		let mut m = Mock {
			props: [
				(1, p("window", Some("Title"))),
				(2, p("outline", Some("Sidebar"))),
				(3, inbox),
				(4, p("row", Some("Sent"))),
				(5, p("list", Some("Files"))),
				(6, p("image", Some("a.pdf"))),
				(7, b_pdf),
			]
			.into(),
			children: [(1, vec![2, 5]), (2, vec![3, 4]), (5, vec![6, 7])].into(),
			..Default::default()
		};
		let text = tree(&mut m);
		let marked: Vec<_> = text
			.lines()
			.filter(|line| line.ends_with(" (selected)"))
			.map(str::trim_start)
			.collect();
		assert_eq!(marked, [
			"- row \"Inbox\" [ref=e3] (selected)",
			"- image \"b.pdf\" [ref=e7] (selected)"
		]);
	}
	#[test]
	fn lines_list_the_actions_a_role_does_not_imply() {
		let with = |role: &str, title: &str, actions: &[&str]| {
			let mut props = p(role, Some(title));
			props.actions = actions.iter().map(|action| (*action).to_owned()).collect();
			props
		};
		let mut m = Mock {
			props: [
				(1, p("window", Some("Title"))),
				(2, with("button", "Save", &["AXPress", "AXShowMenu"])),
				(3, with("button", "Search", &["AXShowMenu", "AXScrollToVisible"])),
				(4, with("image", "a.pdf", &["AXOpen", "SomeVendorAction", "AXShowMenu"])),
				(5, with("statictext", "Yoga", &["AXPress", "AXShowMenu", "AXScrollToVisible"])),
				(6, with("textfield", "Name", &["AXConfirm", "AXCancel", "Name:Delete\nTarget:0x0"])),
				(7, with("popover", "Details", &["AXCancel"])),
				(8, with("button", "Native", &["press", "invoke"])),
			]
			.into(),
			children: [(1, (2..=8).collect())].into(),
			..Default::default()
		};
		let text = tree(&mut m);
		let actions = |reference| {
			line(&text, reference)
				.split_once(" actions=")
				.map(|(_, actions)| actions)
		};
		assert_eq!(actions("e2"), None);
		assert_eq!(actions("e3"), Some("showmenu,scrolltovisible"));
		assert_eq!(actions("e4"), Some("open"));
		assert_eq!(actions("e5"), Some("press"));
		assert_eq!(actions("e6"), None);
		assert_eq!(actions("e7"), Some("cancel"));
		assert_eq!(actions("e8"), None);
	}
	#[test]
	fn a_window_control_named_only_by_its_subrole_takes_that_name() {
		let mut close = p("button", None);
		close.role_name = Some("close".into());
		close.actions.push("AXPress".into());
		let mut m = Mock {
			props: [(1, p("window", Some("Title"))), (2, close)].into(),
			children: [(1, vec![2])].into(),
			..Default::default()
		};
		assert_eq!(
			tree(&mut m),
			"- window \"Title\" [ref=e1] app=Safari (focused)\n  - button \"close\" [ref=e2]"
		);
		let found = query(&mut m, &mut AxRegistry::default(), &window(), &AxQuery {
			role:  None,
			title: Some("close".into()),
			value: None,
			limit: None,
		})
		.unwrap();
		assert_eq!((found.len(), found[0].title.as_deref()), (1, None));
	}
	#[test]
	fn truncation_sets_flag_and_trailer() {
		let mut m = Mock {
			props: [(1, p("window", Some("Title"))), (2, p("button", Some("A")))].into(),
			children: [(1, vec![2])].into(),
			..Default::default()
		};
		let s = snapshot(&mut m, &mut AxRegistry::default(), &window(), &AxSnapshotOptions {
			max_nodes: Some(1),
			..Default::default()
		})
		.unwrap();
		assert!(s.truncated);
		assert!(s.text.ends_with("… truncated (1 nodes)"));
	}
	#[test]
	fn unreadable_subtree_is_skipped_with_trailer() {
		let mut m = Mock {
			props: [(1, p("window", Some("Title"))), (3, p("button", Some("Ready")))].into(),
			children: [(1, vec![2, 3])].into(),
			..Default::default()
		};
		let s =
			snapshot(&mut m, &mut AxRegistry::default(), &window(), &AxSnapshotOptions::default())
				.unwrap();
		assert_eq!(
			s.text,
			"- window \"Title\" [ref=e1] app=Safari (focused)\n  - button \"Ready\" [ref=e2]\n… \
			 skipped 1 unreadable nodes"
		);
		assert_eq!(s.node_count, 2);
		let limited = snapshot(&mut m, &mut AxRegistry::default(), &window(), &AxSnapshotOptions {
			max_nodes: Some(2),
			..Default::default()
		})
		.unwrap();
		assert!(limited.truncated);
		assert!(
			limited
				.text
				.ends_with("… truncated (2 nodes)\n… skipped 1 unreadable nodes")
		);
		let nodes = query(&mut m, &mut AxRegistry::default(), &window(), &AxQuery {
			role:  Some("button".into()),
			title: None,
			value: None,
			limit: None,
		})
		.unwrap();
		assert_eq!(nodes.len(), 1);
		assert_eq!(nodes[0].title.as_deref(), Some("Ready"));
	}
	#[test]
	fn bounds_center_hit_test_is_global_and_frameless() {
		let bounds = AxBounds { x: -420.0, y: 75.0, width: 80.0, height: 50.0 };
		let mut hit = p("button", Some("Global"));
		hit.bounds = Some(bounds);
		let mut m =
			Mock { props: [(1, p("window", Some("Title"))), (2, hit)].into(), ..Default::default() };
		let mut registry = AxRegistry::default();
		let node = element_at_node(
			&mut m,
			&mut registry,
			"desktop",
			bounds.x + bounds.width / 2.0,
			bounds.y + bounds.height / 2.0,
		)
		.unwrap()
		.unwrap();
		assert_eq!(node.ref_, "e1");
		assert_eq!(
			(node.x, node.y, node.width, node.height),
			(Some(-420.0), Some(75.0), Some(80.0), Some(50.0))
		);
		assert!(matches!(registry.resolve("e1").unwrap(), AxHandle::Test(2)));
	}
	#[test]
	fn normalization_tables() {
		for (native, role) in [
			("AXTextArea", "textarea"),
			("AXTextField", "textfield"),
			("AXPopUpButton", "popupbutton"),
			("AXRadioButton", "radio"),
			("AXCheckBox", "checkbox"),
			("AXStaticText", "statictext"),
			("AXScrollArea", "scrollarea"),
			("AXTabGroup", "tabgroup"),
			("AXWebArea", "webarea"),
			("AXRow", "row"),
			("AXCell", "cell"),
			("AXOutline", "outline"),
			("AXButton", "button"),
		] {
			assert_eq!(normalize_role_macos(native), role);
		}
		for (native, role) in [
			("Edit", "textfield"),
			("Document", "textarea"),
			("Text", "statictext"),
			("Hyperlink", "link"),
			("Pane", "group"),
			("TabItem", "tab"),
			("Tab", "tabgroup"),
			("DataItem", "listitem"),
			("DataGrid", "table"),
			("SplitButton", "popupbutton"),
			("Button", "button"),
		] {
			assert_eq!(normalize_role_uia(native), role);
		}
		for (native, multiline, role) in [
			("push button", false, "button"),
			("toggle button", false, "button"),
			("entry", false, "textfield"),
			("text", true, "textarea"),
			("label", false, "statictext"),
			("page tab", false, "tab"),
			("page tab list", false, "tabgroup"),
			("table cell", false, "cell"),
			("tree", false, "outline"),
			("tree item", false, "outlineitem"),
			("frame", false, "window"),
			("dialog", false, "window"),
			("list item", false, "listitem"),
		] {
			assert_eq!(normalize_role_atspi(native, multiline), role);
		}
	}
}
