export interface BoxSymbols {
	topLeft: string;
	topRight: string;
	bottomLeft: string;
	bottomRight: string;
	horizontal: string;
	vertical: string;
	teeDown: string;
	teeUp: string;
	teeLeft: string;
	teeRight: string;
	cross: string;
}

export interface SymbolTheme {
	cursor: string;
	inputCursor: string;
	boxRound: Omit<BoxSymbols, "teeDown" | "teeUp" | "teeLeft" | "teeRight" | "cross">;
	boxSharp: BoxSymbols;
	table: BoxSymbols;
	quoteBorder: string;
	hrChar: string;
	/** Chip glyph drawn (painted with the referenced color) before inline hex colors. */
	colorSwatch?: string;
	spinnerFrames: string[];
}
