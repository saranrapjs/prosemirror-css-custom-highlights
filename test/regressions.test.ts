import { afterEach, expect, test } from "vitest";
import { EditorView, DecorationSet, Decoration } from "prosemirror-view";
import { EditorState, Plugin, PluginKey, TextSelection, Transaction } from "prosemirror-state";
import { Node as PMNode } from "prosemirror-model";
import { schema } from "prosemirror-schema-basic";
import { cssHighlights, highlight } from "../src/highlights";
import { verifyHighlights } from "./test-utils";

const { doc, paragraph: p, heading: h } = schema.nodes;
const { strong, em } = schema.marks;
const t = (text: string, ...marks: any[]) => schema.text(text, marks.map(m => m.create()));
const h2 = (...content: PMNode[]) => h.create({ level: 2 }, content);

const key = new PluginKey<DecorationSet>("test-highlights");
let view: EditorView | undefined;

afterEach(() => {
	view?.destroy();
	view?.dom.remove();
	view = undefined;
});

function setup(content: PMNode[], highlights: [number, number][]) {
	const mount = document.body.appendChild(document.createElement("div"));
	view = new EditorView(mount, {
		state: EditorState.create({
			doc: doc.create(null, content),
			plugins: [
				new Plugin<DecorationSet>({
					key,
					state: {
						init: (_, state) => DecorationSet.create(state.doc, highlights.map(([from, to]) => highlight(from, to, { name: "test" }))),
						apply: (tr, set) => tr.getMeta(key) ?? set.map(tr.mapping, tr.doc),
					},
					props: { highlights: state => key.getState(state) },
				}),
				cssHighlights(),
			],
		}),
	});
	expect(verifyHighlights(view).ok).toBe(true);
	return view;
}

function apply(view: EditorView, change: (tr: Transaction) => Transaction) {
	view.dispatch(change(view.state.tr));
	return verifyHighlights(view);
}

test("typing into an empty paragraph the highlight spans adds a range", () => {
	const v = setup([p.create(null, t("aa")), p.create(), p.create(null, t("bb"))], [[2, 8]]);
	expect(apply(v, tr => tr.insertText("new", 5))).toMatchObject({ ok: true, expected: 3 });
});

test("a deletion spanning the start, leaving a text node with identical text", () => {
	// "q" + strong("qxy") + "qqyqy": deleting 2..6 leaves "q" + "qyqy", which ProseMirror
	// renders by reusing the old "qqyqy" text node.
	const v = setup([p.create(null, [t("q"), t("qxy", strong), t("qqyqy")])], [[5, 10]]);
	expect(apply(v, tr => tr.delete(2, 6)).mismatches).toEqual([]);
});

test("splitting a heading so its first half ends in a reusable text node", () => {
	const v = setup([h2(t("x"), t("y", strong), t("xy"), t("q", strong), t("x"))], [[1, 7]]);
	expect(apply(v, tr => tr.split(5)).mismatches).toEqual([]);
});

test("removing marks so siblings are swapped around a surviving text node", () => {
	const v = setup([h2(t("xx", em, strong), t("xqq", strong), t("x", em), t("yxy", em, strong), t("qxqq", strong), t("q"))], [[1, 15]]);
	expect(apply(v, tr => tr.removeMark(5, 6, strong).removeMark(7, 14, strong)).mismatches).toEqual([]);
});

test("a split upstream of identical neighbouring blocks", () => {
	const x = () => h2(t("x", em, strong));
	const v = setup([h2(t("abc")), x(), x(), x(), h2()], [[7, 8], [10, 11]]);
	expect(apply(v, tr => tr.split(2)).mismatches).toEqual([]);
});

test("a decoration change elsewhere that re-renders the DOM without changing the doc", () => {
	const flag = new PluginKey<boolean>("flag");
	const mount = document.body.appendChild(document.createElement("div"));
	view = new EditorView(mount, {
		state: EditorState.create({
			doc: doc.create(null, [p.create(null, t("hello world"))]),
			plugins: [
				new Plugin<boolean>({
					key: flag,
					state: { init: () => false, apply: (tr, on) => tr.getMeta(flag) ?? on },
					props: {
						decorations: state => flag.getState(state)
							? DecorationSet.create(state.doc, [Decoration.inline(3, 9, { class: "split" })])
							: null,
					},
				}),
				new Plugin({ props: { highlights: state => DecorationSet.create(state.doc, [highlight(2, 11, { name: "test" })]) } }),
				cssHighlights(),
			],
		}),
	});
	expect(apply(view, tr => tr.setMeta(flag, true))).toMatchObject({ ok: true, expected: 1 });
	expect(apply(view, tr => tr.setMeta(flag, false))).toMatchObject({ ok: true, expected: 1 });
});

test("selection-only updates keep the same range objects", () => {
	const v = setup([p.create(null, t("hello world"))], [[2, 6]]);
	const before = [...CSS.highlights.get("test")!];
	v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 4)));
	expect([...CSS.highlights.get("test")!]).toEqual(before);
});

test("a block whose node object appears twice in the document", () => {
	const v = setup([p.create(null, t("aaa")), p.create(null, t("bbb"))], [[2, 3]]);
	// Inserting the first paragraph's own node object again (what pasting a block copied
	// from the same document does) leaves one node standing for two different blocks.
	const first = v.state.doc.child(0);
	expect(apply(v, tr => tr.insert(tr.doc.content.size, first)).mismatches).toEqual([]);
	const second = v.state.doc.content.size - first.nodeSize;
	expect(apply(v, tr => tr.setMeta(key, DecorationSet.create(tr.doc, [highlight(second + 2, second + 3, { name: "test" })]))).mismatches).toEqual([]);
});
