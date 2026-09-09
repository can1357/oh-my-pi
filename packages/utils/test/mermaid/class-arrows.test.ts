/**
 * Comprehensive tests for class diagram arrow directions.
 *
 * Ensures all relationship types have correctly oriented arrows:
 * - Inheritance/Realization: hollow triangles point toward parent/interface
 * - Association/Dependency: filled arrows point from source to target
 * - Composition/Aggregation: diamonds are omnidirectional
 */

import { describe, expect, test } from "bun:test";
import { type AsciiRenderOptions, renderMermaidAscii as renderRaw } from "../../src/vendor/mermaid-ascii/ascii/index";

// Pin colorMode so assertions stay deterministic even if a concurrent or leaked
// TTY override makes the renderer auto-detect ANSI color.
function renderMermaidAscii(text: string, opts: AsciiRenderOptions = {}): string {
	return renderRaw(text, { colorMode: "none", ...opts });
}

describe("Class Diagram Arrow Directions", () => {
	// ============================================================================
	// INHERITANCE (<|--)
	// ============================================================================

	describe("Inheritance (<|--)", () => {
		test("parent above child - triangle points UP toward parent", () => {
			const diagram = `classDiagram
        Animal <|-- Dog`;
			const result = renderMermaidAscii(diagram);

			// Should contain upward triangle
			expect(result).toContain("△");
			expect(result).not.toContain("▽");

			// Parent should be above child
			const lines = result.split("\n");
			const animalLine = lines.findIndex(l => l.includes("Animal"));
			const dogLine = lines.findIndex(l => l.includes("Dog"));
			expect(animalLine).toBeLessThan(dogLine);
		});

		test("multiple inheritance creates separate arrows", () => {
			const diagram = `classDiagram
        Animal <|-- Dog
        Animal <|-- Cat
        Dog <|-- Puppy`;
			const result = renderMermaidAscii(diagram);

			// Animal should be at top, then Dog/Cat, then Puppy
			const lines = result.split("\n");
			const animalLine = lines.findIndex(l => l.includes("Animal"));
			const dogLine = lines.findIndex(l => l.includes("Dog"));
			const catLine = lines.findIndex(l => l.includes("Cat"));
			const puppyLine = lines.findIndex(l => l.includes("Puppy"));

			expect(animalLine).toBeLessThan(dogLine);
			expect(animalLine).toBeLessThan(catLine);
			expect(dogLine).toBeLessThan(puppyLine);
		});

		test("multi-level inheritance - all triangles point UP", () => {
			const diagram = `classDiagram
        Animal <|-- Mammal
        Mammal <|-- Dog`;
			const result = renderMermaidAscii(diagram);

			// Verify ordering: Animal > Mammal > Dog (top to bottom)
			const lines = result.split("\n");
			const animalLine = lines.findIndex(l => l.includes("Animal"));
			const mammalLine = lines.findIndex(l => l.includes("Mammal"));
			const dogLine = lines.findIndex(l => l.includes("Dog"));

			expect(animalLine).toBeLessThan(mammalLine);
			expect(mammalLine).toBeLessThan(dogLine);

			// All triangles should point up
			expect(result.match(/△/g)?.length).toBe(2);
		});

		test("multiple inheritance from same parent", () => {
			const diagram = `classDiagram
        Animal <|-- Dog
        Animal <|-- Cat`;
			const result = renderMermaidAscii(diagram);

			// Animal should be above both children
			const lines = result.split("\n");
			const animalLine = lines.findIndex(l => l.includes("Animal"));
			const dogLine = lines.findIndex(l => l.includes("Dog"));
			const catLine = lines.findIndex(l => l.includes("Cat"));

			expect(animalLine).toBeLessThan(dogLine);
			expect(animalLine).toBeLessThan(catLine);

			// Should have at least one triangle pointing up (may merge visually)
			expect(result).toContain("△");
		});

		test("ASCII mode uses ^ for upward triangle", () => {
			const diagram = `classDiagram
        Animal <|-- Dog`;
			const result = renderMermaidAscii(diagram, { useAscii: true });

			expect(result).toContain("^");
			expect(result).not.toContain("v");
		});
	});

	// ============================================================================
	// ASSOCIATION (-->)
	// ============================================================================

	describe("Association (-->)", () => {
		test("source above target - arrow points DOWN", () => {
			const diagram = `classDiagram
        Person --> Address`;
			const result = renderMermaidAscii(diagram);

			// Should contain downward arrow
			expect(result).toContain("▼");
			expect(result).not.toContain("▲");

			// Person should be above Address
			const lines = result.split("\n");
			const personLine = lines.findIndex(l => l.includes("Person"));
			const addressLine = lines.findIndex(l => l.includes("Address"));
			expect(personLine).toBeLessThan(addressLine);
		});

		test("multiple associations from same source", () => {
			const diagram = `classDiagram
        Person --> Address
        Person --> Phone`;
			const result = renderMermaidAscii(diagram);

			// Person should be above both targets
			const lines = result.split("\n");
			const personLine = lines.findIndex(l => l.includes("Person"));
			const addressLine = lines.findIndex(l => l.includes("Address"));
			const phoneLine = lines.findIndex(l => l.includes("Phone"));

			expect(personLine).toBeLessThan(addressLine);
			expect(personLine).toBeLessThan(phoneLine);
		});

		test("chain of associations", () => {
			const diagram = `classDiagram
        A --> B
        B --> C`;
			const result = renderMermaidAscii(diagram);

			// A > B > C ordering
			const lines = result.split("\n");
			const aLine = lines.findIndex(l => l.includes("│ A │"));
			const bLine = lines.findIndex(l => l.includes("│ B │"));
			const cLine = lines.findIndex(l => l.includes("│ C │"));

			expect(aLine).toBeLessThan(bLine);
			expect(bLine).toBeLessThan(cLine);

			// Both arrows point down
			expect(result.match(/▼/g)?.length).toBe(2);
		});

		test("ASCII mode uses v for downward arrow", () => {
			const diagram = `classDiagram
        Person --> Address`;
			const result = renderMermaidAscii(diagram, { useAscii: true });

			expect(result).toContain("v");
			expect(result).not.toContain("^");
		});
	});

	// ============================================================================
	// DEPENDENCY (..>)
	// ============================================================================

	describe("Dependency (..>)", () => {
		test("source above target - arrow points DOWN", () => {
			const diagram = `classDiagram
        Client ..> Server`;
			const result = renderMermaidAscii(diagram);

			expect(result).toContain("▼");
			expect(result).not.toContain("▲");

			const lines = result.split("\n");
			const clientLine = lines.findIndex(l => l.includes("Client"));
			const serverLine = lines.findIndex(l => l.includes("Server"));
			expect(clientLine).toBeLessThan(serverLine);
		});

		test("multiple dependencies", () => {
			const diagram = `classDiagram
        Client ..> Server
        Client ..> Database`;
			const result = renderMermaidAscii(diagram);

			const lines = result.split("\n");
			const clientLine = lines.findIndex(l => l.includes("Client"));
			const serverLine = lines.findIndex(l => l.includes("Server"));
			const dbLine = lines.findIndex(l => l.includes("Database"));

			expect(clientLine).toBeLessThan(serverLine);
			expect(clientLine).toBeLessThan(dbLine);
		});

		test("ASCII mode uses v for downward arrow", () => {
			const diagram = `classDiagram
        Client ..> Server`;
			const result = renderMermaidAscii(diagram, { useAscii: true });

			expect(result).toContain("v");
		});
	});

	// ============================================================================
	// REALIZATION (..|>)
	// ============================================================================

	describe("Realization (..|>)", () => {
		test("interface above implementation - triangle points UP", () => {
			// Circle ..|> Shape means "Circle implements Shape"
			// Shape (interface/parent) should be placed ABOVE Circle (implementation/child)
			const diagram = `classDiagram
        Circle ..|> Shape`;
			const result = renderMermaidAscii(diagram);

			// Shape (interface) should be above Circle (implementation)
			const lines = result.split("\n");
			const shapeLine = lines.findIndex(l => l.includes("Shape"));
			const circleLine = lines.findIndex(l => l.includes("Circle"));
			expect(shapeLine).toBeLessThan(circleLine);
			expect(result).toContain("△");
		});

		test("realization with <|.. syntax (marker at from end)", () => {
			// Shape <|.. Circle means "Circle implements Shape" (same as Circle ..|> Shape)
			const diagram = `classDiagram
        Shape <|.. Circle`;
			const result = renderMermaidAscii(diagram);

			// Shape (interface) should be above Circle (implementation)
			const lines = result.split("\n");
			const shapeLine = lines.findIndex(l => l.includes("Shape"));
			const circleLine = lines.findIndex(l => l.includes("Circle"));
			expect(shapeLine).toBeLessThan(circleLine);
			expect(result).toContain("△");
		});

		test("multiple implementations", () => {
			// Circle and Square both implement Shape
			const diagram = `classDiagram
        Circle ..|> Shape
        Square ..|> Shape`;
			const result = renderMermaidAscii(diagram);

			// Shape (interface) above both implementations
			const lines = result.split("\n");
			const shapeLine = lines.findIndex(l => l.includes("Shape"));
			const circleLine = lines.findIndex(l => l.includes("Circle"));
			const squareLine = lines.findIndex(l => l.includes("Square"));

			expect(shapeLine).toBeLessThan(circleLine);
			expect(shapeLine).toBeLessThan(squareLine);
			// At least one triangle (may merge visually if same connection point)
			expect(result).toContain("△");
		});
	});

	// ============================================================================
	// COMPOSITION & AGGREGATION (omnidirectional diamonds)
	// ============================================================================

	describe("Composition (*--) and Aggregation (o--)", () => {
		test("composition - diamond is omnidirectional", () => {
			const diagram = `classDiagram
        Car *-- Engine`;
			const result = renderMermaidAscii(diagram);

			// Should contain filled diamond
			expect(result).toContain("◆");
		});

		test("aggregation - hollow diamond is omnidirectional", () => {
			const diagram = `classDiagram
        Team o-- Player`;
			const result = renderMermaidAscii(diagram);

			// Should contain hollow diamond
			expect(result).toContain("◇");
		});
	});

	// ============================================================================
	// MIXED SCENARIOS
	// ============================================================================

	describe("Mixed Relationship Scenarios", () => {
		test("all 6 relationship types together", () => {
			const diagram = `classDiagram
        A <|-- B : inheritance
        C *-- D : composition
        E o-- F : aggregation
        G --> H : association
        I ..> J : dependency
        K ..|> L : realization`;
			const result = renderMermaidAscii(diagram);

			// Upward triangles for inheritance and realization
			expect(result.match(/△/g)?.length).toBe(2);

			// Downward arrows for association and dependency
			expect(result.match(/▼/g)?.length).toBe(2);

			// Diamonds for composition and aggregation
			expect(result).toContain("◆");
			expect(result).toContain("◇");
		});

		test("inheritance with association - different arrow directions", () => {
			const diagram = `classDiagram
        Animal <|-- Dog
        Dog --> Food`;
			const result = renderMermaidAscii(diagram);

			// Should have both up triangle (inheritance) and down arrow (association)
			expect(result).toContain("△");
			expect(result).toContain("▼");
		});

		test("circular reference creates valid layout", () => {
			const diagram = `classDiagram
        A --> B
        B --> C
        C ..> A`;
			const result = renderMermaidAscii(diagram);

			// Cycles may create mixed arrow directions (up and down) to avoid overlaps
			// Just verify arrows are present and classes are rendered
			const hasUpArrow = result.includes("▲");
			const hasDownArrow = result.includes("▼");
			expect(hasUpArrow || hasDownArrow).toBe(true);
			expect(result).toContain("│ A │");
			expect(result).toContain("│ B │");
			expect(result).toContain("│ C │");
		});
	});

	// ============================================================================
	// ASCII vs UNICODE CONSISTENCY
	// ============================================================================

	describe("ASCII and Unicode Mode Consistency", () => {
		test("same diagram produces consistent layouts in both modes", () => {
			const diagram = `classDiagram
        Animal <|-- Dog
        Person --> Address`;

			const unicode = renderMermaidAscii(diagram);
			const ascii = renderMermaidAscii(diagram, { useAscii: true });

			// Both should have same node ordering
			const unicodeLines = unicode.split("\n");
			const asciiLines = ascii.split("\n");

			const uAnimal = unicodeLines.findIndex(l => l.includes("Animal"));
			const uDog = unicodeLines.findIndex(l => l.includes("Dog"));
			const aPerson = asciiLines.findIndex(l => l.includes("Person"));
			const aAddress = asciiLines.findIndex(l => l.includes("Address"));

			expect(uAnimal).toBeLessThan(uDog);
			expect(aPerson).toBeLessThan(aAddress);

			// Unicode has △ and ▼, ASCII has ^ and v
			expect(unicode).toContain("△");
			expect(unicode).toContain("▼");
			expect(ascii).toContain("^");
			expect(ascii).toContain("v");
		});
	});

	// ============================================================================
	// EDGE CASES
	// ============================================================================

	describe("Edge Cases", () => {
		test("single inheritance relationship", () => {
			const diagram = `classDiagram
        A <|-- B`;
			const result = renderMermaidAscii(diagram);

			expect(result).toContain("△");
			const lines = result.split("\n");
			const aLine = lines.findIndex(l => l.includes("│ A │"));
			const bLine = lines.findIndex(l => l.includes("│ B │"));
			expect(aLine).toBeLessThan(bLine);
		});

		test("classes with members maintain arrow directions", () => {
			const diagram = `classDiagram
        class Animal {
          +String name
          +eat() void
        }
        class Dog {
          +bark() void
        }
        Animal <|-- Dog`;
			const result = renderMermaidAscii(diagram);

			expect(result).toContain("△");
			const lines = result.split("\n");
			const animalLine = lines.findIndex(l => l.includes("Animal"));
			const dogLine = lines.findIndex(l => l.includes("Dog"));
			expect(animalLine).toBeLessThan(dogLine);
		});
	});
});
