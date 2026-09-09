//! Immutable catalog contribution layers and provider declaration activation.
//!
//! Contributions are assembled off the request path.  A published
//! [`OverlayStack`] is immutable, so consumers can rebuild a registry for its
//! generation and keep executing requests that captured an older generation.

use std::{
	collections::{BTreeMap, BTreeSet},
	fmt::{self, Display},
	mem::size_of,
	sync::Arc,
};

use arc_swap::ArcSwap;
use omp_core::Str;
use serde::{Deserialize, Serialize};

use crate::{
	AuthSpec, CatalogOverlay, ModelOverlay, ModelSpec, OAuthSpec, ProvenanceSource, ProviderDef,
	ProviderId, RouteDef, RouteOverlay, ScopedAlias,
};

/// The owner of one replaceable catalog overlay layer.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind", content = "id")]
pub enum OverlaySource {
	/// Facts compiled into the checked-in catalog.
	Bundled,
	/// Explicit user configuration.
	UserConfig,
	/// Restart-recovered discovery disk cache.
	DiskCache,
	/// Runtime model discovery.
	Discovery,
	/// One extension's catalog declaration.
	Extension {
		/// Stable extension identity.
		id: Str,
	},
}

/// Immutable, generation-stamped catalog overlays in increasing precedence.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OverlayStack {
	overlays:   Arc<[CatalogOverlay]>,
	sources:    Arc<[OverlaySource]>,
	generation: u64,
}

impl Default for OverlayStack {
	fn default() -> Self {
		Self::empty()
	}
}

impl OverlayStack {
	/// Creates an empty stack at generation zero.
	pub fn empty() -> Self {
		Self { overlays: Arc::from([]), sources: Arc::from([]), generation: 0 }
	}

	/// Creates a stack from layers already ordered from lowest to highest
	/// precedence. Repeated source identities are collapsed to their final
	/// supplied layer; use [`Self::with_replaced`] to advance a published
	/// generation.
	pub fn from_layers(layers: impl IntoIterator<Item = (OverlaySource, CatalogOverlay)>) -> Self {
		let mut sources = Vec::new();
		let mut overlays = Vec::new();
		for (source, overlay) in layers {
			if let Some(index) = sources.iter().position(|candidate| candidate == &source) {
				overlays[index] = overlay;
			} else {
				sources.push(source);
				overlays.push(overlay);
			}
		}
		let generation = u64::try_from(overlays.len()).unwrap_or(u64::MAX);
		Self { overlays: overlays.into(), sources: sources.into(), generation }
	}

	/// Returns the monotonically increasing publication generation.
	pub const fn generation(&self) -> u64 {
		self.generation
	}

	/// Returns overlays in increasing precedence order.
	pub fn overlays(&self) -> &[CatalogOverlay] {
		&self.overlays
	}

	/// Returns source identities in the same order as [`Self::overlays`].
	pub fn sources(&self) -> &[OverlaySource] {
		&self.sources
	}

	/// Publishes `overlay` for `source`, replacing that source's prior layer and
	/// advancing the generation exactly once.
	pub fn with_replaced(&self, source: OverlaySource, overlay: CatalogOverlay) -> Self {
		let mut sources = self.sources.to_vec();
		let mut overlays = self.overlays.to_vec();
		if let Some(index) = sources.iter().position(|candidate| candidate == &source) {
			overlays[index] = overlay;
		} else {
			sources.push(source);
			overlays.push(overlay);
		}
		Self {
			overlays:   overlays.into(),
			sources:    sources.into(),
			generation: self.generation.saturating_add(1),
		}
	}
}

/// Lock-free publication point for immutable overlay generations.
///
/// Writers construct a complete replacement off-path and atomically exchange
/// it; readers retain their loaded [`Arc`] for the whole resolution, so an
/// in-flight request can never observe a mixed generation.
#[derive(Debug)]
pub struct OverlayStore {
	current: ArcSwap<OverlayStack>,
}

impl Default for OverlayStore {
	fn default() -> Self {
		Self::new(OverlayStack::empty())
	}
}

impl OverlayStore {
	/// Creates a store with one published immutable stack.
	pub fn new(initial: OverlayStack) -> Self {
		Self { current: ArcSwap::from_pointee(initial) }
	}

	/// Loads one stable generation without locking.
	pub fn load(&self) -> Arc<OverlayStack> {
		self.current.load_full()
	}

	/// Atomically replaces the complete stack.
	pub fn publish(&self, next: OverlayStack) {
		self.current.store(Arc::new(next));
	}

	/// Replaces one source layer from the latest published generation.
	///
	/// Concurrent writers are retried against the generation they displaced, so
	/// no independently published layer is lost.
	pub fn replace(&self, source: OverlaySource, overlay: CatalogOverlay) -> Arc<OverlayStack> {
		loop {
			let current = self.current.load_full();
			let next = Arc::new(current.with_replaced(source.clone(), overlay.clone()));
			let previous = self.current.compare_and_swap(&current, next.clone());
			if Arc::ptr_eq(&*previous, &current) {
				return next;
			}
		}
	}
}
/// Public construction path for one immutable [`CatalogOverlay`].
#[derive(Clone, Debug)]
pub struct CatalogOverlayBuilder {
	source:     ProvenanceSource,
	auth_specs: Vec<AuthSpec>,
	providers:  Vec<ProviderDef>,
	models:     Vec<ModelOverlay>,
	routes:     Vec<RouteOverlay>,
	aliases:    Vec<ScopedAlias>,
}

impl CatalogOverlayBuilder {
	/// Starts an overlay with one auditable source applied to every changed
	/// field during resolution.
	pub const fn new(source: ProvenanceSource) -> Self {
		Self {
			source,
			auth_specs: Vec::new(),
			providers: Vec::new(),
			models: Vec::new(),
			routes: Vec::new(),
			aliases: Vec::new(),
		}
	}

	/// Adds one complete provider definition.
	pub fn with_provider(mut self, provider: ProviderDef) -> Self {
		self.providers.push(provider);
		self
	}

	/// Adds one interned authentication-specification addition.
	pub fn with_auth_spec(mut self, spec: AuthSpec) -> Self {
		self.auth_specs.push(spec);
		self
	}

	/// Adds one model addition or field-granular patch.
	pub fn with_model(mut self, overlay: ModelOverlay) -> Self {
		self.models.push(overlay);
		self
	}

	/// Adds one route addition or field-granular patch.
	pub fn with_route(mut self, overlay: RouteOverlay) -> Self {
		self.routes.push(overlay);
		self
	}

	/// Adds one provider-scoped exact alias.
	pub fn with_alias(mut self, alias: ScopedAlias) -> Self {
		self.aliases.push(alias);
		self
	}

	/// Adds provider-scoped aliases in their declared order.
	pub fn with_aliases(mut self, aliases: impl IntoIterator<Item = ScopedAlias>) -> Self {
		self.aliases.extend(aliases);
		self
	}

	/// Freezes the accumulated layer for publication in an [`OverlayStack`].
	pub fn build(self) -> CatalogOverlay {
		CatalogOverlay {
			source:     self.source,
			auth_specs: self.auth_specs.into_boxed_slice(),
			providers:  self.providers.into_boxed_slice(),
			models:     self.models.into_boxed_slice(),
			routes:     self.routes.into_boxed_slice(),
			aliases:    self.aliases.into_boxed_slice(),
		}
	}
}

/// Stable identity named in provider conflict and replacement evidence.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
pub struct ProviderDeclarationId(Arc<ProviderDeclarationIdentity>);

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
struct ProviderDeclarationIdentity {
	publisher:      Str,
	extension_id:   Str,
	declaration_id: Str,
}

impl ProviderDeclarationId {
	/// Creates a stable identity for one admitted extension declaration.
	pub fn new(publisher: Str, extension_id: Str, declaration_id: Str) -> Self {
		Self(Arc::new(ProviderDeclarationIdentity { publisher, extension_id, declaration_id }))
	}

	/// Returns the publisher identity from the admitted extension manifest.
	pub fn publisher(&self) -> &Str {
		&self.0.publisher
	}

	/// Returns the extension identifier under [`Self::publisher`].
	pub fn extension_id(&self) -> &Str {
		&self.0.extension_id
	}

	/// Returns the declaration identifier within the extension.
	pub fn declaration_id(&self) -> &Str {
		&self.0.declaration_id
	}
}

impl Display for ProviderDeclarationId {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(formatter, "{}/{}/{}", self.publisher(), self.extension_id(), self.declaration_id())
	}
}

/// Publisher-qualified extension identity accepted by `replaces=`.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
pub struct ProviderPublisher {
	/// Publisher identity from the admitted extension manifest.
	pub publisher:    Str,
	/// Extension identifier under `publisher`.
	pub extension_id: Str,
}

impl ProviderPublisher {
	fn matches(&self, declaration: &ProviderDeclarationId) -> bool {
		self.publisher == *declaration.publisher() && self.extension_id == *declaration.extension_id()
	}
}

/// Complete non-secret records contributed by an admitted runtime provider.
///
/// Rebuilds an immutable catalog generation; no extension callback enters the
/// inference request path.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct RuntimeProviderRecords {
	/// Provider/account management definition.
	pub provider:    ProviderDef,
	/// Dynamically registered authentication specifications.
	pub auth_specs:  Box<[AuthSpec]>,
	/// Dynamically registered public OAuth flow specifications.
	pub oauth_specs: Box<[OAuthSpec]>,
	/// Concrete provider routes.
	pub routes:      Box<[RouteDef]>,
	/// Models made selectable through those routes.
	pub models:      Box<[ModelSpec]>,
}
/// One admitted `@omp.provider` declaration lowered into a catalog overlay.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderDeclaration {
	/// Identity retained in activation evidence, including for losing entries.
	pub id:        ProviderDeclarationId,
	/// Provider namespace contributed by this declaration.
	pub provider:  ProviderId,
	/// Field-granular model and route contribution.
	pub overlay:   CatalogOverlay,
	/// Larger values win among unrelated declarations.
	pub priority:  i32,
	/// Named base provider whose active declaration this overlay extends.
	pub extends:   Option<ProviderId>,
	/// Publisher-qualified declaration fully replaced by this declaration.
	pub replaces:  Option<ProviderPublisher>,
	/// Whether admission and policy allow this declaration to participate.
	pub available: bool,
	/// Complete records used to rebuild the immutable runtime catalog. Required
	/// on a new root provider; extensions may omit it and contribute overlays.
	pub runtime:   Option<RuntimeProviderRecords>,
}

/// Activation failure for a provider declaration set.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum ProviderActivationError {
	/// Two unrelated declarations had the same winning priority.
	#[error("provider {provider} has equal-priority declarations {first} and {second}")]
	EqualPriority {
		/// Contested provider namespace.
		provider: ProviderId,
		/// One conflicting declaration.
		first:    ProviderDeclarationId,
		/// The other conflicting declaration.
		second:   ProviderDeclarationId,
	},
	/// An extension declaration named a provider base that is unavailable.
	#[error("provider declaration {declaration} extends unavailable base {base}")]
	MissingBase {
		/// Declaration that requested the base.
		declaration: ProviderDeclarationId,
		/// Provider base required by `extends=`.
		base:        ProviderId,
	},
}

const _: () = assert!(
	size_of::<ProviderActivationError>() <= 64,
	"ProviderActivationError must remain compact"
);

/// Active provider layers plus every declaration retained as evidence.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ActivatedProvider {
	/// Provider namespace selected for activation.
	pub provider: ProviderId,
	/// Only active declaration layers, ordered for field-granular merging.
	pub overlays: OverlayStack,
	/// All declarations considered, including losing and replaced declarations.
	pub evidence: Arc<[ProviderDeclarationId]>,
	/// Complete records selected from the active root declaration.
	pub runtime:  Option<RuntimeProviderRecords>,
}

/// Activates declarations for one provider without a load-order tie-break.
#[derive(Clone, Debug, Default)]
pub struct ProviderDeclarations {
	declarations: Arc<[ProviderDeclaration]>,
}

impl ProviderDeclarations {
	/// Captures declarations in deterministic admission order for provenance
	/// only; it is never used as a conflict tie-break.
	pub fn new(declarations: impl IntoIterator<Item = ProviderDeclaration>) -> Self {
		Self { declarations: declarations.into_iter().collect::<Vec<_>>().into() }
	}

	/// Activates the named provider and returns its field-granular overlay
	/// stack.
	pub fn activate(
		&self,
		provider: &ProviderId,
	) -> Result<Option<ActivatedProvider>, ProviderActivationError> {
		let declarations = self
			.declarations
			.iter()
			.filter(|declaration| declaration.provider == *provider)
			.collect::<Vec<_>>();
		if declarations.is_empty() {
			return Ok(None);
		}
		let evidence = declarations
			.iter()
			.map(|declaration| declaration.id.clone())
			.collect::<Vec<_>>()
			.into();
		let available = declarations
			.iter()
			.copied()
			.filter(|declaration| declaration.available)
			.collect::<Vec<_>>();
		if available.is_empty() {
			return Ok(None);
		}
		let unreplaced = available
			.iter()
			.copied()
			.filter(|candidate| {
				!available.iter().any(|replacement| {
					replacement
						.replaces
						.as_ref()
						.is_some_and(|target| target.matches(&candidate.id))
				})
			})
			.collect::<Vec<_>>();
		let mut roots = unreplaced
			.iter()
			.copied()
			.filter(|declaration| declaration.extends.is_none())
			.collect::<Vec<_>>();
		roots.sort_by(|left, right| {
			right
				.priority
				.cmp(&left.priority)
				.then_with(|| left.id.cmp(&right.id))
		});
		let Some(root) = roots.first().copied() else {
			let declaration = available
				.first()
				.expect("available declaration has no root");
			return Err(ProviderActivationError::MissingBase {
				declaration: declaration.id.clone(),
				base:        declaration
					.extends
					.clone()
					.expect("root absence requires extends"),
			});
		};
		if let Some(other) = roots.get(1).filter(|other| other.priority == root.priority) {
			return Err(ProviderActivationError::EqualPriority {
				provider: provider.clone(),
				first:    root.id.clone(),
				second:   other.id.clone(),
			});
		}
		let mut active = vec![root];
		let mut extensions = unreplaced
			.iter()
			.copied()
			.filter(|declaration| declaration.extends.as_ref() == Some(provider))
			.collect::<Vec<_>>();
		extensions.sort_by(|left, right| {
			left
				.priority
				.cmp(&right.priority)
				.then_with(|| left.id.cmp(&right.id))
		});
		if let Some((first, second)) = extensions
			.windows(2)
			.find_map(|pair| (pair[0].priority == pair[1].priority).then_some((pair[0], pair[1])))
		{
			return Err(ProviderActivationError::EqualPriority {
				provider: provider.clone(),
				first:    first.id.clone(),
				second:   second.id.clone(),
			});
		}
		active.extend(extensions);
		let overlays = OverlayStack::from_layers(active.into_iter().map(|declaration| {
			(
				OverlaySource::Extension { id: declaration.id.extension_id().clone() },
				declaration.overlay.clone(),
			)
		}));
		Ok(Some(ActivatedProvider {
			provider: provider.clone(),
			overlays,
			evidence,
			runtime: root.runtime.clone(),
		}))
	}

	/// Activates every declared provider in lexical provider-id order.
	pub fn activate_all(
		&self,
	) -> Result<BTreeMap<ProviderId, ActivatedProvider>, ProviderActivationError> {
		let providers = self
			.declarations
			.iter()
			.map(|declaration| declaration.provider.clone())
			.collect::<BTreeSet<_>>();
		let mut activated = BTreeMap::new();
		for provider in providers {
			if let Some(value) = self.activate(&provider)? {
				activated.insert(provider, value);
			}
		}
		Ok(activated)
	}
}

#[cfg(test)]
mod tests {
	use omp_core::IntoStr;

	use super::*;
	use crate::{Catalog, EvidenceConfidence, ProvenanceKind, ProvenanceSource};

	fn overlay(origin: &str) -> CatalogOverlay {
		CatalogOverlay {
			auth_specs: Box::new([]),
			source:     ProvenanceSource {
				kind:           ProvenanceKind::Configured,
				origin:         origin.to_str(),
				revision:       None,
				confidence:     EvidenceConfidence::Declared,
				observed_at_ms: None,
			},
			providers:  Box::new([]),
			models:     Box::new([]),
			routes:     Box::new([]),
			aliases:    Box::new([]),
		}
	}

	fn declaration(name: &str, priority: i32) -> ProviderDeclaration {
		ProviderDeclaration {
			id: ProviderDeclarationId::new("publisher".to_str(), name.to_str(), "provider".to_str()),
			provider: "provider".into(),
			overlay: overlay(name),
			priority,
			extends: None,
			replaces: None,
			available: true,
			runtime: None,
		}
	}

	#[test]
	fn replacement_bumps_generation_without_reordering_layers() {
		let first = OverlayStack::empty().with_replaced(OverlaySource::UserConfig, overlay("first"));
		let second = first.with_replaced(OverlaySource::UserConfig, overlay("second"));
		assert_eq!(second.generation(), first.generation() + 1);
		assert_eq!(second.overlays().len(), 1);
		assert_eq!(second.overlays()[0].source.origin, "second");
	}

	#[test]
	fn higher_priority_wins_but_loser_is_retained_as_evidence() {
		let provider = ProviderId::new("provider");
		let active = ProviderDeclarations::new([declaration("low", 1), declaration("high", 2)])
			.activate(&provider)
			.unwrap()
			.unwrap();
		assert_eq!(active.overlays.overlays()[0].source.origin, "high");
		assert_eq!(active.evidence.len(), 2);
	}

	#[test]
	fn equal_priority_unrelated_declarations_name_both_identities() {
		let provider = ProviderId::new("provider");
		let error = ProviderDeclarations::new([declaration("first", 1), declaration("second", 1)])
			.activate(&provider)
			.unwrap_err();
		assert!(matches!(
			error,
			ProviderActivationError::EqualPriority { first, second, .. }
				if first.extension_id() == "first" && second.extension_id() == "second"
		));
	}

	#[test]
	fn extends_applies_after_the_selected_base() {
		let base = declaration("base", 0);
		let mut extension = declaration("extension", 0);
		extension.extends = Some("provider".into());
		let provider = ProviderId::new("provider");
		let active = ProviderDeclarations::new([base, extension])
			.activate(&provider)
			.unwrap()
			.unwrap();
		assert_eq!(
			active
				.overlays
				.overlays()
				.iter()
				.map(|overlay| overlay.source.origin.as_str())
				.collect::<Vec<_>>(),
			vec!["base", "extension"]
		);
	}

	#[test]
	fn denied_replacement_reactivates_the_replaced_declaration() {
		let base = declaration("base", 0);
		let mut replacement = declaration("replacement", 0);
		replacement.replaces = Some(ProviderPublisher {
			publisher:    "publisher".to_str(),
			extension_id: "base".to_str(),
		});
		replacement.available = false;
		let provider = ProviderId::new("provider");
		let active = ProviderDeclarations::new([base, replacement])
			.activate(&provider)
			.unwrap()
			.unwrap();
		assert_eq!(active.overlays.overlays()[0].source.origin, "base");
	}
	#[test]
	fn publisher_qualified_replacement_supplants_only_its_declared_target() {
		let base = declaration("base", 0);
		let mut replacement = declaration("replacement", 0);
		replacement.replaces = Some(ProviderPublisher {
			publisher:    "publisher".to_str(),
			extension_id: "base".to_str(),
		});
		let provider = ProviderId::new("provider");
		let active = ProviderDeclarations::new([base, replacement])
			.activate(&provider)
			.unwrap()
			.unwrap();
		assert_eq!(active.overlays.overlays()[0].source.origin, "replacement");
		assert_eq!(active.evidence.len(), 2);
	}

	#[test]
	fn admitted_runtime_provider_registers_oauth_into_a_new_catalog_generation() {
		let catalog = Catalog::embedded();
		let provider = catalog
			.providers()
			.iter()
			.find(|provider| {
				provider
					.auth
					.iter()
					.filter_map(|id| catalog.auth_spec(id))
					.any(|auth| auth.oauth.is_some())
			})
			.expect("OAuth provider")
			.clone();
		let auth_specs = provider
			.auth
			.iter()
			.filter_map(|id| catalog.auth_spec(id).cloned())
			.collect::<Vec<_>>();
		let oauth_specs = auth_specs
			.iter()
			.filter_map(|auth| auth.oauth.as_ref())
			.filter_map(|id| catalog.oauth_spec(id).cloned())
			.collect::<Vec<_>>();
		let routes = provider
			.routes
			.iter()
			.filter_map(|id| catalog.route(id).cloned())
			.collect::<Vec<_>>();
		let models = catalog
			.models()
			.iter()
			.filter(|model| {
				model
					.routes
					.iter()
					.any(|route| provider.routes.contains(route))
			})
			.cloned()
			.collect::<Vec<_>>();
		let runtime = RuntimeProviderRecords {
			provider:    provider.clone(),
			auth_specs:  auth_specs.into_boxed_slice(),
			oauth_specs: oauth_specs.clone().into_boxed_slice(),
			routes:      routes.into_boxed_slice(),
			models:      models.into_boxed_slice(),
		};
		let mut declaration = declaration("runtime", 10);
		declaration.provider = provider.id.clone();
		declaration.runtime = Some(runtime);
		let active = ProviderDeclarations::new([declaration])
			.activate(&provider.id)
			.expect("activation")
			.expect("active");
		let rebuilt = catalog
			.with_runtime_provider(active.runtime.as_ref().expect("runtime records"))
			.expect("runtime catalog");
		assert_ne!(rebuilt.revision(), catalog.revision());
		assert!(
			oauth_specs
				.iter()
				.all(|oauth| rebuilt.oauth_spec(&oauth.id).is_some())
		);
		assert!(rebuilt.provider(&provider.id).is_some());
	}
}
