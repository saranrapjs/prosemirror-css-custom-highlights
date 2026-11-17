import { EditorView, DecorationSet, Decoration, NodeView, MarkView } from "prosemirror-view";
import { Schema, Node as PMNode, Mark } from "prosemirror-model";
import { EditorState, Plugin, PluginKey, Transaction } from "prosemirror-state";
import { schema as basicSchema } from "prosemirror-schema-basic";
import { addListNodes, splitListItem, liftListItem, sinkListItem } from "prosemirror-schema-list";
import { keymap } from "prosemirror-keymap";
import { baseKeymap } from "prosemirror-commands";
import { history, undo, redo } from "prosemirror-history";
import { cssHighlights, highlight, HighlightSpec } from "../src/highlights";
import { fuzzHighlights, markChrome, FuzzOptions } from "../test/test-utils";

export const schema = new Schema({
	nodes: addListNodes(basicSchema.spec.nodes, "paragraph block*", "block")
		.addToEnd("callout", {
			group: "block",
			content: "block+",
			toDOM: () => ["div", { class: "callout" }, 0],
			parseDOM: [{ tag: "div.callout" }],
		})
		.addToEnd("mention", {
			group: "inline",
			inline: true,
			atom: true,
			attrs: { name: {} },
			leafText: node => `@${node.attrs.name}`,
			toDOM: node => ["span", { class: "mention" }, `@${node.attrs.name}`],
		}),
	marks: basicSchema.spec.marks,
});

class CalloutView implements NodeView {
	dom: HTMLElement;
	contentDOM: HTMLElement;
	constructor() {
		this.dom = document.createElement("div");
		this.dom.className = "callout";
		const label = this.dom.appendChild(document.createElement("div"));
		label.className = "callout-label";
		label.contentEditable = "false";
		label.textContent = "💡 Note";
		this.contentDOM = this.dom.appendChild(document.createElement("div"));
	}
}

// A textblock node view whose DOM holds text outside its contentDOM.
class HeadingView implements NodeView {
	dom: HTMLElement;
	contentDOM: HTMLElement;
	constructor(node: PMNode) {
		this.dom = document.createElement(`h${node.attrs.level}`);
		const anchor = this.dom.appendChild(markChrome(document.createElement("span")));
		anchor.className = "heading-anchor";
		anchor.contentEditable = "false";
		anchor.textContent = "§ ";
		this.contentDOM = this.dom.appendChild(document.createElement("span"));
	}
}

// A mark view with text after its content, inside the textblock's inline flow.
function linkView(mark: Mark): MarkView {
	const dom = document.createElement("a");
	dom.href = mark.attrs.href;
	const contentDOM = dom.appendChild(document.createElement("span"));
	const icon = dom.appendChild(markChrome(document.createElement("span")));
	icon.contentEditable = "false";
	icon.textContent = "↗";
	return { dom, contentDOM };
}

class MentionView implements NodeView {
	dom: HTMLElement;
	constructor(node: PMNode) {
		this.dom = document.createElement("span");
		this.dom.className = "mention";
		this.dom.textContent = `@${node.attrs.name}`;
	}
}

const { doc, paragraph: p, heading, blockquote, bullet_list, list_item, callout, mention, code_block, hard_break } = schema.nodes;
const { strong, em, code, link } = schema.marks;
const t = (text: string, ...marks: any[]) => schema.text(text, marks.map(m => m.create ? m.create() : m));

export const initialDoc = doc.create(null, [
	heading.create({ level: 2 }, t("A heterogeneous document")),
	p.create(null, [t("Some "), t("bold", strong), t(" and "), t("italic", em), t(" text with "), t("inline code", code), t(" and a "), t("link", link.create({ href: "#" })), t(".")]),
	blockquote.create(null, [p.create(null, t("A quoted paragraph inside a blockquote."))]),
	bullet_list.create(null, [
		list_item.create(null, [p.create(null, t("First item"))]),
		list_item.create(null, [
			p.create(null, t("Second item with a nested list")),
			bullet_list.create(null, [
				list_item.create(null, p.create(null, t("Nested one"))),
				list_item.create(null, p.create(null, t("Nested two"))),
			]),
		]),
	]),
	callout.create(null, [
		p.create(null, t("A callout rendered by a node view with non-editable chrome.")),
		p.create(null, [t("It has "), t("two", strong), t(" paragraphs.")]),
	]),
	p.create(null, [t("Ping "), mention.create({ name: "jeff" }), t(" and "), mention.create({ name: "ada" }), t(" here,"), hard_break.create(), t("then a line break.")]),
	code_block.create(null, t("const x = 1;\nconst y = 2;")),
]);

function findText(doc: PMNode, text: string): number {
	let found = -1;
	doc.descendants((node, pos) => {
		if (found >= 0) return false;
		if (node.isText) {
			const index = node.text!.indexOf(text);
			if (index >= 0) found = pos + index;
		}
	});
	if (found < 0) throw new Error(`text not found: ${text}`);
	return found;
}

function span(doc: PMNode, start: string, end: string) {
	return [findText(doc, start), findText(doc, end) + end.length] as const;
}

export interface Comment {
	author: string;
	text: string;
}

export const commentsKey = new PluginKey<DecorationSet>("comments");

type CommentAction = { add: Decoration } | { remove: Decoration };

export type CommentClickHandler = NonNullable<HighlightSpec["onClick"]>;

export function addComment(tr: Transaction, dec: Decoration): Transaction {
	return tr.setMeta(commentsKey, { add: dec });
}

export function removeComment(tr: Transaction, dec: Decoration): Transaction {
	return tr.setMeta(commentsKey, { remove: dec });
}

function commentsPlugin(commentHighlight: (from: number, to: number, comment: Comment) => Decoration) {
	return new Plugin<DecorationSet>({
		key: commentsKey,
		state: {
			init: (_, state) => DecorationSet.create(state.doc, [
				commentHighlight(...span(state.doc, "bold", "code"), { author: "ada", text: "Crosses three marks." }),
				commentHighlight(...span(state.doc, "quoted", "Second item"), { author: "jeff", text: "Blockquote into a list." }),
				commentHighlight(...span(state.doc, "Nested one", "Nested two"), { author: "ada", text: "Nested list items." }),
				commentHighlight(...span(state.doc, "with a nested list", "A callout"), { author: "jeff", text: "From a list item into the callout, skipping its label." }),
				commentHighlight(...span(state.doc, "rendered by", " paragraphs."), { author: "ada", text: "Both paragraphs inside the node view's contentDOM." }),
				commentHighlight(...span(state.doc, "Ping", "line break"), { author: "jeff", text: "Across two mention node views and a hard break." }),
			]),
			apply(tr, set) {
				set = set.map(tr.mapping, tr.doc);
				const action: CommentAction | undefined = tr.getMeta(commentsKey);
				if (action && "add" in action) set = set.add(tr.doc, [action.add]);
				if (action && "remove" in action) set = set.remove(set.find(undefined, undefined, spec => spec === action.remove.spec));
				return set;
			},
		},
		props: {
			highlights: state => commentsKey.getState(state),
		},
	});
}

export const spellingKey = new PluginKey<DecorationSet>("spelling");

export function addSpellingError(tr: Transaction, from: number, to: number): Transaction {
	return tr.setMeta(spellingKey, highlight(from, to, { name: "spelling-error", type: "spelling-error", priority: 1 }));
}

// Spelling errors, a second highlight that can overlap comments.
function spellingPlugin() {
	return new Plugin<DecorationSet>({
		key: spellingKey,
		state: {
			init: () => DecorationSet.empty,
			apply(tr, set) {
				set = set.map(tr.mapping, tr.doc);
				const dec: Decoration | undefined = tr.getMeta(spellingKey);
				return dec ? set.add(tr.doc, [dec]) : set;
			},
		},
		props: {
			highlights: state => spellingKey.getState(state),
		},
	});
}

export const decorationsKey = new PluginKey<DecorationSet>("decorations");

type DecorationAction = { add: Decoration } | { remove: number };

// Inline decorations split text nodes in the DOM, and widgets add DOM (some of it text)
// that isn't document content; both sit inside the textblocks highlights are placed in.
function decorationsPlugin() {
	return new Plugin<DecorationSet>({
		key: decorationsKey,
		state: {
			init: (_, state) => DecorationSet.create(state.doc, [
				Decoration.inline(...span(state.doc, "old", "talic"), { class: "deco-inline" }),
				Decoration.widget(findText(state.doc, "nested list"), textWidget("[w]")),
				Decoration.widget(findText(state.doc, "rendered"), () => markChrome(document.createTextNode("‹raw›")), { raw: true }),
			]),
			apply(tr, set) {
				set = set.map(tr.mapping, tr.doc);
				const action: DecorationAction | undefined = tr.getMeta(decorationsKey);
				if (action && "add" in action) set = set.add(tr.doc, [action.add]);
				if (action && "remove" in action) {
					const all = set.find();
					if (all.length) set = set.remove([all[action.remove % all.length]]);
				}
				return set;
			},
		},
		props: {
			decorations: state => decorationsKey.getState(state),
		},
	});
}

function textWidget(text: string) {
	return () => {
		const dom = document.createElement("span");
		dom.className = "deco-widget";
		dom.textContent = text;
		return dom;
	};
}

function fuzzDecoration(from: number, to: number, kind: number): Decoration | null {
	switch (kind) {
		case 0: return from < to ? Decoration.inline(from, to, { class: "deco-inline" }) : null;
		case 1: return from < to ? Decoration.inline(from, to, { nodeName: "mark" }) : null;
		case 2: return from < to ? Decoration.inline(from, to, { class: "deco-inline" }, { inclusiveStart: true, inclusiveEnd: true }) : null;
		case 3: return Decoration.widget(from, textWidget("[w]"), { side: -1 });
		case 4: return Decoration.widget(from, textWidget("[w]"), { side: 1 });
		case 5: return Decoration.widget(from, () => document.createElement("span"));
		case 6: return Decoration.widget(from, () => document.createTextNode("‹t›"));
		default: return Decoration.widget(from, () => markChrome(document.createTextNode("‹raw›")), { raw: true, side: from % 2 ? 1 : -1 });
	}
}

export function createMixedEditor(mount: HTMLElement, onCommentClick?: CommentClickHandler) {
	const commentHighlight = (from: number, to: number, comment: Comment, spec?: HighlightSpec) =>
		highlight(from, to, { name: "comment" }, { comment, onClick: onCommentClick, ...spec });

	const view = new EditorView(mount, {
		state: EditorState.create({
			doc: initialDoc,
			plugins: [
				keymap({
					Enter: splitListItem(schema.nodes.list_item),
					Tab: sinkListItem(schema.nodes.list_item),
					"Shift-Tab": liftListItem(schema.nodes.list_item),
					"Mod-z": undo,
					"Mod-Shift-z": redo,
				}),
				keymap(baseKeymap),
				history(),
				commentsPlugin(commentHighlight),
				spellingPlugin(),
				decorationsPlugin(),
				cssHighlights(),
			],
		}),
		attributes: { spellcheck: "true" },
		nodeViews: {
			callout: () => new CalloutView(),
			mention: node => new MentionView(node),
			heading: node => new HeadingView(node),
		},
		markViews: {
			link: mark => linkView(mark),
		},
	});

	const fuzz = (seed: number, steps: number, { verifyEvery = 1, compose = true, beforeVerify }: Pick<FuzzOptions, "verifyEvery" | "compose" | "beforeVerify"> = {}) => fuzzHighlights(view, {
		seed,
		steps,
		verifyEvery,
		compose,
		beforeVerify,
		marks: [strong.create(), link.create({ href: "#" })],
		insertInline: (tr, pos) => tr.insert(pos, mention.create({ name: "fuzz" })),
		decorate: (tr, from, to, kind) => {
			const dec = fuzzDecoration(from, to, kind);
			if (dec) tr.setMeta(decorationsKey, { add: dec });
		},
		undecorate: (tr, which) => tr.setMeta(decorationsKey, { remove: which }),
		undo,
		redo,
		addHighlight: (tr, from, to, inclusiveStart, inclusiveEnd) =>
			addComment(tr, commentHighlight(from, to, { author: "fuzz", text: "" }, { inclusiveStart, inclusiveEnd })),
	});

	return { view, commentHighlight, fuzz };
}
