import { EditorView, DecorationSet, Decoration, NodeView } from "prosemirror-view";
import { Node as PMNode, Schema } from "prosemirror-model";
import { EditorState, Plugin, PluginKey } from "prosemirror-state";
import { schema as basicSchema } from "prosemirror-schema-basic";
import { addListNodes } from "prosemirror-schema-list";
import { cssHighlights, highlight } from "../src/highlights";

export type Mode = "none" | "inline" | "highlights" | "highlights-all" | "highlights-fresh";

// "flat" puts every paragraph at the top level. "list" puts each one in an item of a
// single bullet list, rendered by a node view that nests the item's content beside
// non-editable chrome rather than directly in the <li> its toDOM describes.
export type Shape = "flat" | "list";

export interface PerfOptions {
	mode: Mode;
	paragraphCount: number;
	highlightCount: number;
	seed?: number;
	highlightParagraphs?: [start: number, end: number];
	shape?: Shape;
}

const schema = new Schema({
	nodes: addListNodes(basicSchema.spec.nodes, "paragraph block*", "block"),
	marks: basicSchema.spec.marks,
});

// A task list item: a checkbox, then the item's content in a <div> of its own. Left
// unstyled, since laying 5,000 of them out as flex rows made every dispatch take ~130ms.
class TaskItemView implements NodeView {
	dom = document.createElement("li");
	contentDOM: HTMLElement;
	constructor() {
		const checkbox = this.dom.appendChild(document.createElement("input"));
		checkbox.type = "checkbox";
		checkbox.contentEditable = "false";
		this.contentDOM = this.dom.appendChild(document.createElement("div"));
	}
}

function mulberry32(seed: number) {
	return () => {
		seed = seed + 0x6D2B79F5 | 0;
		let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
		t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
		return ((t ^ t >>> 14) >>> 0) / 4294967296;
	};
}

const words = ["lorem", "ipsum", "dolor", "sit", "amet", "consectetur", "adipiscing", "elit", "sed", "do", "eiusmod", "tempor"];

export const spansKey = new PluginKey<DecorationSet>("spans");

export function createPerfEditor(mount: HTMLElement, { mode, paragraphCount, highlightCount, seed = 42, highlightParagraphs, shape = "flat" }: PerfOptions) {
	const random = mulberry32(seed);
	const rand = (n: number) => Math.floor(random() * n);

	const paragraphs: PMNode[] = [];
	for (let i = 0; i < paragraphCount; i++) {
		const content: PMNode[] = [];
		for (let w = 0; w < 14; w++) {
			const roll = rand(10);
			const marks = roll === 0 ? [schema.marks.strong.create()] : roll === 1 ? [schema.marks.em.create()] : [];
			content.push(schema.text(words[rand(words.length)] + " ", marks));
		}
		paragraphs.push(schema.node("paragraph", null, content));
	}
	const inList = shape === "list";
	const doc = schema.node("doc", null, inList
		? schema.node("bullet_list", null, paragraphs.map(paragraph => schema.node("list_item", null, paragraph)))
		: paragraphs);

	const randomSpans = (doc: PMNode) => {
		const starts: number[] = [], textblocks: PMNode[] = [];
		doc.descendants((node, pos) => {
			if (!node.isTextblock) return true;
			starts.push(pos);
			textblocks.push(node);
			return false;
		});
		const spans = [];
		for (let i = 0; i < highlightCount; i++) {
			const [first, last] = highlightParagraphs ?? [0, starts.length];
			const index = first + rand(last - first);
			const paragraph = textblocks[index];
			const from = starts[index] + 1 + rand(paragraph.content.size - 20);
			const crossesBlocks = rand(10) === 0;
			const to = crossesBlocks ? Math.min(doc.content.size - 1, from + paragraph.nodeSize + rand(60)) : from + 3 + rand(15);
			spans.push({ from, to });
		}
		return spans;
	};

	const spansPlugin = (render: (from: number, to: number) => Decoration, prop: "decorations" | "highlights" | null) =>
		new Plugin<DecorationSet>({
			key: spansKey,
			state: {
				init: (_, state) => DecorationSet.create(state.doc, randomSpans(state.doc).map(s => render(s.from, s.to))),
				apply: (tr, set) => set.map(tr.mapping, tr.doc),
			},
			props: prop ? { [prop]: (state: EditorState) => spansKey.getState(state) } : {},
		});

	const freshSets = new WeakMap<EditorState, DecorationSet>();
	const freshHighlights = (state: EditorState) => {
		let set = freshSets.get(state);
		if (!set) {
			const decorations = spansKey.getState(state)!.find().map(d => highlight(d.from, d.to, { name: "perf" }));
			freshSets.set(state, set = DecorationSet.create(state.doc, decorations));
		}
		return set;
	};

	const plugins = {
		none: () => [spansPlugin((from, to) => Decoration.inline(from, to, {}), null)],
		inline: () => [spansPlugin((from, to) => Decoration.inline(from, to, { class: "perf-inline" }), "decorations")],
		highlights: () => [spansPlugin((from, to) => highlight(from, to, { name: "perf" }), "highlights"), cssHighlights()],
		"highlights-all": () => [spansPlugin((from, to) => highlight(from, to, { name: "perf" }), "highlights"), cssHighlights({ viewportOnly: false })],
		"highlights-fresh": () => [
			spansPlugin((from, to) => Decoration.inline(from, to, {}), null),
			new Plugin({ props: { highlights: freshHighlights } }),
			cssHighlights(),
		],
	}[mode]();

	const view = new EditorView(mount, {
		state: EditorState.create({ doc, plugins }),
		nodeViews: inList ? { list_item: () => new TaskItemView() } : {},
	});

	// The top-level blocks, or the list's items, each of which starts with a paragraph.
	const blocks = () => inList ? view.state.doc.child(0) : view.state.doc;
	const positionIn = (index: number) => {
		let pos = inList ? 1 : 0;
		for (let i = 0; i < index; i++) pos += blocks().child(i).nodeSize;
		const block = blocks().child(index);
		return inList ? pos + 2 + rand(block.child(0).content.size) : pos + 1 + rand(block.content.size);
	};

	return {
		view,
		rand,
		textPosition: () => positionIn(rand(blocks().childCount)),
		visibleTextPosition: (paragraphs: number) => positionIn(rand(Math.min(paragraphs, blocks().childCount))),
	};
}
