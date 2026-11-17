import { EditorView, DecorationSet } from "prosemirror-view";
import { Mark } from "prosemirror-model";
import { Command, TextSelection, Transaction } from "prosemirror-state";
import { canSplit, canJoin } from "prosemirror-transform";

export interface VerifyResult {
	ok: boolean;
	expected: number;
	actual: number;
	mismatches: string[];
}

// One live Range reused for reading highlights back: creating one per check leaves
// thousands alive until GC, and WebKit updates every live Range on each DOM mutation.
const probeRange = document.createRange();

// Text rendered by widgets, or by node and mark views outside their content, isn't
// document text, so it's left out when comparing a range's text with the document.
const chromeNodes = new WeakSet<Node>();

export function markChrome<T extends Node>(node: T): T {
	chromeNodes.add(node);
	return node;
}

function isChrome(node: Node, root: Node): boolean {
	for (let n: Node | null = node; n && n !== root; n = n.parentNode) {
		if (chromeNodes.has(n) || (n as Element).classList?.contains("ProseMirror-widget")) return true;
	}
	return false;
}

function documentText(range: Range, root: Node): string {
	const container = range.commonAncestorContainer;
	if (container.nodeType === 3) return isChrome(container, root) ? "" : range.toString();
	let text = "";
	const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
	for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
		if (!range.intersectsNode(node) || isChrome(node, root)) continue;
		const start = node === range.startContainer ? range.startOffset : 0;
		const end = node === range.endContainer ? range.endOffset : node.length;
		text += node.data.slice(start, end);
	}
	return text;
}

// The vertical extent of the editor's visible area, clipped by the viewport and any
// scrolling ancestors.
function visibleExtent(view: EditorView): { top: number; bottom: number } {
	let { top, bottom } = view.dom.getBoundingClientRect();
	top = Math.max(top, 0);
	bottom = Math.min(bottom, innerHeight);
	for (let el = view.dom.parentElement; el; el = el.parentElement) {
		if (el.scrollHeight <= el.clientHeight || getComputedStyle(el).overflowY === "visible") continue;
		const clip = el.getBoundingClientRect();
		top = Math.max(top, clip.top);
		bottom = Math.min(bottom, clip.bottom);
	}
	return { top, bottom };
}

// Every registered range must match a highlight in the document, and every highlight that's
// on screen must be registered. Offscreen ones may be left out, as they are by default.
export function verifyHighlights(view: EditorView): VerifyResult {
	const visible = visibleExtent(view);
	// From the boxes the text lays out in, since coordsAtPos can report an empty rect at 0,0.
	const onScreen = (from: number, to: number) => {
		if (visible.bottom <= visible.top) return false;
		const start = view.domAtPos(from, 1), end = view.domAtPos(to, -1);
		probeRange.setStart(start.node, start.offset);
		probeRange.setEnd(end.node, end.offset);
		return [...probeRange.getClientRects()].some(rect => rect.height > 0 && rect.top < visible.bottom && rect.bottom > visible.top);
	};
	const expected = new Map<string, number>();
	const extents = new Map<string, [from: number, to: number]>();
	const names = new Set<string>();
	let total = 0;
	view.someProp("highlights", f => {
		const set: DecorationSet | null | undefined = f(view.state);
		for (const dec of set?.find() ?? []) {
			const name: unknown = dec.spec.highlight?.name;
			if (typeof name !== "string" || dec.from >= dec.to) continue;
			names.add(name);
			view.state.doc.nodesBetween(dec.from, dec.to, (node, pos) => {
				if (!node.isTextblock) return true;
				const from = Math.max(dec.from, pos + 1), to = Math.min(dec.to, pos + node.nodeSize - 1);
				if (from >= to) return false;
				total++;
				const key = `${name}:${from}-${to}`;
				extents.set(key, [from, to]);
				expected.set(key, (expected.get(key) ?? 0) + 1);
				return false;
			});
		}
	});

	const mismatches: string[] = [];
	let actual = 0;
	const range = probeRange;
	for (const name of names) {
		for (const abstractRange of CSS.highlights.get(name) ?? []) {
			if (!view.dom.contains(abstractRange.startContainer)) continue;
			range.setStart(abstractRange.startContainer, abstractRange.startOffset);
			range.setEnd(abstractRange.endContainer, abstractRange.endOffset);
			actual++;
			const from = view.posAtDOM(range.startContainer, range.startOffset);
			const to = view.posAtDOM(range.endContainer, range.endOffset);
			const key = `${name}:${from}-${to}`;
			const remaining = expected.get(key) ?? 0;
			if (remaining === 0) {
				mismatches.push(`unexpected range ${key} ${JSON.stringify(range.toString())}`);
				continue;
			}
			expected.set(key, remaining - 1);
			const docText = view.state.doc.textBetween(from, to, "", leaf => leaf.type.spec.leafText?.(leaf) ?? "");
			const rangeText = range.toString() === docText ? docText : documentText(range, view.dom);
			if (docText !== rangeText) {
				mismatches.push(`text mismatch ${key}: range ${JSON.stringify(rangeText)} doc ${JSON.stringify(docText)}`);
			}
		}
	}
	for (const [key, remaining] of expected) {
		if (remaining > 0 && onScreen(...extents.get(key)!)) mismatches.push(`missing range ${key} x${remaining}`);
	}
	return { ok: mismatches.length === 0, expected: total, actual, mismatches };
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Simulates an input method the way WebKit drives one: composition events around direct
// edits to the DOM text node at the caret, which ProseMirror reads back through its
// MutationObserver. Waits are long enough for ProseMirror's delayed flushes (a shrinking
// text change and compositionend both schedule one 20ms out).
export class Composition {
	private text: Text | null = null;
	private start = 0;
	private composed = "";

	constructor(private view: EditorView) {}

	get active() {
		return this.text !== null;
	}

	async begin(pos: number, data: string) {
		const { view } = this;
		view.focus();
		view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
		const { node, offset } = view.domAtPos(pos, 1);
		document.getSelection()!.collapse(node, offset);
		// compositionstart flushes pending DOM changes, so a text node the browser creates
		// for the composition only appears after it.
		view.dom.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
		if (node.nodeType === 3) {
			this.text = node as Text;
			this.start = offset;
		} else {
			this.text = node.insertBefore(document.createTextNode(""), node.childNodes[offset] ?? null);
			this.start = 0;
		}
		this.composed = "";
		return this.update(data);
	}

	// Returns false when ProseMirror redrew the composed text out from under the input
	// method (an edit elsewhere touched it), which ends the composition.
	async update(data: string): Promise<boolean> {
		const { text } = this;
		if (!text?.isConnected || text.data.slice(this.start, this.start + this.composed.length) !== this.composed) {
			await this.end();
			return false;
		}
		this.view.dom.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data }));
		const shrinks = data.length < this.composed.length;
		text.replaceData(this.start, this.composed.length, data);
		this.composed = data;
		document.getSelection()!.collapse(text, this.start + data.length);
		await delay(shrinks ? 30 : 0);
		return true;
	}

	async end() {
		this.view.dom.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: this.composed }));
		this.text = null;
		await delay(30);
	}
}

const metaOps = new Set(["highlight", "decorate", "undecorate"]);

const compositions = ["か", "かん", "かんじ", "漢字", "感じ", "ㄱ", "한", "한글", "é"];

export interface FuzzOptions {
	seed: number;
	steps: number;
	marks?: Mark[];
	insertInline?: (tr: Transaction, pos: number) => void;
	decorate?: (tr: Transaction, from: number, to: number, kind: number) => void;
	undecorate?: (tr: Transaction, which: number) => void;
	compose?: boolean;
	undo?: Command;
	redo?: Command;
	verifyEvery?: number;
	// Runs before each check, e.g. to scroll the editor and wait for the next frame.
	beforeVerify?: () => Promise<void> | void;
	addHighlight?: (tr: Transaction, from: number, to: number, inclusiveStart: boolean, inclusiveEnd: boolean) => void;
}

function mulberry32(seed: number) {
	return () => {
		seed = seed + 0x6D2B79F5 | 0;
		let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
		t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
		return ((t ^ t >>> 14) >>> 0) / 4294967296;
	};
}

export async function fuzzHighlights(view: EditorView, options: FuzzOptions) {
	const random = mulberry32(options.seed);
	const rand = (n: number) => Math.floor(random() * n);
	const ops: Record<string, number> = {};
	const failures: { step: number; op: string; mismatches: string[] }[] = [];
	let lastSteps: unknown[] = [];
	const composition = new Composition(view);
	const pickMark = () => options.marks?.length ? options.marks[rand(options.marks.length)] : undefined;
	for (let step = 0; step < options.steps && failures.length < 3; step++) {
		const positions: number[] = [];
		view.state.doc.descendants((node, pos) => {
			if (node.isTextblock) for (let i = 0; i <= node.content.size; i++) positions.push(pos + 1 + i);
		});
		const pos = positions[rand(positions.length)];
		const { doc } = view.state;
		const tr = view.state.tr;
		let op = "";
		try {
			switch (rand(options.compose ? 13 : 12)) {
				case 0:
					op = "insert";
					tr.insertText("xyz".slice(0, 1 + rand(3)), pos);
					break;
				case 1: {
					op = "insert-marked";
					const mark = pickMark();
					if (mark) tr.insert(pos, view.state.schema.text("q", [mark]));
					else tr.insertText("q", pos);
					break;
				}
				case 2: {
					op = "delete";
					const end = positions[Math.min(positions.length - 1, positions.indexOf(pos) + 1 + rand(6))];
					if (end > pos) tr.delete(pos, end);
					break;
				}
				case 3:
					op = "split";
					if (canSplit(doc, pos)) tr.split(pos);
					break;
				case 4: {
					op = "join";
					const before = doc.resolve(pos).before();
					if (canJoin(doc, before)) tr.join(before);
					break;
				}
				case 5: {
					op = "mark";
					const mark = pickMark();
					if (mark) tr.addMark(pos, Math.min(doc.content.size, pos + rand(8)), mark);
					break;
				}
				case 6: {
					op = "unmark";
					const mark = pickMark();
					if (mark) tr.removeMark(pos, Math.min(doc.content.size, pos + 10), mark.type);
					break;
				}
				case 7:
					op = rand(2) ? "undo" : "redo";
					(op === "undo" ? options.undo : options.redo)?.(view.state, view.dispatch);
					break;
				case 8: {
					op = "highlight";
					const end = positions[Math.min(positions.length - 1, positions.indexOf(pos) + 1 + rand(40))];
					if (end > pos) options.addHighlight?.(tr, pos, end, rand(2) === 0, rand(2) === 0);
					break;
				}
				case 9: {
					op = "decorate";
					const end = positions[Math.min(positions.length - 1, positions.indexOf(pos) + rand(12))];
					options.decorate?.(tr, pos, end, rand(8));
					break;
				}
				case 10:
					op = "undecorate";
					options.undecorate?.(tr, rand(1000));
					break;
				case 11: {
					// Paired with a wider delete so the document doesn't keep growing, which
					// makes every later step slower to verify.
					const end = positions[Math.min(positions.length - 1, positions.indexOf(pos) + 1 + rand(3))];
					if (options.insertInline && rand(2)) {
						op = "insert-inline";
						options.insertInline(tr, pos);
					} else if (end > pos) {
						op = "delete";
						tr.delete(pos, end);
					}
					break;
				}
				case 12: {
					const data = compositions[rand(compositions.length)];
					if (!composition.active) {
						op = "compose-start";
						await composition.begin(pos, data);
					} else if (rand(3) === 0) {
						op = "compose-end";
						await composition.end();
					} else {
						op = "compose-update";
						await composition.update(data);
					}
					break;
				}
			}
		} catch {
			op = "invalid";
		}
		if ((tr.docChanged || metaOps.has(op)) && op !== "invalid") view.dispatch(tr);
		lastSteps = tr.steps.map(s => s.toJSON());
		ops[op] = (ops[op] ?? 0) + 1;
		if (step % (options.verifyEvery ?? 1) === 0) {
			await options.beforeVerify?.();
			const result = verifyHighlights(view);
			if (!result.ok) failures.push({ step, op, mismatches: result.mismatches.slice(0, 3) });
		}
	}
	if (composition.active) await composition.end();
	await options.beforeVerify?.();
	return { ops, failures, lastSteps, final: verifyHighlights(view) };
}
