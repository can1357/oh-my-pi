//! `CoinGecko` (`coingecko.com/coins/<id>` and `/en/coins/<id>`): price, market
//! data, supply, links and the description of one asset from the public API.

use std::fmt::Write as _;

use serde_json::Value;
use url::Url;

use super::{
	Action, Context, Done, Fetch, Site, arr_of, f64_of, fetch, format_number, iso_date, str_of,
};

/// Registry entry.
pub const SITE: Site = Site { name: "coingecko", open };

const METHOD: &str = "coingecko";
const MONTHS: [&str; 12] =
	["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

fn open(url: &Url, _: &Context) -> Option<Action> {
	if !url.host_str()?.contains("coingecko.com") {
		return None;
	}
	let parts: Vec<&str> = url
		.path()
		.trim_start_matches('/')
		.split('/')
		.filter(|part| !part.is_empty())
		.collect();
	let coin_id = match parts.as_slice() {
		["coins", id, ..] => *id,
		[locale, "coins", id, ..]
			if locale.len() == 2 && locale.bytes().all(|byte| byte.is_ascii_lowercase()) =>
		{
			*id
		},
		_ => return None,
	};
	let coin_id = percent_decode(coin_id);
	let api = format!(
		"https://api.coingecko.com/api/v3/coins/{coin_id}?localization=false&tickers=false&community_data=false&developer_data=false"
	);

	fetch(Fetch::get(api).accept_json(), move |reply, _| {
		let coin = reply.json_value()?;
		let name = str_of(&coin, "name").unwrap_or(&coin_id);
		let symbol = str_of(&coin, "symbol").unwrap_or_default().to_uppercase();
		let market = coin.get("market_data");
		let group = |key: &str, field: &str| {
			market
				.and_then(|market| market.get(key))
				.and_then(|value| f64_of(value, field))
		};

		let mut md = format!("# {name} ({symbol})\n\n");
		if let Some(price) = group("current_price", "usd") {
			let _ = write!(md, "**Price:** ${}", format_price(price));
			if let Some(change) =
				market.and_then(|market| f64_of(market, "price_change_percentage_24h"))
			{
				let sign = if change >= 0.0 { "+" } else { "" };
				let _ = write!(md, " ({sign}{change:.2}% 24h)");
			}
			md.push('\n');
		}
		if let Some(cap) = group("market_cap", "usd").filter(|cap| *cap != 0.0) {
			let _ = writeln!(md, "**Market Cap:** ${}", format_number(cap));
		}
		if let Some(volume) = group("total_volume", "usd").filter(|volume| *volume != 0.0) {
			let _ = writeln!(md, "**24h Volume:** ${}", format_number(volume));
		}
		if let Some(high) = group("ath", "usd") {
			let _ = write!(md, "**All-Time High:** ${}", format_price(high));
			if let Some(date) = market
				.and_then(|market| market.get("ath_date"))
				.and_then(|dates| str_of(dates, "usd"))
				.and_then(short_date)
			{
				let _ = write!(md, " ({date})");
			}
			md.push('\n');
		}
		md.push('\n');

		if let Some(circulating) = market
			.and_then(|market| f64_of(market, "circulating_supply"))
			.filter(|supply| *supply != 0.0)
		{
			let _ = write!(md, "**Circulating Supply:** {}", format_number(circulating.round()));
			if let Some(maximum) = market
				.and_then(|market| f64_of(market, "max_supply"))
				.filter(|supply| *supply != 0.0)
			{
				let _ = write!(
					md,
					" / {} ({:.1}%)",
					format_number(maximum.round()),
					circulating / maximum * 100.0
				);
			} else if let Some(total) = market
				.and_then(|market| f64_of(market, "total_supply"))
				.filter(|supply| *supply != 0.0)
			{
				let _ = write!(md, " / {} total", format_number(total.round()));
			}
			md.push('\n');
		}
		if let Some(genesis) = str_of(&coin, "genesis_date") {
			let _ = writeln!(md, "**Launch Date:** {genesis}");
		}
		let categories: Vec<&str> = arr_of(&coin, "categories")
			.iter()
			.filter_map(Value::as_str)
			.collect();
		if !categories.is_empty() {
			let _ = writeln!(md, "**Categories:** {}", categories.join(", "));
		}

		let links = coin.get("links");
		let mut row: Vec<String> = Vec::new();
		if let Some(homepage) = first_link(links, "homepage") {
			row.push(format!("[Website]({homepage})"));
		}
		if let Some(explorer) = first_link(links, "blockchain_site") {
			row.push(format!("[Explorer]({explorer})"));
		}
		if let Some(github) = links
			.and_then(|links| links.get("repos_url"))
			.and_then(|repos| first_link(Some(repos), "github"))
		{
			row.push(format!("[GitHub]({github})"));
		}
		if !row.is_empty() {
			let _ = writeln!(md, "**Links:** {}", row.join(" · "));
		}

		if let Some(description) = coin
			.get("description")
			.and_then(|description| str_of(description, "en"))
		{
			let description = strip_tags(description).replace("\r\n", "\n");
			let description = description.trim();
			if !description.is_empty() {
				let _ = write!(md, "\n## About\n\n{description}\n");
			}
		}
		Done::new(md, METHOD)
			.title(format!("{name} ({symbol})"))
			.note("Fetched via CoinGecko API")
			.finish()
	})
}

fn first_link<'a>(section: Option<&'a Value>, key: &str) -> Option<&'a str> {
	section
		.and_then(|section| arr_of(section, key).first())
		.and_then(Value::as_str)
		.map(str::trim)
		.filter(|link| !link.is_empty())
}

/// The TS handler's `formatPrice`: more decimals the smaller the price.
fn format_price(price: f64) -> String {
	if price >= 1_000.0 {
		let rounded = format!("{:.2}", (price * 100.0).round() / 100.0);
		with_commas(rounded.trim_end_matches('0').trim_end_matches('.'))
	} else if price >= 1.0 {
		format!("{price:.2}")
	} else if price >= 0.01 {
		format!("{price:.4}")
	} else if price >= 0.0001 {
		format!("{price:.6}")
	} else {
		format!("{price:.8}")
	}
}

fn with_commas(text: &str) -> String {
	let (integer, fraction) = text.split_once('.').unwrap_or((text, ""));
	let digits: Vec<char> = integer.chars().collect();
	let mut out = String::with_capacity(text.len() + digits.len() / 3);
	for (index, digit) in digits.iter().enumerate() {
		if index > 0 && (digits.len() - index).is_multiple_of(3) {
			out.push(',');
		}
		out.push(*digit);
	}
	if !fraction.is_empty() {
		out.push('.');
		out.push_str(fraction);
	}
	out
}

/// `Dec 17, 2017` of an ISO timestamp, `toLocaleDateString("en-US")`-style.
fn short_date(iso: &str) -> Option<String> {
	let date = iso_date(iso)?;
	let mut parts = date.split('-');
	let year: i32 = parts.next()?.parse().ok()?;
	let month = MONTHS.get(parts.next()?.parse::<usize>().ok()?.checked_sub(1)?)?;
	let day: u32 = parts.next()?.parse().ok()?;
	Some(format!("{month} {day}, {year}"))
}

/// `<[^>]+>` removal.
fn strip_tags(html: &str) -> String {
	let mut out = String::with_capacity(html.len());
	let mut in_tag = false;
	for ch in html.chars() {
		match ch {
			'<' => in_tag = true,
			'>' => in_tag = false,
			_ if !in_tag => out.push(ch),
			_ => {},
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
	use serde_json::{Value, json};

	use super::super::{Fetched, testing::run};

	fn bitcoin() -> Value {
		json!({
			"id": "bitcoin", "symbol": "btc", "name": "Bitcoin",
			"description": { "en": "<p>Bitcoin is a <b>decentralized</b> digital currency.</p>" },
			"links": {
				"homepage": ["https://bitcoin.org"],
				"blockchain_site": ["https://blockchair.com/bitcoin"],
				"repos_url": { "github": ["https://github.com/bitcoin/bitcoin"] }
			},
			"market_data": {
				"current_price": { "usd": 67_890.12 },
				"market_cap": { "usd": 1_340_000_000.0 },
				"total_volume": { "usd": 42_000_000_000.0 },
				"price_change_percentage_24h": 2.5,
				"ath": { "usd": 69_044.0 },
				"ath_date": { "usd": "2021-11-10T14:24:11.849Z" },
				"circulating_supply": 19_000_000.0,
				"max_supply": 21_000_000.0
			},
			"categories": ["Cryptocurrency", "Proof of Work"],
			"genesis_date": "2009-01-03"
		})
	}

	#[test]
	fn a_coin_page_renders_market_data_links_and_the_stripped_description() {
		let mut requests = Vec::new();
		let done = run("https://www.coingecko.com/en/coins/bitcoin", |request| {
			requests.push(request.url.clone());
			Fetched::json(&bitcoin())
		})
		.unwrap();
		assert_eq!(
			requests,
			["https://api.coingecko.com/api/v3/coins/bitcoin?localization=false&tickers=false&community_data=false&developer_data=false"]
		);
		assert_eq!((done.method, done.title.as_deref()), ("coingecko", Some("Bitcoin (BTC)")));
		let md = &done.markdown;
		assert!(md.starts_with("# Bitcoin (BTC)\n\n**Price:** $67,890.12 (+2.50% 24h)\n"));
		assert!(md.contains("**Market Cap:** $1.3B\n"));
		assert!(md.contains("**24h Volume:** $42B\n"));
		assert!(md.contains("**All-Time High:** $69,044 (Nov 10, 2021)\n"));
		assert!(md.contains("**Circulating Supply:** 19M / 21M (90.5%)\n"));
		assert!(
			md.contains(
				"**Launch Date:** 2009-01-03\n**Categories:** Cryptocurrency, Proof of Work\n"
			)
		);
		assert!(md.contains(
			"**Links:** [Website](https://bitcoin.org) · [Explorer](https://blockchair.com/bitcoin) · [GitHub](https://github.com/bitcoin/bitcoin)\n"
		));
		assert!(md.contains("\n## About\n\nBitcoin is a decentralized digital currency.\n"));
	}

	#[test]
	fn a_small_price_gets_more_decimals_and_an_empty_asset_still_renders() {
		let done = run("https://www.coingecko.com/coins/doge", |request| {
			assert_eq!(
				request.url,
				"https://api.coingecko.com/api/v3/coins/doge?localization=false&tickers=false&community_data=false&developer_data=false"
			);
			Fetched::json(&json!({ "name": "Dogecoin", "symbol": "doge", "market_data": { "current_price": { "usd": 0.5 } } }))
		})
		.unwrap();
		assert_eq!(done.markdown, "# Dogecoin (DOGE)\n\n**Price:** $0.5000\n\n");

		let empty = run("https://www.coingecko.com/en/coins/novalue", |_| {
			Fetched::json(&json!({ "name": "Novalue", "symbol": "nov" }))
		})
		.unwrap();
		assert_eq!(empty.markdown, "# Novalue (NOV)\n\n\n");
	}

	#[test]
	fn other_hosts_other_paths_and_failures_fall_through() {
		assert_eq!(
			run("https://www.coingecko.com/en/categories", |_| panic!("no fetch expected")),
			None
		);
		assert_eq!(run("https://example.com/coins/bitcoin", |_| panic!("no fetch expected")), None);
		assert_eq!(run("https://www.coingecko.com/en/coins/bitcoin", |_| Fetched::status(429)), None);
		assert_eq!(
			run("https://www.coingecko.com/en/coins/bitcoin", |_| Fetched::text(
				"text/html",
				"<html></html>"
			)),
			None
		);
	}
}
