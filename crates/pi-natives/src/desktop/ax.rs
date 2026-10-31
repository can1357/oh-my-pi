use std::{
	collections::{HashMap, HashSet},
	fmt::Write as _,
	hash::{DefaultHasher, Hash, Hasher},
};

use super::{
	backend::AxBackend,
	control,
	error::{CoreResult, DesktopError, ErrorCode},
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
	/// Hash of the fields that tell the element apart in its window, compared
	/// to name the one element left with them once the app has destroyed it;
	/// `None` where the backend reads none or could not read them all.
	pub identity:    Option<u64>,
	/// The backend failed to read an identifying field or the children of an
	/// element that is still there, so a read that met it cannot tell whether
	/// an identity is unique in the window.
	pub partial:     bool,
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

/// What one read says about an element's identity.
pub(crate) enum Uniqueness<'a> {
	/// No other element of this walk of the whole window shares it.
	Proven(&'a WholeWalk),
	/// Another element of the walk shares it.
	Shared,
	/// A read that cannot tell, of the element alone or of part of the
	/// window: an earlier proof stands while the identity is unchanged.
	Unknown,
}

/// A walk that read every element of the window element `root` still there,
/// within these limits. A window id the system has since given to another
/// window is not the window to search, and a search reads as far as the walk
/// that proved the identity did.
#[derive(Clone)]
pub(crate) struct WholeWalk {
	root:      AxHandle,
	max_nodes: u32,
	max_depth: u32,
}

/// Why a ref's identity can name its element's one copy: it was unique in
/// `walk`.
#[derive(Clone)]
struct Proof {
	identity: u64,
	walk:     WholeWalk,
}

struct Registered {
	handle:      AxHandle,
	target_key:  String,
	generation:  u64,
	/// Role and label at registration. An identity read again with another
	/// role or label gets a new ref.
	fingerprint: u64,
	proof:       Option<Proof>,
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
	/// identity gets a new ref on every read. `uniqueness` says whether the
	/// element's [`AxProps::identity`] can name its one copy once the app has
	/// destroyed it.
	pub(crate) fn register(
		&mut self,
		backend: &mut dyn AxBackend,
		target: &str,
		generation: u64,
		handle: AxHandle,
		props: &AxProps,
		uniqueness: Uniqueness,
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
		let proof = match uniqueness {
			Uniqueness::Proven(walk) => props
				.identity
				.map(|identity| Proof { identity, walk: walk.clone() }),
			Uniqueness::Shared => None,
			Uniqueness::Unknown => renewed
				.and_then(|id| self.entries.remove(&id))
				.and_then(|entry| entry.proof)
				.filter(|proof| props.identity == Some(proof.identity)),
		};
		self.entries.insert(id, Registered {
			handle,
			target_key: target.to_string(),
			generation,
			fingerprint,
			proof,
		});
		self.enforce_cap();
		format!("e{id}")
	}

	fn entry(&self, reference: &str) -> CoreResult<&Registered> {
		ref_id(reference)
			.and_then(|id| self.entries.get(&id))
			.ok_or_else(|| DesktopError::stale_ref(format!("{reference} expired; re-run ax()/find()")))
	}

	pub(crate) fn resolve(&self, reference: &str) -> CoreResult<AxHandle> {
		self.entry(reference).map(|entry| entry.handle.clone())
	}

	pub(crate) fn target(&self, reference: &str) -> CoreResult<String> {
		self.entry(reference).map(|entry| entry.target_key.clone())
	}

	/// Whether `reference` was read with an identity that can name its
	/// element's one copy, so [`refind`] can search for it.
	pub(crate) fn has_proof(&self, reference: &str) -> bool {
		self
			.entry(reference)
			.is_ok_and(|entry| entry.proof.is_some())
	}

	/// Drops expired refs. An identity a newer ref took over keeps pointing at
	/// that one.
	fn evict(&mut self, mut expired: impl FnMut(&Registered) -> bool) {
		for (id, entry) in self.entries.extract_if(|_, entry| expired(entry)) {
			if let Some(target_refs) = self.refs.get_mut(&entry.target_key)
				&& target_refs.get(&entry.handle) == Some(&id)
			{
				target_refs.remove(&entry.handle);
			}
		}
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

/// The number in an `eN` ref.
fn ref_id(reference: &str) -> Option<u64> {
	reference.strip_prefix('e')?.parse().ok()
}

#[derive(Clone)]
struct WalkNode {
	handle:   AxHandle,
	props:    AxProps,
	children: Vec<Self>,
}

struct WalkState {
	visited:     u32,
	skipped:     u32,
	/// The skipped nodes the app destroyed before the walk read them, as
	/// Activity Monitor does with its rows while the walk is under way.
	vanished:    u32,
	/// Whether a node was read with [`AxProps::partial`] set.
	partial:     bool,
	max_nodes:   u32,
	max_depth:   u32,
	truncated:   bool,
	bounds:      WalkBounds,
	/// Whether the walk stops when the current operation is cancelled.
	cancellable: bool,
}

impl WalkState {
	const fn new(max_nodes: u32, max_depth: u32, bounds: WalkBounds) -> Self {
		Self {
			visited: 0,
			skipped: 0,
			vanished: 0,
			partial: false,
			max_nodes,
			max_depth,
			truncated: false,
			bounds,
			cancellable: false,
		}
	}

	/// Stops the walk between nodes once the current operation is cancelled.
	const fn cancellable(mut self) -> Self {
		self.cancellable = true;
		self
	}

	/// The walk of the window element `root`, when it read every element of
	/// the window that still exists, so it can vouch that an identity is unique
	/// there. An element the app destroyed under the walk hides none. A root
	/// without an identity of its own could be any window.
	fn whole(&self, root: &AxHandle) -> Option<WholeWalk> {
		if self.truncated || self.skipped != self.vanished || self.partial || !root.identified() {
			return None;
		}
		Some(WholeWalk {
			root:      root.clone(),
			max_nodes: self.max_nodes,
			max_depth: self.max_depth,
		})
	}
}

fn walk_raw(
	backend: &mut dyn AxBackend,
	handle: AxHandle,
	depth: u32,
	state: &mut WalkState,
) -> CoreResult<Option<WalkNode>> {
	if depth > state.max_depth || state.visited >= state.max_nodes {
		state.truncated = true;
		return Ok(None);
	}
	if state.cancellable {
		control::check()?;
	}
	state.visited += 1;
	let (props, child_handles) = match backend.walk_node(&handle, state.bounds) {
		Ok(node) => node,
		Err(error) if depth > 0 => {
			state.skipped = state.skipped.saturating_add(1);
			if error.code == ErrorCode::StaleRef {
				state.vanished = state.vanished.saturating_add(1);
			}
			return Ok(None);
		},
		Err(error) => return Err(error),
	};
	state.partial |= props.partial;
	let mut children = Vec::new();
	for child in child_handles {
		if let Some(child) = walk_raw(backend, child, depth + 1, state)? {
			children.push(child);
		}
		if state.truncated && state.visited >= state.max_nodes {
			break;
		}
	}
	Ok(Some(WalkNode { handle, props, children }))
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
	[props.title.as_deref(), props.description.as_deref()]
		.into_iter()
		.flatten()
		.map(str::trim)
		.find(|label| !label.is_empty())
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

fn escaped_truncated(value: &str, max: usize) -> String {
	let mut out: String = value.chars().take(max).collect();
	if value.chars().count() > max {
		out.push('…');
	}
	out.replace('\\', "\\\\")
		.replace('"', "\\\"")
		.replace('\n', " ")
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
	backend: &mut dyn AxBackend,
	registry: &mut AxRegistry,
	target: &str,
	generation: u64,
	identities: &ReadIdentities,
	text: &mut String,
	nodes: &mut u32,
) {
	let uniqueness = identities.of(&node.props);
	let reference =
		registry.register(backend, target, generation, node.handle, &node.props, uniqueness);
	if !text.is_empty() {
		text.push('\n');
	}
	text.push_str(&"  ".repeat(depth));
	// The root's own AXFocused only reflects app-local focus; report the global
	// roster flag instead.
	let (app, focused) = if depth == 0 {
		(Some(window.app.as_str()), window.focused)
	} else {
		(None, node.props.focused)
	};
	write_line(text, &node.props, &reference, app, focused);
	*nodes += 1;
	for child in node.children {
		format_tree(
			child,
			depth + 1,
			window,
			backend,
			registry,
			target,
			generation,
			identities,
			text,
			nodes,
		);
	}
}

/// One element's line as `ax()` prints it, without its indent.
fn write_line(
	text: &mut String,
	props: &AxProps,
	reference: &str,
	app: Option<&str>,
	focused: bool,
) {
	text.push_str("- ");
	text.push_str(&props.role);
	if let Some(label) = label(props) {
		let _ = write!(text, " \"{}\"", escaped_truncated(label, 80));
	}
	let _ = write!(text, " [ref={reference}]");
	if let Some(app) = app {
		let _ = write!(text, " app={app}");
	}
	if let Some(value) = props.value.as_deref().filter(|value| !value.is_empty()) {
		let _ = write!(text, ": \"{}\"", escaped_truncated(value, 80));
	}
	if !props.enabled {
		text.push_str(" (disabled)");
	}
	if focused {
		text.push_str(" (focused)");
	}
}

/// `handle`'s line as `ax()` prints it, registered under `target` so its ref
/// resolves.
pub fn element_line(
	backend: &mut dyn AxBackend,
	registry: &mut AxRegistry,
	target: &str,
	handle: AxHandle,
) -> CoreResult<String> {
	let props = backend.props(&handle)?;
	let generation = registry.current_generation(target);
	let reference =
		registry.register(backend, target, generation, handle, &props, Uniqueness::Unknown);
	let mut line = String::new();
	write_line(&mut line, &props, &reference, None, props.focused);
	Ok(line)
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
	let mut state = WalkState::new(
		options.max_nodes.unwrap_or(800).max(1),
		options.max_depth.unwrap_or(24),
		WalkBounds::Skip,
	);
	let tree = walk_raw(backend, root.clone(), 0, &mut state)?;
	let identities = ReadIdentities::new(&root, tree.as_ref(), &state);
	let root = tree.and_then(|node| filter_node(node, options.all.unwrap_or(false)));
	let mut text = String::new();
	let mut node_count = 0;
	if let Some(root) = root {
		format_tree(
			root,
			0,
			window,
			backend,
			registry,
			target,
			generation,
			&identities,
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
	let mut state = WalkState::new(5_000, 24, WalkBounds::Read);
	let Some(tree) = walk_raw(backend, root.clone(), 0, &mut state)? else {
		return Ok(Vec::new());
	};
	let identities = ReadIdentities::new(&root, Some(&tree), &state);
	let role = query.role.as_deref().map(str::to_lowercase);
	let title = query.title.as_deref().map(str::to_lowercase);
	let value = query.value.as_deref().map(str::to_lowercase);
	let limit = query.limit.unwrap_or(100).min(5_000) as usize;
	let mut result = Vec::new();
	let mut stack = vec![tree];
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
			let uniqueness = identities.of(&node.props);
			let reference =
				registry.register(backend, target, generation, node.handle, &node.props, uniqueness);
			result.push(node_to_napi(reference, node.props));
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
) -> CoreResult<AxNode> {
	let props = backend.props(&handle)?;
	let generation = registry.current_generation(target);
	let reference =
		registry.register(backend, target, generation, handle, &props, Uniqueness::Unknown);
	Ok(node_to_napi(reference, props))
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
	register_node(backend, registry, target, handle).map(Some)
}

/// What one tree walk can say about whether each identity is unique in its
/// window.
struct ReadIdentities {
	/// The identities more than one element of the walk shares.
	shared: HashSet<u64>,
	/// The walk, when it read the whole window.
	whole:  Option<WholeWalk>,
}

impl ReadIdentities {
	fn new(root: &AxHandle, tree: Option<&WalkNode>, state: &WalkState) -> Self {
		let mut seen = HashSet::new();
		let mut shared = HashSet::new();
		let mut stack: Vec<_> = tree.into_iter().collect();
		while let Some(node) = stack.pop() {
			stack.extend(&node.children);
			if let Some(identity) = node.props.identity
				&& !seen.insert(identity)
			{
				shared.insert(identity);
			}
		}
		Self { shared, whole: state.whole(root) }
	}

	/// A twin anywhere in the walk rules naming out, but only a walk of the
	/// whole window can rule it in.
	fn of(&self, props: &AxProps) -> Uniqueness<'_> {
		match (props.identity, &self.whole) {
			(Some(identity), _) if self.shared.contains(&identity) => Uniqueness::Shared,
			(Some(_), Some(walk)) => Uniqueness::Proven(walk),
			_ => Uniqueness::Unknown,
		}
	}
}

/// The one element of `window` with the identity `reference` was read with,
/// registered under the ref's target, for a `StaleRef` to name once the app
/// has destroyed the ref's element, as apps do when they rebuild a row or a
/// control in place. The ref itself keeps naming the destroyed element: equal
/// fields do not prove the match is the same control. `None` when the ref's
/// identity was not unique in a walk of the whole window, the window id now
/// names another window, this walk could not read the whole window, zero or
/// several elements match, or the registry cap evicted the match as it was
/// registered. The walk reads as far as the one that proved the identity did,
/// and at least as far as `find()` does; it stops with `Cancelled` once the
/// current operation is cancelled.
pub fn refind(
	backend: &mut dyn AxBackend,
	registry: &mut AxRegistry,
	window: &DesktopWindow,
	reference: &str,
) -> CoreResult<Option<String>> {
	let entry = registry.entry(reference)?;
	let (Some(proof), target) = (entry.proof.clone(), entry.target_key.clone()) else {
		return Ok(None);
	};
	// Finding a sheet's, popover's or menu's root walks the app's tree too.
	control::check()?;
	let root = backend.window_root(window)?;
	// The window id may now name another window, of this app or another.
	if root != proof.walk.root {
		return Ok(None);
	}
	let mut state = WalkState::new(
		proof.walk.max_nodes.max(5_000),
		proof.walk.max_depth.max(24),
		WalkBounds::Skip,
	)
	.cancellable();
	let tree = walk_raw(backend, root.clone(), 0, &mut state)?;
	// A copy in a part the walk could not read would make the match ambiguous.
	let Some(walk) = state.whole(&root) else {
		return Ok(None);
	};
	let mut matches = Vec::new();
	let mut stack: Vec<_> = tree.into_iter().collect();
	while let Some(node) = stack.pop() {
		stack.extend(node.children);
		if node.props.identity == Some(proof.identity) {
			matches.push((node.handle, node.props));
		}
	}
	let Ok([(handle, props)]) = <[_; 1]>::try_from(matches) else {
		return Ok(None);
	};
	let generation = registry.current_generation(&target);
	let found =
		registry.register(backend, &target, generation, handle, &props, Uniqueness::Proven(&walk));
	// At the registry cap, registering it can evict its own generation: name
	// no ref that already expired.
	Ok(registry.resolve(&found).is_ok().then_some(found))
}

/// An [`AxProps::identity`] hashed from `fields`, as a backend hashes its own.
#[cfg(test)]
pub(crate) fn test_identity(fields: impl Hash) -> u64 {
	let mut hasher = DefaultHasher::new();
	fields.hash(&mut hasher);
	hasher.finish()
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

	use super::*;

	#[derive(Default)]
	struct Mock {
		props:        HashMap<u64, AxProps>,
		children:     HashMap<u64, Vec<u64>>,
		/// Nodes read without an identity.
		unidentified: HashSet<u64>,
		/// Nodes whose earlier reads are gone, their identity taken over.
		gone:         HashSet<u64>,
		/// Nodes the app destroyed: every read of them is a stale ref.
		destroyed:    HashSet<u64>,
		/// Bounds read by tree walks.
		bounds_reads: u32,
		/// The window element, when not node 1.
		root:         Option<u64>,
		/// Window root lookups.
		root_reads:   u32,
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
			self.root_reads += 1;
			Ok(self.handle(self.root.unwrap_or(1)))
		}

		fn window_id(&mut self, _: &AxHandle, _: &[DesktopWindow]) -> CoreResult<String> {
			unreachable!("window ownership is not exercised by tree traversal tests")
		}

		fn props(&mut self, h: &AxHandle) -> CoreResult<AxProps> {
			let id = node(h);
			if self.destroyed.contains(&id) {
				return Err(DesktopError::stale_ref(format!("test node {id} was destroyed")));
			}
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
			identity:    Some(test_identity((role, title))),
			partial:     false,
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
			let button = p("button", None);
			r.register(&mut m, "x", generation, AxHandle::Test(g), &button, Uniqueness::Unknown);
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
	fn a_rebuilt_element_is_refound_only_by_a_walk_that_read_the_whole_window() {
		let mut m = Mock {
			props: [
				(1, p("window", Some("Title"))),
				(2, p("button", Some("Go"))),
				(3, p("button", Some("Stop"))),
				(4, p("button", Some("Go"))),
			]
			.into(),
			children: [(1, vec![2, 3])].into(),
			..Default::default()
		};
		let mut registry = AxRegistry::default();
		snapshot(&mut m, &mut registry, &window(), &AxSnapshotOptions::default()).unwrap();
		// Node 9 cannot be read, so it could be a second copy.
		m.children.insert(1, vec![4, 3, 9]);
		assert!(
			refind(&mut m, &mut registry, &window(), "e2")
				.unwrap()
				.is_none()
		);
		assert!(matches!(registry.resolve("e2").unwrap(), AxHandle::Test(2)));
		// Node 6's children cannot be read, so they could hold a second copy.
		let mut group = p("group", None);
		group.partial = true;
		m.props.insert(6, group);
		m.children.insert(1, vec![4, 3, 6]);
		assert!(
			refind(&mut m, &mut registry, &window(), "e2")
				.unwrap()
				.is_none()
		);
		// Node 8 was destroyed under the walk, so it hides no copy.
		m.destroyed.insert(8);
		m.children.insert(1, vec![4, 3, 8]);
		let found = refind(&mut m, &mut registry, &window(), "e2")
			.unwrap()
			.expect("the one copy");
		assert!(matches!(registry.resolve(&found).unwrap(), AxHandle::Test(4)));
		// It gets a ref of its own; `e2` keeps naming the destroyed element.
		assert_ne!(found, "e2");
		assert!(matches!(registry.resolve("e2").unwrap(), AxHandle::Test(2)));
		// The copy's later reads keep that ref.
		let reread =
			snapshot(&mut m, &mut registry, &window(), &AxSnapshotOptions::default()).unwrap();
		assert!(
			reread
				.text
				.contains(&format!("button \"Go\" [ref={found}]")),
			"{}",
			reread.text
		);
	}
	#[test]
	fn a_window_id_now_naming_another_window_is_not_searched() {
		let mut m = Mock {
			props: [
				(1, p("window", Some("Title"))),
				(2, p("button", Some("Go"))),
				(3, p("button", Some("Stop"))),
				(4, p("button", Some("Go"))),
				(9, p("window", Some("Title"))),
			]
			.into(),
			children: [(1, vec![2, 3]), (9, vec![4, 3])].into(),
			..Default::default()
		};
		let mut registry = AxRegistry::default();
		snapshot(&mut m, &mut registry, &window(), &AxSnapshotOptions::default()).unwrap();
		// The app closed the window and opened an identical one the system
		// gave the same id.
		m.root = Some(9);
		assert!(
			refind(&mut m, &mut registry, &window(), "e2")
				.unwrap()
				.is_none()
		);
		m.root = None;
		m.children.insert(1, vec![4, 3]);
		let found = refind(&mut m, &mut registry, &window(), "e2")
			.unwrap()
			.expect("the one copy");
		assert!(matches!(registry.resolve(&found).unwrap(), AxHandle::Test(4)));
	}
	#[test]
	fn a_cancelled_search_does_not_look_up_the_window() {
		let mut m = Mock {
			props: [
				(1, p("window", Some("Title"))),
				(2, p("button", Some("Go"))),
				(4, p("button", Some("Go"))),
			]
			.into(),
			children: [(1, vec![2])].into(),
			..Default::default()
		};
		let mut registry = AxRegistry::default();
		snapshot(&mut m, &mut registry, &window(), &AxSnapshotOptions::default()).unwrap();
		m.destroyed.insert(2);
		m.children.insert(1, vec![4]);
		let source = control::CancellationSource::default();
		let token = source.token();
		source.cancel();
		let reads = m.root_reads;
		let result =
			control::with_token_for_test(&token, || refind(&mut m, &mut registry, &window(), "e2"));
		assert_eq!(result.err().map(|error| error.code), Some(ErrorCode::Cancelled));
		assert_eq!(m.root_reads, reads);
	}
	/// A window with a "Go" button, node 100, 31 levels down: past the 24
	/// `find()` reads.
	fn deep_go() -> Mock {
		let mut m = Mock {
			props: [(1, p("window", Some("Title"))), (100, p("button", Some("Go")))].into(),
			..Default::default()
		};
		for group in 2..=31 {
			m.props.insert(group, p("group", None));
			m.children.insert(group - 1, vec![group]);
		}
		m.children.insert(31, vec![100]);
		m
	}
	/// The app destroys the deep button `old` and puts an identical `new` in
	/// its place.
	fn rebuild_deep(m: &mut Mock, old: u64, new: u64) {
		m.destroyed.insert(old);
		m.props.insert(new, p("button", Some("Go")));
		m.children.insert(31, vec![new]);
	}
	#[test]
	fn a_ref_from_a_read_deeper_than_find_reads_is_searched_as_deep() {
		let mut m = deep_go();
		let mut registry = AxRegistry::default();
		let options = AxSnapshotOptions { max_depth: Some(40), ..Default::default() };
		let read = snapshot(&mut m, &mut registry, &window(), &options).unwrap();
		assert!(!read.truncated && read.text.contains("\"Go\" [ref=e2]"), "{}", read.text);
		rebuild_deep(&mut m, 100, 101);
		let found = refind(&mut m, &mut registry, &window(), "e2")
			.unwrap()
			.expect("the one copy");
		assert!(matches!(registry.resolve(&found).unwrap(), AxHandle::Test(101)));
	}
	#[test]
	fn a_read_that_missed_part_of_the_window_cannot_make_a_ref_refindable() {
		let twins = || Mock {
			props: [
				(1, p("window", Some("Title"))),
				(2, p("button", Some("Go"))),
				(3, p("button", Some("Go"))),
			]
			.into(),
			children: [(1, vec![2, 3])].into(),
			..Default::default()
		};
		// The app destroys e2's button; the "Go" left is the one the read missed.
		let destroy = |m: &mut Mock, registry: &mut AxRegistry| {
			m.destroyed.insert(2);
			m.children.insert(1, vec![3]);
			m.props.insert(3, p("button", Some("Go")));
			refind(m, registry, &window(), "e2").unwrap()
		};

		// The node limit cut the read off before the second "Go".
		let mut m = twins();
		let mut registry = AxRegistry::default();
		let options = AxSnapshotOptions { max_nodes: Some(2), ..Default::default() };
		let read = snapshot(&mut m, &mut registry, &window(), &options).unwrap();
		assert!(read.truncated && read.text.contains("[ref=e2]"), "{}", read.text);
		assert!(destroy(&mut m, &mut registry).is_none());

		// The second "Go" could not be read.
		let mut m = twins();
		m.props.remove(&3);
		let mut registry = AxRegistry::default();
		snapshot(&mut m, &mut registry, &window(), &AxSnapshotOptions::default()).unwrap();
		assert!(destroy(&mut m, &mut registry).is_none());

		// The second "Go" sat under a group whose children could not be read,
		// and `find()` made the ref.
		let mut m = twins();
		let mut group = p("group", None);
		group.partial = true;
		m.props.insert(4, group);
		m.children.insert(1, vec![2, 4]);
		let mut registry = AxRegistry::default();
		let found = query(&mut m, &mut registry, &window(), &AxQuery {
			role: Some("button".into()),
			..Default::default()
		})
		.unwrap();
		assert_eq!(found[0].ref_, "e1");
		m.destroyed.insert(2);
		m.children.insert(1, vec![4]);
		m.props.insert(4, p("group", None));
		m.children.insert(4, vec![3]);
		assert!(
			refind(&mut m, &mut registry, &window(), "e1")
				.unwrap()
				.is_none()
		);
	}
	#[test]
	fn a_match_the_registry_cap_evicts_is_not_named() {
		// `find({limit: 5000})` on a window of exactly 5,000 elements fills the
		// registry with one generation.
		let mut m = Mock { props: [(1, p("window", Some("Title")))].into(), ..Default::default() };
		for id in 2..=5_000 {
			m.props.insert(id, p("button", Some(&format!("b{id}"))));
		}
		m.children.insert(1, (2..=5_000).collect());
		let mut registry = AxRegistry::default();
		let all = AxQuery { limit: Some(5_000), ..Default::default() };
		let found = query(&mut m, &mut registry, &window(), &all).unwrap();
		assert_eq!((found.len(), found[1].ref_.as_str()), (5_000, "e2"));
		// The app rebuilds node 2 as node 5001.
		m.destroyed.insert(2);
		m.props.insert(5_001, p("button", Some("b2")));
		m.children
			.insert(1, std::iter::once(5_001).chain(3..=5_000).collect());
		assert!(
			refind(&mut m, &mut registry, &window(), "e2")
				.unwrap()
				.is_none()
		);
	}
	#[test]
	fn refs_are_per_target() {
		let mut m = Mock::default();
		let mut r = AxRegistry::default();
		let go = p("button", Some("Go"));
		let desktop = r.current_generation("desktop");
		let mut register = |r: &mut AxRegistry, target: &str, generation: u64| {
			r.register(&mut m, target, generation, AxHandle::Test(5), &go, Uniqueness::Unknown)
		};
		assert_eq!(register(&mut r, "desktop", desktop), "e1");
		for _ in 0..2 {
			let generation = r.begin_snapshot("7");
			assert_eq!(register(&mut r, "7", generation), "e2");
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
			let button = p("button", None);
			r.register(&mut m, "x", g, AxHandle::Test(n), &button, Uniqueness::Unknown);
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
