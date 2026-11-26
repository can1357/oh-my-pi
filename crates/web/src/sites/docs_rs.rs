//! docs.rs rustdoc pages, from the crate's compressed rustdoc JSON archive.

mod render;

use serde_json::{Map, Value};
use url::Url;

use super::{Action, Context, Done, Fetch, Site, arr_of, fetch, gunzip, unix_date, unzstd};
use crate::strategy::MAX_BYTES;

/// Registry entry.
pub const SITE: Site = Site { name: METHOD, open };

const METHOD: &str = "docs.rs";
const MAX_JSON_BYTES: usize = 256 * 1024 * 1024;
const DAY_SECS: u64 = 86_400;

struct Target {
	modules: Vec<String>,
	item:    Option<String>,
}

type Index = Map<String, Value>;

fn open(url: &Url, context: &Context) -> Option<Action> {
	if url.host_str()? != "docs.rs" {
		return None;
	}
	let mut path = url.path_segments()?.filter(|part| !part.is_empty());
	let krate = path.next().filter(|part| *part != "crate")?;
	let version = path.next()?;
	let mut modules: Vec<_> = path.map(str::to_owned).collect();
	let leaf = modules.last()?;
	let item = item_name(leaf).map(str::to_owned);
	if item.is_some() || leaf == "index.html" {
		let _ = modules.pop();
	}
	let target = Target { modules, item };

	let (key, ttl) = cache_key(krate, version, context.now_ms());
	if let Some(cached) = context.cache_get(&key)
		&& let Ok(data) = serde_json::from_str(&cached)
		&& data_index(&data).is_some()
	{
		return finish(&target, &data, "Loaded from docs.rs rustdoc JSON cache");
	}

	let url = format!("https://docs.rs/crate/{krate}/{version}/json.gz");
	let request = Fetch::get(url)
		.header("Accept", "application/gzip")
		.max_bytes(MAX_BYTES);
	fetch(request, move |reply, context| {
		if !reply.ok() || reply.truncated || reply.body.len() > MAX_BYTES {
			return None;
		}
		let bytes = if reply.body.starts_with(&[0x1f, 0x8b]) {
			gunzip(&reply.body, MAX_JSON_BYTES)?
		} else {
			unzstd(&reply.body, MAX_JSON_BYTES)?
		};
		let json = String::from_utf8(bytes).ok()?;
		let data = serde_json::from_str(&json).ok()?;
		data_index(&data)?;
		context.cache_put(&key, json, ttl);
		finish(&target, &data, "Fetched via docs.rs rustdoc JSON")
	})
}

fn item_name(leaf: &str) -> Option<&str> {
	let (kind, name) = leaf.strip_suffix(".html")?.split_once('.')?;
	(matches!(
		kind,
		"struct"
			| "trait"
			| "fn"
			| "enum"
			| "macro"
			| "type"
			| "constant"
			| "static"
			| "attr"
			| "derive"
			| "union"
			| "primitive"
	) && !name.is_empty())
	.then_some(name)
}

fn cache_key(krate: &str, version: &str, now_ms: u64) -> (String, u64) {
	let (version, ttl) = if version == "latest" {
		let secs = now_ms / 1_000;
		// The dated key rolls over at midnight, even with a whole-second TTL.
		(unix_date(secs.cast_signed()), DAY_SECS - secs % DAY_SECS)
	} else {
		(sanitize_cache_segment(version), u64::MAX)
	};
	(format!("docsrs_{}_{version}/rustdoc.json", sanitize_cache_segment(krate)), ttl)
}

fn sanitize_cache_segment(value: &str) -> String {
	let mut out = String::with_capacity(value.len());
	let mut replacing = false;
	for byte in value.bytes() {
		if byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-') {
			out.push(char::from(byte));
			replacing = false;
		} else if !replacing {
			out.push('_');
			replacing = true;
		}
	}
	out
}

fn data_index(data: &Value) -> Option<&Index> {
	data["index"].as_object()
}

fn lookup<'a>(index: &'a Index, id: &Value) -> Option<&'a Value> {
	if let Some(id) = id.as_str() {
		return index.get(id);
	}
	let mut n = id.as_u64()?;
	// Index keys are strings even when the corresponding rustdoc IDs are
	// numbers.
	let mut digits = [0; 20];
	let mut start = digits.len();
	loop {
		start -= 1;
		digits[start] = b'0' + (n % 10) as u8;
		n /= 10;
		if n == 0 {
			break;
		}
	}
	index.get(str::from_utf8(&digits[start..]).ok()?)
}

fn finish(target: &Target, data: &Value, note: &'static str) -> Option<Action> {
	let index = data_index(data)?;
	let mut module = lookup(index, &data["root"])?;
	for segment in target.modules.iter().skip(1) {
		module = arr_of(&module["inner"]["module"], "items")
			.iter()
			.filter_map(|id| lookup(index, id))
			.find(|item| {
				item["name"].as_str() == Some(segment.as_str()) && item["inner"].get("module").is_some()
			})?;
	}
	let version = data["crate_version"].as_str().filter(|v| !v.is_empty());
	let markdown = if let Some(name) = target.item.as_deref() {
		let item = arr_of(&module["inner"]["module"], "items")
			.iter()
			.filter_map(|id| lookup(index, id))
			.find_map(|child| {
				if child["name"].as_str() == Some(name) {
					return Some(child);
				}
				let reexport = &child["inner"]["use"];
				if reexport["name"].as_str() == Some(name) {
					lookup(index, &reexport["id"])
				} else {
					None
				}
			})?;
		render::item(item, index, version)
	} else {
		render::module(module, index, version, &target.modules)
	};
	Done::new(markdown, METHOD).note(note).finish()
}

#[cfg(test)]
mod tests {
	use std::io::Write as _;

	use flate2::{Compression, write::GzEncoder};

	use super::{DAY_SECS, MAX_BYTES, METHOD};
	use crate::sites::{
		Cache, Fetched,
		testing::{context, run, run_in},
	};

	const ROOT: &str = "https://docs.rs/sample/latest/sample/";
	const ITEM: &str = "https://docs.rs/sample/1.2.3/sample/tools/trait.Alias.html#method.provided";
	const CRATE: &str = r#"{
		"root": 0,
		"crate_version": "1.2.3",
		"index": {
			"0": {"name": "sample", "docs": "Crate documentation.", "inner": {"module": {"items": [1, 2, 3, 4, 5]}}},
			"1": {"name": "make", "docs": "Makes a value.\nMore details.", "inner": {"function": {
				"is_unsafe": true,
				"generics": {"params": [{"name": "'a", "kind": {"lifetime": {}}}, {"name": "T", "kind": {"type": {}}}]},
				"sig": {"inputs": [["arg", {"borrowed_ref": {"lifetime": "a", "type": {"generic": "T"}}}]],
					"output": {"resolved_path": {"path": "Option", "args": {"angle_bracketed": {"args": [{"type": {"generic": "T"}}]}}}}}
			}}},
			"2": {"name": "tools", "inner": {"module": {"items": [3]}}},
			"3": {"name": null, "inner": {"use": {"name": "Alias", "id": "6"}}},
			"4": {"name": "Hidden", "visibility": "crate", "inner": {"struct": {}}},
			"5": {"name": "Internal", "visibility": {"restricted": {"parent": 0}}, "inner": {"struct": {}}},
			"6": {"name": "Example", "docs": "First line.\n\nSecond paragraph.", "deprecation": {"note": "Use another trait."},
				"inner": {"trait": {"is_unsafe": true, "items": [7, 8], "impls": [9, 10, 11, 12]}}},
			"7": {"name": "Output", "docs": "Associated type.", "inner": {"assoc_type": {}}},
			"8": {"name": "provided", "inner": {"function": {"has_body": true, "sig": {"inputs": [["self", {"borrowed_ref": {"type": "Self"}}]]}}}},
			"9": {"inner": {"impl": {"trait": {"path": "Display"}}}},
			"10": {"inner": {"impl": {"trait": {"path": "Display"}}}},
			"11": {"inner": {"impl": {"trait": {"path": "Send"}, "is_synthetic": true}}},
			"12": {"inner": {"impl": {"trait": {"path": "Blanket"}, "blanket_impl": {"generic": "T"}}}}
		}
	}"#;

	fn gzip() -> Fetched {
		let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
		encoder.write_all(CRATE.as_bytes()).unwrap();
		Fetched { status: 200, body: encoder.finish().unwrap(), ..Fetched::default() }
	}

	#[test]
	fn crate_root_downloads_gzip_and_groups_public_items() {
		let done = run(ROOT, |request| {
			assert_eq!(request.url, "https://docs.rs/crate/sample/latest/json.gz");
			assert_eq!(request.max_bytes, MAX_BYTES);
			assert!(
				request
					.headers
					.iter()
					.any(|(name, value)| { name == "Accept" && value == "application/gzip" })
			);
			gzip()
		})
		.unwrap();
		assert_eq!(done.method, METHOD);
		assert_eq!(done.notes, ["Fetched via docs.rs rustdoc JSON"]);
		assert_eq!(
			done.markdown,
			concat!(
				"# sample\n\nCrate documentation.\n\n",
				"## Modules\n\n- **tools**\n\n",
				"## Traits\n\n- **Alias** — First line.\n\n",
				"## Functions\n\n- `unsafe fn make<T>(arg: &'a T) -> Option<T>` — Makes a value.\n\n",
				"---\n*1.2.3*\n",
			)
		);
	}

	#[test]
	fn an_item_page_resolves_reexports_and_renders_trait_items() {
		let done = run(ITEM, |request| {
			assert_eq!(request.url, "https://docs.rs/crate/sample/1.2.3/json.gz");
			let body = zstd::stream::encode_all(CRATE.as_bytes(), 1).unwrap();
			Fetched { status: 200, body, ..Fetched::default() }
		})
		.unwrap();
		assert_eq!(
			done.markdown,
			concat!(
				"# trait Example\n\n> **Deprecated**: Use another trait.\n\n",
				"```rust\nunsafe trait Example\n```\n\nFirst line.\n\nSecond paragraph.\n\n",
				"## Required Methods\n\n- `type Output` — Associated type.\n\n",
				"## Provided Methods\n\n- `fn provided(&Self)`\n\n",
				"## Trait Implementations\n\n- Display\n\n---\n*1.2.3*\n",
			)
		);
	}

	#[test]
	fn latest_archive_is_reused_across_pages_until_midnight_utc() {
		let cache = Cache::isolated();
		let midnight = DAY_SECS * 1_000;
		let before = context(|setup| {
			setup.cache = cache.clone();
			setup.now_ms = midnight - 1;
		});
		run_in(ROOT, &before, |_| gzip()).unwrap();
		let done = run_in("https://docs.rs/sample/latest/sample/tools/index.html", &before, |_| {
			panic!("the crate archive was already downloaded")
		})
		.unwrap();
		assert_eq!(done.notes, ["Loaded from docs.rs rustdoc JSON cache"]);
		assert!(
			done
				.markdown
				.starts_with("# sample::tools\n\n## Traits\n\n- **Alias**")
		);

		let after = context(|setup| {
			setup.cache = cache;
			setup.now_ms = midnight;
		});
		let done = run_in(ROOT, &after, |_| gzip()).unwrap();
		assert_eq!(done.notes, ["Fetched via docs.rs rustdoc JSON"]);
	}

	#[test]
	fn non_rustdoc_pages_and_failed_downloads_fall_through() {
		assert_eq!(run("https://docs.rs/crate/sample/latest", |_| panic!("no fetch expected")), None);
		assert_eq!(run(ROOT, |_| Fetched::status(404)), None);
		assert_eq!(run(ROOT, |_| Fetched::text("text/html", "not an archive")), None);
		assert_eq!(run("https://docs.rs/sample/latest/sample/fn.missing.html", |_| gzip()), None);
	}
}
