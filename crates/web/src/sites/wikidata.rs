//! Wikidata (`wikidata.org/wiki/Q…`): an entity's labels, description, aliases,
//! claims and notable Wikipedia sitelinks from the `EntityData` API, with the
//! referenced entities' labels resolved in one `wbgetentities` query.

use std::{cmp::Ordering, collections::HashMap, fmt::Write as _};

use serde_json::Value;
use url::Url;

use super::{
	Action, Context, Done, Fetch, Site, arr_of, f64_of, fetch, format_number, segment, u64_of,
};

/// Registry entry.
pub const SITE: Site = Site { name: "wikidata", open };

const METHOD: &str = "wikidata";
/// Values listed per property.
const VALUES_PER_PROPERTY: usize = 10;
/// Properties listed.
const PROPERTIES: usize = 50;
/// Referenced entities whose labels are resolved.
const RESOLVED_ENTITIES: usize = 50;
/// Languages linked at the end, in order.
const NOTABLE_SITES: &[&str] = &["enwiki", "dewiki", "frwiki", "eswiki", "jawiki", "zhwiki"];

/// Human-readable names for the properties worth naming.
const PROPERTY_LABELS: &[(&str, &str)] = &[
	("P31", "Instance of"),
	("P279", "Subclass of"),
	("P17", "Country"),
	("P131", "Located in"),
	("P625", "Coordinates"),
	("P18", "Image"),
	("P154", "Logo"),
	("P571", "Founded"),
	("P576", "Dissolved"),
	("P169", "CEO"),
	("P112", "Founded by"),
	("P159", "Headquarters"),
	("P452", "Industry"),
	("P1128", "Employees"),
	("P2139", "Revenue"),
	("P856", "Website"),
	("P21", "Sex/Gender"),
	("P27", "Citizenship"),
	("P569", "Born"),
	("P570", "Died"),
	("P19", "Birthplace"),
	("P20", "Death place"),
	("P106", "Occupation"),
	("P108", "Employer"),
	("P69", "Educated at"),
	("P22", "Father"),
	("P25", "Mother"),
	("P26", "Spouse"),
	("P40", "Child"),
	("P166", "Award"),
	("P136", "Genre"),
	("P495", "Country of origin"),
	("P577", "Publication date"),
	("P50", "Author"),
	("P123", "Publisher"),
	("P364", "Original language"),
	("P86", "Composer"),
	("P57", "Director"),
	("P161", "Cast member"),
	("P170", "Creator"),
	("P178", "Developer"),
	("P275", "License"),
	("P306", "Operating system"),
	("P277", "Programming language"),
	("P348", "Version"),
	("P1566", "GeoNames ID"),
	("P214", "VIAF ID"),
	("P227", "GND ID"),
	("P213", "ISNI"),
	("P496", "ORCID"),
];

fn open(url: &Url, _: &Context) -> Option<Action> {
	if !url.host_str()?.contains("wikidata.org") {
		return None;
	}
	let qid = qid(url.path())?;
	let entity_url = format!("https://www.wikidata.org/wiki/Special:EntityData/{qid}.json");
	fetch(Fetch::get(entity_url), move |reply, _| {
		let data = reply.json_value()?;
		let entity = data.get("entities")?.get(&qid)?;
		let ids = referenced_entities(entity);
		if ids.is_empty() {
			return finish(&qid, entity, &HashMap::new());
		}
		let query = format!(
			"https://www.wikidata.org/w/api.php?action=wbgetentities&ids={}&props=labels&languages=en&format=json",
			ids.join("|")
		);
		fetch(Fetch::get(query), move |reply, _| {
			// Labels are decoration; a failed query still leaves the entity read.
			let labels = reply
				.json_value()
				.map_or_else(HashMap::new, |data| label_map(&data));
			let entity = data.get("entities")?.get(&qid)?;
			finish(&qid, entity, &labels)
		})
	})
}

fn finish(qid: &str, entity: &Value, labels: &HashMap<String, String>) -> Option<Action> {
	Done::new(render(qid, entity, labels), METHOD)
		.note("Fetched via Wikidata EntityData API")
		.finish()
}

/// The `Q…` id of a `/wiki/…` or `/entity/…` path, uppercased.
fn qid(path: &str) -> Option<String> {
	let lower = path.to_ascii_lowercase();
	let (at, len) = ["/wiki/", "/entity/"]
		.iter()
		.filter_map(|marker| lower.find(marker).map(|at| (at, marker.len())))
		.min_by_key(|(at, _)| *at)?;
	let rest = &path[at + len..];
	if !matches!(rest.as_bytes().first(), Some(b'Q' | b'q')) {
		return None;
	}
	let digits = rest[1..].bytes().take_while(u8::is_ascii_digit).count();
	(digits > 0).then(|| format!("Q{}", &rest[1..=digits]))
}

/// The referenced entity ids of the claims, in first-seen order.
fn referenced_entities(entity: &Value) -> Vec<String> {
	let mut ids = Vec::new();
	let Some(claims) = entity.get("claims").and_then(Value::as_object) else {
		return ids;
	};
	for claims in claims.values() {
		for claim in claims.as_array().into_iter().flatten() {
			let Some(id) = wikibase_id(claim) else {
				continue;
			};
			if !ids.iter().any(|seen| seen.as_str() == id) {
				ids.push(id.to_owned());
			}
			if ids.len() == RESOLVED_ENTITIES {
				return ids;
			}
		}
	}
	ids
}

/// The `id` of a `wikibase-entityid` main snak.
fn wikibase_id(claim: &Value) -> Option<&str> {
	let datavalue = claim.get("mainsnak")?.get("datavalue")?;
	if datavalue.get("type")?.as_str()? != "wikibase-entityid" {
		return None;
	}
	datavalue.get("value")?.get("id")?.as_str()
}

/// `id` to English label from a `wbgetentities` reply.
fn label_map(data: &Value) -> HashMap<String, String> {
	data
		.get("entities")
		.and_then(Value::as_object)
		.into_iter()
		.flatten()
		.filter_map(|(id, entity)| {
			let label = entity
				.pointer("/labels/en/value")
				.and_then(Value::as_str)
				.filter(|label| !label.is_empty())?;
			Some((id.clone(), label.to_owned()))
		})
		.collect()
}

/// A localized value of `key`, preferring `lang` then any language.
fn localized(entity: &Value, key: &str, lang: &str) -> Option<String> {
	let map = entity.get(key)?.as_object()?;
	if let Some(entry) = map.get(lang) {
		return entry
			.get("value")
			.and_then(Value::as_str)
			.map(str::to_owned);
	}
	map.values()
		.find_map(|entry| entry.get("value").and_then(Value::as_str))
		.map(str::to_owned)
}

fn aliases(entity: &Value, lang: &str) -> Vec<String> {
	let empty = Value::Null;
	arr_of(entity.get("aliases").unwrap_or(&empty), lang)
		.iter()
		.filter_map(|alias| alias.get("value").and_then(Value::as_str))
		.map(str::to_owned)
		.collect()
}

fn prop_label(id: &str) -> &str {
	PROPERTY_LABELS
		.iter()
		.find(|(key, _)| *key == id)
		.map_or(id, |(_, label)| label)
}

/// Whether a rendered property line names a known property.
fn known(line: &str) -> bool {
	line
		.strip_prefix("- **")
		.and_then(|rest| rest.split_once(":**"))
		.is_some_and(|(label, _)| PROPERTY_LABELS.iter().any(|(_, name)| *name == label))
}

fn render(qid: &str, entity: &Value, labels: &HashMap<String, String>) -> String {
	let label = localized(entity, "labels", "en").unwrap_or_else(|| qid.to_owned());
	let description =
		localized(entity, "descriptions", "en").filter(|description| !description.is_empty());
	let aliases = aliases(entity, "en");

	let mut md = format!("# {label} ({qid})\n\n");
	if let Some(description) = description {
		let _ = write!(md, "*{description}*\n\n");
	}
	if !aliases.is_empty() {
		let _ = write!(md, "**Also known as:** {}\n\n", aliases.join(", "));
	}
	let sitelinks = entity.get("sitelinks").and_then(Value::as_object);
	let sitelink_count = sitelinks.map_or(0, |sitelinks| sitelinks.len());
	if sitelink_count > 0 {
		let _ = write!(
			md,
			"**Wikipedia articles:** {} languages\n\n",
			format_number(sitelink_count as f64)
		);
	}

	if let Some(claims) = entity.get("claims").and_then(Value::as_object)
		&& !claims.is_empty()
	{
		md.push_str("## Properties\n\n");
		let mut lines = Vec::new();
		for (property, claims) in claims {
			let mut values: Vec<String> = Vec::new();
			for claim in claims.as_array().into_iter().flatten() {
				if claim.get("rank").and_then(Value::as_str) == Some("deprecated") {
					continue;
				}
				if let Some(value) = claim_value(claim, labels)
					&& !value.is_empty()
					&& !values.contains(&value)
				{
					values.push(value);
				}
			}
			if values.is_empty() {
				continue;
			}
			let shown = values
				.iter()
				.take(VALUES_PER_PROPERTY)
				.cloned()
				.collect::<Vec<_>>()
				.join(", ");
			let overflow = if values.len() > VALUES_PER_PROPERTY {
				format!(" […{} values elided…]", values.len() - VALUES_PER_PROPERTY)
			} else {
				Default::default()
			};
			lines.push(format!("- **{}:** {shown}{overflow}", prop_label(property)));
		}
		lines.sort_by(|a, b| match (known(a), known(b)) {
			(true, false) => Ordering::Less,
			(false, true) => Ordering::Greater,
			_ => a.cmp(b),
		});
		let shown = lines
			.iter()
			.take(PROPERTIES)
			.cloned()
			.collect::<Vec<_>>()
			.join("\n");
		md.push_str(&shown);
		if lines.len() > PROPERTIES {
			let _ = write!(md, "\n\n[…{} properties elided…]", lines.len() - PROPERTIES);
		}
		md.push('\n');
	}

	if let Some(sitelinks) = sitelinks {
		let links = NOTABLE_SITES
			.iter()
			.filter_map(|site| {
				let title = sitelinks.get(*site)?.get("title")?.as_str()?;
				let lang = site.strip_suffix("wiki").unwrap_or(*site);
				Some(format!(
					"[{}](https://{lang}.wikipedia.org/wiki/{})",
					lang.to_uppercase(),
					segment(title)
				))
			})
			.collect::<Vec<_>>();
		if !links.is_empty() {
			let _ = write!(md, "\n## Wikipedia Links\n\n{}\n", links.join(" · "));
		}
	}
	md
}

/// A claim's main snak as display text.
fn claim_value(claim: &Value, labels: &HashMap<String, String>) -> Option<String> {
	let snak = claim.get("mainsnak")?;
	if snak.get("snaktype")?.as_str()? != "value" {
		return None;
	}
	let datavalue = snak.get("datavalue")?;
	let value = datavalue.get("value")?;
	match datavalue.get("type")?.as_str()? {
		"wikibase-entityid" => {
			let id = value.get("id")?.as_str()?;
			Some(labels.get(id).cloned().unwrap_or_else(|| id.to_owned()))
		},
		"string" => Some(value.as_str()?.to_owned()),
		"time" => {
			let time = value.get("time")?.as_str()?;
			Some(time_text(time, u64_of(value, "precision").unwrap_or(0)))
		},
		"quantity" => {
			let amount = value.get("amount")?.as_str()?;
			let amount = amount.strip_prefix('+').unwrap_or(amount);
			let unit = value
				.get("unit")
				.and_then(Value::as_str)
				.and_then(unit_id)
				.and_then(|id| labels.get(id));
			Some(match unit {
				Some(unit) => format!("{amount} {unit}"),
				None => amount.to_owned(),
			})
		},
		"monolingualtext" => Some(value.get("text")?.as_str()?.to_owned()),
		"globecoordinate" => {
			Some(format!("{:.4}, {:.4}", f64_of(value, "latitude")?, f64_of(value, "longitude")?))
		},
		_ => None,
	}
}

/// The trailing `Q…` of a quantity's unit URL.
fn unit_id(unit: &str) -> Option<&str> {
	let at = unit.rfind('Q')?;
	let digits = &unit[at + 1..];
	(!digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())).then(|| &unit[at..])
}

/// `DD/MM/YYYY`, `MM/YYYY` or `YYYY`, with ` BCE` for negative years.
fn time_text(time: &str, precision: u64) -> String {
	let (sign, rest) = match time.strip_prefix('-') {
		Some(rest) => (-1, rest),
		None => (1, time.strip_prefix('+').unwrap_or(time)),
	};
	let mut parts = rest.split('-');
	let (Some(year), Some(month), Some(day)) = (parts.next(), parts.next(), parts.next()) else {
		return time.to_owned();
	};
	if year.is_empty() || !year.bytes().all(|byte| byte.is_ascii_digit()) {
		return time.to_owned();
	}
	let (Some(month), Some(day)) = (month.get(..2), day.get(..2)) else {
		return time.to_owned();
	};
	if !month.bytes().all(|byte| byte.is_ascii_digit())
		|| !day.bytes().all(|byte| byte.is_ascii_digit())
	{
		return time.to_owned();
	}
	let year = year.parse::<i64>().unwrap_or(0) * sign;
	let era = if year < 0 { " BCE" } else { "" };
	let year = year.abs();
	if precision >= 11 {
		format!("{day}/{month}/{year}{era}")
	} else if precision >= 10 {
		format!("{month}/{year}{era}")
	} else {
		format!("{year}{era}")
	}
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::super::{Fetched, testing::run};

	#[test]
	fn an_entity_reads_its_claims_and_resolves_referenced_labels() {
		let entity = json!({
			"entities": { "Q312": {
				"type": "item", "id": "Q312",
				"labels": { "en": { "language": "en", "value": "Apple Inc." } },
				"descriptions": { "en": { "language": "en", "value": "American technology company" } },
				"aliases": { "en": [{ "language": "en", "value": "Apple" }] },
				"claims": {
					"P31": [{ "mainsnak": { "snaktype": "value", "property": "P31",
						"datavalue": { "type": "wikibase-entityid", "value": { "entity-type": "item", "id": "Q4830453", "numeric-id": 4830453 } } }, "rank": "normal" }],
					"P571": [{ "mainsnak": { "snaktype": "value", "property": "P571",
						"datavalue": { "type": "time", "value": { "time": "+1976-04-01T00:00:00Z", "precision": 11 } } }, "rank": "normal" }],
					"P856": [{ "mainsnak": { "snaktype": "value", "property": "P856",
						"datavalue": { "type": "string", "value": "https://www.apple.com" } }, "rank": "normal" }],
					"P625": [{ "mainsnak": { "snaktype": "value", "property": "P625",
						"datavalue": { "type": "globecoordinate", "value": { "latitude": 37.33182, "longitude": -122.03118, "precision": 0.0001 } } }, "rank": "normal" }]
				},
				"sitelinks": { "enwiki": { "site": "enwiki", "title": "Apple Inc." }, "dewiki": { "site": "dewiki", "title": "Apple" } }
			} }
		});
		let mut requests = Vec::new();
		let done = run("https://www.wikidata.org/wiki/Q312", |request| {
			requests.push(request.url.clone());
			if request.url.contains("Special:EntityData") {
				Fetched::json(&entity)
			} else {
				Fetched::json(
					&json!({ "entities": { "Q4830453": { "labels": { "en": { "value": "business" } } } } }),
				)
			}
		})
		.unwrap();
		assert_eq!(requests, [
			"https://www.wikidata.org/wiki/Special:EntityData/Q312.json",
			"https://www.wikidata.org/w/api.php?action=wbgetentities&ids=Q4830453&props=labels&languages=en&format=json"
		]);
		assert_eq!(done.method, "wikidata");
		assert_eq!(done.notes, ["Fetched via Wikidata EntityData API"]);
		assert_eq!(
			done.markdown,
			"# Apple Inc. (Q312)\n\n*American technology company*\n\n**Also known as:** Apple\n\n**Wikipedia articles:** 2 languages\n\n## Properties\n\n- **Coordinates:** 37.3318, -122.0312\n- **Founded:** 01/04/1976\n- **Instance of:** business\n- **Website:** https://www.apple.com\n\n## Wikipedia Links\n\n[EN](https://en.wikipedia.org/wiki/Apple%20Inc.) · [DE](https://de.wikipedia.org/wiki/Apple)\n"
		);
	}

	#[test]
	fn an_entity_without_claims_still_links_its_wikis() {
		let done = run("https://www.wikidata.org/entity/Q2", |_| {
			Fetched::json(&json!({
				"entities": { "Q2": { "labels": { "en": { "value": "Earth" } },
					"sitelinks": { "zhwiki": { "title": "地球" } } } }
			}))
		})
		.unwrap();
		assert_eq!(
			done.markdown,
			"# Earth (Q2)\n\n**Wikipedia articles:** 1 languages\n\n\n## Wikipedia Links\n\n[ZH](https://zh.wikipedia.org/wiki/%E5%9C%B0%E7%90%83)\n"
		);
	}

	#[test]
	fn other_urls_and_api_failures_fall_through() {
		assert_eq!(
			run("https://www.wikidata.org/wiki/Special:EntityData/Q312.json", |_| panic!(
				"no fetch expected"
			)),
			None
		);
		assert_eq!(run("https://example.com/wiki/Q312", |_| panic!("no fetch expected")), None);
		assert_eq!(run("https://www.wikidata.org/wiki/Q312", |_| Fetched::status(404)), None);
	}
}
