class TestHTMLElement {}

const globals = globalThis as typeof globalThis & { HTMLElement?: typeof HTMLElement };
globals.HTMLElement ??= TestHTMLElement as unknown as typeof HTMLElement;
