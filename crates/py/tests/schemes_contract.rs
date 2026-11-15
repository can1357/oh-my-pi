//! Embedded contract for the `omp.schemes` declaration surface (ADR 0050 S1).

use omp_py::{
	Engine,
	pyo3::{
		ffi::c_str,
		types::{PyDict, PyDictMethods},
	},
};

const URL_VOCAB_JSON: &str = include_str!("../../tools/url-vocab.json");

#[test]
fn declared_schemes_refuse_builtins_and_stay_inert() {
	let engine = Engine::builder().init().expect("embedded Python boots");
	engine
		.attach(|py| {
			let globals = PyDict::new(py);
			globals.set_item("URL_VOCAB_JSON", URL_VOCAB_JSON)?;
			py.run(
				c_str!(
					r#"
import json
import typing

import omp
import omp.schemes as schemes
import omp.urls as urls
from _omp_url_vocab import SCHEMES as GENERATED_VOCAB


def expect_raises(error_type, call):
    try:
        call()
    except error_type as error:
        return error
    raise AssertionError(f"expected {error_type.__name__}")


urls_schemes_before = urls.schemes
table_before = dict(urls.schemes())
members_before = [(member.name, member.value) for member in urls.Scheme]
aliases_before = dict(urls._SCHEME_ALIASES)

assert omp.schemes is schemes
assert "schemes" in omp.__all__
assert "schemes" in urls.__all__
for name in schemes.__all__:
    value = getattr(schemes, name)
    if getattr(value, "__annotations__", None):
        typing.get_type_hints(value)
for error_type in (
    schemes.SchemeGrammarError,
    schemes.BuiltinSchemeError,
    schemes.DuplicateSchemeError,
    schemes.SchemeLimitError,
):
    assert issubclass(error_type, schemes.SchemeError)
assert issubclass(schemes.SchemeError, urls.UrlError)
assert issubclass(schemes.SchemeError, omp.OmpError)
assert issubclass(schemes.SchemeError, ValueError)
assert (
    schemes.MAX_SCHEME_BYTES,
    schemes.MAX_SCHEMES,
    schemes.MAX_DESCRIPTION_BYTES,
) == (64, 32, 4096)

for spelling, canonical in (
    ("widget", "widget"),
    ("Widget", "widget"),
    ("WIDGET", "widget"),
    ("a", "a"),
    ("x1", "x1"),
    ("a+b.c-d", "a+b.c-d"),
    ("Z9-", "z9-"),
):
    assert schemes.Declaration(spelling).name == canonical, spelling

assert "\u212a".lower() == "k"
for spelling in (
    "",
    "1widget",
    "-widget",
    "+widget",
    ".widget",
    "wid get",
    " widget",
    "widget ",
    "widget\n",
    "\twidget",
    "wid_get",
    "wid/get",
    "wid:get",
    "widget://",
    "wid\0get",
    "\u212a",
    "\u212aelvin",
    "widg\u00e9t",
    "\uff57idget",
    "wid\u2010get",
    "\u0130stanbul",
):
    error = expect_raises(
        schemes.SchemeGrammarError, lambda spelling=spelling: schemes.Declaration(spelling)
    )
    assert not isinstance(error, schemes.BuiltinSchemeError), spelling

longest = "a" * schemes.MAX_SCHEME_BYTES
assert schemes.Declaration(longest).name == longest
assert schemes.Declaration(longest.upper()).name == longest
expect_raises(schemes.SchemeLimitError, lambda: schemes.Declaration(longest + "a"))
multibyte_over = "a" * (schemes.MAX_SCHEME_BYTES - 1) + "\u00e9"
assert len(multibyte_over) == schemes.MAX_SCHEME_BYTES
expect_raises(schemes.SchemeLimitError, lambda: schemes.Declaration(multibyte_over))
expect_raises(
    schemes.SchemeLimitError,
    lambda: schemes.Declaration("\u00e9" * (schemes.MAX_SCHEME_BYTES // 2 + 1)),
)
expect_raises(
    schemes.SchemeLimitError,
    lambda: schemes.Declaration("\ud800" * (schemes.MAX_SCHEME_BYTES // 3 + 1)),
)
multibyte_fits = "a" * (schemes.MAX_SCHEME_BYTES - 2) + "\u00e9"
expect_raises(schemes.SchemeGrammarError, lambda: schemes.Declaration(multibyte_fits))
empty = expect_raises(schemes.SchemeGrammarError, lambda: schemes.Declaration(""))
assert "must not be empty" in str(empty), empty
expect_raises(schemes.SchemeLimitError, lambda: schemes.Declaration(longest.upper() + "A"))

fits = schemes.Declaration("widget", description="d" * schemes.MAX_DESCRIPTION_BYTES)
assert len(fits.description) == schemes.MAX_DESCRIPTION_BYTES
expect_raises(
    schemes.SchemeLimitError,
    lambda: schemes.Declaration(
        "widget", description="d" * (schemes.MAX_DESCRIPTION_BYTES + 1)
    ),
)
expect_raises(
    schemes.SchemeLimitError,
    lambda: schemes.Declaration(
        "widget", description="\u00e9" * (schemes.MAX_DESCRIPTION_BYTES // 2 + 1)
    ),
)
expect_raises(schemes.SchemeError, lambda: schemes.Declaration("widget", description="\ud800"))

for bad in (7, None, b"widget", ["widget"], 1.5):
    expect_raises(TypeError, lambda bad=bad: schemes.Declaration(bad))
    expect_raises(TypeError, lambda bad=bad: schemes.register(bad))
expect_raises(TypeError, lambda: schemes.Declaration("widget", description=5))
expect_raises(TypeError, lambda: schemes.Declaration("widget", immutable="yes"))
expect_raises(TypeError, lambda: schemes.Declaration("widget", writable=1))

for spelling in ("https", "pr", "mcp", "HTTPS", "Pr", "MCP"):
    error = expect_raises(
        schemes.BuiltinSchemeError, lambda spelling=spelling: schemes.Declaration(spelling)
    )
    assert spelling.lower() in str(error), error
    expect_raises(schemes.BuiltinSchemeError, lambda spelling=spelling: schemes.register(spelling))

vocabulary = json.loads(URL_VOCAB_JSON)
wire_names = {spelling for row in vocabulary["schemes"] for spelling in row["wire"]}
assert {"https", "pr", "mcp"} <= wire_names
assert len(wire_names) >= 20, wire_names
assert {
    spelling for _member, wire, _selectors in GENERATED_VOCAB for spelling in wire
} == wire_names
assert set(urls._SCHEME_ALIASES) == wire_names
for spelling in sorted(wire_names):
    for variant in (spelling, spelling.upper()):
        expect_raises(
            schemes.BuiltinSchemeError, lambda variant=variant: schemes.Declaration(variant)
        )

assert schemes.declared() == ()
expect_raises(
    schemes.SchemeLimitError,
    lambda: schemes.register(*(f"s{index}" for index in range(schemes.MAX_SCHEMES + 1))),
)
assert schemes.declared() == ()
expect_raises(schemes.DuplicateSchemeError, lambda: schemes.register("widget", "WIDGET"))
expect_raises(schemes.BuiltinSchemeError, lambda: schemes.register("gadget", "pr"))
assert schemes.declared() == ()
first = schemes.register(
    schemes.Declaration("Widget", description="Widget records by id", immutable=True)
)
assert first == (
    schemes.Declaration("widget", description="Widget records by id", immutable=True),
)
assert first[0].writable is False
expect_raises(schemes.DuplicateSchemeError, lambda: schemes.register("WIDGET"))
assert schemes.declared() == first
rest = schemes.register(*(f"s{index}" for index in range(schemes.MAX_SCHEMES - 1)))
assert len(rest) == schemes.MAX_SCHEMES - 1
assert schemes.declared() == first + rest
expect_raises(schemes.SchemeLimitError, lambda: schemes.register("one-more"))
assert len(schemes.declared()) == schemes.MAX_SCHEMES

assert urls.schemes is urls_schemes_before
assert dict(urls.schemes()) == table_before
assert [(member.name, member.value) for member in urls.Scheme] == members_before
assert dict(urls._SCHEME_ALIASES) == aliases_before
declared_url = urls.parse("widget://records:2-3")
assert declared_url.scheme is urls.Scheme.UNKNOWN
assert declared_url.raw_scheme == "widget"
assert declared_url.resource == "records:2-3" and declared_url.selector is None

assert "live" in schemes.__all__
assert "LiveDeclaration" in schemes.__all__
typing.get_type_hints(schemes.LiveDeclaration)
typing.get_type_hints(schemes.live)


class ListingBackend:
    async def request(self, operation, arguments):
        assert operation == "omp.schemes.live"
        return {
            "schemes": [
                {
                    "name": "widget",
                    "description": "live row",
                    "immutable": True,
                    "writable": False,
                    "owner": "acme.widgets",
                    "fetch": False,
                    "credentials": False,
                }
            ]
        }


async def live_exercise():
    try:
        await schemes.live()
    except omp.NotWiredError:
        pass
    else:
        raise AssertionError("live without CONTROL must raise")
    omp._install_control_backend(ListingBackend())
    rows = await schemes.live()
    assert rows[0].name == "widget"
    assert rows[0].owner == "acme.widgets"
    assert dict(urls.schemes()) == table_before


import asyncio

asyncio.run(live_exercise())
assert dict(urls.schemes()) == table_before
"#
				),
				Some(&globals),
				None,
			)
		})
		.expect("omp.schemes contract");
}
