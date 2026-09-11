import * as fs from "node:fs/promises";
import * as path from "node:path";
import { FileHistory } from "../../src/session/file-history";

const base = process.argv[2]!;
const cwd = path.join(base, `workspace-${process.pid}`);
await fs.mkdir(cwd, { recursive: true });
const file = path.join(cwd, "asset.bin");
await Bun.write(file, new Uint8Array([0, 255, 3]));
const history = new FileHistory(cwd, path.join(base, "data"), `session-${process.pid}`);
await history.command("on");
const turn = (await history.command("list")).split(/\s+/)[0]!;
await Bun.write(file, new Uint8Array([1, 2]));
await history.command(`restore ${turn}`);
const restored = [...(await Bun.file(file).bytes())];
await history.command("redo");
const redone = [...(await Bun.file(file).bytes())];
console.log(JSON.stringify({ restored, redone }));
