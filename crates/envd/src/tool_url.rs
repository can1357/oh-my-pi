//! App-owned internal URL resolver composition.

mod artifact;
mod attachment;
pub(crate) mod docs;
pub mod host;
pub(super) mod local;
mod mcp;
mod memory;
pub(super) mod ssh;
pub(super) mod vault;

use std::{fmt::Display, path::PathBuf, sync::Arc};

use omp_agent::{SessionAuthority, SessionEndpoint};
use omp_cache::github_cache::GithubCache;
use omp_core::{CowBytes, Str};
use omp_dom::{Dom, KnownTag, PropId, PropKey, Tag, Value as DomValue};
use omp_journal::blob::{BlobRef, BlobStore};
use omp_tools::read::{
	Fault,
	conflicts::{ConflictRegistry, ConflictResolver},
	json_query::{apply_query, parse_query, path_to_query, render_value},
	resolver::{
		LineOffsetCache, Resolve, ResolvedRead, ResolverTable, ResourceCompletion, ResourceEntry,
		ResourceList, Scheme, SchemeEntry, fuzzy_score,
	},
	selector::ParsedSelector,
};

use super::{
	github_url::{GithubCredentialBridge, GithubResolver, GithubScheme},
	mcp::McpService,
	security_scan::SecurityScanService,
	ssh::SshService,
	vault::VaultService,
};
use crate::{ContentResolver, HostResources};

#[derive(Clone, Copy, Debug)]
enum RegistryResource {
	Agent,
	History,
}

pub(super) struct RegistryResolver {
	resource:  RegistryResource,
	lines:     LineOffsetCache,
	authority: Option<Arc<dyn SessionAuthority>>,
	blobs:     BlobStore,
}

impl RegistryResolver {
	fn new(
		resource: RegistryResource,
		authority: Option<Arc<dyn SessionAuthority>>,
		blobs: BlobStore,
	) -> Self {
		Self { resource, lines: LineOffsetCache::default(), authority, blobs }
	}

	fn authority(&self) -> Result<&dyn SessionAuthority, Fault> {
		self.authority.as_deref().ok_or_else(|| Fault::Source {
			message: Str::new_static("No live session registry is bound."),
		})
	}
}

impl Resolve for RegistryResolver {
	async fn read<'a>(
		&'a self,
		resource: &'a str,
		selector: &'a ParsedSelector,
	) -> Result<CowBytes<'static>, Fault> {
		self.read_query(resource, None, selector).await
	}

	async fn read_query<'a>(
		&'a self,
		resource: &'a str,
		query: Option<&'a str>,
		selector: &'a ParsedSelector,
	) -> Result<CowBytes<'static>, Fault> {
		let authority = self.authority()?;
		let bytes = if matches!(self.resource, RegistryResource::History)
			&& resource.trim_matches('/').is_empty()
		{
			let rows = authority
				.list()
				.into_iter()
				.map(|endpoint| {
					serde_json::json!({
						"id": endpoint.id,
						"name": endpoint.name,
					})
				})
				.collect::<Vec<_>>();
			serde_json::to_vec(&rows).map_err(json_fault)?
		} else {
			let (base, path) = resource.split_once('/').unwrap_or((resource, ""));
			match self.resource {
				RegistryResource::Agent => {
					if query.is_some() && !path.is_empty() {
						return Err(Fault::Invalid {
							message: Str::new_static("agent:// cannot combine path extraction with ?q=."),
						});
					}
					let projection = agent_projection(authority, &self.blobs, base)?;
					let bytes = serde_json::to_vec(&projection).map_err(json_fault)?;
					project_json(bytes, query, (!path.is_empty()).then_some(path))?
				},
				RegistryResource::History => {
					let endpoint = authority.lookup(base).ok_or_else(|| Fault::Source {
						message: Str::new(format!("Session `{base}` is not live.")),
					})?;
					render_history(resource, &endpoint)?
				},
			}
		};
		select_bytes(&self.lines, resource, CowBytes::from(bytes), selector)
	}

	async fn path(&self, _resource: &str) -> Result<Option<Str>, Fault> {
		Ok(None)
	}

	async fn list(
		&self,
		resource: &str,
		max_entries: usize,
		max_bytes: usize,
	) -> Result<ResourceList, Fault> {
		if !resource.trim_matches('/').is_empty() {
			return Err(Fault::Invalid {
				message: Str::new_static(
					"Session resource listing is supported only at the scheme root.",
				),
			});
		}
		let scheme = match self.resource {
			RegistryResource::Agent => "agent",
			RegistryResource::History => "history",
		};
		let mut entries = Vec::new();
		let mut bytes = 0usize;
		let mut truncated = false;
		for endpoint in self.authority()?.list() {
			let uri = format!("{scheme}://{}", endpoint.id);
			let entry_bytes = uri.len().saturating_add(endpoint.name.len());
			if entries.len() == max_entries || bytes.saturating_add(entry_bytes) > max_bytes {
				truncated = true;
				break;
			}
			bytes += entry_bytes;
			entries.push(ResourceEntry {
				uri:       Str::new(uri),
				name:      endpoint.name,
				directory: false,
				size:      0,
			});
		}
		Ok(ResourceList { entries, truncated })
	}

	async fn complete(
		&self,
		query: &str,
		max_results: usize,
	) -> Result<Vec<ResourceCompletion>, Fault> {
		let scheme = match self.resource {
			RegistryResource::Agent => "agent",
			RegistryResource::History => "history",
		};
		let mut matches = self
			.authority()?
			.list()
			.into_iter()
			.filter_map(|endpoint| {
				let score =
					fuzzy_score(query, &endpoint.id).or_else(|| fuzzy_score(query, &endpoint.name))?;
				Some(ResourceCompletion {
					value: Str::new(format!("{scheme}://{}", endpoint.id)),
					description: endpoint.name,
					score,
				})
			})
			.collect::<Vec<_>>();
		matches.sort_unstable_by(|left, right| {
			right
				.score
				.cmp(&left.score)
				.then_with(|| left.value.cmp(&right.value))
		});
		matches.truncate(max_results);
		Ok(matches)
	}
}

/// Constructor-owned resolver union used by the production read registry.
pub(super) enum UrlResolver {
	/// RPC host-owned generation-fenced resources.
	Host(host::HostUriResolver),
	/// Session artifacts by ordinal or durable digest.
	Artifact(artifact::ArtifactUrlResolver),
	/// Images from the latest projected user message.
	Attachment(attachment::AttachmentUrlResolver),
	/// Agent output and child artifacts.
	Agent(RegistryResolver),
	/// Read-only agent transcript index and bodies.
	History(RegistryResolver),
	/// Direct GitHub issue views.
	Issue(GithubResolver),
	/// Direct GitHub pull-request views and diffs.
	Pr(GithubResolver),
	/// Session-local scratch files.
	Local(local::LocalResolver),
	/// Active-session bounded memory projections.
	Memory(memory::MemoryUrlResolver),
	/// Configured native SSH hosts.
	Ssh(ssh::SshResolver),
	/// Project-owned security scan reports and advisories.
	Security(SecurityScanService),
	/// Configured local vaults.
	Vault(vault::VaultResolver),
	/// Resources exposed by mounted MCP servers.
	Mcp(mcp::McpUrlResolver),
	/// Composition-owned active content.
	Content(Arc<dyn ContentResolver>),
	/// Session-registered merge conflict regions.
	Conflict(ConflictResolver),
	/// Packaged harness documentation.
	Docs(docs::DocsResolver),
}

impl Resolve for UrlResolver {
	async fn read<'a>(
		&'a self,
		resource: &'a str,
		selector: &'a ParsedSelector,
	) -> Result<CowBytes<'static>, Fault> {
		match self {
			Self::Host(resolver) => resolver.read(resource, selector).await,
			Self::Artifact(resolver) => resolver.read(resource, selector).await,
			Self::Attachment(resolver) => resolver.read(resource, selector).await,
			Self::Agent(resolver) | Self::History(resolver) => resolver.read(resource, selector).await,
			Self::Issue(resolver) | Self::Pr(resolver) => resolver.read(resource, selector).await,
			Self::Local(resolver) => resolver.read(resource, selector).await,
			Self::Memory(resolver) => resolver.read(resource, selector).await,
			Self::Ssh(resolver) => resolver.read(resource, selector).await,
			Self::Security(resolver) => resolver.read(resource, selector).await,
			Self::Vault(resolver) => resolver.read(resource, selector).await,
			Self::Mcp(resolver) => resolver.read(resource, selector).await,
			Self::Content(resolver) => resolver.read(resource, selector).await,
			Self::Conflict(resolver) => resolver.read(resource, selector).await,
			Self::Docs(resolver) => resolver.read(resource, selector).await,
		}
	}

	async fn read_with_diags<'a>(
		&'a self,
		resource: &'a str,
		selector: &'a ParsedSelector,
	) -> Result<ResolvedRead, Fault> {
		match self {
			Self::Issue(resolver) | Self::Pr(resolver) => {
				resolver.read_with_diags(resource, selector).await
			},
			_ => self
				.read(resource, selector)
				.await
				.map(|data| ResolvedRead { data, diags: Default::default() }),
		}
	}

	async fn read_query<'a>(
		&'a self,
		resource: &'a str,
		query: Option<&'a str>,
		selector: &'a ParsedSelector,
	) -> Result<CowBytes<'static>, Fault> {
		match self {
			Self::Host(resolver) => resolver.read_query(resource, query, selector).await,
			Self::Agent(resolver) | Self::History(resolver) => {
				resolver.read_query(resource, query, selector).await
			},
			Self::Issue(resolver) | Self::Pr(resolver) => {
				resolver.read_query(resource, query, selector).await
			},
			Self::Ssh(resolver) => resolver.read_query(resource, query, selector).await,
			Self::Security(resolver) if query.is_some() => {
				resolver.read_query(resource, query, selector).await
			},
			Self::Vault(resolver) if query.is_some() => {
				resolver.read_query(resource, query, selector).await
			},
			Self::Content(resolver) => resolver.read_query(resource, query, selector).await,
			_ => self.read(resource, selector).await,
		}
	}

	async fn read_query_with_diags<'a>(
		&'a self,
		resource: &'a str,
		query: Option<&'a str>,
		selector: &'a ParsedSelector,
	) -> Result<ResolvedRead, Fault> {
		match self {
			Self::Issue(resolver) | Self::Pr(resolver) => {
				resolver
					.read_query_with_diags(resource, query, selector)
					.await
			},
			_ => self
				.read_query(resource, query, selector)
				.await
				.map(|data| ResolvedRead { data, diags: Default::default() }),
		}
	}

	async fn list(
		&self,
		resource: &str,
		max_entries: usize,
		max_bytes: usize,
	) -> Result<ResourceList, Fault> {
		match self {
			Self::Host(_) => Err(Fault::Invalid {
				message: Str::new_static("Host resources do not support listing."),
			}),
			Self::Artifact(resolver) => resolver.list(resource, max_entries, max_bytes).await,
			Self::Attachment(_) => Err(Fault::Invalid {
				message: Str::new_static("Attachment resources cannot be listed."),
			}),
			Self::Agent(resolver) | Self::History(resolver) => {
				resolver.list(resource, max_entries, max_bytes).await
			},
			Self::Local(resolver) => resolver.list(resource, max_entries, max_bytes).await,
			Self::Memory(resolver) => resolver.list(resource, max_entries, max_bytes).await,
			Self::Ssh(resolver) => resolver.list(resource, max_entries, max_bytes).await,
			Self::Security(resolver) => resolver.list(resource, max_entries, max_bytes).await,
			Self::Vault(resolver) => resolver.list(resource, max_entries, max_bytes).await,
			Self::Mcp(_) => Err(Fault::Invalid {
				message: Str::new_static(
					"MCP resources are discovered through the mounted server device.",
				),
			}),
			Self::Content(resolver) => resolver.list(resource, max_entries, max_bytes).await,
			Self::Docs(resolver) => resolver.list(resource, max_entries, max_bytes).await,
			Self::Issue(_) | Self::Pr(_) => Err(Fault::Invalid {
				message: Str::new_static("GitHub list resources are read as Markdown."),
			}),
			Self::Conflict(_) => {
				Err(Fault::Invalid { message: Str::new_static("Conflict resources cannot be listed.") })
			},
		}
	}

	async fn path(&self, resource: &str) -> Result<Option<Str>, Fault> {
		match self {
			Self::Host(_) => Err(Fault::Invalid {
				message: Str::new_static("Host resources have no local materializable path."),
			}),
			Self::Agent(resolver) => resolver.path(resource).await,
			Self::Local(resolver) => resolver.path(resource).await,
			Self::Content(resolver) => resolver.path(resource).await,
			Self::Ssh(_) | Self::Vault(_) => Err(Fault::Invalid {
				message: Str::new_static(
					"Remote and vault resources have no local materializable path.",
				),
			}),
			Self::Mcp(_) => Err(Fault::Invalid {
				message: Str::new_static("MCP resources have no local materializable path."),
			}),
			_ => Err(Fault::Invalid {
				message: Str::new_static("This resource has no materializable path."),
			}),
		}
	}

	async fn complete(
		&self,
		query: &str,
		max_results: usize,
	) -> Result<Vec<ResourceCompletion>, Fault> {
		match self {
			Self::Host(_) | Self::Attachment(_) => Ok(Vec::new()),
			Self::Artifact(resolver) => resolver.complete(query, max_results).await,
			Self::Agent(resolver) | Self::History(resolver) => {
				resolver.complete(query, max_results).await
			},
			Self::Local(resolver) => resolver.complete(query, max_results).await,
			Self::Memory(resolver) => resolver.complete(query, max_results).await,
			Self::Ssh(resolver) => resolver.complete(query, max_results).await,
			Self::Security(resolver) => resolver.complete(query, max_results).await,
			Self::Vault(resolver) => resolver.complete(query, max_results).await,
			Self::Mcp(resolver) => resolver.complete(query, max_results).await,
			Self::Content(resolver) => resolver.complete(query, max_results).await,
			Self::Docs(resolver) => resolver.complete(query, max_results).await,
			Self::Issue(_) | Self::Pr(_) | Self::Conflict(_) => Ok(Vec::new()),
		}
	}
}

/// Live policy for `local://`: readable, listable, pathable, and completable
/// session scratch files; never minted by the model.
pub(super) fn local_scheme_entry() -> SchemeEntry {
	SchemeEntry::new(Scheme::Local, true, false, "session-local scratch files")
		.with_capabilities(true, true, true)
}

/// Builds the production internal URL table and shared conflict registry.
pub(super) fn production_url_resolvers(
	conflicts: Arc<ConflictRegistry>,
	blob_store: BlobStore,
	session_id: &str,
	sessions_dir: PathBuf,
	workspace_root: PathBuf,
	github_cache: Arc<GithubCache>,
	github_credentials: Arc<GithubCredentialBridge>,
	content: Vec<Arc<dyn ContentResolver>>,
	host_resources: Option<Arc<dyn HostResources>>,
	session_authority: Option<Arc<dyn SessionAuthority>>,
	mcp: Arc<McpService>,
	ssh: SshService,
	security: SecurityScanService,
	vault: VaultService,
) -> Arc<ResolverTable<UrlResolver>> {
	let mut builder = ResolverTable::builder();
	if let Some(resources) = host_resources.as_ref() {
		let _ = host::bind(resources);
	}
	builder
		.install_unknown_fallback(UrlResolver::Host(host::HostUriResolver::new(host_resources)))
		.expect("RPC host URL fallback is unique");
	if let Some(runtime) =
		omp_memory::RuntimeRegistry::lookup(session_id).filter(|runtime| runtime.is_active())
	{
		builder
			.register(
				SchemeEntry::new(Scheme::Memory, true, false, "bounded active Mnemopi memory")
					.with_capabilities(true, false, true),
				UrlResolver::Memory(memory::MemoryUrlResolver::new(runtime)),
			)
			.expect("memory URL resolver is unique");
	}
	builder
		.register(
			SchemeEntry::new(Scheme::Ssh, true, false, "configured native SSH/SFTP hosts")
				.with_capabilities(true, false, true)
				.with_stamp(false, 1),
			UrlResolver::Ssh(ssh::SshResolver::new(ssh)),
		)
		.expect("ssh URL resolver is unique");
	builder
		.register(
			SchemeEntry::new(
				Scheme::Security,
				true,
				false,
				"project-owned security scan reports and validated advisories",
			)
			.with_capabilities(true, false, true),
			UrlResolver::Security(security),
		)
		.expect("security URL resolver is unique");
	builder
		.register(
			SchemeEntry::new(Scheme::Vault, true, false, "configured symlink-confined vaults")
				.with_capabilities(true, false, true)
				.with_stamp(false, 1),
			UrlResolver::Vault(vault::VaultResolver::new(vault)),
		)
		.expect("vault URL resolver is unique");
	builder
		.register(
			SchemeEntry::new(Scheme::Mcp, true, false, "resources from mounted MCP servers")
				.with_capabilities(false, false, true)
				.with_whole_body(true),
			UrlResolver::Mcp(mcp::McpUrlResolver::new(mcp)),
		)
		.expect("mcp URL resolver is unique");
	builder
		.register(
			SchemeEntry::new(Scheme::Issue, true, false, "direct GitHub issues"),
			UrlResolver::Issue(GithubResolver::new(
				GithubScheme::Issue,
				workspace_root.clone(),
				Arc::clone(&github_cache),
				Arc::clone(&github_credentials),
			)),
		)
		.expect("issue URL resolver is unique");
	builder
		.register(
			SchemeEntry::new(Scheme::Pr, true, false, "direct GitHub pull requests and diffs"),
			UrlResolver::Pr(GithubResolver::new(
				GithubScheme::PullRequest,
				workspace_root,
				github_cache,
				github_credentials,
			)),
		)
		.expect("pr URL resolver is unique");
	builder
		.register(
			SchemeEntry::new(Scheme::Attachment, true, false, "latest user image attachments"),
			UrlResolver::Attachment(attachment::AttachmentUrlResolver::new(
				blob_store.clone(),
				session_id,
				session_authority.clone(),
			)),
		)
		.expect("attachment URL resolver is unique");
	builder
		.register(
			SchemeEntry::new(
				Scheme::Artifact,
				true,
				false,
				"session artifacts by ordinal or durable digest",
			)
			.with_capabilities(true, true, true),
			UrlResolver::Artifact(
				artifact::ArtifactUrlResolver::open(blob_store.clone(), session_id)
					.expect("artifact catalog opens with the environment blob store"),
			),
		)
		.expect("artifact URL resolver is unique");
	builder
		.register(
			local_scheme_entry(),
			UrlResolver::Local(
				local::LocalResolver::open(sessions_dir.clone())
					.expect("canonical sessions directory can be created"),
			),
		)
		.expect("local URL resolver is unique");
	for resolver in content {
		builder
			.register(resolver.entry(), UrlResolver::Content(resolver))
			.expect("composition content URL resolver is unique");
	}
	builder
		.register(
			SchemeEntry::new(Scheme::Agent, true, false, "settled agent output and child artifacts")
				.with_capabilities(true, true, true),
			UrlResolver::Agent(RegistryResolver::new(
				RegistryResource::Agent,
				session_authority.clone(),
				blob_store.clone(),
			)),
		)
		.expect("agent URL resolver is unique");
	builder
		.register(
			SchemeEntry::new(Scheme::History, true, false, "read-only agent transcript index")
				.with_capabilities(true, false, true),
			UrlResolver::History(RegistryResolver::new(
				RegistryResource::History,
				session_authority,
				blob_store,
			)),
		)
		.expect("history URL resolver is unique");
	builder
		.register(
			SchemeEntry::new(Scheme::Conflict, true, false, "registered merge conflict regions"),
			UrlResolver::Conflict(ConflictResolver::new((*conflicts).clone())),
		)
		.expect("conflict URL resolver is unique");
	builder
		.register(
			SchemeEntry::new(Scheme::Omp, true, false, "packaged OMP documentation")
				.with_capabilities(true, false, true),
			UrlResolver::Docs(docs::DocsResolver::default()),
		)
		.expect("omp URL resolver is unique");
	Arc::new(builder.build())
}
fn project_json(bytes: Vec<u8>, query: Option<&str>, path: Option<&str>) -> Result<Vec<u8>, Fault> {
	let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|source| {
		Fault::Invalid { message: Str::new(format!("Agent output is not valid JSON: {source}")) }
	})?;
	let query = if let Some(query) = query {
		let mut selected = None;
		for (name, value) in url::form_urlencoded::parse(query.as_bytes()) {
			if name == "q" {
				if selected.replace(value.into_owned()).is_some() {
					return Err(Fault::Invalid {
						message: Str::new_static("agent:// accepts exactly one ?q= value."),
					});
				}
			} else {
				return Err(Fault::Invalid {
					message: Str::new(format!("Unsupported agent:// query parameter '{name}'.")),
				});
			}
		}
		Str::new(selected.ok_or_else(|| Fault::Invalid {
			message: Str::new_static("agent:// query form requires a nonempty ?q= value."),
		})?)
	} else if let Some(path) = path {
		path_to_query(path).map_err(json_fault)?
	} else {
		return Ok(bytes);
	};
	if query.is_empty() {
		return Err(Fault::Invalid {
			message: Str::new_static("agent:// JSON query cannot be empty."),
		});
	}
	let tokens = parse_query(&query).map_err(json_fault)?;
	let selected = apply_query(&value, &tokens).map_err(json_fault)?;
	render_value(selected, 8 * 1024 * 1024)
		.map(|rendered| rendered.as_bytes().to_vec())
		.map_err(json_fault)
}

fn agent_projection(
	authority: &dyn SessionAuthority,
	blobs: &BlobStore,
	id: &str,
) -> Result<serde_json::Value, Fault> {
	for endpoint in authority.list() {
		let snapshot = endpoint.snapshot.read().clone();
		let dom = Dom::from_snapshot(&snapshot);
		for handle in dom.handles() {
			let Some(node) = dom.get(handle) else {
				continue;
			};
			let kind = match node.tag {
				Tag::Known(KnownTag::Job) => "job",
				Tag::Known(KnownTag::Subagent) => "subagent",
				_ => continue,
			};
			if dom_str(node, PropId::Id) != Some(id) {
				continue;
			}
			let status = dom_str(node, PropId::Status).unwrap_or("running");
			let result: Option<serde_json::Value> = node
				.prop(&PropKey::from(PropId::Data))
				.and_then(|value| match value {
					DomValue::Json(raw) => serde_json::from_str(raw.get()).ok(),
					_ => None,
				})
				.map(|value| resolve_job_artifact(blobs, value))
				.transpose()?;
			let output = result
				.as_ref()
				.and_then(|value| value.get("text").and_then(serde_json::Value::as_str))
				.filter(|text| !text.is_empty())
				.map(|text| serde_json::Value::String(text.to_owned()))
				.or_else(|| {
					result
						.as_ref()
						.and_then(|value| value.pointer("/output/data").cloned())
				})
				.or_else(|| result.as_ref().and_then(|value| value.get("text").cloned()))
				.or_else(|| result.clone())
				.unwrap_or(serde_json::Value::Null);
			let data = result
				.as_ref()
				.and_then(|value| value.pointer("/output/data").cloned());
			return Ok(serde_json::json!({
				"id": id,
				"kind": kind,
				"status": status,
				"output": output,
				"data": data,
				"result": result,
			}));
		}
	}
	if let Some(endpoint) = authority.lookup(id) {
		return Ok(session_projection(&endpoint));
	}
	Err(Fault::Source {
		message: Str::new(format!("Agent or job `{id}` is not live in the session tree.")),
	})
}

fn resolve_job_artifact(
	blobs: &BlobStore,
	value: serde_json::Value,
) -> Result<serde_json::Value, Fault> {
	let Some(object) = value.as_object() else {
		return Ok(value);
	};
	let Some(address) = object.get("artifact").and_then(serde_json::Value::as_str) else {
		return Ok(value);
	};
	let Some(size) = object.get("byte_len").and_then(serde_json::Value::as_u64) else {
		return Ok(value);
	};
	let Some(digest) = address.strip_prefix("artifact://sha256/") else {
		return Ok(value);
	};
	let reference = BlobRef::parse_hex(digest, size).map_err(json_fault)?;
	let bytes = blobs.get(&reference).map_err(json_fault)?;
	serde_json::from_slice(&bytes).map_err(json_fault)
}

fn session_projection(endpoint: &SessionEndpoint) -> serde_json::Value {
	let snapshot = endpoint.snapshot.read().clone();
	let dom = Dom::from_snapshot(&snapshot);
	let mut output = "";
	let mut status = "running";
	for turn in dom.children(dom.body()).iter().rev() {
		let Some((text, settled)) = dom.children(*turn).iter().rev().find_map(|child| {
			let node = dom.get(*child)?;
			(node.tag == Tag::Known(KnownTag::Assistant)).then(|| {
				(
					dom_str(node, PropId::Text)
						.or(node.content.as_deref())
						.unwrap_or(""),
					node.prop(&PropKey::from(PropId::StopReason)).is_some(),
				)
			})
		}) else {
			continue;
		};
		output = text;
		status = if settled { "completed" } else { "running" };
		break;
	}
	serde_json::json!({
		"id": endpoint.id,
		"name": endpoint.name,
		"status": status,
		"output": output,
		"text": output,
	})
}

fn render_history(resource: &str, endpoint: &SessionEndpoint) -> Result<Vec<u8>, Fault> {
	let snapshot = endpoint.snapshot.read().clone();
	let dom = Dom::from_snapshot(&snapshot);
	let mut output = format!("# {} transcript\n\n", resource.trim_matches('/'));
	let mut rendered = 0usize;
	for turn in dom.children(dom.body()) {
		for child in dom.children(*turn) {
			let Some(node) = dom.get(*child) else {
				continue;
			};
			let (role, text) = match node.tag {
				Tag::Known(KnownTag::User) => ("user", node.content.as_deref()),
				Tag::Known(KnownTag::Developer) => ("developer", node.content.as_deref()),
				Tag::Known(KnownTag::Assistant) => {
					("assistant", dom_str(node, PropId::Text).or(node.content.as_deref()))
				},
				_ => continue,
			};
			let Some(text) = text.filter(|text| !text.is_empty()) else {
				continue;
			};
			output.push_str("## ");
			output.push_str(role);
			output.push_str("\n\n");
			output.push_str(text);
			output.push_str("\n\n");
			rendered += 1;
		}
	}
	if rendered == 0 {
		output.push_str("_Transcript contains no renderable message text._\n");
	}
	Ok(output.into_bytes())
}

fn dom_str(node: &omp_dom::Node, prop: PropId) -> Option<&str> {
	node.prop(&PropKey::from(prop)).and_then(DomValue::as_str)
}

fn json_fault(error: impl Display) -> Fault {
	Fault::Invalid { message: Str::new(error.to_string()) }
}

pub(super) fn select_bytes(
	lines: &LineOffsetCache,
	resource: &str,
	bytes: CowBytes<'static>,
	selector: &ParsedSelector,
) -> Result<CowBytes<'static>, Fault> {
	let ParsedSelector::Lines { ranges, .. } = selector else {
		return Ok(bytes);
	};
	if ranges.len() == 1 {
		return lines
			.slice(resource, &bytes, ranges[0])
			.map(CowBytes::into_owned)
			.map_err(|error| Fault::Invalid { message: Str::from(error.to_string()) });
	}
	let mut output = Vec::new();
	for range in ranges {
		let piece = lines
			.slice(resource, &bytes, *range)
			.map_err(|error| Fault::Invalid { message: Str::from(error.to_string()) })?;
		output.extend_from_slice(&piece);
	}
	Ok(CowBytes::from(output))
}

#[cfg(test)]
mod tests {
	use omp_agent::{SessionRole, SessionTopology, Up};
	use omp_core::sf;
	use omp_dom::{NodeSpec, Op, Txn};
	use omp_journal::EntryId;
	use parking_lot::RwLock;

	use super::*;

	struct Authority {
		endpoints: Vec<SessionEndpoint>,
	}

	impl SessionAuthority for Authority {
		fn lookup(&self, id_or_name: &str) -> Option<SessionEndpoint> {
			self
				.endpoints
				.iter()
				.find(|endpoint| endpoint.id == id_or_name || endpoint.name == id_or_name)
				.cloned()
		}

		fn list(&self) -> Vec<SessionEndpoint> {
			self.endpoints.clone()
		}

		fn relay_target(
			&self,
			_from: &SessionEndpoint,
			_to: &SessionEndpoint,
		) -> Option<SessionEndpoint> {
			None
		}
	}

	fn endpoint(id: &'static str, dom: &Dom) -> SessionEndpoint {
		let (up, _rx) = flume::unbounded::<Up>();
		SessionEndpoint {
			id: sf!(id),
			name: sf!(id),
			up,
			snapshot: Arc::new(RwLock::new(dom.snapshot())),
			topology: SessionTopology {
				role:      SessionRole::Main,
				parent_id: None,
				main_id:   sf!(id),
			},
			autoreply: None,
		}
	}

	#[test]
	fn agent_projection_resolves_job_output_from_the_dom_and_session_cas() {
		let root = tempfile::tempdir().expect("temporary blob root");
		let blobs = BlobStore::open(root.path()).expect("blob store");
		let result = serde_json::json!({
			"id": "child-1",
			"text": "durable child output",
			"output": {
				"mode": "strict",
				"status": "valid",
				"data": {"answer": 42},
				"error": null
			}
		});
		let encoded = serde_json::to_vec(&result).expect("encode child result");
		let blob = blobs.put(&encoded).expect("persist child result");

		let mut parent = Dom::new();
		let jobs = parent.high_water() + 1;
		let job = jobs + 1;
		parent
			.apply(&Txn {
				cause: EntryId::default(),
				label: None,
				ops:   vec![
					Op::Ins {
						parent: parent.meta(),
						after:  None,
						node:   NodeSpec::new(KnownTag::Jobs),
					},
					Op::Ins {
						parent: omp_dom::Handle::new(jobs).expect("jobs handle"),
						after:  None,
						node:   NodeSpec::new(KnownTag::Subagent)
							.with_prop(PropId::Id, DomValue::Str(sf!("child-1")))
							.with_prop(PropId::Status, DomValue::Str(sf!("completed")))
							.with_prop(
								PropId::Data,
								DomValue::Json(
									serde_json::value::to_raw_value(&serde_json::json!({
										"artifact": format!(
											"artifact://sha256/{}",
											blob.to_hex()
										),
										"byte_len": blob.size,
										"text": "bounded head"
									}))
									.expect("encode spilled output"),
								),
							),
					},
				],
			})
			.expect("materialize parent jobs");
		assert_eq!(job, parent.high_water());

		let authority = Authority { endpoints: vec![endpoint("parent", &parent)] };
		let projection =
			agent_projection(&authority, &blobs, "child-1").expect("resolve journal job output");
		assert_eq!(projection["status"], "completed");
		assert_eq!(projection["output"], "durable child output");
		assert_eq!(projection["data"], serde_json::json!({"answer": 42}));
		assert_eq!(projection["result"], result);
	}
}
