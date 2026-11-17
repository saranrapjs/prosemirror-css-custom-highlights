import { afterEach, expect, test } from "vitest";
import { EditorView, DecorationSet } from "prosemirror-view";
import { EditorState, Plugin, PluginKey } from "prosemirror-state";
import { schema } from "prosemirror-schema-basic";
import { cssHighlights, highlight } from "../src/highlights";
import { verifyHighlights } from "./test-utils";

const { doc, paragraph: p } = schema.nodes;

const key = new PluginKey<DecorationSet>("test-highlights");
let view: EditorView | undefined;

afterEach(() => {
	view?.destroy();
	view?.dom.remove();
	view = undefined;
});

// "abcde" with "bcd" (2..5) highlighted.
function setup(inclusiveStart: boolean, inclusiveEnd: boolean) {
	const mount = document.body.appendChild(document.createElement("div"));
	view = new EditorView(mount, {
		state: EditorState.create({
			doc: doc.create(null, [p.create(null, schema.text("abcde"))]),
			plugins: [
				new Plugin<DecorationSet>({
					key,
					state: {
						init: (_, state) => DecorationSet.create(state.doc, [highlight(2, 5, { name: "test" }, { inclusiveStart, inclusiveEnd })]),
						apply: (tr, set) => set.map(tr.mapping, tr.doc),
					},
					props: { highlights: state => key.getState(state) },
				}),
				cssHighlights(),
			],
		}),
	});
	return view;
}

function paintedText(view: EditorView): string[] {
	expect(verifyHighlights(view).mismatches).toEqual([]);
	return [...CSS.highlights.get("test") ?? []].map(range => {
		const live = document.createRange();
		live.setStart(range.startContainer, range.startOffset);
		live.setEnd(range.endContainer, range.endOffset);
		return live.toString();
	});
}

for (const inclusiveStart of [false, true]) {
	for (const inclusiveEnd of [false, true]) {
		const flags = `inclusiveStart: ${inclusiveStart}, inclusiveEnd: ${inclusiveEnd}`;

		test(`typing at the start edge (${flags})`, () => {
			const v = setup(inclusiveStart, inclusiveEnd);
			v.dispatch(v.state.tr.insertText("X", 2));
			expect(paintedText(v)).toEqual([inclusiveStart ? "Xbcd" : "bcd"]);
		});

		test(`typing at the end edge (${flags})`, () => {
			const v = setup(inclusiveStart, inclusiveEnd);
			v.dispatch(v.state.tr.insertText("X", 5));
			expect(paintedText(v)).toEqual([inclusiveEnd ? "bcdX" : "bcd"]);
		});

		test(`typing inside (${flags})`, () => {
			const v = setup(inclusiveStart, inclusiveEnd);
			v.dispatch(v.state.tr.insertText("X", 3));
			expect(paintedText(v)).toEqual(["bXcd"]);
		});

		test(`deleting everything it covers removes it (${flags})`, () => {
			const v = setup(inclusiveStart, inclusiveEnd);
			v.dispatch(v.state.tr.delete(2, 5));
			expect(paintedText(v)).toEqual([]);
			v.dispatch(v.state.tr.insertText("X", 2));
			expect(paintedText(v)).toEqual([]);
		});
	}
}
