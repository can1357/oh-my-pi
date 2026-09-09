//! Bounded configured and Obsidian-backed `vault://` resolver.

use std::collections::BTreeMap;

use omp_core::{CowBytes, Str, sf};
use omp_tools::read::{
	Fault,
	resolver::{
		LineOffsetCache, Resolve, ResourceCompletion, ResourceEntry, ResourceList, fuzzy_score,
	},
	selector::ParsedSelector,
};

use crate::vault::{ObsidianOperation, VaultEntry, VaultError, VaultSearch, VaultService};

const INLINE_LIMIT: usize = 8 * 1024 * 1024;
const DIRECTORY_ENTRY_LIMIT: usize = 1_000;

pub(crate) struct VaultResolver {
	service: VaultService,
}

impl VaultResolver {
	pub(crate) fn new(service: VaultService) -> Self {
		Self { service }
	}

	async fn directory_bytes(
		&self,
		resource: &ParsedVaultResource,
		limit: usize,
	) -> Result<CowBytes<'static>, Fault> {
		let (entries, truncated) = self
			.service
			.list(&resource.vault, &resource.path, limit)
			.await
			.map_err(vault_fault)?;
		let mut body = String::new();
		body.push_str("# Vault ");
		body.push_str(&resource.vault);
		body.push('/');
		if !resource.path.is_empty() {
			body.push_str(&resource.path);
			body.push('/');
		}
		body.push_str("\n\n");
		if entries.is_empty() {
			body.push_str("(empty)\n");
		} else {
			for entry in &entries {
				body.push_str("- [");
				body.push_str(&entry.name);
				if entry.directory {
					body.push('/');
				}
				body.push_str("](");
				body.push_str(&child_uri(resource, entry));
				body.push_str(")\n");
			}
		}
		if truncated {
			body.push_str("\n[Listing truncated at the configured entry bound.]\n");
		}
		Ok(CowBytes::from(body.into_bytes()))
	}
}

impl Resolve for VaultResolver {
	async fn read<'a>(
		&'a self,
		resource: &'a str,
		selector: &'a ParsedSelector,
	) -> Result<CowBytes<'static>, Fault> {
		use super::select_bytes;

		let bytes = if resource.is_empty() {
			let names = self
				.service
				.names_with_obsidian()
				.await
				.map_err(vault_fault)?;
			let mut body = String::from("# Vaults\n\n");
			if names.is_empty() {
				body.push_str("(none)\n");
			} else {
				for name in names {
					body.push_str("- [");
					body.push_str(&name);
					body.push_str("](vault://");
					body.push_str(&encode_component(&name));
					body.push_str("/)\n");
				}
			}
			CowBytes::from(body.into_bytes())
		} else {
			let parsed = parse_resource(resource).map_err(vault_url_fault)?;
			match self
				.service
				.read(&parsed.vault, &parsed.path, INLINE_LIMIT)
				.await
			{
				Ok(bytes) => bytes,
				Err(VaultError::IsDirectory { .. }) => {
					self.directory_bytes(&parsed, DIRECTORY_ENTRY_LIMIT).await?
				},
				Err(error) => return Err(vault_fault(error)),
			}
		};
		// Vault files are mutable outside this process, so their line offsets must
		// never be retained across reads.
		select_bytes(&LineOffsetCache::default(), resource, bytes, selector)
	}

	async fn read_query<'a>(
		&'a self,
		resource: &'a str,
		query: Option<&'a str>,
		selector: &'a ParsedSelector,
	) -> Result<CowBytes<'static>, Fault> {
		use super::select_bytes;

		let Some(query) = query else {
			return self.read(resource, selector).await;
		};
		let parsed = parse_resource(resource).map_err(vault_url_fault)?;
		let params = parse_query(query);
		let operation = params
			.get("op")
			.filter(|operation| !operation.is_empty())
			.ok_or_else(|| Fault::Invalid {
				message: Str::new_static("vault:// query operations require an 'op' parameter"),
			})?
			.parse::<ObsidianOperation>()
			.map_err(|_| Fault::Invalid {
				message: Str::new_static("unsupported vault:// query operation"),
			})?;
		let bytes = match operation {
			ObsidianOperation::Read => {
				if parsed.path.is_empty() {
					return Err(Fault::Invalid {
						message: Str::new_static("vault://?op=read requires a file path"),
					});
				}
				self
					.service
					.obsidian_read(&parsed.vault, &parsed.path)
					.await
					.map_err(vault_fault)?
					.stdout
			},
			ObsidianOperation::Search => {
				let query = params
					.get("q")
					.filter(|value| !value.is_empty())
					.ok_or_else(|| Fault::Invalid {
						message: Str::new_static("vault://?op=search requires a non-empty 'q' parameter"),
					})?;
				let path = params
					.get("path")
					.filter(|value| !value.is_empty())
					.map(String::as_str)
					.or_else(|| (!parsed.path.is_empty()).then_some(parsed.path.as_str()));
				let limit = params
					.get("limit")
					.map(|value| {
						value.parse::<usize>().map_err(|_| Fault::Invalid {
							message: Str::new_static(
								"vault://?op=search 'limit' must be a non-negative integer",
							),
						})
					})
					.transpose()?;
				self
					.service
					.obsidian_search(&parsed.vault, &VaultSearch {
						query,
						path,
						limit,
						case_sensitive: params.contains_key("case"),
					})
					.await
					.map_err(vault_fault)?
					.stdout
			},
			ObsidianOperation::Create
			| ObsidianOperation::Move
			| ObsidianOperation::Delete
			| ObsidianOperation::Open => {
				return Err(Fault::Invalid {
					message: Str::new_static("mutating Obsidian operations use Write, not Read"),
				});
			},
			ObsidianOperation::Discover => {
				return Err(Fault::Invalid {
					message: Str::new_static("unsupported vault:// query operation"),
				});
			},
		};
		select_bytes(&LineOffsetCache::default(), resource, bytes, selector)
	}

	async fn list(
		&self,
		resource: &str,
		max_entries: usize,
		max_bytes: usize,
	) -> Result<ResourceList, Fault> {
		if resource.is_empty() {
			let names = self
				.service
				.names_with_obsidian()
				.await
				.map_err(vault_fault)?;
			let mut used = 0usize;
			let mut entries = Vec::new();
			let mut truncated = false;
			for name in names {
				let uri = Str::new(format!("vault://{}/", encode_component(&name)));
				let bytes = uri.len().saturating_add(name.len());
				if entries.len() == max_entries || used.saturating_add(bytes) > max_bytes {
					truncated = true;
					break;
				}
				used += bytes;
				entries.push(ResourceEntry { uri, name, directory: true, size: 0 });
			}
			return Ok(ResourceList { entries, truncated });
		}
		let parsed = parse_resource(resource).map_err(vault_url_fault)?;
		let (values, mut truncated) = self
			.service
			.list(&parsed.vault, &parsed.path, max_entries)
			.await
			.map_err(vault_fault)?;
		let mut used = 0usize;
		let mut entries = Vec::new();
		for entry in values {
			let uri = child_uri(&parsed, &entry);
			let bytes = uri.len().saturating_add(entry.name.len());
			if used.saturating_add(bytes) > max_bytes {
				truncated = true;
				break;
			}
			used += bytes;
			entries.push(ResourceEntry {
				uri,
				name: entry.name,
				directory: entry.directory,
				size: entry.size,
			});
		}
		Ok(ResourceList { entries, truncated })
	}

	async fn complete(
		&self,
		query: &str,
		max_results: usize,
	) -> Result<Vec<ResourceCompletion>, Fault> {
		let mut values = self
			.service
			.names_with_obsidian()
			.await
			.map_err(vault_fault)?
			.into_iter()
			.filter_map(|name| {
				Some(ResourceCompletion {
					score:       fuzzy_score(query, &name)?,
					value:       Str::new(format!("vault://{}/", encode_component(&name))),
					description: Str::new_static("configured or Obsidian-discovered vault"),
				})
			})
			.collect::<Vec<_>>();
		values.sort_unstable_by(|left, right| {
			right
				.score
				.cmp(&left.score)
				.then_with(|| left.value.cmp(&right.value))
		});
		values.truncate(max_results);
		Ok(values)
	}
}

/// Parsed configured-vault address after strict percent decoding.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ParsedVaultResource {
	pub(crate) vault:     Str,
	pub(crate) path:      Str,
	pub(crate) directory: bool,
}

fn parse_query(query: &str) -> BTreeMap<String, String> {
	url::form_urlencoded::parse(query.as_bytes())
		.into_owned()
		.collect()
}

pub(crate) fn parse_resource(resource: &str) -> Result<ParsedVaultResource, VaultUrlError> {
	let (raw_vault, raw_path) = resource.split_once('/').unwrap_or((resource, ""));
	if raw_vault.is_empty() {
		return Err(VaultUrlError::MissingName);
	}
	let vault = percent_decode(raw_vault)
		.map_err(|_| VaultUrlError::InvalidEncoding { component: Str::new(raw_vault) })?;
	if vault.is_empty()
		|| vault.bytes().any(|byte| {
			byte.is_ascii_control() || matches!(byte, b'/' | b'\\' | b':' | b'@' | b'?' | b'#')
		}) {
		return Err(VaultUrlError::InvalidName { name: Str::new(vault) });
	}
	let decoded_path = percent_decode(raw_path)
		.map_err(|_| VaultUrlError::InvalidEncoding { component: Str::new(raw_path) })?;
	let directory = raw_path.is_empty() || decoded_path.ends_with('/');
	let path = decoded_path.trim_end_matches('/');
	if !path.is_empty()
		&& (path.contains('\\')
			|| path.bytes().any(|byte| byte.is_ascii_control())
			|| path
				.split('/')
				.any(|component| component.is_empty() || matches!(component, "." | "..")))
	{
		return Err(VaultUrlError::InvalidPath { path: Str::new(decoded_path) });
	}
	Ok(ParsedVaultResource { vault: Str::new(vault), path: Str::new(path), directory })
}

fn percent_decode(value: &str) -> Result<String, ()> {
	let bytes = value.as_bytes();
	let mut decoded = Vec::with_capacity(bytes.len());
	let mut index = 0usize;
	while index < bytes.len() {
		if bytes[index] != b'%' {
			decoded.push(bytes[index]);
			index += 1;
			continue;
		}
		let high = bytes
			.get(index + 1)
			.copied()
			.and_then(hex_value)
			.ok_or(())?;
		let low = bytes
			.get(index + 2)
			.copied()
			.and_then(hex_value)
			.ok_or(())?;
		decoded.push((high << 4) | low);
		index += 3;
	}
	String::from_utf8(decoded).map_err(|_| ())
}

const fn hex_value(byte: u8) -> Option<u8> {
	match byte {
		b'0'..=b'9' => Some(byte - b'0'),
		b'a'..=b'f' => Some(byte - b'a' + 10),
		b'A'..=b'F' => Some(byte - b'A' + 10),
		_ => None,
	}
}

fn encode_component(value: &str) -> String {
	let mut encoded = String::with_capacity(value.len());
	for byte in value.bytes() {
		if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
			encoded.push(char::from(byte));
		} else {
			use std::fmt::Write as _;
			let _ = write!(encoded, "%{byte:02X}");
		}
	}
	encoded
}

fn child_uri(parent: &ParsedVaultResource, entry: &VaultEntry) -> Str {
	let mut uri = format!("vault://{}/", encode_component(&parent.vault));
	if !parent.path.is_empty() {
		for component in parent.path.split("/") {
			uri.push_str(&encode_component(&component));
			uri.push('/');
		}
	}
	uri.push_str(&encode_component(&entry.name));
	if entry.directory {
		uri.push('/');
	}
	Str::new(uri)
}

/// Typed syntax failure for a `vault://` address.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub(crate) enum VaultUrlError {
	#[error("vault:// URL requires a vault name")]
	MissingName,
	#[error("invalid percent encoding in vault:// component {component}")]
	InvalidEncoding { component: Str },
	#[error("invalid vault:// authority {name}")]
	InvalidName { name: Str },
	#[error("invalid or escaping vault:// path {path}")]
	InvalidPath { path: Str },
}

pub(crate) fn vault_url_fault(error: VaultUrlError) -> Fault {
	match error {
		VaultUrlError::MissingName => {
			Fault::Invalid { message: Str::new_static("vault:// URL requires a vault name") }
		},
		VaultUrlError::InvalidEncoding { component } => Fault::Invalid {
			message: sf!("Invalid percent encoding in vault:// component '{component}'"),
		},
		VaultUrlError::InvalidName { name } => {
			Fault::Invalid { message: sf!("Invalid vault:// authority '{name}'") }
		},
		VaultUrlError::InvalidPath { path } => {
			Fault::Invalid { message: sf!("Invalid or escaping vault:// path '{path}'") }
		},
	}
}

pub(crate) fn vault_fault(error: VaultError) -> Fault {
	match error {
		VaultError::InvalidName { name } => {
			Fault::Invalid { message: sf!("Invalid vault name '{name}'") }
		},
		VaultError::InvalidPath { path } => {
			Fault::Invalid { message: sf!("Invalid or escaping vault path '{path}'") }
		},
		VaultError::Unknown { name } => {
			Fault::Source { message: sf!("Vault '{name}' is not available") }
		},
		VaultError::Limit { limit, actual } => Fault::Source {
			message: sf!("Vault resource is {actual} bytes; narrow it below the {limit}-byte bound"),
		},
		VaultError::Escape { path } => Fault::Source {
			message: sf!("Vault path '{}' escapes its configured root", path.display()),
		},
		VaultError::SymlinkTarget { path } => Fault::Source {
			message: sf!("Vault write target '{}' is a symbolic link", path.display()),
		},
		VaultError::NotFound { path } => {
			Fault::Source { message: sf!("Vault path '{}' does not exist", path.display()) }
		},
		VaultError::NotDirectory { path } => {
			Fault::Source { message: sf!("Vault path '{}' is not a directory", path.display()) }
		},
		VaultError::NotFile { path } => {
			Fault::Source { message: sf!("Vault path '{}' is not a regular file", path.display()) }
		},
		VaultError::IsDirectory { path } => {
			Fault::Source { message: sf!("Vault path '{}' is a directory", path.display()) }
		},
		VaultError::NonUtf8Name { path } => Fault::Source {
			message: sf!("Vault entry name at '{}' is not UTF-8", path.display()),
		},
		VaultError::TemporaryNamesExhausted { path } => Fault::Source {
			message: sf!("Cannot allocate an atomic vault temporary file under '{}'", path.display()),
		},
		VaultError::Parse { path, .. } => {
			Fault::Source { message: sf!("Invalid vault configuration '{}'.", path.display()) }
		},
		VaultError::AtomicReplace { path, .. } => Fault::Source {
			message: sf!("Cannot atomically replace vault path '{}'.", path.display()),
		},
		VaultError::Io { operation, path, .. } => Fault::Source {
			message: sf!("Cannot {operation} vault path '{}'.", path.display()),
		},
		VaultError::MissingParameter { operation, name } => Fault::Invalid {
			message: sf!("Obsidian {operation} requires query parameter '{name}'"),
		},
		VaultError::ObsidianUnavailable => Fault::Source {
			message: Str::new_static(
				"Obsidian CLI binary not found; checked PATH and the platform application location. Install Obsidian from https://obsidian.md or add its CLI binary to PATH",
			),
		},
		VaultError::ObsidianFailed { operation, code, diagnostic } => Fault::Source {
			message: sf!("Obsidian {operation} failed with status {code:?}: {diagnostic}"),
		},
		VaultError::ObsidianTimeout { operation, timeout } => Fault::Source {
			message: sf!("Obsidian {operation} timed out after {timeout:?}"),
		},
		VaultError::ObsidianOutputLimit { operation, limit, actual } => Fault::Source {
			message: sf!("Obsidian {operation} returned {actual} bytes, exceeding the {limit}-byte bound"),
		},
		VaultError::ObsidianActiveVaultMissing => Fault::Source {
			message: Str::new_static("Obsidian returned no active vault path"),
		},
		VaultError::ObsidianSpawn { operation, binary, .. } => Fault::Source {
			message: sf!("Cannot start Obsidian {operation} with '{}'", binary.display()),
		},
		VaultError::ObsidianPipe { operation, stream } => Fault::Source {
			message: sf!("Obsidian {operation} did not expose {stream}"),
		},
		VaultError::ObsidianWait { operation, .. } => Fault::Source {
			message: sf!("Cannot wait for Obsidian {operation}"),
		},
		VaultError::ObsidianOutput { operation, .. } => Fault::Source {
			message: sf!("Cannot read Obsidian {operation} output"),
		},
		VaultError::ObsidianUtf8 { operation, .. } => Fault::Source {
			message: sf!("Obsidian {operation} returned non-UTF-8 output"),
		},
	}
}

#[cfg(test)]
mod tests {
	use std::fs;

	use super::*;
	use crate::vault::VaultPaths;

	fn service() -> (tempfile::TempDir, VaultService) {
		let temp = tempfile::tempdir().expect("tempdir");
		let root = temp.path().join("notes");
		fs::create_dir_all(root.join("folder")).expect("vault root");
		fs::write(root.join("folder/a:b.md"), "one\ntwo\nthree\n").expect("note");
		fs::write(
			temp.path().join("vaults.toml"),
			format!("[vaults]\n'My Notes' = {:?}\n", root.display().to_string()),
		)
		.expect("vault config");
		let service = VaultService::load_layered(&VaultPaths {
			user:    temp.path().join("vaults.toml"),
			project: temp.path().join("missing"),
		})
		.expect("vault service");
		(temp, service)
	}

	#[test]
	fn parser_decodes_components_and_rejects_escape_forms() {
		assert_eq!(
			parse_resource("My%20Notes/folder/a%3Ab.md").expect("decoded resource"),
			ParsedVaultResource {
				vault:     sf!("My Notes"),
				path:      sf!("folder/a:b.md"),
				directory: false,
			}
		);
		assert!(
			parse_resource("My%20Notes/folder%2F")
				.expect("encoded directory suffix")
				.directory
		);
		for resource in ["/note", "notes/../secret", "notes/a//b", "notes/%2E%2E/secret", "notes/%GG"]
		{
			assert!(parse_resource(resource).is_err(), "{resource}");
		}
	}

	#[cfg(unix)]
	#[tokio::test]
	async fn read_query_routes_obsidian_read_and_search_without_mutations() {
		use std::os::unix::fs::PermissionsExt as _;

		let (temp, service) = service();
		let log = temp.path().join("argv");
		let script = temp.path().join("obsidian");
		fs::write(
			&script,
			format!(
				"#!/bin/sh\nprintf '%s\\n' \"$*\" >> '{}'\nprintf '{{\"matches\":[]}}'\n",
				log.display(),
			),
		)
		.expect("script");
		let mut permissions = fs::metadata(&script)
			.expect("script metadata")
			.permissions();
		permissions.set_mode(0o700);
		fs::set_permissions(&script, permissions).expect("script permissions");
		let resolver = VaultResolver::new(service.with_obsidian_binary(Some(script)));
		let read = resolver
			.read_query("My%20Notes/folder/a%3Ab.md", Some("op=read"), &ParsedSelector::None)
			.await
			.expect("CLI read");
		assert_eq!(read.as_ref(), br#"{"matches":[]}"#);
		let search = resolver
			.read_query(
				"My%20Notes/",
				Some("op=search&q=two&path=folder&limit=2&case"),
				&ParsedSelector::None,
			)
			.await
			.expect("CLI search");
		assert_eq!(search.as_ref(), br#"{"matches":[]}"#);
		assert_eq!(
			fs::read_to_string(log).expect("argv log"),
			concat!(
				"vault=My Notes read path=folder/a:b.md\n",
				"vault=My Notes search:context query=two path=folder limit=2 case format=json\n",
			)
		);
		assert!(
			resolver
				.read_query("My%20Notes/folder/a%3Ab.md", Some("op=delete"), &ParsedSelector::None,)
				.await
				.is_err()
		);
	}

	#[tokio::test]
	async fn read_routes_files_directories_roots_and_line_selectors() {
		let (_temp, service) = service();
		let resolver = VaultResolver::new(service);
		let parsed =
			omp_tools::read::selector::parse_uri("vault://My%20Notes/folder/a%3Ab.md:raw:2-2")
				.expect("valid URI")
				.expect("absolute URI");
		assert_eq!(parsed.resource, "My%20Notes/folder/a%3Ab.md");
		let selected = resolver
			.read(parsed.resource, &parsed.selector)
			.await
			.expect("selected read");
		assert_eq!(selected.as_ref(), b"two\n");
		let directory = resolver
			.read("My%20Notes/folder/", &ParsedSelector::None)
			.await
			.expect("directory read");
		assert!(
			std::str::from_utf8(&directory)
				.unwrap()
				.contains("a%3Ab.md")
		);
		let listed = resolver
			.list("My%20Notes/folder/", 8, 1024)
			.await
			.expect("bounded list");
		assert_eq!(listed.entries[0].uri, "vault://My%20Notes/folder/a%3Ab.md");
		assert!(!listed.truncated);
		let root = resolver
			.read("", &ParsedSelector::None)
			.await
			.expect("root read");
		assert!(
			std::str::from_utf8(&root)
				.unwrap()
				.contains("vault://My%20Notes/")
		);
	}
}
