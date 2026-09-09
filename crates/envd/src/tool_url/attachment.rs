//! Live-session `attachment://N` resolver.

use std::sync::Arc;

use omp_agent::SessionAuthority;
use omp_core::{CowBytes, Str};
use omp_dom::{Dom, KnownTag, PropId, PropKey, Tag, Value};
use omp_journal::blob::{BlobRef, BlobStore};
use omp_tools::read::{
	Fault,
	resolver::{LineOffsetCache, Resolve},
	selector::ParsedSelector,
};

pub(crate) struct AttachmentUrlResolver {
	store:     BlobStore,
	session:   Str,
	authority: Option<Arc<dyn SessionAuthority>>,
	lines:     LineOffsetCache,
}

impl AttachmentUrlResolver {
	pub(super) fn new(
		store: BlobStore,
		session: &str,
		authority: Option<Arc<dyn SessionAuthority>>,
	) -> Self {
		Self { store, session: Str::new(session), authority, lines: LineOffsetCache::default() }
	}
}

impl Resolve for AttachmentUrlResolver {
	async fn read<'a>(
		&'a self,
		resource: &'a str,
		selector: &'a ParsedSelector,
	) -> Result<CowBytes<'static>, Fault> {
		use super::select_bytes;
		let authority = self.authority.as_deref().ok_or_else(|| Fault::Source {
			message: Str::new_static("No live session registry is bound."),
		})?;
		let endpoint = authority
			.lookup(self.session.as_str())
			.ok_or_else(|| Fault::Source {
				message: Str::new_static("No live attachment snapshot is available."),
			})?;
		let dom = Dom::from_snapshot(&endpoint.snapshot.read());
		let latest = dom
			.handles()
			.collect::<Vec<_>>()
			.into_iter()
			.rev()
			.find_map(|handle| {
				let node = dom.get(handle)?;
				(node.tag == Tag::Known(KnownTag::User))
					.then(|| node.prop(&PropKey::from(PropId::Data)))
					.flatten()
			});
		let attachments = match latest {
			Some(Value::Json(value)) => {
				serde_json::from_str::<Vec<BlobRef>>(value.get()).map_err(|_| Fault::Source {
					message: Str::new_static("Attachment metadata is invalid."),
				})?
			},
			_ => Vec::new(),
		};
		let ordinal = resource
			.trim_matches('/')
			.parse::<usize>()
			.map_err(|_| Fault::Invalid {
				message: Str::new_static("Attachment identity must be a positive ordinal."),
			})?;
		let reference = attachments
			.get(ordinal.saturating_sub(1))
			.copied()
			.ok_or_else(|| Fault::Source {
				message: Str::new_static("Attachment was not found in the latest user attachment set."),
			})?;
		let bytes = CowBytes::from(self.store.get(&reference).map_err(|_| Fault::Source {
			message: Str::new_static("Attachment content is unavailable."),
		})?);
		select_bytes(&self.lines, resource, bytes, selector)
	}
}
