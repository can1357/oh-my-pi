import { describe, expect, test } from "bun:test";
import { Chalk, detectColorLevel } from "../src/chalk";

const ESC = "\u001B[";

describe("chalk", () => {
	test("matches chalk 5 ANSI bytes at color level 3", () => {
		const chalk = new Chalk({ level: 3 });
		expect(chalk.red("x")).toBe(`${ESC}31mx${ESC}39m`);
		expect(chalk.bold.blue("x")).toBe(`${ESC}1m${ESC}34mx${ESC}39m${ESC}22m`);
		expect(chalk.bgRedBright.white("x")).toBe(`${ESC}101m${ESC}37mx${ESC}39m${ESC}49m`);
		expect(chalk.reset.red("x")).toBe(`${ESC}0m${ESC}31mx${ESC}39m${ESC}0m`);
		expect(chalk.red("a\nb")).toBe(`${ESC}31ma${ESC}39m\n${ESC}31mb${ESC}39m`);
	});

	test("reopens outer styles after nested and literal close sequences", () => {
		const chalk = new Chalk({ level: 3 });
		expect(chalk.red(`a${chalk.blue("b")}c`)).toBe(`${ESC}31ma${ESC}34mb${ESC}39m${ESC}31mc${ESC}39m`);
		expect(chalk.red(`a${ESC}39mb`)).toBe(`${ESC}31ma${ESC}39m${ESC}31mb${ESC}39m`);
		expect(chalk.bold(`a${ESC}22mb`)).toBe(`${ESC}1ma${ESC}22m${ESC}1mb${ESC}22m`);
		expect(chalk.bold.dim("x")).toBe(`${ESC}1m${ESC}2mx${ESC}22m${ESC}22m`);
	});

	test("matches truecolor hex and disabled output", () => {
		const enabled = new Chalk({ level: 3 });
		const disabled = new Chalk({ level: 0 });
		expect(enabled.hex("#C5FFD6")("x")).toBe(`${ESC}38;2;197;255;214mx${ESC}39m`);
		expect(disabled.red.bold("x")).toBe("x");
		expect(disabled.hex("#C5FFD6")("x")).toBe("x");
	});

	test("joins arguments and shares mutable level across chains", () => {
		const chalk = new Chalk({ level: 0 });
		const red = chalk.red;
		expect(red("a", "b", 3)).toBe("a b 3");
		chalk.level = 3;
		expect(red("x")).toBe(`${ESC}31mx${ESC}39m`);
	});

	test("honors FORCE_COLOR, NO_COLOR, TTY, TERM, and CI detection", () => {
		expect(detectColorLevel({ FORCE_COLOR: "3", NO_COLOR: "1" }, false)).toBe(3);
		expect(detectColorLevel({ FORCE_COLOR: "0" }, true)).toBe(0);
		expect(detectColorLevel({ NO_COLOR: "1" }, true)).toBe(0);
		expect(detectColorLevel({ TERM: "dumb" }, true)).toBe(0);
		expect(detectColorLevel({ TERM: "xterm-256color" }, true)).toBe(2);
		expect(detectColorLevel({ COLORTERM: "truecolor" }, true)).toBe(3);
		expect(detectColorLevel({ CI: "1", GITHUB_ACTIONS: "1" }, true)).toBe(3);
		expect(detectColorLevel({ CI: "1" }, true)).toBe(0);
		expect(detectColorLevel({ TERM: "xterm-256color" }, false)).toBe(0);
	});
});
