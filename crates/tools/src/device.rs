//! Device catalog rendering and the `dyn` CLI transport support.

use std::{
	collections::BTreeMap,
	future::Future,
	pin::Pin,
	str,
	sync::{Arc, OnceLock, Weak},
};

use bytes::Bytes;
use omp_core::{Duration, Str};
use omp_tool::{
	DevicePath, ErasedStream, MountedDevice, Registry, ToolRoute, ToolsPolicy, WorkerSiteKind,
};
use serde::{Deserialize, Serialize};
use smallvec::SmallVec;

use crate::device_ctl::levenshtein;

/// Aggregate character budget for documentation inlined into a prompt.
pub const DOCS_TOTAL_BUDGET: usize = 48_000;
/// Per-device character cap for documentation inlined into a prompt.
pub const PER_DEVICE_DOCS_CAP: usize = 10_000;
/// UTF-8 byte cap for third-party catalog summaries.
pub const EXTERNAL_SUMMARY_CAP: usize = 200;

/// Stable model-facing guidance for the live dynamic-device transport.
pub const PROMPT_GUIDANCE: &str =
	"\
Dynamic devices are invoked through the `dyn` builtin inside the shell tool. Run `dyn` to list the \
	 live device catalog (`dyn --q <text>` searches it), `dyn <device> --help` for exact usage and \
	 schema, and `dyn <device> [args…]` to invoke one. Usage is derived from each device's schema: \
	 required string/number/enum properties are positionals in declaration order, every property \
	 has a `--flag` (`--no-flag` for booleans, repeated for arrays, dotted for nested keys), `dyn \
	 <device> --json '<payload>'` passes raw JSON arguments, and `@FILE` or `-` (stdin) supply \
	 either a JSON object or literal text for the next positional. Image results arrive as \
	 attachments. Retry an empty or narrow search with different terms; absent devices are \
	 unavailable and MUST NOT be advertised or guessed.";

/// Conditional model-facing guidance for the mounted `AutoQA` recorder.
pub const AUTO_QA_PROMPT_GUIDANCE: &str =
	"\
Automated QA reporting is available through the live `report_issue` device. When a tool or device \
	 result contradicts its documented behavior for the supplied parameters, run `dyn report_issue \
	 <session-id> <device> <rev> --verdict '<JSON verdict>'` in the shell, using the current exact \
	 session id and the reported call's canonical device revision. The verdict requires a one-line \
	 `summary`; it may include `expected`, `observed`, bounded `evidence`, and at most one \
	 structured `outcome` or `fault`. False positives are acceptable and should be reported rather \
	 than suppressed. Filing persists a redacted local-only record; external delivery requires a \
	 separate explicit user consent action.";

/// How much dynamic-device documentation is inlined into a prompt.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DocsMode {
	/// Render one bounded catalog line per device.
	#[default]
	Catalog,
	/// Inline full documentation for harness-owned devices only.
	Builtins,
	/// Inline full documentation for devices selected by the allowlist.
	Inline,
}

/// Stable search controls for the dynamic-device catalog.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct CatalogQuery {
	/// Case-insensitive text matched against path, summary, provenance, and
	/// tags.
	pub text:       Option<Str>,
	/// Tags every result must have.
	pub tags:       SmallVec<Str, 4>,
	/// Case-insensitive owner/provenance filter.
	pub provenance: Option<Str>,
	/// Number of matched rows to skip.
	pub offset:     usize,
	/// Maximum rows to return.
	pub limit:      Option<usize>,
	/// Maximum path depth relative to the searched subtree.
	pub depth:      Option<usize>,
}

/// A deterministic `tool_only` flattening collision.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FlattenCollision {
	/// Existing owner of the flattened slot.
	pub existing_owner:    Str,
	/// Owner whose path conflicts with the existing slot.
	pub conflicting_owner: Str,
	/// Model-facing flattened slot spelling.
	pub slot:              Str,
}

/// Flattens device paths for `tool_only`, rejecting collisions fail-closed.
pub fn flatten_slots(
	paths: impl IntoIterator<Item = (Str, Str)>,
) -> Result<BTreeMap<Str, Str>, FlattenCollision> {
	let mut slots = BTreeMap::new();
	for (path, owner) in paths {
		let slot = Str::new(path.as_str().replace('/', "_"));
		if let Some(existing_owner) = slots.insert(slot.clone(), owner.clone()) {
			return Err(FlattenCollision { existing_owner, conflicting_owner: owner, slot });
		}
	}
	Ok(slots)
}

/// Whether the `dyn` builtin is present under `policy`.
pub const fn dyn_enabled(policy: ToolsPolicy) -> bool {
	!matches!(policy, ToolsPolicy::ToolOnly)
}

/// Late-bound immutable registry access for the envd-owned `dyn` host.
///
/// The registry is frozen in an [`Arc`] and installed exactly once. The catalog
/// retains only a weak reference, so registry assembly creates no ownership
/// cycle.
#[derive(Clone, Default)]
pub struct DeviceCatalog(Arc<OnceLock<Weak<Registry>>>);

impl DeviceCatalog {
	/// Installs the completed immutable registry once.
	pub fn install_registry(&self, registry: Arc<Registry>) -> Result<(), Weak<Registry>> {
		self.0.set(Arc::downgrade(&registry))
	}

	/// Upgrades the installed registry while its owning environment is live.
	pub fn registry(&self) -> Option<Arc<Registry>> {
		self.0.get()?.upgrade()
	}
}

/// Fully resolved final device invocation handed to the environment route.
pub struct DeviceInvokeRequest {
	/// Address used by the model.
	pub path:          DevicePath,
	/// Resolved device name.
	pub name:          Str,
	/// Resolved revision.
	pub rev:           Str,
	/// Owning extension when worker-routed.
	pub owner:         Option<Str>,
	/// Placed worker site when worker-routed.
	pub site:          Option<WorkerSiteKind>,
	/// Placed worker name when worker-routed.
	pub worker:        Option<Str>,
	/// Environment invocation identity.
	pub invocation_id: Str,
	/// Execution deadline.
	pub deadline:      Duration,
	/// Final nested device arguments.
	pub args_json:     Bytes,
}

/// Environment-owned dispatch bridge for a resolved device route.
///
/// Both native and worker routes yield the registry's existing erased stream;
/// the router only supplies final nested arguments and never observes
/// speculative fragments.
pub trait DeviceInvoker: Send + Sync {
	/// Dispatches one resolved device with its final, nested JSON bytes.
	fn invoke(
		&self,
		request: DeviceInvokeRequest,
	) -> impl Future<Output = ErasedStream<'static>> + Send;
}
/// Object-safe device-invoker handle for host components that cannot be
/// generic.
pub trait ErasedDeviceInvoker: Send + Sync {
	/// Dispatches one resolved worker-routed device.
	fn invoke(
		&self,
		request: DeviceInvokeRequest,
	) -> Pin<Box<dyn Future<Output = ErasedStream<'static>> + Send + 'static>>;
}

impl<I: DeviceInvoker + Clone + 'static> ErasedDeviceInvoker for I {
	fn invoke(
		&self,
		request: DeviceInvokeRequest,
	) -> Pin<Box<dyn Future<Output = ErasedStream<'static>> + Send + 'static>> {
		let invoker = self.clone();
		Box::pin(async move { DeviceInvoker::invoke(&invoker, request).await })
	}
}

/// Renders the deterministic live catalog used for discovery.
pub fn render_catalog<'a>(devices: impl Iterator<Item = MountedDevice<'a>>) -> Str {
	render_catalog_query(devices, &CatalogQuery::default(), None)
}

/// Searches and paginates mounted devices with deterministic relevance.
///
/// Text search prefers exact leaves, then path prefixes, path containment,
/// summaries, provenance, and finally tags. Without text, registry order is
/// preserved. `tags` are conjunctive and `provenance` matches the authenticated
/// owner identity.
pub fn render_catalog_query<'a>(
	devices: impl Iterator<Item = MountedDevice<'a>>,
	query: &CatalogQuery,
	subtree: Option<&str>,
) -> Str {
	let mut matched = BTreeMap::<(u8, Str), MountedDevice<'a>>::new();
	for device in devices {
		if !catalog_matches(&device, query, subtree) {
			continue;
		}
		let score = query
			.text
			.as_deref()
			.map_or(0, |text| catalog_score(&device, text));
		if score == u8::MAX {
			continue;
		}
		matched.insert((score, device.name.clone()), device);
	}
	let total = matched.len();
	let offset = query.offset.min(total);
	let take = query.limit.unwrap_or(usize::MAX);
	let mut rendered = String::new();
	for (_, device) in matched.into_iter().skip(offset).take(take) {
		append_catalog_row(&mut rendered, &device);
	}
	let shown = total.saturating_sub(offset).min(take);
	if offset.saturating_add(shown) < total {
		rendered.push_str("More: offset=");
		rendered.push_str(&offset.saturating_add(shown).to_string());
		rendered.push_str(" (");
		rendered.push_str(&total.to_string());
		rendered.push_str(" total)\n");
	}
	Str::new(rendered)
}

/// Renders prompt documentation under the selected inlining mode and budgets.
///
/// `allowlist` accepts `*` and `?` globs over canonical device names. Full
/// blocks that exceed the per-device cap, or the remaining aggregate budget,
/// fall back to their catalog line rather than being cut mid-schema.
pub fn render_prompt_docs<'a>(
	devices: impl Iterator<Item = MountedDevice<'a>>,
	mode: DocsMode,
	allowlist: &[Str],
) -> Str {
	let mut rendered = String::new();
	let mut used_chars: usize = 0;
	for device in devices {
		let inline = match mode {
			DocsMode::Catalog => false,
			DocsMode::Builtins => is_builtin(&device),
			DocsMode::Inline => allowlist
				.iter()
				.any(|pattern| glob_matches(pattern.as_str(), device.name.as_str())),
		};
		let block = inline.then(|| render_device_docs(&device, device.name.as_str()));
		let block = block
			.filter(|block| block.chars().count() <= PER_DEVICE_DOCS_CAP)
			.unwrap_or_else(|| {
				let mut line = String::new();
				append_catalog_row(&mut line, &device);
				line
			});
		let block_chars = block.chars().count();
		if used_chars.saturating_add(block_chars) > DOCS_TOTAL_BUDGET {
			break;
		}
		used_chars += block_chars;
		rendered.push_str(&block);
	}
	Str::new(rendered)
}

/// Renders a bounded nearest-match fragment from deterministic catalog rows.
pub fn render_near_miss<'a>(path: &str, devices: impl Iterator<Item = MountedDevice<'a>>) -> Str {
	let needle = path.rsplit('/').next().unwrap_or(path);
	let mut scored = BTreeMap::<(u8, Str), MountedDevice<'a>>::new();
	for device in devices {
		let leaf = device
			.name
			.as_str()
			.rsplit('/')
			.next()
			.unwrap_or(device.name.as_str());
		let distance = levenshtein(needle, leaf).min(u8::MAX as usize) as u8;
		scored.insert((distance, device.name.clone()), device);
	}
	let mut rendered = String::from("Nearest:\n");
	for (_, device) in scored.into_iter().take(5) {
		rendered.push_str("  ");
		append_catalog_row(&mut rendered, &device);
	}
	Str::new(rendered)
}

fn append_catalog_row(rendered: &mut String, device: &MountedDevice<'_>) {
	rendered.push_str(device.name);
	rendered.push_str(" — ");
	rendered.push_str(&catalog_summary(device));
	let mut first_tag = true;
	for tag in DEVICE_TAGS {
		if has_tag(device, tag) {
			if first_tag {
				rendered.push_str(" [");
				first_tag = false;
			} else {
				rendered.push(',');
			}
			rendered.push_str(tag);
		}
	}
	if !first_tag {
		rendered.push(']');
	}
	rendered.push_str(" @ ");
	rendered.push_str(device.claimant);
	rendered.push('\n');
}

/// Renders one mounted device's documentation and exact parameter schema.
pub fn render_device_docs(device: &MountedDevice<'_>, path: &str) -> String {
	let mut output = String::new();
	output.push_str(path);
	output.push_str(" @ ");
	output.push_str(device.claimant);
	output.push_str(" — ");
	output.push_str(&catalog_summary(device));
	if let Some(docs) = device.docs.filter(|docs| !docs.trim().is_empty()) {
		output.push_str("\n\n");
		output.push_str(docs);
	}
	output.push_str("\n\nEffects:");
	let mut any = false;
	for tag in DEVICE_TAGS {
		if has_tag(device, tag) {
			output.push(' ');
			output.push_str(tag);
			any = true;
		}
	}
	if !any {
		output.push_str(" none");
	}
	output.push_str("\nProvenance: ");
	output.push_str(device.claimant);
	output.push_str("\nRevision: ");
	output.push_str(&device.rev.to_string());
	output.push_str("\n\nSchema:\n");
	output.push_str(str::from_utf8(device.schema).unwrap_or("{}"));
	output.push('\n');
	output
}

const DEVICE_TAGS: &[&str] = &[
	"control",
	"effectful",
	"read",
	"write",
	"exec",
	"net",
	"inference",
	"subagent",
	"builtin",
	"external",
	"native",
	"remote",
	"worker",
];

fn has_tag(device: &MountedDevice<'_>, tag: &str) -> bool {
	match tag {
		"control" => device.effects.is_empty(),
		"effectful" => !device.effects.is_empty(),
		"read" => device
			.effects
			.documents
			.as_ref()
			.is_some_and(|effects| effects.read),
		"write" => device
			.effects
			.documents
			.as_ref()
			.is_some_and(|effects| !effects.write_globs.is_empty()),
		"exec" => device
			.effects
			.exec
			.as_ref()
			.is_some_and(|effects| !effects.commands.is_empty()),
		"net" => device
			.effects
			.exec
			.as_ref()
			.is_some_and(|effects| effects.network),
		"inference" => device
			.effects
			.inference
			.as_ref()
			.is_some_and(|effects| !effects.is_empty()),
		"subagent" => device.effects.subagents != 0,
		"builtin" => is_builtin(device),
		"external" => matches!(device.route, ToolRoute::Remote) || !is_builtin(device),
		"native" => matches!(device.route, ToolRoute::Native),
		"remote" => matches!(device.route, ToolRoute::Remote),
		"worker" => matches!(device.route, ToolRoute::Worker { .. }),
		_ => false,
	}
}

fn is_builtin(device: &MountedDevice<'_>) -> bool {
	device.claimant.as_str() == "omp/core"
}

fn catalog_summary(device: &MountedDevice<'_>) -> String {
	let mut summary = String::with_capacity(device.summary.len().min(EXTERNAL_SUMMARY_CAP));
	let mut spacing = false;
	for character in device.summary.chars() {
		if character.is_control() || character.is_whitespace() {
			spacing = !summary.is_empty();
			continue;
		}
		if spacing {
			summary.push(' ');
			spacing = false;
		}
		summary.push(character);
	}
	if is_builtin(device) || summary.len() <= EXTERNAL_SUMMARY_CAP {
		return summary;
	}
	let mut end = EXTERNAL_SUMMARY_CAP.saturating_sub(3).min(summary.len());
	while !summary.is_char_boundary(end) {
		end -= 1;
	}
	summary.truncate(end);
	summary.push_str("...");
	summary
}

fn catalog_matches(
	device: &MountedDevice<'_>,
	query: &CatalogQuery,
	subtree: Option<&str>,
) -> bool {
	if let Some(subtree) = subtree {
		if device.name.as_str() != subtree
			&& !device
				.name
				.as_str()
				.strip_prefix(subtree)
				.is_some_and(|tail| tail.starts_with('/'))
		{
			return false;
		}
		if let Some(depth) = query.depth {
			let relative = device
				.name
				.as_str()
				.strip_prefix(subtree)
				.unwrap_or(device.name.as_str())
				.trim_start_matches('/');
			if !relative.is_empty() && relative.split('/').count() > depth {
				return false;
			}
		}
	} else if let Some(depth) = query.depth
		&& device.name.as_str().split('/').count() > depth
	{
		return false;
	}
	if query
		.tags
		.iter()
		.any(|tag| !has_tag(device, tag.to_ascii_lowercase().as_str()))
	{
		return false;
	}
	if let Some(provenance) = query.provenance.as_deref()
		&& !device
			.claimant
			.to_ascii_lowercase()
			.contains(&provenance.to_ascii_lowercase())
	{
		return false;
	}
	true
}

fn catalog_score(device: &MountedDevice<'_>, text: &str) -> u8 {
	let needle = text.trim().to_ascii_lowercase();
	if needle.is_empty() {
		return 0;
	}
	let name = device.name.to_ascii_lowercase();
	let leaf = name.rsplit('/').next().unwrap_or(&name);
	if leaf == needle || name == needle {
		0
	} else if leaf.starts_with(&needle) || name.starts_with(&needle) {
		1
	} else if name.contains(&needle) {
		2
	} else if device.summary.to_ascii_lowercase().contains(&needle) {
		3
	} else if device.claimant.to_ascii_lowercase().contains(&needle) {
		4
	} else if DEVICE_TAGS
		.iter()
		.any(|tag| has_tag(device, tag) && tag.contains(&needle))
	{
		5
	} else {
		u8::MAX
	}
}

const fn glob_matches(pattern: &str, value: &str) -> bool {
	let pattern = pattern.as_bytes();
	let value = value.as_bytes();
	let (mut pattern_at, mut value_at, mut star, mut retry) = (0, 0, None, 0);
	while value_at < value.len() {
		if pattern_at < pattern.len()
			&& (pattern[pattern_at] == b'?' || pattern[pattern_at] == value[value_at])
		{
			pattern_at += 1;
			value_at += 1;
		} else if pattern_at < pattern.len() && pattern[pattern_at] == b'*' {
			star = Some(pattern_at);
			pattern_at += 1;
			retry = value_at;
		} else if let Some(star_at) = star {
			pattern_at = star_at + 1;
			retry += 1;
			value_at = retry;
		} else {
			return false;
		}
	}
	while pattern_at < pattern.len() && pattern[pattern_at] == b'*' {
		pattern_at += 1;
	}
	pattern_at == pattern.len()
}

#[cfg(test)]
mod tests {
	use omp_core::{Str, sf};
	use omp_tool::{Effects, MountedDevice, Precedence, Rev, ToolRoute, ToolsPolicy};

	use super::{
		AUTO_QA_PROMPT_GUIDANCE, CatalogQuery, DOCS_TOTAL_BUDGET, DocsMode, EXTERNAL_SUMMARY_CAP,
		PER_DEVICE_DOCS_CAP, PROMPT_GUIDANCE, dyn_enabled, flatten_slots, render_catalog,
		render_catalog_query, render_near_miss, render_prompt_docs,
	};

	fn mounted<'a>(
		name: &'a Str,
		claimant: &'a Str,
		summary: &'a Str,
		docs: Option<&'a str>,
		rev: &'a Rev,
		effects: &'a Effects,
		route: &'a ToolRoute,
	) -> MountedDevice<'a> {
		MountedDevice {
			name,
			rev,
			claimant,
			precedence: Precedence::DEFAULT,
			summary,
			schema: br#"{"type":"object"}"#,
			effects,
			docs,
			route,
			metadata: None,
		}
	}

	#[test]
	fn prompt_guidance_names_dyn_help_without_inventing_urls() {
		assert!(PROMPT_GUIDANCE.contains("`dyn`"));
		assert!(PROMPT_GUIDANCE.contains("--help"));
		assert!(PROMPT_GUIDANCE.contains("positionals"));
		assert!(AUTO_QA_PROMPT_GUIDANCE.contains("report_issue"));
		// The AutoQA command is schema-shaped: report_issue@1 requires
		// `session_id`, `device`, `rev` (positionals, in that order) and the
		// `verdict` object, which is never positional.
		assert!(
			AUTO_QA_PROMPT_GUIDANCE
				.contains("`dyn report_issue <session-id> <device> <rev> --verdict '<JSON verdict>'`")
		);
		assert!(!AUTO_QA_PROMPT_GUIDANCE.contains("--rev"));
		assert!(AUTO_QA_PROMPT_GUIDANCE.contains("False positives are acceptable"));
		assert!(AUTO_QA_PROMPT_GUIDANCE.contains("external delivery requires"));
		for guidance in [PROMPT_GUIDANCE, AUTO_QA_PROMPT_GUIDANCE] {
			assert!(!guidance.contains("dyn://"));
			assert!(!guidance.contains("dyn:"));
		}
	}

	#[test]
	fn catalog_search_ranks_filters_and_paginates() {
		let first_name = sf!("lint");
		let second_name = sf!("format");
		let first_claimant = sf!("acme/lint");
		let second_claimant = sf!("other/format");
		let first_summary = sf!("Pending proposal: resolve or reject the lint rewrite.");
		let second_summary = sf!("Format files and lint imports.");
		let rev = Rev { family: Str::default(), n: 1 };
		let effects = Effects::default();
		let route = ToolRoute::Native;
		let devices = [
			mounted(&first_name, &first_claimant, &first_summary, None, &rev, &effects, &route),
			mounted(&second_name, &second_claimant, &second_summary, None, &rev, &effects, &route),
		];
		let first_page = render_catalog_query(
			devices.into_iter(),
			&CatalogQuery {
				text:       Some("lint".into()),
				tags:       smallvec::smallvec!["external".into()],
				provenance: None,
				offset:     0,
				limit:      Some(1),
				depth:      None,
			},
			None,
		);
		assert!(first_page.starts_with("lint — Pending proposal:"));
		assert!(first_page.contains("More: offset=1 (2 total)"));
		let filtered = render_catalog_query(
			devices.into_iter(),
			&CatalogQuery { provenance: Some("other".into()), ..CatalogQuery::default() },
			None,
		);
		assert!(!filtered.contains("acme/lint"));
		assert!(filtered.contains("other/format"));
	}

	#[test]
	fn docs_modes_honor_allowlist_and_external_summary_budget() {
		let builtin_name = sf!("builtin");
		let external_name = sf!("external");
		let builtin_claimant = sf!("omp/core");
		let external_claimant = sf!("acme/tools");
		let builtin_summary = sf!("Built-in summary.");
		let external_summary = sf!("{}\nignored", "é".repeat(150));
		let rev = Rev { family: Str::default(), n: 1 };
		let effects = Effects::default();
		let route = ToolRoute::Native;
		let builtin = mounted(
			&builtin_name,
			&builtin_claimant,
			&builtin_summary,
			Some("BUILTIN FULL DOCS"),
			&rev,
			&effects,
			&route,
		);
		let external = mounted(
			&external_name,
			&external_claimant,
			&external_summary,
			Some("EXTERNAL FULL DOCS"),
			&rev,
			&effects,
			&route,
		);
		let builtins = render_prompt_docs([builtin, external].into_iter(), DocsMode::Builtins, &[]);
		assert!(builtins.contains("BUILTIN FULL DOCS"));
		assert!(!builtins.contains("EXTERNAL FULL DOCS"));
		let inline =
			render_prompt_docs([builtin, external].into_iter(), DocsMode::Inline, &["ext*".into()]);
		assert!(!inline.contains("BUILTIN FULL DOCS"));
		assert!(inline.contains("EXTERNAL FULL DOCS"));
		let oversized_docs = "x".repeat(PER_DEVICE_DOCS_CAP + 1);
		let oversized = mounted(
			&external_name,
			&external_claimant,
			&external_summary,
			Some(&oversized_docs),
			&rev,
			&effects,
			&route,
		);
		let bounded = render_prompt_docs([oversized].into_iter(), DocsMode::Inline, &["*".into()]);
		assert!(!bounded.contains(&"x".repeat(PER_DEVICE_DOCS_CAP)));
		assert!(bounded.chars().count() <= DOCS_TOTAL_BUDGET);
		let catalog = render_catalog([external].into_iter());
		let summary = catalog
			.split_once(" — ")
			.expect("catalog separator")
			.1
			.split_once(" [")
			.expect("tag separator")
			.0;
		assert!(summary.len() <= EXTERNAL_SUMMARY_CAP);
		assert!(!summary.contains('\n'));
		assert!(summary.ends_with("..."));
	}

	#[test]
	fn near_miss_prefers_the_closest_leaf() {
		let close_name = sf!("house_lint");
		let far_name = sf!("jira");
		let claimant = sf!("acme/tools");
		let summary = sf!("Fixture.");
		let rev = Rev { family: Str::default(), n: 1 };
		let effects = Effects::default();
		let route = ToolRoute::Native;
		let rendered = render_near_miss(
			"hose_lint",
			[
				mounted(&far_name, &claimant, &summary, None, &rev, &effects, &route),
				mounted(&close_name, &claimant, &summary, None, &rev, &effects, &route),
			]
			.into_iter(),
		);
		assert!(
			rendered
				.lines()
				.nth(1)
				.is_some_and(|line| line.contains("house_lint"))
		);
	}

	#[test]
	fn tool_only_flattening_refuses_collisions_and_dyn() {
		let collision = flatten_slots([
			("jira/create".into(), "acme/jira".into()),
			("jira_create".into(), "other/tools".into()),
		])
		.expect_err("flattening must reject ambiguous slots");
		assert_eq!(collision.slot, "jira_create");
		assert_eq!(collision.existing_owner, "acme/jira");
		assert_eq!(collision.conflicting_owner, "other/tools");
		assert!(dyn_enabled(ToolsPolicy::Auto));
		assert!(!dyn_enabled(ToolsPolicy::ToolOnly));
	}
}
