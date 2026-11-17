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

function setup(decorations: (state: EditorState) => DecorationSet) {
	const mount = document.body.appendChild(document.createElement("div"));
	view = new EditorView(mount, {
		state: EditorState.create({
			doc: doc.create(null, [p.create(null, schema.text("one two three"))]),
			plugins: [
				new Plugin<DecorationSet>({
					key,
					state: {
						init: (_, state) => decorations(state),
						apply: (tr, set) => tr.getMeta(key) ?? set.map(tr.mapping, tr.doc),
					},
					props: { highlights: state => key.getState(state) },
				}),
				cssHighlights(),
			],
		}),
	});
	return view;
}

test("priority and type are applied to the registered Highlight", () => {
	const v = setup(state => DecorationSet.create(state.doc, [
		highlight(1, 4, { name: "test", priority: 3, type: "spelling-error" }),
	]));
	expect(verifyHighlights(v).mismatches).toEqual([]);
	const registered = CSS.highlights.get("test")!;
	expect(registered.priority).toBe(3);
	expect(registered.type).toBe("spelling-error");
});

test("a name alone leaves the default priority and type", () => {
	setup(state => DecorationSet.create(state.doc, [highlight(1, 4, { name: "test" })]));
	const registered = CSS.highlights.get("test")!;
	expect(registered.priority).toBe(0);
	expect(registered.type).toBe("highlight");
});

test("changing only the priority updates the registered Highlight", () => {
	const v = setup(state => DecorationSet.create(state.doc, [highlight(1, 4, { name: "test", priority: 1 })]));
	expect(CSS.highlights.get("test")!.priority).toBe(1);
	v.dispatch(v.state.tr.setMeta(key, DecorationSet.create(v.state.doc, [highlight(1, 4, { name: "test", priority: 5 })])));
	expect(CSS.highlights.get("test")!.priority).toBe(5);
	expect(verifyHighlights(v).mismatches).toEqual([]);
});

test("the last decoration sharing a name wins", () => {
	setup(state => DecorationSet.create(state.doc, [
		highlight(1, 4, { name: "test", priority: 1 }),
		highlight(5, 8, { name: "test", priority: 2 }),
	]));
	expect(CSS.highlights.get("test")!.priority).toBe(2);
	expect(CSS.highlights.get("test")!.size).toBe(2);
});
