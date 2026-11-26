//! Clojars (`clojars.org/<artifact>` and `clojars.org/<group>/<artifact>`):
//! artifact metadata, licenses and dependencies from the Clojars API.

use std::fmt::Write as _;

use serde_json::Value;
use url::Url;

use super::{Action, Context, Done, Fetch, Site, f64_of, fetch, format_number, segment, str_of};

/// Registry entry.
pub const SITE: Site = Site { name: "clojars", open };

const METHOD: &str = "clojars";

fn open(url: &Url, _: &Context) -> Option<Action> {
	if !matches!(url.host_str()?, "clojars.org" | "www.clojars.org") {
		return None;
	}
	let path = url.path();
	let path = path.trim_start_matches('/').trim_end_matches('/');
	let segments: Vec<&str> = path
		.split('/')
		.filter(|segment| !segment.is_empty())
		.collect();
	if segments.is_empty() || segments.len() > 2 {
		return None;
	}
	let group = (segments.len() == 2).then(|| percent_decode(segments[0]));
	let artifact = percent_decode(segments[segments.len() - 1]);
	let api = match &group {
		Some(group) => {
			format!("https://clojars.org/api/artifacts/{}/{}", segment(group), segment(&artifact))
		},
		None => format!("https://clojars.org/api/artifacts/{}", segment(&artifact)),
	};

	fetch(Fetch::get(api).accept_json(), move |reply, _| {
		let payload = reply.json_value()?;
		let data = match payload.as_array() {
			Some(entries) => entries.first()?,
			None => &payload,
		};
		if !data.is_object() {
			return None;
		}

		let group_name = str_of(data, "group_name")
			.or_else(|| str_of(data, "group"))
			.or(group.as_deref());
		let artifact_name = str_of(data, "jar_name")
			.or_else(|| str_of(data, "artifact"))
			.or_else(|| str_of(data, "name"))
			.unwrap_or(&artifact);
		let version = str_of(data, "latest_version").or_else(|| str_of(data, "version"));
		let description = str_of(data, "description").or_else(|| str_of(data, "summary"));
		let downloads = f64_of(data, "downloads")
			.or_else(|| f64_of(data, "downloads_total"))
			.or_else(|| f64_of(data, "total_downloads"));
		let homepage = str_of(data, "homepage").or_else(|| str_of(data, "url"));
		let licenses = format_licenses(data.get("licenses"));
		let dependencies = format_dependencies(
			data
				.get("dependencies")
				.filter(|value| !value.is_null())
				.or_else(|| data.get("deps")),
		);

		let display = match group_name {
			Some(group) if group != artifact_name => format!("{group}/{artifact_name}"),
			_ => artifact_name.to_owned(),
		};

		let mut md = format!("# {display}\n\n");
		if let Some(description) = description {
			let _ = write!(md, "{description}\n\n");
		}
		if let Some(group) = group_name {
			let _ = writeln!(md, "**Group:** {group}");
		}
		let _ = writeln!(md, "**Artifact:** {artifact_name}");
		if let Some(version) = version {
			let _ = writeln!(md, "**Latest:** {version}");
		}
		if let Some(downloads) = downloads {
			let _ = writeln!(md, "**Downloads:** {}", format_number(downloads));
		}
		if let Some(homepage) = homepage {
			let _ = writeln!(md, "**Homepage:** {homepage}");
		}
		if !licenses.is_empty() {
			let _ = writeln!(md, "**Licenses:** {}", licenses.join(", "));
		}
		if !dependencies.is_empty() {
			md.push_str("\n## Dependencies\n\n");
			for dependency in &dependencies {
				let _ = writeln!(md, "- {dependency}");
			}
		}
		Done::new(md, METHOD)
			.title(display)
			.note("Fetched via Clojars API")
			.finish()
	})
}

fn format_licenses(value: Option<&Value>) -> Vec<String> {
	let Some(entries) = value.and_then(Value::as_array) else {
		return Vec::new();
	};
	let mut out = Vec::new();
	for entry in entries {
		if let Some(text) = entry.as_str() {
			let text = text.trim();
			if !text.is_empty() {
				out.push(text.to_owned());
			}
			continue;
		}
		if entry.is_object() {
			match (str_of(entry, "name"), str_of(entry, "url")) {
				(Some(name), Some(url)) => out.push(format!("{name} ({url})")),
				(Some(name), None) => out.push(name.to_owned()),
				(None, Some(url)) => out.push(url.to_owned()),
				(None, None) => {},
			}
		}
	}
	out
}

fn format_dependencies(value: Option<&Value>) -> Vec<String> {
	let mut out = Vec::new();
	let Some(value) = value else {
		return out;
	};
	if let Some(entries) = value.as_array() {
		for entry in entries {
			if let Some(text) = entry.as_str() {
				let text = text.trim();
				if !text.is_empty() {
					out.push(text.to_owned());
				}
				continue;
			}
			if let Some(pair) = entry.as_array() {
				let name = pair
					.first()
					.and_then(Value::as_str)
					.map(str::trim)
					.filter(|name| !name.is_empty());
				if let Some(name) = name {
					out.push(
						match pair
							.get(1)
							.and_then(Value::as_str)
							.map(str::trim)
							.filter(|v| !v.is_empty())
						{
							Some(version) => format!("{name}: {version}"),
							None => name.to_owned(),
						},
					);
				}
				continue;
			}
			if entry.is_object() {
				let name = ["name", "artifact", "jar_name"]
					.into_iter()
					.find_map(|key| str_of(entry, key));
				if let Some(name) = name {
					out.push(match str_of(entry, "version") {
						Some(version) => format!("{name}: {version}"),
						None => name.to_owned(),
					});
				}
			}
		}
		return out;
	}
	if let Some(map) = value.as_object() {
		for (name, version) in map {
			match version
				.as_str()
				.map(str::trim)
				.filter(|version| !version.is_empty())
			{
				Some(version) => out.push(format!("{name}: {version}")),
				None if !name.trim().is_empty() => out.push(name.clone()),
				None => {},
			}
		}
	}
	out
}

/// `decodeURIComponent` of a percent-encoded path; invalid escapes pass
/// through.
fn percent_decode(text: &str) -> String {
	let bytes = text.as_bytes();
	let mut out = Vec::with_capacity(bytes.len());
	let mut index = 0;
	while index < bytes.len() {
		if bytes[index] == b'%'
			&& index + 2 < bytes.len()
			&& let (Some(high), Some(low)) = (hex(bytes[index + 1]), hex(bytes[index + 2]))
		{
			out.push(high * 16 + low);
			index += 3;
			continue;
		}
		out.push(bytes[index]);
		index += 1;
	}
	String::from_utf8_lossy(&out).into_owned()
}

const fn hex(byte: u8) -> Option<u8> {
	match byte {
		b'0'..=b'9' => Some(byte - b'0'),
		b'a'..=b'f' => Some(byte - b'a' + 10),
		b'A'..=b'F' => Some(byte - b'A' + 10),
		_ => None,
	}
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::super::{Fetched, testing::run};

	#[test]
	fn a_two_segment_page_uses_the_group_and_artifact_api() {
		let entry = json!({
			"group_name": "org.clojure", "jar_name": "clojure", "latest_version": "1.11.1",
			"description": "Clojure core", "downloads": 5_432_100, "homepage": "https://clojure.org",
			"licenses": [{ "name": "EPL-1.0", "url": "https://www.eclipse.org/legal/epl-v10.html" }, "MIT"],
			"dependencies": [["org.clojure", "spec.alpha"], { "name": "core.specs.alpha", "version": "0.2.62" }]
		});
		let mut requests = Vec::new();
		let done = run("https://clojars.org/org.clojure/clojure", |request| {
			requests.push(request.url.clone());
			Fetched::json(&entry)
		})
		.unwrap();
		assert_eq!(requests, ["https://clojars.org/api/artifacts/org.clojure/clojure"]);
		assert_eq!((done.method, done.title.as_deref()), ("clojars", Some("org.clojure/clojure")));
		assert_eq!(
			done.markdown,
			"# org.clojure/clojure\n\nClojure core\n\n**Group:** org.clojure\n**Artifact:** clojure\n**Latest:** 1.11.1\n**Downloads:** 5.4M\n**Homepage:** https://clojure.org\n**Licenses:** EPL-1.0 (https://www.eclipse.org/legal/epl-v10.html), MIT\n\n## Dependencies\n\n- org.clojure: spec.alpha\n- core.specs.alpha: 0.2.62\n"
		);
	}

	#[test]
	fn a_single_segment_page_reads_the_first_element_of_an_array_payload() {
		let done = run("https://clojars.org/ring", |request| {
			assert_eq!(request.url, "https://clojars.org/api/artifacts/ring");
			Fetched::json(&json!([{
				"artifact": "ring", "version": "1.9.0", "description": "HTTP server",
				"dependencies": { "ring-core": "1.9.0" }
			}]))
		})
		.unwrap();
		assert_eq!(
			done.markdown,
			"# ring\n\nHTTP server\n\n**Artifact:** ring\n**Latest:** 1.9.0\n\n## Dependencies\n\n- \
			 ring-core: 1.9.0\n"
		);
	}

	#[test]
	fn other_hosts_deep_paths_and_failures_fall_through() {
		assert_eq!(run("https://example.com/ring", |_| panic!("no fetch expected")), None);
		assert_eq!(run("https://clojars.org/", |_| panic!("no fetch expected")), None);
		assert_eq!(
			run("https://clojars.org/group/artifact/extra", |_| panic!("no fetch expected")),
			None
		);
		assert_eq!(run("https://clojars.org/ring", |_| Fetched::status(404)), None);
		assert_eq!(run("https://clojars.org/ring", |_| Fetched::json(&json!("nope"))), None);
	}
}
