//! Discogs (`discogs.com/release|master/<id>`): release and master metadata
//! from the Discogs API, rendered as a tracklist with credits.

use std::{fmt::Write as _, sync::LazyLock};

use regex::Regex;
use serde_json::Value;
use url::Url;

use super::{Action, Context, Done, Fetch, Site, arr_of, f64_of, fetch, str_of, strs_of, u64_of};

/// Registry entry.
pub const SITE: Site = Site { name: "discogs", open };

const METHOD: &str = "discogs";

static RELEASE_PATH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"/release/(\d+)").unwrap());
static MASTER_PATH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"/master/(\d+)").unwrap());

fn open(url: &Url, _: &Context) -> Option<Action> {
	if !url.host_str()?.contains("discogs.com") {
		return None;
	}
	let path = url.path();
	let release = RELEASE_PATH
		.captures(path)
		.and_then(|captures| captures.get(1))
		.map(|id| id.as_str().to_owned());
	let master = MASTER_PATH
		.captures(path)
		.and_then(|captures| captures.get(1))
		.map(|id| id.as_str().to_owned());
	let is_release = release.is_some();
	let id = release.or(master)?;
	let kind = if is_release { "release" } else { "master" };
	fetch(
		Fetch::get(format!("https://api.discogs.com/{kind}s/{id}")).accept_json(),
		move |reply, _| {
			let record = reply.json_value()?;
			let md = if is_release {
				build_release(&record)
			} else {
				build_master(&record)
			};
			Done::new(md, METHOD)
				.title(str_of(&record, "title").unwrap_or_default())
				.note(format!("Fetched via Discogs API ({kind})"))
				.finish()
		},
	)
}

/// Join artist names, honouring name variations and joining words.
fn format_artists(artists: &[Value]) -> String {
	if artists.is_empty() {
		return "Unknown Artist".to_owned();
	}
	let mut out = String::new();
	for artist in artists {
		out.push_str(
			str_of(artist, "anv")
				.or_else(|| str_of(artist, "name"))
				.unwrap_or_default(),
		);
		if let Some(join) = str_of(artist, "join") {
			let _ = write!(out, " {join} ");
		}
	}
	let mut text = out.trim_end().to_owned();
	if text.ends_with(',') || text.ends_with('&') {
		text.pop();
	}
	text.trim().to_owned()
}

fn format_track(track: &Value) -> String {
	let mut line = match str_of(track, "position") {
		Some(position) => format!("{position}. "),
		None => "- ".to_owned(),
	};
	line.push_str(str_of(track, "title").unwrap_or_default());
	if let Some(duration) = str_of(track, "duration") {
		let _ = write!(line, " ({duration})");
	}
	let artists = arr_of(track, "artists");
	if !artists.is_empty() {
		let _ = write!(line, " - {}", format_artists(artists));
	}
	line
}

/// Credits grouped by role, in first-seen role order.
fn format_credits(extraartists: &[Value]) -> String {
	let mut roles: Vec<(&str, Vec<&str>)> = Vec::new();
	for artist in extraartists {
		let role = str_of(artist, "role").unwrap_or("Other");
		let name = str_of(artist, "anv")
			.or_else(|| str_of(artist, "name"))
			.unwrap_or_default();
		match roles.iter_mut().find(|(existing, _)| *existing == role) {
			Some((_, names)) => names.push(name),
			None => roles.push((role, vec![name])),
		}
	}
	roles
		.iter()
		.map(|(role, names)| format!("- **{role}**: {}", names.join(", ")))
		.collect::<Vec<_>>()
		.join("\n")
}

fn format_formats(formats: &[Value]) -> String {
	formats
		.iter()
		.map(|format| {
			let mut parts: Vec<String> = Vec::new();
			if let Some(qty) = u64_of(format, "qty").filter(|qty| *qty > 1) {
				parts.push(format!("{qty}×"));
			}
			if let Some(name) = str_of(format, "name") {
				parts.push(name.to_owned());
			}
			let descriptions = strs_of(format, "descriptions");
			if !descriptions.is_empty() {
				parts.push(descriptions.join(", "));
			}
			parts.join(" ")
		})
		.collect::<Vec<_>>()
		.join(" + ")
}

fn format_labels(labels: &[Value]) -> String {
	labels
		.iter()
		.map(|label| {
			let name = str_of(label, "name").unwrap_or_default();
			match str_of(label, "catno") {
				Some(catno) if catno != "none" => format!("{name} ({catno})"),
				_ => name.to_owned(),
			}
		})
		.collect::<Vec<_>>()
		.join(", ")
}

fn build_release(release: &Value) -> String {
	let mut sections: Vec<String> = Vec::new();
	let artist = format_artists(arr_of(release, "artists"));
	sections.push(format!("# {artist} - {}\n", str_of(release, "title").unwrap_or_default()));

	let mut meta: Vec<String> = Vec::new();
	if let Some(year) = u64_of(release, "year").filter(|year| *year > 0) {
		meta.push(format!("**Year**: {year}"));
	}
	if let Some(country) = str_of(release, "country") {
		meta.push(format!("**Country**: {country}"));
	}
	let format = format_formats(arr_of(release, "formats"));
	if !format.is_empty() {
		meta.push(format!("**Format**: {format}"));
	}
	let labels = format_labels(arr_of(release, "labels"));
	if !labels.is_empty() {
		meta.push(format!("**Label**: {labels}"));
	}
	let genres = strs_of(release, "genres");
	if !genres.is_empty() {
		meta.push(format!("**Genre**: {}", genres.join(", ")));
	}
	let styles = strs_of(release, "styles");
	if !styles.is_empty() {
		meta.push(format!("**Style**: {}", styles.join(", ")));
	}
	if let Some(master) = u64_of(release, "master_id").filter(|master| *master > 0) {
		meta.push(format!("**Master Release**: [{master}](https://www.discogs.com/master/{master})"));
	}
	if !meta.is_empty() {
		sections.push(format!("{}\n", meta.join("\n")));
	}

	let tracklist = arr_of(release, "tracklist");
	if !tracklist.is_empty() {
		sections.push("## Tracklist\n".to_owned());
		sections.push(format!(
			"{}\n",
			tracklist
				.iter()
				.map(format_track)
				.collect::<Vec<_>>()
				.join("\n")
		));
	}
	let credits = format_credits(arr_of(release, "extraartists"));
	if !credits.is_empty() {
		sections.push("## Credits\n".to_owned());
		sections.push(format!("{credits}\n"));
	}
	if let Some(notes) = str_of(release, "notes") {
		sections.push("## Notes\n".to_owned());
		sections.push(format!("{notes}\n"));
	}
	sections.join("\n")
}

fn build_master(master: &Value) -> String {
	let mut sections: Vec<String> = Vec::new();
	let artist = format_artists(arr_of(master, "artists"));
	sections.push(format!("# {artist} - {}\n", str_of(master, "title").unwrap_or_default()));
	sections.push("*Master Release*\n".to_owned());

	let mut meta: Vec<String> = Vec::new();
	if let Some(year) = u64_of(master, "year").filter(|year| *year > 0) {
		meta.push(format!("**Year**: {year}"));
	}
	let genres = strs_of(master, "genres");
	if !genres.is_empty() {
		meta.push(format!("**Genre**: {}", genres.join(", ")));
	}
	let styles = strs_of(master, "styles");
	if !styles.is_empty() {
		meta.push(format!("**Style**: {}", styles.join(", ")));
	}
	if let Some(release) = u64_of(master, "main_release").filter(|release| *release > 0) {
		meta
			.push(format!("**Main Release**: [{release}](https://www.discogs.com/release/{release})"));
	}
	if let Some(sale) = u64_of(master, "num_for_sale").filter(|sale| *sale > 0) {
		meta.push(format!("**For Sale**: {sale} copies"));
		if let Some(price) = f64_of(master, "lowest_price") {
			meta.push(format!("**Lowest Price**: ${price:.2}"));
		}
	}
	if !meta.is_empty() {
		sections.push(format!("{}\n", meta.join("\n")));
	}

	let tracklist = arr_of(master, "tracklist");
	if !tracklist.is_empty() {
		sections.push("## Tracklist\n".to_owned());
		sections.push(format!(
			"{}\n",
			tracklist
				.iter()
				.map(format_track)
				.collect::<Vec<_>>()
				.join("\n")
		));
	}
	if let Some(notes) = str_of(master, "notes") {
		sections.push("## Notes\n".to_owned());
		sections.push(format!("{notes}\n"));
	}
	sections.join("\n")
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::super::{Fetched, testing::run};

	#[test]
	fn a_release_renders_tracks_and_credits() {
		let release = json!({
			"title": "Discovery",
			"artists": [{ "name": "Daft Punk" }],
			"year": 2001, "country": "France",
			"formats": [{ "name": "LP", "qty": "2", "descriptions": ["Album", "Reissue"] }],
			"labels": [{ "name": "Parlophone", "catno": "0190296617164" }],
			"genres": ["Electronic"], "styles": ["House"],
			"master_id": 96559,
			"tracklist": [
				{ "position": "A1", "title": "One More Time", "duration": "5:20", "artists": [{ "name": "Daft Punk" }] },
				{ "title": "Aerodynamic" }
			],
			"extraartists": [
				{ "name": "Guy-Manuel", "role": "Producer" },
				{ "name": "Pedro", "anv": "P. Winter", "role": "Producer" }
			],
			"notes": "Recorded in Paris."
		});
		let mut requests = Vec::new();
		let done = run("https://www.discogs.com/release/249504-Daft-Punk-Discovery", |request| {
			requests.push(request.url.clone());
			Fetched::json(&release)
		})
		.unwrap();
		assert_eq!(requests, ["https://api.discogs.com/releases/249504"]);
		assert_eq!((done.method, done.title.as_deref()), ("discogs", Some("Discovery")));
		let md = &done.markdown;
		assert!(md.starts_with("# Daft Punk - Discovery\n\n**Year**: 2001\n**Country**: France\n**Format**: 2× LP Album, Reissue\n**Label**: Parlophone (0190296617164)\n**Genre**: Electronic\n**Style**: House\n**Master Release**: [96559](https://www.discogs.com/master/96559)\n\n## Tracklist\n\nA1. One More Time (5:20) - Daft Punk\n- Aerodynamic\n"));
		assert!(md.contains("## Credits\n\n- **Producer**: Guy-Manuel, P. Winter\n"));
		assert!(md.contains("## Notes\n\nRecorded in Paris.\n"));
		assert_eq!(done.notes, ["Fetched via Discogs API (release)"]);
	}

	#[test]
	fn a_master_lists_versions_for_sale() {
		let master = json!({
			"title": "Never Gonna Give You Up",
			"artists": [{ "name": "Rick Astley", "join": "&" }, { "name": "Stock Aitken Waterman" }],
			"year": 1987, "main_release": 12345, "num_for_sale": 7, "lowest_price": 3.5
		});
		let done = run("https://www.discogs.com/master/96559", |_| Fetched::json(&master)).unwrap();
		let md = &done.markdown;
		assert!(md.starts_with("# Rick Astley & Stock Aitken Waterman - Never Gonna Give You Up\n\n*Master Release*\n\n**Year**: 1987\n**Main Release**: [12345](https://www.discogs.com/release/12345)\n**For Sale**: 7 copies\n**Lowest Price**: $3.50\n"));
		assert_eq!(done.notes, ["Fetched via Discogs API (master)"]);
	}

	#[test]
	fn other_pages_and_api_failures_fall_through() {
		assert_eq!(run("https://www.discogs.com/search/", |_| panic!("no fetch expected")), None);
		assert_eq!(run("https://example.test/release/1", |_| panic!("no fetch expected")), None);
		assert_eq!(run("https://www.discogs.com/release/249504", |_| Fetched::status(500)), None);
	}
}
