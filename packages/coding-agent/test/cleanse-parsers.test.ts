import { describe, expect, test } from "bun:test";
import {
	CLEANSE_PARSER_KINDS,
	type CleanseParserKind,
	CleanseStreamParser,
	parseCleanseDiagnostics,
} from "@oh-my-pi/pi-coding-agent/cleanse/parsers";
import { diagnosticKey } from "@oh-my-pi/pi-coding-agent/cleanse/checkers";
import type { CleanseDiagnostic } from "@oh-my-pi/pi-coding-agent/cleanse/types";

interface ParserFixture {
	kind: CleanseParserKind;
	stdout: string;
	stderr: string;
	expected: CleanseDiagnostic[];
}

// Golden outputs pinned from the per-tool parsers; every parser kind has at least one case.
const FIXTURES: ParserFixture[] = [
	{
		kind: "rust",
		stdout:
			'{"reason":"compiler-artifact","target":{"name":"x"}}\n{"reason":"compiler-message","message":{"message":"mismatched types","level":"error","code":{"code":"E0308"},"spans":[{"file_name":"src/other.rs","is_primary":false,"line_start":1,"column_start":1,"line_end":1,"column_end":2},{"file_name":"src/main.rs","is_primary":true,"line_start":4,"column_start":9,"line_end":4,"column_end":14,"suggested_replacement":"1u32"}]}}\n{"reason":"compiler-message","message":{"message":"unused import","level":"warning","code":null,"spans":[]}}\n{"reason":"compiler-message","message":{"message":"aborting","level":"note","spans":[]}}\n{"reason":"build-finished","success":false}\n',
		stderr: "   Compiling demo v0.1.0\n",
		expected: [
			{
				checker: "checker",
				file: "src/main.rs",
				line: 4,
				column: 9,
				endLine: 4,
				endColumn: 14,
				code: "E0308",
				severity: "error",
				message: "mismatched types",
				suggestion: "1u32",
			},
			{
				checker: "checker",
				severity: "warning",
				message: "unused import",
			},
		],
	},
	{
		kind: "rust-test",
		stdout:
			'{"reason":"compiler-message","message":{"message":"unused variable: `x`","level":"warning","code":{"code":"unused_variables"},"spans":[{"file_name":"src/lib.rs","is_primary":true,"line_start":2,"column_start":9,"line_end":2,"column_end":10}]}}\n',
		stderr:
			"running 2 tests\nthread 'tests::adds' panicked at src/lib.rs:10:5:\nassertion `left == right` failed\nthread 'tests::subs' panicked at /outside/lib.rs:3:1:\n",
		expected: [
			{
				checker: "checker",
				file: "src/lib.rs",
				line: 2,
				column: 9,
				endLine: 2,
				endColumn: 10,
				code: "unused_variables",
				severity: "warning",
				message: "unused variable: `x`",
			},
			{
				checker: "checker",
				file: "src/lib.rs",
				line: 10,
				column: 5,
				code: "test-failure",
				severity: "error",
				message: "test tests::adds panicked",
			},
		],
	},
	{
		kind: "go",
		stdout: "",
		stderr:
			'# example.com/pkg\n{\n  "example.com/pkg": {\n    "printf": [\n      {\n        "posn": "/repo/main.go:7:2",\n        "message": "fmt.Printf format %d has arg x of wrong type"\n      }\n    ],\n    "unusedresult": [\n      {\n        "posn": "main.go(9,3)",\n        "message": "result of fmt.Sprintf call not used",\n        "category": "unusedresult"\n      }\n    ]\n  }\n}\n',
		expected: [
			{
				checker: "checker",
				file: "main.go",
				line: 7,
				column: 2,
				code: "printf",
				severity: "warning",
				message: "fmt.Printf format %d has arg x of wrong type",
			},
			{
				checker: "checker",
				file: "main.go",
				line: 9,
				column: 3,
				code: "unusedresult",
				severity: "warning",
				message: "result of fmt.Sprintf call not used",
			},
		],
	},
	{
		kind: "go",
		stdout: "",
		stderr: "# example.com/pkg\n./main.go:3:2: error: undefined: foo\n",
		expected: [
			{
				checker: "checker",
				file: "main.go",
				line: 3,
				column: 2,
				severity: "error",
				message: "undefined: foo",
			},
		],
	},
	{
		kind: "go-test",
		stdout:
			'{"Action":"run","Test":"TestAdd"}\n{"Action":"output","Test":"TestAdd","Output":"    add_test.go:12: expected 1, got 2\\n"}\n{"Action":"output","Test":"TestAdd","Output":"    ./pkg/add_test.go:20:3: boom\\n"}\n{"Action":"fail","Test":"TestAdd"}\n{"Action":"pass","Test":"TestSub"}\n',
		stderr: "",
		expected: [
			{
				checker: "checker",
				file: "add_test.go",
				line: 12,
				code: "test-failure",
				severity: "error",
				message: "expected 1, got 2",
			},
			{
				checker: "checker",
				file: "pkg/add_test.go",
				line: 20,
				column: 3,
				code: "test-failure",
				severity: "error",
				message: "boom",
			},
			{
				checker: "checker",
				code: "test-failure",
				severity: "error",
				message: "test TestAdd failed",
			},
		],
	},
	{
		kind: "go-test",
		stdout: "",
		stderr: "main.go:4:1: error: syntax error\n",
		expected: [
			{
				checker: "checker",
				file: "main.go",
				line: 4,
				column: 1,
				severity: "error",
				message: "syntax error",
			},
		],
	},
	{
		kind: "staticcheck",
		stdout:
			'{"code":"S1002","severity":"error","location":{"file":"/repo/main.go","line":5,"column":7},"end":{"line":5,"column":20},"message":"should omit comparison to bool constant"}\n{"code":"U1000","location":{"file":"util.go","line":2,"column":6},"end":{"line":0,"column":0},"message":"func unused is unused"}\n',
		stderr: "",
		expected: [
			{
				checker: "checker",
				file: "main.go",
				line: 5,
				column: 7,
				endLine: 5,
				endColumn: 20,
				code: "S1002",
				severity: "error",
				message: "should omit comparison to bool constant",
			},
			{
				checker: "checker",
				file: "util.go",
				line: 2,
				column: 6,
				code: "U1000",
				severity: "warning",
				message: "func unused is unused",
			},
		],
	},
	{
		kind: "golangci",
		stdout:
			'main.go:10:2: ineffectual assignment to err (ineffassign)\n  util.go:3:1: exported function Foo should have comment or be unexported (revive)  \nlevel=warning msg="deprecated"\n',
		stderr: "",
		expected: [
			{
				checker: "checker",
				file: "main.go",
				line: 10,
				column: 2,
				code: "ineffassign",
				severity: "warning",
				message: "ineffectual assignment to err",
			},
			{
				checker: "checker",
				file: "util.go",
				line: 3,
				column: 1,
				code: "revive",
				severity: "warning",
				message: "exported function Foo should have comment or be unexported",
			},
		],
	},
	{
		kind: "ruff",
		stdout:
			'[\n  {\n    "code": "F401",\n    "filename": "/repo/src/app.py",\n    "message": "`os` imported but unused",\n    "location": {\n      "row": 1,\n      "column": 8\n    },\n    "end_location": {\n      "row": 1,\n      "column": 10\n    },\n    "fix": {\n      "message": "Remove unused import: `os`",\n      "applicability": "safe"\n    }\n  },\n  {\n    "code": "E501",\n    "filename": "src/app.py",\n    "message": "Line too long (120 > 88)",\n    "location": {\n      "row": 3,\n      "column": 89\n    },\n    "end_location": {\n      "row": 3,\n      "column": 120\n    },\n    "fix": null\n  }\n]\n',
		stderr: "",
		expected: [
			{
				checker: "checker",
				file: "src/app.py",
				line: 1,
				column: 8,
				endLine: 1,
				endColumn: 10,
				code: "F401",
				severity: "warning",
				message: "`os` imported but unused",
				suggestion: "Remove unused import: `os`",
			},
			{
				checker: "checker",
				file: "src/app.py",
				line: 3,
				column: 89,
				endLine: 3,
				endColumn: 120,
				code: "E501",
				severity: "warning",
				message: "Line too long (120 > 88)",
			},
		],
	},
	{
		kind: "pyright",
		stdout:
			'{\n  "version": "1.1.400",\n  "generalDiagnostics": [\n    {\n      "file": "/repo/src/app.py",\n      "severity": "error",\n      "message": "Import \\"foo\\" could not be resolved",\n      "range": {\n        "start": {\n          "line": 0,\n          "character": 7\n        },\n        "end": {\n          "line": 0,\n          "character": 10\n        }\n      },\n      "rule": "reportMissingImports"\n    },\n    {\n      "file": "/repo/src/app.py",\n      "severity": "information",\n      "message": "Code is unreachable",\n      "range": {\n        "start": {\n          "line": 4,\n          "character": 0\n        },\n        "end": {\n          "line": 4,\n          "character": 8\n        }\n      }\n    }\n  ],\n  "summary": {\n    "errorCount": 1\n  }\n}\n',
		stderr: "",
		expected: [
			{
				checker: "checker",
				file: "src/app.py",
				line: 1,
				column: 8,
				endLine: 1,
				endColumn: 11,
				code: "reportMissingImports",
				severity: "error",
				message: 'Import "foo" could not be resolved',
			},
			{
				checker: "checker",
				file: "src/app.py",
				line: 5,
				column: 1,
				endLine: 5,
				endColumn: 9,
				severity: "info",
				message: "Code is unreachable",
			},
		],
	},
	{
		kind: "mypy",
		stdout:
			"src/app.py:3: error: Incompatible types in assignment  [assignment]\nsrc/app.py:4:5: note: See https://mypy.rtfd.io\nFound 1 error in 1 file (checked 2 source files)\n",
		stderr: "",
		expected: [
			{
				checker: "checker",
				file: "src/app.py",
				line: 3,
				severity: "error",
				message: "Incompatible types in assignment [assignment]",
			},
			{
				checker: "checker",
				file: "src/app.py",
				line: 4,
				column: 5,
				severity: "info",
				message: "See https://mypy.rtfd.io",
			},
		],
	},
	{
		kind: "pylint",
		stdout:
			'[\n  {\n    "type": "convention",\n    "module": "app",\n    "obj": "",\n    "line": 1,\n    "column": 0,\n    "endLine": 1,\n    "endColumn": 9,\n    "path": "src/app.py",\n    "symbol": "missing-module-docstring",\n    "message": "Missing module docstring",\n    "message-id": "C0114"\n  },\n  {\n    "type": "error",\n    "module": "app",\n    "obj": "",\n    "line": 3,\n    "column": 4,\n    "endLine": null,\n    "endColumn": null,\n    "path": "src/app.py",\n    "symbol": "",\n    "message": "Undefined variable \'x\'",\n    "message-id": "E0602"\n  }\n]\n',
		stderr: "",
		expected: [
			{
				checker: "checker",
				file: "src/app.py",
				line: 1,
				column: 1,
				endLine: 1,
				endColumn: 10,
				code: "missing-module-docstring",
				severity: "warning",
				message: "Missing module docstring",
			},
			{
				checker: "checker",
				file: "src/app.py",
				line: 3,
				column: 5,
				code: "E0602",
				severity: "error",
				message: "Undefined variable 'x'",
			},
		],
	},
	{
		kind: "flake8",
		stdout:
			"src/app.py:1:1: F401 'os' imported but unused\nsrc/app.py:2:80: W291 trailing whitespace\nsrc/app.py:5:1: E999 SyntaxError: invalid syntax\n",
		stderr: "",
		expected: [
			{
				checker: "checker",
				file: "src/app.py",
				line: 1,
				column: 1,
				code: "F401",
				severity: "error",
				message: "'os' imported but unused",
			},
			{
				checker: "checker",
				file: "src/app.py",
				line: 2,
				column: 80,
				code: "W291",
				severity: "warning",
				message: "trailing whitespace",
			},
			{
				checker: "checker",
				file: "src/app.py",
				line: 5,
				column: 1,
				code: "E999",
				severity: "error",
				message: "SyntaxError: invalid syntax",
			},
		],
	},
	{
		kind: "ty",
		stdout:
			"src/main.py:1:8: error[unresolved-import] Cannot resolve imported module `foo`\nsrc/main.py:3:1: warning[possibly-unbound] Name `y` may be unbound\nFound 2 diagnostics\n",
		stderr: "",
		expected: [
			{
				checker: "checker",
				file: "src/main.py",
				line: 1,
				column: 8,
				code: "unresolved-import",
				severity: "error",
				message: "Cannot resolve imported module `foo`",
			},
			{
				checker: "checker",
				file: "src/main.py",
				line: 3,
				column: 1,
				code: "possibly-unbound",
				severity: "warning",
				message: "Name `y` may be unbound",
			},
		],
	},
	{
		kind: "eslint",
		stdout:
			'[{"filePath":"/repo/src/index.ts","messages":[{"ruleId":"no-unused-vars","severity":2,"message":"\'x\' is defined but never used.","line":1,"column":7,"endLine":1,"endColumn":8},{"ruleId":"semi","severity":1,"message":"Missing semicolon.","line":2,"column":10,"fix":{"range":[1,2],"text":";"}},{"ruleId":null,"severity":2,"message":"Parsing error: Unexpected token","line":9,"column":1,"fatal":true}]},{"filePath":"/repo/src/clean.ts","messages":[]}]',
		stderr: "",
		expected: [
			{
				checker: "checker",
				file: "src/index.ts",
				line: 1,
				column: 7,
				endLine: 1,
				endColumn: 8,
				code: "no-unused-vars",
				severity: "error",
				message: "'x' is defined but never used.",
			},
			{
				checker: "checker",
				file: "src/index.ts",
				line: 2,
				column: 10,
				code: "semi",
				severity: "warning",
				message: "Missing semicolon.",
				suggestion: "automatic fix available",
			},
			{
				checker: "checker",
				file: "src/index.ts",
				line: 9,
				column: 1,
				severity: "error",
				message: "Parsing error: Unexpected token",
			},
		],
	},
	{
		kind: "eslint",
		stdout:
			'\u001b[33mwarning\u001b[0m: config [legacy] deprecated\n[{"filePath":"src/x.ts","messages":[{"ruleId":"eqeqeq","severity":2,"message":"Expected \'===\' and instead saw \'==\'.","line":1,"column":3}]}]\n{broken json}\n',
		stderr: "",
		expected: [
			{
				checker: "checker",
				file: "src/x.ts",
				line: 1,
				column: 3,
				code: "eqeqeq",
				severity: "error",
				message: "Expected '===' and instead saw '=='.",
			},
		],
	},
	{
		kind: "biome",
		stdout:
			'{"summary":{"errors":1},"diagnostics":[{"category":"lint/suspicious/noDoubleEquals","severity":"error","description":"Use === instead of ==","message":"ignored","location":{"path":{"file":"src/a.ts"},"span":[1,2]}},{"category":"format","severity":"warning","message":"File content differs from formatting output","location":{"path":"src/b.ts"}},{"category":"internalError/io","severity":"information","title":"No files were processed","location":{}}]}',
		stderr: "",
		expected: [
			{
				checker: "checker",
				file: "src/a.ts",
				code: "lint/suspicious/noDoubleEquals",
				severity: "error",
				message: "Use === instead of ==",
			},
			{
				checker: "checker",
				file: "src/b.ts",
				code: "format",
				severity: "warning",
				message: "File content differs from formatting output",
			},
			{
				checker: "checker",
				code: "internalError/io",
				severity: "info",
				message: "No files were processed",
			},
		],
	},
	{
		kind: "oxlint",
		stdout:
			"src/index.ts:4:10: Variable 'x' is declared but never used. [Warning/no-unused-vars]\nsrc/index.ts:7:1: Unexpected debugger statement [error/eslint(no-debugger)]\nFound 1 warning and 1 error.\n",
		stderr: "",
		expected: [
			{
				checker: "checker",
				file: "src/index.ts",
				line: 4,
				column: 10,
				code: "no-unused-vars",
				severity: "warning",
				message: "Variable 'x' is declared but never used.",
			},
			{
				checker: "checker",
				file: "src/index.ts",
				line: 7,
				column: 1,
				code: "eslint(no-debugger)",
				severity: "error",
				message: "Unexpected debugger statement",
			},
		],
	},
	{
		kind: "deno-lint",
		stdout:
			'{"diagnostics":[{"filename":"file:///repo/src/mod.ts","range":{"start":{"line":3,"col":6},"end":{"line":3,"col":9}},"message":"`foo` is never used","code":"no-unused-vars","hint":"If this is intentional, prefix it with an underscore"}],"errors":[{"file_path":"/repo/src/broken.ts","message":"Expected \';\', got \'x\'"}]}',
		stderr: "",
		expected: [
			{
				checker: "checker",
				file: "src/mod.ts",
				line: 3,
				column: 7,
				endLine: 3,
				endColumn: 10,
				code: "no-unused-vars",
				severity: "warning",
				message: "`foo` is never used",
				suggestion: "If this is intentional, prefix it with an underscore",
			},
			{
				checker: "checker",
				file: "src/broken.ts",
				severity: "error",
				message: "Expected ';', got 'x'",
			},
		],
	},
	{
		kind: "stylelint",
		stdout:
			'[{"source":"/repo/styles/site.css","warnings":[{"line":3,"column":5,"endLine":3,"endColumn":12,"rule":"color-no-invalid-hex","severity":"error","text":"Unexpected invalid hex color \\"#ab\\" (color-no-invalid-hex)"},{"line":9,"column":1,"rule":"block-no-empty","severity":"warning","text":"Unexpected empty block"}]},{"warnings":[{"line":1,"column":1,"rule":"x","severity":"error","text":"orphan without source"}]}]',
		stderr: "",
		expected: [
			{
				checker: "checker",
				file: "styles/site.css",
				line: 3,
				column: 5,
				endLine: 3,
				endColumn: 12,
				code: "color-no-invalid-hex",
				severity: "error",
				message: 'Unexpected invalid hex color "#ab" (color-no-invalid-hex)',
			},
			{
				checker: "checker",
				file: "styles/site.css",
				line: 9,
				column: 1,
				code: "block-no-empty",
				severity: "warning",
				message: "Unexpected empty block",
			},
		],
	},
	{
		kind: "rubocop",
		stdout:
			'{"metadata":{},"files":[{"path":"app/models/user.rb","offenses":[{"severity":"convention","message":"Style/StringLiterals: Prefer single-quoted strings.","cop_name":"Style/StringLiterals","corrected":true,"location":{"start_line":2,"start_column":7,"last_line":2,"last_column":15}},{"severity":"fatal","message":"unexpected token","cop_name":"Lint/Syntax","corrected":false,"location":{"start_line":5,"start_column":1,"last_line":5,"last_column":1}}]}]}',
		stderr: "",
		expected: [
			{
				checker: "checker",
				file: "app/models/user.rb",
				line: 2,
				column: 7,
				endLine: 2,
				endColumn: 15,
				code: "Style/StringLiterals",
				severity: "warning",
				message: "Style/StringLiterals: Prefer single-quoted strings.",
				suggestion: "automatic correction available",
			},
			{
				checker: "checker",
				file: "app/models/user.rb",
				line: 5,
				column: 1,
				endLine: 5,
				endColumn: 1,
				code: "Lint/Syntax",
				severity: "error",
				message: "unexpected token",
			},
		],
	},
	{
		kind: "phpstan",
		stdout:
			'{"totals":{"errors":1,"file_errors":2},"files":{"/repo/src/Foo.php":{"errors":2,"messages":[{"message":"Call to an undefined method Foo::bar().","line":12,"ignorable":true,"identifier":"method.notFound"},{"message":"Property Foo::$x has no type.","line":4,"ignorable":true}]}},"errors":["Ignored error pattern was not matched",{"not":"a string"}]}',
		stderr: "",
		expected: [
			{
				checker: "checker",
				file: "src/Foo.php",
				line: 12,
				code: "method.notFound",
				severity: "error",
				message: "Call to an undefined method Foo::bar().",
			},
			{
				checker: "checker",
				file: "src/Foo.php",
				line: 4,
				severity: "error",
				message: "Property Foo::$x has no type.",
			},
			{
				checker: "checker",
				severity: "error",
				message: "Ignored error pattern was not matched",
			},
		],
	},
	{
		kind: "psalm",
		stdout:
			'[{"severity":"error","line_from":3,"line_to":3,"type":"UndefinedVariable","message":"Cannot find referenced variable $x","file_name":"src/a.php","column_from":5,"column_to":7,"shortcode":24},{"severity":"info","line_from":8,"line_to":9,"message":"Docblock-defined type mismatch","file_path":"/repo/src/b.php","column_from":1,"column_to":2,"shortcode":120}]',
		stderr: "",
		expected: [
			{
				checker: "checker",
				file: "src/a.php",
				line: 3,
				column: 5,
				endLine: 3,
				endColumn: 7,
				code: "UndefinedVariable",
				severity: "error",
				message: "Cannot find referenced variable $x",
			},
			{
				checker: "checker",
				file: "src/b.php",
				line: 8,
				column: 1,
				endLine: 9,
				endColumn: 2,
				code: "120",
				severity: "info",
				message: "Docblock-defined type mismatch",
			},
		],
	},
	{
		kind: "swiftlint",
		stdout:
			'[{"file":"/repo/Sources/App.swift","line":10,"character":5,"rule_id":"force_cast","severity":"Error","reason":"Force casts should be avoided","type":"Force Cast"},{"file":"/repo/Sources/App.swift","line":12,"character":null,"rule_id":"line_length","severity":"Warning","reason":"Line should be 120 characters or less"}]',
		stderr: "",
		expected: [
			{
				checker: "checker",
				file: "Sources/App.swift",
				line: 10,
				column: 5,
				code: "force_cast",
				severity: "error",
				message: "Force casts should be avoided",
			},
			{
				checker: "checker",
				file: "Sources/App.swift",
				line: 12,
				code: "line_length",
				severity: "warning",
				message: "Line should be 120 characters or less",
			},
		],
	},
	{
		kind: "dart",
		stdout: "",
		stderr:
			"ERROR|COMPILE_TIME_ERROR|UNDEFINED_IDENTIFIER|/repo/lib/main.dart|3|5|3|Undefined name 'x'.\nINFO|LINT|prefer_const|lib/util.dart|7|1|5|Use 'const' | not 'final'.\nAnalyzing lib...\n",
		expected: [
			{
				checker: "checker",
				file: "lib/main.dart",
				line: 3,
				column: 5,
				code: "UNDEFINED_IDENTIFIER",
				severity: "error",
				message: "Undefined name 'x'.",
			},
			{
				checker: "checker",
				file: "lib/util.dart",
				line: 7,
				column: 1,
				code: "prefer_const",
				severity: "info",
				message: "Use 'const' | not 'final'.",
			},
		],
	},
	{
		kind: "credo",
		stdout:
			'{"issues":[{"category":"readability","check":"Credo.Check.Readability.ModuleDoc","filename":"lib/app.ex","line_no":1,"column":11,"message":"Modules should have a @moduledoc tag.","priority":1},{"category":"warning","check":"Credo.Check.Warning.IoInspect","filename":"lib/app.ex","line":9,"message":"There should be no calls to IO.inspect/1.","priority":"high"}]}',
		stderr: "",
		expected: [
			{
				checker: "checker",
				file: "lib/app.ex",
				line: 1,
				column: 11,
				code: "Credo.Check.Readability.ModuleDoc",
				severity: "info",
				message: "Modules should have a @moduledoc tag.",
			},
			{
				checker: "checker",
				file: "lib/app.ex",
				line: 9,
				code: "Credo.Check.Warning.IoInspect",
				severity: "info",
				message: "There should be no calls to IO.inspect/1.",
			},
		],
	},
	{
		kind: "shellcheck",
		stdout:
			'[{"file":"scripts/run.sh","line":3,"endLine":3,"column":6,"endColumn":10,"level":"warning","code":2086,"message":"Double quote to prevent globbing and word splitting.","fix":{"replacements":[]}}]',
		stderr: "",
		expected: [
			{
				checker: "checker",
				file: "scripts/run.sh",
				line: 3,
				column: 6,
				endLine: 3,
				endColumn: 10,
				code: "SC2086",
				severity: "warning",
				message: "Double quote to prevent globbing and word splitting.",
				suggestion: "automatic fix available",
			},
		],
	},
	{
		kind: "shellcheck",
		stdout:
			'{"comments":[{"file":"scripts/run.sh","line":1,"endLine":1,"column":1,"endColumn":2,"level":"error","code":2148,"message":"Tips depend on target shell.","fix":null}]}',
		stderr: "",
		expected: [
			{
				checker: "checker",
				file: "scripts/run.sh",
				line: 1,
				column: 1,
				endLine: 1,
				endColumn: 2,
				code: "SC2148",
				severity: "error",
				message: "Tips depend on target shell.",
			},
		],
	},
	{
		kind: "hlint",
		stdout:
			'[{"module":["Main"],"decl":["main"],"severity":"Warning","hint":"Use concatMap","file":"src/Main.hs","startLine":5,"startColumn":8,"endLine":5,"endColumn":30,"from":"concat (map f xs)","to":"concatMap f xs","note":[]},{"severity":"Suggestion","file":"src/Main.hs","startLine":9,"startColumn":1,"endLine":9,"endColumn":4,"from":"x = y","to":null}]',
		stderr: "",
		expected: [
			{
				checker: "checker",
				file: "src/Main.hs",
				line: 5,
				column: 8,
				endLine: 5,
				endColumn: 30,
				code: "Use concatMap",
				severity: "warning",
				message: "Use concatMap",
				suggestion: "concatMap f xs",
			},
			{
				checker: "checker",
				file: "src/Main.hs",
				line: 9,
				column: 1,
				endLine: 9,
				endColumn: 4,
				severity: "info",
				message: "x = y",
			},
		],
	},
	{
		kind: "terraform",
		stdout:
			'{"format_version":"1.0","valid":false,"error_count":1,"diagnostics":[{"severity":"error","summary":"Unsupported argument","detail":"An argument named \\"foo\\" is not expected here.","range":{"filename":"main.tf","start":{"line":3,"column":3,"byte":20},"end":{"line":3,"column":6,"byte":23}}},{"severity":"warning","summary":"Deprecated attribute"}]}',
		stderr: "",
		expected: [
			{
				checker: "checker",
				file: "main.tf",
				line: 3,
				column: 3,
				endLine: 3,
				endColumn: 6,
				severity: "error",
				message: 'Unsupported argument: An argument named "foo" is not expected here.',
			},
			{
				checker: "checker",
				severity: "warning",
				message: "Deprecated attribute",
			},
		],
	},
	{
		kind: "tflint",
		stdout:
			'{"issues":[{"rule":{"name":"terraform_unused_declarations","severity":"warning","link":""},"message":"variable \\"x\\" is declared but not used","range":{"filename":"variables.tf","start":{"line":1,"column":1},"end":{"line":1,"column":15}},"callers":[]}],"errors":[{"message":"Failed to load configurations"},{"summary":"no message"}]}',
		stderr: "",
		expected: [
			{
				checker: "checker",
				file: "variables.tf",
				line: 1,
				column: 1,
				endLine: 1,
				endColumn: 15,
				code: "terraform_unused_declarations",
				severity: "warning",
				message: 'variable "x" is declared but not used',
			},
			{
				checker: "checker",
				severity: "error",
				message: "Failed to load configurations",
			},
		],
	},
	{
		kind: "actionlint",
		stdout:
			'[{"message":"shellcheck reported issue in this script: SC2086","filepath":".github/workflows/ci.yml","line":10,"column":9,"kind":"shellcheck","snippet":"x","end_column":12}]',
		stderr: "",
		expected: [
			{
				checker: "checker",
				file: ".github/workflows/ci.yml",
				line: 10,
				column: 9,
				code: "shellcheck",
				severity: "error",
				message: "shellcheck reported issue in this script: SC2086",
			},
		],
	},
	{
		kind: "generic",
		stdout:
			"src/main.cpp(12,5): error C2065: 'x': undeclared identifier [/repo/build/app.vcxproj]\nsrc/lib.c:4:2: warning: unused variable 'y' [-Wunused-variable]\nsrc/lib.c:9: error: expected ';'\n../outside.c:1:1: error: out of tree\n\n   \nmake: *** [all] Error 1\n",
		stderr: "src/lib.c:4:2: warning: unused variable 'y' [-Wunused-variable]\n",
		expected: [
			{
				checker: "checker",
				file: "src/main.cpp",
				line: 12,
				column: 5,
				code: "C2065",
				severity: "error",
				message: "'x': undeclared identifier",
			},
			{
				checker: "checker",
				file: "src/lib.c",
				line: 4,
				column: 2,
				severity: "warning",
				message: "unused variable 'y' [-Wunused-variable]",
			},
			{
				checker: "checker",
				file: "src/lib.c",
				line: 9,
				severity: "error",
				message: "expected ';'",
			},
		],
	},
];

const context = { checker: "checker", projectCwd: "/repo", checkerCwd: "/repo" };

describe("cleanse parser fixtures", () => {
	test("cover every parser kind", () => {
		const covered = new Set(FIXTURES.map(fixture => fixture.kind));
		expect(CLEANSE_PARSER_KINDS.filter(kind => !covered.has(kind))).toEqual([]);
	});

	for (const [index, fixture] of FIXTURES.entries()) {
		test(`${fixture.kind} #${index}`, () => {
			const diagnostics = parseCleanseDiagnostics(fixture.kind, {
				...context,
				stdout: fixture.stdout,
				stderr: fixture.stderr,
			});
			expect(diagnostics).toEqual(fixture.expected);
		});
	}
});

/** Cut at the last newline, as partial output was cut before incremental parsing. */
function completeLines(text: string): string {
	const cut = text.lastIndexOf("\n");
	return cut < 0 ? "" : text.slice(0, cut + 1);
}

function chunk(text: string, size: number): string[] {
	const chunks: string[] = [];
	for (let index = 0; index < text.length; index += size) chunks.push(text.slice(index, index + size));
	return chunks;
}

describe("cleanse incremental parsing", () => {
	// Each push must yield exactly what re-parsing the whole completed prefix would have
	// newly yielded, so streamed emission is unchanged by parsing only new output.
	for (const [index, fixture] of FIXTURES.entries()) {
		test(`${fixture.kind} #${index} matches prefix re-parsing`, () => {
			for (const size of [1, 7, 64, Number.MAX_SAFE_INTEGER]) {
				const stdoutChunks = chunk(fixture.stdout, size);
				const stderrChunks = chunk(fixture.stderr, size);
				const parser = new CleanseStreamParser(fixture.kind, context);
				const incremental = new Map<string, CleanseDiagnostic>();
				const reference = new Map<string, CleanseDiagnostic>();
				let stdout = "";
				let stderr = "";
				for (let step = 0; step < Math.max(stdoutChunks.length, stderrChunks.length); step += 1) {
					stdout += stdoutChunks[step] ?? "";
					stderr += stderrChunks[step] ?? "";
					for (const diagnostic of parser.push(stdoutChunks[step] ?? "", stderrChunks[step] ?? "")) {
						incremental.set(diagnosticKey(diagnostic), diagnostic);
					}
					const prefix = parseCleanseDiagnostics(fixture.kind, {
						...context,
						stdout: completeLines(stdout),
						stderr: completeLines(stderr),
					});
					for (const diagnostic of prefix) reference.set(diagnosticKey(diagnostic), diagnostic);
				}
				expect([...incremental.keys()].sort()).toEqual([...reference.keys()].sort());
				expect(new Map([...incremental].sort())).toEqual(new Map([...reference].sort()));
			}
		});
	}

	test("holds a pretty-printed JSON document until it closes", () => {
		const parser = new CleanseStreamParser("ruff", context);
		const record = { code: "F401", filename: "a.py", message: "unused", location: { row: 1, column: 1 } };
		const document = `${JSON.stringify([record], null, 2)}\n`;
		const split = document.indexOf("\n", document.indexOf("location"));
		expect(parser.push(document.slice(0, split + 1), "")).toEqual([]);
		expect(parser.push(document.slice(split + 1), "")).toMatchObject([{ file: "a.py", code: "F401" }]);
	});

	test("streams a plain-text diagnostic that contains a brace without waiting for a closing one", () => {
		const parser = new CleanseStreamParser("go", context);
		const line = "main.go:4:1: error: expected '{'\n";
		const full = parseCleanseDiagnostics("go", { ...context, stdout: "", stderr: line });
		expect(full.length).toBeGreaterThan(0);
		expect(parser.push("", line)).toEqual(full);
	});
});
