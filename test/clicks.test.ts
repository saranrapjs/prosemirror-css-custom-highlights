import { afterEach, expect, test } from "vitest";
import { EditorView, DecorationSet, Decoration } from "prosemirror-view";
import { EditorState, Plugin } from "prosemirror-state";
import { schema } from "prosemirror-schema-basic";
import { cssHighlights, highlight } from "../src/highlights";

let view: EditorView | undefined;
let restore: (() => void) | undefined;

afterEach(() => {
	restore?.();
	restore = undefined;
	view?.destroy();
	view?.dom.remove();
	view = undefined;
});

function setup(onClick: (dec: Decoration) => void) {
	const mount = document.body.appendChild(document.createElement("div"));
	const { doc, paragraph: p } = schema.nodes;
	view = new EditorView(mount, {
		state: EditorState.create({
			doc: doc.create(null, [p.create(null, schema.text("one two three four"))]),
			plugins: [
				new Plugin({
					props: {
						highlights: state => DecorationSet.create(state.doc, [
							highlight(5, 8, { name: "click-test" }, { word: "two", onClick: (_view, dec) => onClick(dec) }),
							highlight(15, 19, { name: "click-test" }, { word: "four" }),
						]),
					},
				}),
				cssHighlights(),
			],
		}),
	});
	return view;
}

function centerOf(view: EditorView, from: number, to: number) {
	const start = view.coordsAtPos(from, 1), end = view.coordsAtPos(to, -1);
	return { x: (start.left + end.right) / 2, y: (start.top + start.bottom) / 2 };
}

function click(target: Element, { x, y }: { x: number; y: number }) {
	const init = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, detail: 1, view: window };
	target.dispatchEvent(new MouseEvent("mousedown", init));
	target.dispatchEvent(new MouseEvent("mouseup", init));
	target.dispatchEvent(new MouseEvent("click", init));
}

function hideHighlightsFromPoint() {
	const registry = CSS.highlights as unknown as Record<string, unknown>;
	Object.defineProperty(registry, "highlightsFromPoint", { value: undefined, configurable: true });
	return () => delete registry.highlightsFromPoint;
}

for (const variant of ["highlightsFromPoint", "posAtCoords fallback"] as const) {
	test(`clicking a highlight calls its onClick (${variant})`, () => {
		if (variant === "posAtCoords fallback") restore = hideHighlightsFromPoint();
		const clicked: string[] = [];
		const v = setup(dec => clicked.push(dec.spec.word));
		const textNode = v.dom.querySelector("p")!.firstChild!.parentElement!;

		click(textNode, centerOf(v, 5, 8));
		expect(clicked).toEqual(["two"]);

		click(textNode, centerOf(v, 1, 4));
		click(textNode, centerOf(v, 15, 19));
		expect(clicked).toEqual(["two"]);
	});
}
