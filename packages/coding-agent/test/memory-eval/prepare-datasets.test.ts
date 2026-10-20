import { expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { pythonPath } from "./python";

const PY = path.join(import.meta.dir, "../../bench/memory-eval/py");

// A non-UTF-8 locale (here ASCII, as a stand-in for a Windows code page) must not change the corpus bytes Bun reads.
it.skipIf(pythonPath === undefined)("publishes and re-reads non-ASCII datasets as UTF-8 under any locale", async () => {
	await using dir = await TempDir.create("@memory-eval-prepare-");
	const out = dir.join("beam.json");
	const text = JSON.stringify([{ content: "café — naïve 日本語 🙂" }]);
	const proc = Bun.spawn(
		[
			pythonPath!,
			"-c",
			`
import json, sys, types
from pathlib import Path
# Only publish/read_current run; stub the download dependencies so any Python 3 can import the module.
for name in ("pyarrow", "pyarrow.parquet", "huggingface_hub"):
    sys.modules[name] = types.ModuleType(name)
sys.modules["pyarrow"].parquet = sys.modules["pyarrow.parquet"]
sys.modules["huggingface_hub"].hf_hub_download = None
sys.path.insert(0, sys.argv[1])
from prepare_datasets import publish, read_current
# argv is ASCII-escaped JSON: under the ASCII locale Python would decode raw non-ASCII argv to surrogates.
out, text = Path(sys.argv[2]), json.loads(sys.argv[3])
publish(out, text, "rev")
assert read_current(out, "rev") == text
# Marker contract, on a second file so the one checked below keeps its bytes.
other = out.with_name("other.json")
marker = other.with_name(other.name + ".revision")
publish(other, text, "rev")
# Another writer's data next to this marker, as two racing setups can leave them, is not taken for "rev".
other.write_text(json.dumps(["other writer"]), encoding="utf-8")
assert read_current(other, "rev") is None
# A marker from before digests were recorded is upgraded to the data as it stands, then holds it.
marker.write_text("rev\\n", encoding="utf-8")
assert read_current(other, "rev") == json.dumps(["other writer"])
assert len(marker.read_text(encoding="utf-8").split()) == 2
`,
			PY,
			out,
			JSON.stringify(text).replace(/[\u0080-\uffff]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`),
		],
		{
			// The script refuses PYTHONPATH/PYTHONHOME, so a developer's own must not leak in.
			env: {
				...Object.fromEntries(
					Object.entries(Bun.env).filter(([key]) => !["PYTHONPATH", "PYTHONHOME"].includes(key.toUpperCase())),
				),
				PYTHONUTF8: "0",
				PYTHONCOERCECLOCALE: "0",
				LC_ALL: "C",
				LANG: "C",
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
	expect(stderr).toBe("");
	expect(code).toBe(0);
	expect(await Bun.file(out).text()).toBe(text);
});
