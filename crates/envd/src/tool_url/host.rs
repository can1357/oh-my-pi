//! Late-bound RPC host-resource resolver.

use std::sync::{Arc, Weak};

use omp_core::{CowBytes, Str};
use omp_tool::FetchEffects;
use omp_tools::read::{
	Fault,
	resolver::{LineOffsetCache, Resolve},
	selector::{ParsedSelector, ParsedUri, parse_selector, parse_uri, split_path_and_selector},
};
use parking_lot::RwLock;

use crate::{HostResources, HostUriJudgment};

static BROKER: RwLock<Option<Weak<dyn HostResources>>> = RwLock::new(None);

/// Installs the sole live RPC host-resource authority.
pub fn bind(broker: &Arc<dyn HostResources>) -> Result<(), ()> {
	let mut current = BROKER.write();
	if current.as_ref().and_then(Weak::upgrade).is_some() {
		return Err(());
	}
	*current = Some(Arc::downgrade(broker));
	Ok(())
}

/// Removes the authority only when it still names this RPC generation owner.
pub fn unbind(broker: &Arc<dyn HostResources>) {
	let mut current = BROKER.write();
	if current
		.as_ref()
		.and_then(Weak::upgrade)
		.as_ref()
		.is_some_and(|active| Arc::ptr_eq(active, broker))
	{
		*current = None;
	}
}

/// Resolver arm for the bounded set of schemes declared by the RPC host.
pub struct HostUriResolver {
	lines:  LineOffsetCache,
	broker: Option<Arc<dyn HostResources>>,
}

impl HostUriResolver {
	/// Builds a host URI resolver over an optional live broker.
	#[must_use]
	pub fn new(broker: Option<Arc<dyn HostResources>>) -> Self {
		Self { lines: LineOffsetCache::default(), broker }
	}

	fn broker(&self) -> Result<Arc<dyn HostResources>, Fault> {
		self
			.broker
			.as_ref()
			.cloned()
			.or_else(|| BROKER.read().as_ref().and_then(Weak::upgrade))
			.ok_or_else(|| Fault::Unsupported {
				message: Str::new_static("RPC host resource authority is unavailable."),
			})
	}
}

impl Resolve for HostUriResolver {
	async fn read<'a>(
		&'a self,
		authored_uri: &'a str,
		selector: &'a ParsedSelector,
	) -> Result<CowBytes<'static>, Fault> {
		use super::select_bytes;
		let parsed = parse_uri(authored_uri)
			.map_err(|_| Fault::Invalid {
				message: Str::new_static("Host resource URI is malformed."),
			})?
			.ok_or_else(|| Fault::Invalid {
				message: Str::new_static("Host resource URI requires scheme:// syntax."),
			})?;
		let broker = self.broker()?;
		let (url, effective_selector) = live_read_target(&broker, &parsed, selector)?;
		let result = broker
			.resolve_read(&url)
			.await
			.map_err(|message| Fault::Source { message })?;
		let content = result.content.unwrap_or_default();
		let selected = select_bytes(
			&self.lines,
			&url,
			CowBytes::from(content.into_bytes()),
			&effective_selector,
		)?;
		if result.notes.is_empty() {
			return Ok(selected);
		}
		use std::fmt::Write as _;
		let mut rendered =
			String::from_utf8(selected.into_bytes().to_vec()).map_err(|_| Fault::Invalid {
				message: Str::new_static("Host resource selection did not resolve to UTF-8 text."),
			})?;
		rendered.push_str("\n\nResolution notes:");
		for note in result.notes {
			let _ = write!(rendered, "\n- {note}");
		}
		Ok(CowBytes::from(rendered.into_bytes()))
	}

	/// Consults [`HostResources::judge`]: only [`HostUriJudgment::Fetch`] yields
	/// fetch effects. Undeclared / Unknown / Local return `None` so `read@3`
	/// Foreign admission stays subset-safe (ADR 0050 S3 / D5).
	fn read_fetch(&self, resource: &str, _query: Option<&str>) -> Option<FetchEffects> {
		let broker = self.broker().ok()?;
		match broker.judge(resource) {
			HostUriJudgment::Fetch(effects) => Some(effects),
			HostUriJudgment::Undeclared | HostUriJudgment::Local | HostUriJudgment::Unknown => None,
		}
	}
}

/// Peels the shared line-selector grammar only for live declared schemes.
///
/// Undeclared Unknown and `mcp://` never reach this peel: Unknown stays opaque
/// at `parse_uri`, and MCP uses its own resolver. `Scheme::accepts_selectors`
/// for Unknown/Mcp stays false.
fn live_read_target(
	broker: &Arc<dyn HostResources>,
	parsed: &ParsedUri<'_>,
	caller_selector: &ParsedSelector,
) -> Result<(String, ParsedSelector), Fault> {
	let opaque_url = parsed.query.map_or_else(
		|| format!("{}://{}", parsed.raw_scheme, parsed.resource),
		|query| format!("{}://{}?{query}", parsed.raw_scheme, parsed.resource),
	);
	let live = !matches!(broker.judge(&opaque_url), HostUriJudgment::Undeclared);
	if !live {
		return Ok((opaque_url, caller_selector.clone()));
	}
	let split = split_path_and_selector(parsed.resource);
	let selector = parse_selector(split.selector)
		.map_err(|error| Fault::Invalid { message: Str::new(error.to_string()) })?;
	let url = parsed.query.map_or_else(
		|| format!("{}://{}", parsed.raw_scheme, split.path),
		|query| format!("{}://{}?{query}", parsed.raw_scheme, split.path),
	);
	// Caller selector is None for Scheme::Unknown; live peel owns the grammar.
	let effective = if matches!(caller_selector, ParsedSelector::None) {
		selector
	} else {
		caller_selector.clone()
	};
	Ok((url, effective))
}

/// Routes one whole-resource write through the same declared generation.
pub(crate) async fn write(uri: &str, content: String) -> Result<u64, Str> {
	let byte_len = content.len() as u64;
	let broker = BROKER
		.read()
		.as_ref()
		.and_then(Weak::upgrade)
		.ok_or_else(|| Str::new_static("RPC host resource authority is unavailable."))?;
	broker.resolve_write(uri, content).await?;
	Ok(byte_len)
}
