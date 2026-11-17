import { afterEach, expect, test } from "vitest";
import { EditorView, DecorationSet } from "prosemirror-view";
import { EditorState, Plugin, PluginKey } from "prosemirror-state";
import { Node as PMNode } from "prosemirror-model";
import { schema } from "prosemirror-schema-basic";
import { cssHighlights, highlight } from "../src/highlights";
import { Composition, verifyHighlights } from "./test-utils";

const { doc, paragraph: p } = schema.nodes;
const { strong } = schema.marks;
const t = (text: string, ...marks: any[]) => schema.text(text, marks.map(m => m.create()));

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
						apply: (tr, set) => set.map(tr.mapping, tr.doc),
					},
					props: { highlights: state => key.getState(state) },
				}),
				cssHighlights(),
			],
		}),
	});
	expect(verifyHighlights(view).mismatches).toEqual([]);
	return view;
}

test("composing inside a highlighted word, through conversion and commit", async () => {
	const v = setup([p.create(null, t("hello world"))], [[2, 11]]);
	const composition = new Composition(v);
	await composition.begin(4, "か");
	expect(v.state.doc.textContent).toBe("helかlo world");
	expect(verifyHighlights(v).mismatches).toEqual([]);
	await composition.update("かんじ");
	expect(verifyHighlights(v).mismatches).toEqual([]);
	await composition.update("漢字");
	expect(v.state.doc.textContent).toBe("hel漢字lo world");
	expect(verifyHighlights(v).mismatches).toEqual([]);
	await composition.end();
	expect(verifyHighlights(v)).toMatchObject({ ok: true, expected: 1 });
});

test("composing before a highlight in the same text node", async () => {
	const v = setup([p.create(null, t("hello world"))], [[7, 12]]);
	const composition = new Composition(v);
	await composition.begin(2, "한");
	await composition.update("한글");
	expect(verifyHighlights(v).mismatches).toEqual([]);
	await composition.end();
	expect(v.state.doc.textContent).toBe("h한글ello world");
	expect(verifyHighlights(v).mismatches).toEqual([]);
});

test("composing at a mark boundary inside a highlight", async () => {
	const v = setup([p.create(null, [t("plain "), t("bold", strong), t(" tail")])], [[3, 14]]);
	const composition = new Composition(v);
	await composition.begin(11, "かん");
	expect(verifyHighlights(v).mismatches).toEqual([]);
	await composition.end();
	expect(verifyHighlights(v).mismatches).toEqual([]);
});

test("composing into an empty paragraph a highlight spans", async () => {
	const v = setup([p.create(null, t("aa")), p.create(), p.create(null, t("bb"))], [[2, 8]]);
	const composition = new Composition(v);
	await composition.begin(5, "é");
	expect(v.state.doc.child(1).textContent).toBe("é");
	expect(verifyHighlights(v).mismatches).toEqual([]);
	await composition.end();
	expect(verifyHighlights(v)).toMatchObject({ ok: true, expected: 3 });
});

test("edits elsewhere while a composition is open", async () => {
	const v = setup([p.create(null, t("first line")), p.create(null, t("second line"))], [[2, 9], [15, 22]]);
	const composition = new Composition(v);
	await composition.begin(17, "か");
	v.dispatch(v.state.tr.insertText("XY", 3));
	expect(verifyHighlights(v).mismatches).toEqual([]);
	await composition.update("かな");
	expect(verifyHighlights(v).mismatches).toEqual([]);
	v.dispatch(v.state.tr.split(5));
	expect(verifyHighlights(v).mismatches).toEqual([]);
	await composition.update("仮名");
	await composition.end();
	expect(verifyHighlights(v).mismatches).toEqual([]);
});

test("a highlight added over the text being composed", async () => {
	const v = setup([p.create(null, t("hello world"))], []);
	const composition = new Composition(v);
	await composition.begin(6, "かん");
	v.dispatch(v.state.tr.setMeta(key, true));
	const set = DecorationSet.create(v.state.doc, [highlight(3, 9, { name: "test" })]);
	v.updateState(v.state.reconfigure({
		plugins: [new Plugin({ props: { highlights: () => set } }), cssHighlights()],
	}));
	expect(verifyHighlights(v).mismatches).toEqual([]);
	await composition.update("漢");
	expect(verifyHighlights(v).mismatches).toEqual([]);
	await composition.end();
	expect(verifyHighlights(v).mismatches).toEqual([]);
});
