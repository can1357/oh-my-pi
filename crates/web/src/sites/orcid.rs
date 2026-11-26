//! ORCID (`orcid.org/<id>`): the public record API gives the person's name,
//! biography, affiliations and up to 50 work titles in one request.

use std::fmt::Write as _;

use serde_json::Value;
use url::Url;

use super::{Action, Context, Done, Fetch, Site, arr_of, fetch, str_of};

/// Registry entry.
pub const SITE: Site = Site { name: "orcid", open };

const METHOD: &str = "orcid-api";
/// Work titles listed.
const MAX_WORKS: usize = 50;

fn open(url: &Url, _: &Context) -> Option<Action> {
	if !matches!(url.host_str()?, "orcid.org" | "www.orcid.org") {
		return None;
	}
	let orcid = orcid_id(url.path())?;
	fetch(
		Fetch::get(format!("https://pub.orcid.org/v3.0/{orcid}/record")).accept_json(),
		move |reply, _| {
			let record = reply.json_value()?;
			let title = name_of(&record).unwrap_or_else(|| "ORCID Profile".to_owned());
			Done::new(record_markdown(&orcid, &record, &title), METHOD)
				.title(title)
				.note("Fetched via ORCID Public API")
				.finish()
		},
	)
}

/// The iD of a path segment shaped `<4>-<4>-<4>-<3><digit|X>`.
fn orcid_id(path: &str) -> Option<String> {
	path
		.split('/')
		.find(|segment| is_orcid(segment))
		.map(str::to_owned)
}

fn is_orcid(segment: &str) -> bool {
	let bytes = segment.as_bytes();
	if bytes.len() != 19 {
		return false;
	}
	bytes.iter().enumerate().all(|(index, byte)| match index {
		4 | 9 | 14 => *byte == b'-',
		18 => byte.is_ascii_digit() || byte.eq_ignore_ascii_case(&b'x'),
		_ => byte.is_ascii_digit(),
	})
}

/// Trimmed, non-empty string at `first.second`.
fn nested_str<'a>(value: &'a Value, first: &str, second: &str) -> Option<&'a str> {
	str_of(value.get(first)?, second)
}

/// The display name: credit name, else given and family names, else either one.
fn name_of(record: &Value) -> Option<String> {
	let name = record.get("person")?.get("name")?;
	if let Some(credit) = nested_str(name, "credit-name", "value") {
		return Some(credit.to_owned());
	}
	let given = nested_str(name, "given-names", "value");
	let family = nested_str(name, "family-name", "value");
	match (given, family) {
		(Some(given), Some(family)) => Some(format!("{given} {family}")),
		(Some(given), None) => Some(given.to_owned()),
		(None, Some(family)) => Some(family.to_owned()),
		(None, None) => None,
	}
}

fn biography(record: &Value) -> Option<&str> {
	str_of(record.get("person")?.get("biography")?, "content")
}

fn record_markdown(orcid: &str, record: &Value, title: &str) -> String {
	let activities = record.get("activities-summary");
	let employments = affiliations(activities, "employments", "employment-summary");
	let educations = affiliations(activities, "educations", "education-summary");
	let works = work_titles(activities);

	let mut md = format!("# {title}\n\n");
	let _ = writeln!(md, "**ORCID:** {orcid}");
	let _ = write!(md, "**ORCID Profile:** https://orcid.org/{orcid}\n\n");
	md.push_str("## Biography\n\n");
	match biography(record) {
		Some(text) => {
			md.push_str(text);
			md.push_str("\n\n");
		},
		None => md.push_str("No biography available.\n\n"),
	}

	md.push_str("## Affiliations\n\n");
	let mut has_affiliations = false;
	if !employments.is_empty() {
		has_affiliations = true;
		md.push_str("### Employment\n\n");
		for summary in &employments {
			if let Some(line) = affiliation(summary) {
				let _ = writeln!(md, "- {line}");
			}
		}
		md.push('\n');
	}
	if !educations.is_empty() {
		has_affiliations = true;
		md.push_str("### Education\n\n");
		for summary in &educations {
			if let Some(line) = affiliation(summary) {
				let _ = writeln!(md, "- {line}");
			}
		}
		md.push('\n');
	}
	if !has_affiliations {
		md.push_str("No affiliations available.\n\n");
	}

	md.push_str("## Works\n\n");
	if works.is_empty() {
		md.push_str("No works available.\n");
	} else {
		for title in &works {
			let _ = writeln!(md, "- {title}");
		}
	}
	md
}

/// Affiliation summaries of one container: its direct list plus its groups.
fn affiliations<'a>(activities: Option<&'a Value>, container: &str, key: &str) -> Vec<&'a Value> {
	let Some(container) = activities.and_then(|activities| activities.get(container)) else {
		return Vec::new();
	};
	let mut summaries: Vec<&Value> = arr_of(container, key).iter().collect();
	for group in arr_of(container, "affiliation-group") {
		for summary in arr_of(group, "summaries") {
			if let Some(entry) = summary.get(key) {
				summaries.push(entry);
			}
		}
	}
	summaries
}

/// One `- Label (details)` line for an affiliation summary.
fn affiliation(summary: &Value) -> Option<String> {
	let organization = summary
		.get("organization")
		.and_then(|organization| str_of(organization, "name"));
	let role = str_of(summary, "role-title");
	let department = str_of(summary, "department-name");
	let address = summary
		.get("organization")
		.and_then(|organization| organization.get("address"));
	let location_parts: Vec<&str> = ["city", "region", "country"]
		.iter()
		.filter_map(|key| address.and_then(|address| str_of(address, key)))
		.collect();
	let location = (!location_parts.is_empty()).then(|| location_parts.join(", "));
	let dates =
		match (summary.get("start-date").and_then(date), summary.get("end-date").and_then(date)) {
			(Some(start), Some(end)) => Some(format!("{start} - {end}")),
			(Some(start), None) => Some(format!("{start} - Present")),
			(None, Some(end)) => Some(format!("Until {end}")),
			(None, None) => None,
		};

	let label = organization.or(role).or(department)?;
	let mut details: Vec<String> = Vec::new();
	match (organization, role) {
		(Some(_), Some(role)) => details.push(role.to_owned()),
		(None, Some(_)) => {
			if let Some(department) = department {
				details.push(department.to_owned());
			}
		},
		_ => {},
	}
	if let (Some(_), Some(department)) = (organization, department) {
		details.push(format!("Dept: {department}"));
	}
	if let Some(location) = location {
		details.push(format!("Location: {location}"));
	}
	if let Some(dates) = dates {
		details.push(format!("Dates: {dates}"));
	}

	if details.is_empty() {
		Some(label.to_owned())
	} else {
		Some(format!("{label} ({})", details.join("; ")))
	}
}

/// `YYYY[-MM[-DD]]` of an ORCID date object.
fn date(value: &Value) -> Option<String> {
	let year = nested_str(value, "year", "value")?;
	let month = nested_str(value, "month", "value");
	let day = nested_str(value, "day", "value");
	match (month, day) {
		(Some(month), Some(day)) => Some(format!("{year}-{month:0>2}-{day:0>2}")),
		(Some(month), None) => Some(format!("{year}-{month:0>2}")),
		(None, _) => Some(year.to_owned()),
	}
}

/// Up to `MAX_WORKS` distinct work titles from the works container.
fn work_titles(activities: Option<&Value>) -> Vec<String> {
	let Some(groups) = activities
		.and_then(|activities| activities.get("works"))
		.map(|works| arr_of(works, "group"))
	else {
		return Vec::new();
	};
	let mut titles: Vec<String> = Vec::new();
	for group in groups {
		for summary in arr_of(group, "work-summary") {
			let Some(title) = summary
				.get("title")
				.and_then(|title| title.get("title"))
				.and_then(|title| str_of(title, "value"))
			else {
				continue;
			};
			if titles.iter().any(|existing| existing.as_str() == title) {
				continue;
			}
			titles.push(title.to_owned());
			if titles.len() >= MAX_WORKS {
				return titles;
			}
		}
	}
	titles
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::super::{Fetched, testing::run};

	fn record() -> serde_json::Value {
		json!({
			"orcid-identifier": { "path": "0000-0002-1825-0097" },
			"person": {
				"name": { "given-names": { "value": "Josiah" }, "family-name": { "value": "Carberry" } },
				"biography": { "content": "  A fictional researcher.  " }
			},
			"activities-summary": {
				"employments": {
					"affiliation-group": [ { "summaries": [ { "employment-summary": {
						"organization": { "name": "Brown University", "address": { "city": "Providence", "region": "RI", "country": "US" } },
						"role-title": "Professor", "department-name": "Biology",
						"start-date": { "year": { "value": "2015" }, "month": { "value": "3" }, "day": { "value": "1" } }
					} } ] } ]
				},
				"educations": {
					"education-summary": [ {
						"organization": { "name": "MIT" },
						"department-name": "Physics",
						"end-date": { "year": { "value": "2010" } }
					} ]
				},
				"works": {
					"group": [
						{ "work-summary": [ { "title": { "title": { "value": "First Paper" } } } ] },
						{ "work-summary": [
							{ "title": { "title": { "value": "Second Paper" } } },
							{ "title": { "title": { "value": "First Paper" } } }
						] }
					]
				}
			}
		})
	}

	#[test]
	fn a_record_renders_person_affiliations_and_works() {
		let done = run("https://orcid.org/0000-0002-1825-0097", |request| {
			assert_eq!(request.url, "https://pub.orcid.org/v3.0/0000-0002-1825-0097/record");
			assert!(
				request
					.headers
					.iter()
					.any(|(name, value)| name == "Accept" && value == "application/json")
			);
			Fetched::json(&record())
		})
		.unwrap();
		assert_eq!(done.method, "orcid-api");
		assert_eq!(done.title.as_deref(), Some("Josiah Carberry"));
		assert_eq!(done.notes, ["Fetched via ORCID Public API"]);
		assert_eq!(
			done.markdown,
			"# Josiah Carberry\n\n**ORCID:** 0000-0002-1825-0097\n**ORCID Profile:** https://orcid.org/0000-0002-1825-0097\n\n\
			 ## Biography\n\nA fictional researcher.\n\n\
			 ## Affiliations\n\n### Employment\n\n\
			 - Brown University (Professor; Dept: Biology; Location: Providence, RI, US; Dates: 2015-03-01 - Present)\n\n\
			 ### Education\n\n- MIT (Dept: Physics; Dates: Until 2010)\n\n\
			 ## Works\n\n- First Paper\n- Second Paper\n"
		);
	}

	#[test]
	fn a_record_without_a_name_or_activity_says_so() {
		let done = run("https://www.orcid.org/0000-0002-1825-0097/record", |_| {
			Fetched::json(&json!({ "person": {}, "activities-summary": {} }))
		})
		.unwrap();
		assert_eq!(done.title.as_deref(), Some("ORCID Profile"));
		assert!(
			done
				.markdown
				.starts_with("# ORCID Profile\n\n**ORCID:** 0000-0002-1825-0097\n")
		);
		assert!(done.markdown.contains(
			"## Biography\n\nNo biography available.\n\n## Affiliations\n\nNo affiliations \
			 available.\n\n## Works\n\nNo works available.\n"
		));
	}

	#[test]
	fn other_pages_and_api_failures_fall_through() {
		assert_eq!(run("https://orcid.org/about", |_| panic!("no fetch expected")), None);
		assert_eq!(
			run("https://example.com/0000-0002-1825-0097", |_| panic!("no fetch expected")),
			None
		);
		assert_eq!(run("https://orcid.org/0000-0002-1825-0097", |_| Fetched::status(404)), None);
	}
}
