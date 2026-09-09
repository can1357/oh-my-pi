/**
 * Default themes for TUI tests using chalk
 */
import type { EditorTheme, MarkdownTheme, SelectListTheme, SymbolTheme } from "@oh-my-pi/pi-tui";
import { Chalk } from "@oh-my-pi/pi-utils/chalk";

const chalk = new Chalk({ level: 3 });

const defaultSymbols: SymbolTheme = {
	cursor: ">",
	inputCursor: "|",
	boxRound: {
		topLeft: "+",
		topRight: "+",
		bottomLeft: "+",
		bottomRight: "+",
		horizontal: "-",
		vertical: "|",
	},
	boxSharp: {
		topLeft: "+",
		topRight: "+",
		bottomLeft: "+",
		bottomRight: "+",
		horizontal: "-",
		vertical: "|",
		teeDown: "+",
		teeUp: "+",
		teeLeft: "+",
		teeRight: "+",
		cross: "+",
	},
	table: {
		topLeft: "+",
		topRight: "+",
		bottomLeft: "+",
		bottomRight: "+",
		horizontal: "-",
		vertical: "|",
		teeDown: "+",
		teeUp: "+",
		teeLeft: "+",
		teeRight: "+",
		cross: "+",
	},
	quoteBorder: "│",
	hrChar: "-",
	spinnerFrames: ["-", "\\", "|", "/"],
};

const defaultSelectListTheme: SelectListTheme = {
	selectedPrefix: (text: string) => chalk.blue(text),
	selectedText: (text: string) => chalk.bold(text),
	description: (text: string) => chalk.dim(text),
	scrollInfo: (text: string) => chalk.dim(text),
	noMatch: (text: string) => chalk.dim(text),
	symbols: defaultSymbols,
};

export const defaultMarkdownTheme: MarkdownTheme = {
	heading: (text: string) => chalk.bold.cyan(text),
	link: (text: string) => chalk.blue(text),
	linkUrl: (text: string) => chalk.dim(text),
	code: (text: string) => chalk.yellow(text),
	codeBlock: (text: string) => chalk.green(text),
	codeBlockBorder: (text: string) => chalk.dim(text),
	quote: (text: string) => chalk.italic(text),
	quoteBorder: (text: string) => chalk.dim(text),
	hr: (text: string) => chalk.dim(text),
	listBullet: (text: string) => chalk.cyan(text),
	bold: (text: string) => chalk.bold(text),
	italic: (text: string) => chalk.italic(text),
	strikethrough: (text: string) => chalk.strikethrough(text),
	underline: (text: string) => chalk.underline(text),
	symbols: defaultSymbols,
};

export const defaultEditorTheme: EditorTheme = {
	borderColor: (text: string) => chalk.dim(text),
	selectList: defaultSelectListTheme,
	symbols: defaultSymbols,
};
