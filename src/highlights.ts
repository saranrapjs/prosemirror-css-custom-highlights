import { EditorState, Plugin } from "prosemirror-state";
import { Node as PMNode } from "prosemirror-model";
import { Decoration, DecorationSet, EditorView } from "prosemirror-view";

declare module "prosemirror-view" {
	interface EditorProps<P = any> {
		highlights?: (this: P, state: EditorState) => DecorationSet | null | undefined;
	}
}

export interface HighlightSpec {
	inclusiveStart?: boolean;
	inclusiveEnd?: boolean;
	onClick?: (view: EditorView, highlight: Decoration, event: MouseEvent) => boolean | void;
	[key: string]: any;
}

export interface HighlightOptions {
	/** The name a highlight is registered under in CSS.highlights, styled with `::highlight(name)` */
	name: string;
    /**
     * The **`priority`** property of the Highlight interface is a number used to determine which highlight's styles should be used to resolve style conflicts in overlapping parts. Highlights with a higher priority number have preference over those with a lower priority.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/Highlight/priority)
     */
	priority?: number;
    /**
     * The **`type`** property of the Highlight interface is an enumerated String used to specify the meaning of the highlight. This allows assistive technologies, such as screen readers, to include this meaning when exposing the highlight to users.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/Highlight/type)
     */
	type?: HighlightType;
}

export interface CSSHighlightsOptions {
	/**
	 * Whether or not to render CSS Custom Higlights outside the editor's viewport.
	 * Defaults to `true` to improve performance.
	 * TODO: Understand how this changes screen reader behavior.
	 * */
	viewportOnly?: boolean;
}

export function highlight(from: number, to: number, options: HighlightOptions, spec?: HighlightSpec): Decoration {
	return Decoration.inline(from, to, {}, { ...spec, highlight: options });
}

function highlightOptions(dec: Decoration): HighlightOptions | null {
	const options = dec.spec.highlight;
	return options && typeof options.name === "string" ? options : null;
}

type HighlightProperties = Partial<Pick<Highlight, "priority" | "type">>;

interface Segment {
	dec: Decoration;
	from: number;
	to: number;
}

// One pass over the textblocks between two positions, cutting each highlight at textblock
// boundaries the way inline decorations are rendered, so a highlight never paints
// non-editable chrome between blocks. Expects decorations sorted by their start.
function segmentsFor(doc: PMNode, decs: Decoration[], from: number, to: number): Segment[] {
	const segments: Segment[] = [];
	let next = 0;
	const active: Decoration[] = [];
	doc.nodesBetween(from, to, (node, pos) => {
		if (!node.isTextblock) return true;
		const start = pos + 1, end = pos + node.nodeSize - 1;
		while (next < decs.length && decs[next].from < end) active.push(decs[next++]);
		let kept = 0;
		for (const dec of active) {
			const from = Math.max(dec.from, start), to = Math.min(dec.to, end);
			if (from < to) segments.push({ dec, from, to });
			if (dec.to > end) active[kept++] = dec;
		}
		active.length = kept;
		return false;
	});
	return segments;
}

type HighlightsWindow = Window & typeof globalThis;

// What one editor draws under one highlight name.
interface NamedHighlight {
	ranges: StaticRange[];
	properties: HighlightProperties;
}

function sameNamed(a: NamedHighlight | undefined, b: NamedHighlight | undefined): boolean {
	const aRanges = a?.ranges ?? [], bRanges = b?.ranges ?? [];
	return aRanges.length === bRanges.length && aRanges.every((range, i) => range === bRanges[i]) &&
		a?.properties.priority === b?.properties.priority && a?.properties.type === b?.properties.type;
}

// What each editor in a window draws under each highlight name, since editors using the
// same name share one registered Highlight.
const sharedHighlights = new WeakMap<Window, Map<string, Map<EditorView, NamedHighlight>>>();

// Synchronizes CSS.highlights with what an editor now draws. Mutating a registered
// Highlight range by range is slow in WebKit once the DOM has changed (each add or delete
// costs time proportional to the whole highlight), so a Highlight name with changes gets a fresh
// Highlight, built from every editor's ranges, swapped into the registry.
function updateHighlights(window: HighlightsWindow, editor: EditorView, byName: Map<string, NamedHighlight>) {
	let shared = sharedHighlights.get(window);
	if (!shared) sharedHighlights.set(window, shared = new Map());
	const names = new Set(byName.keys());
	for (const [name, editors] of shared) if (editors.has(editor)) names.add(name);
	for (const name of names) {
		let editors = shared.get(name);
		if (!editors) shared.set(name, editors = new Map());
		const next = byName.get(name);
		if (sameNamed(editors.get(editor), next)) continue;
		if (next) editors.set(editor, next);
		else editors.delete(editor);
		if (!editors.size) {
			shared.delete(name);
			window.CSS.highlights.delete(name);
			continue;
		}
		const drawn = [...editors.values()];
		const fresh = new window.Highlight(...drawn.flatMap(({ ranges }) => ranges));
		Object.assign(fresh, ...drawn.map(({ properties }) => properties));
		window.CSS.highlights.set(name, fresh);
	}
}

// Everything produced by a given Highlights render
interface Snapshot {
	// The inputs this snapshot was rendered from, so an unchanged render can be skipped.
	doc: PMNode | null;
	sets: readonly DecorationSet[];
	// The decoration each range was drawn for, for hit testing.
	decorationByRange: Map<AbstractRange, Decoration>;
	// What this editor draws under each highlight name, in document order. The next render
	// reuses the range at the same index under the same name when its endpoints are unchanged,
	// so a name whose highlights didn't move keeps identical ranges and isn't redrawn, even
	// when its decorations were recreated.
	byName: Map<string, NamedHighlight>;
	// The positions rendered, or null when every highlight was.
	span: PositionSpan | null;
}

function emptySnapshot(): Snapshot {
	return { doc: null, sets: [], decorationByRange: new Map(), byName: new Map(), span: null };
}

function highlightSets(view: EditorView): DecorationSet[] {
	const sets: DecorationSet[] = [];
	view.someProp("highlights", f => {
		const set = f(view.state);
		if (set) sets.push(set);
	});
	return sets;
}

function sameSets(a: readonly DecorationSet[], b: readonly DecorationSet[]): boolean {
	return a.length === b.length && a.every((set, i) => set === b[i]);
}

type DOMPosition = ReturnType<EditorView["domAtPos"]>;

function maybeReuseRange(window: HighlightsWindow, range: StaticRange | undefined, start: DOMPosition, end: DOMPosition): StaticRange {
	if (range && range.startContainer === start.node && range.startOffset === start.offset &&
		range.endContainer === end.node && range.endOffset === end.offset) return range;
	return new window.StaticRange({
		startContainer: start.node,
		startOffset: start.offset,
		endContainer: end.node,
		endOffset: end.offset,
	});
}

// Computes the next snapshot from the previous one and the current inputs. It reads the
// editor's DOM but has no other effects; committing to CSS.highlights is left to the caller.
function nextSnapshot(view: EditorView, prev: Snapshot, sets: readonly DecorationSet[], span: PositionSpan | null): Snapshot {
	const window = view.dom.ownerDocument.defaultView!;
	const { doc } = view.state;
	const from = Math.max(span?.from ?? 0, 0), to = Math.min(span?.to ?? Infinity, doc.content.size);
	const decs = from > to ? [] : sets.flatMap(set => set.find(from, to))
		.filter(dec => highlightOptions(dec) && dec.from < dec.to)
		.sort((a, b) => a.from - b.from);

	const decorationByRange = new Map<AbstractRange, Decoration>();
	const byName = new Map<string, NamedHighlight>();
	for (const segment of segmentsFor(doc, decs, from, to)) {
		const { name, priority, type } = highlightOptions(segment.dec)!;
		let named = byName.get(name);
		if (!named) byName.set(name, named = { ranges: [], properties: {} });
		const range = maybeReuseRange(window, prev.byName.get(name)?.ranges[named.ranges.length],
			view.domAtPos(segment.from, 1), view.domAtPos(segment.to, -1));
		named.ranges.push(range);
		decorationByRange.set(range, segment.dec);
		if (priority !== undefined) named.properties.priority = priority;
		if (type !== undefined) named.properties.type = type;
	}
	return { doc, sets, decorationByRange, byName, span };
}

// The document positions shown in the editor's visible area, from visibleFrom to visibleTo,
// widened on each side by a margin, from `from` to `to`, so scrolling a little doesn't
// need a redraw.
interface PositionSpan {
	from: number;
	to: number;
	visibleFrom: number;
	visibleTo: number;
}

const NOTHING_VISIBLE: PositionSpan = { from: 0, to: -1, visibleFrom: 0, visibleTo: -1 };

// Hit tests the top and bottom of the editor's visible area, clipped by the viewport and any
// scrolling ancestors. Each posAtCoords costs about 0.3ms in a long document, so there are
// just two, which assumes positions run top to bottom. Null when the editor isn't laid out, or isn't under
// either probe, in which case everything is rendered.
function visibleSpan(view: EditorView): PositionSpan | null {
	const win = view.dom.ownerDocument.defaultView!;
	const rect = view.dom.getBoundingClientRect();
	if (!rect.width && !rect.height) return null;
	let top = Math.max(rect.top, 0), bottom = Math.min(rect.bottom, win.innerHeight);
	for (let el = view.dom.parentElement; el && bottom > top; el = el.parentElement) {
		if (el.scrollHeight <= el.clientHeight || win.getComputedStyle(el).overflowY === "visible") continue;
		const clip = el.getBoundingClientRect();
		top = Math.max(top, clip.top);
		bottom = Math.min(bottom, clip.bottom);
	}
	if (bottom <= top || rect.right <= 0 || rect.left >= win.innerWidth) return NOTHING_VISIBLE;
	const left = (Math.max(rect.left, 0) + Math.min(rect.right, win.innerWidth)) / 2;
	const first = view.posAtCoords({ left, top: top + 1 })?.pos, last = view.posAtCoords({ left, top: bottom - 1 })?.pos;
	if (first === undefined || last === undefined) return null;
	const visibleFrom = Math.min(first, last), visibleTo = Math.max(first, last);
	const margin = Math.max(200, visibleTo - visibleFrom);
	return { from: visibleFrom - margin, to: visibleTo + margin, visibleFrom, visibleTo };
}

// Whether the visible positions are still well inside the rendered span: at most half of
// the margin on either side has been scrolled into.
function withinMargin(rendered: PositionSpan, visible: PositionSpan): boolean {
	return (visible.visibleFrom - rendered.from) * 2 >= rendered.visibleFrom - rendered.from &&
		(rendered.to - visible.visibleTo) * 2 >= rendered.to - rendered.visibleTo;
}

const renderers = new WeakMap<EditorView, HighlightRenderer>();

class HighlightRenderer {
	private snapshot = emptySnapshot();
	// ProseMirror can redraw the DOM without the document or the highlights changing (when
	// other decorations change, say), which leaves ranges pointing at stale nodes.
	private domChanged = false;
	private observer = new MutationObserver(() => { this.domChanged = true; });
	private listeners = new AbortController();
	private window: HighlightsWindow;
	// Between the browser's beforeprint and afterprint events, while the page is laid out
	// for printing, every highlight is rendered, since the printout shows the whole document.
	private printing = false;

	constructor(private view: EditorView, private viewportOnly: boolean) {
		this.window = view.dom.ownerDocument.defaultView!;
		this.observer.observe(view.dom, { childList: true, characterData: true, subtree: true });
		renderers.set(view, this);
		if (viewportOnly) {
			// Captured, to hear scrolls of any ancestor, which don't bubble.
			const options = { capture: true, passive: true, signal: this.listeners.signal };
			const scrolled = () => this.render(true);
			this.window.addEventListener("scroll", scrolled, options);
			this.window.addEventListener("resize", scrolled, options);
			this.window.addEventListener("beforeprint", () => { this.printing = true; this.render(); }, options);
			this.window.addEventListener("afterprint", () => { this.printing = false; this.render(); }, options);
		}
		this.render();
	}

	update() {
		this.render();
	}

	destroy() {
		this.observer.disconnect();
		this.listeners.abort();
		updateHighlights(this.window, this.view, new Map());
		this.snapshot = emptySnapshot();
	}

	private render(scrolled = false) {
		const { view, snapshot: prev } = this;
		const { doc } = view.state;
		const span = this.viewportOnly && !this.printing ? visibleSpan(view) : null;
		if (scrolled && doc === prev.doc && span && prev.span && withinMargin(prev.span, span)) return;

		const domChanged = this.domChanged || this.observer.takeRecords().length > 0;
		// The DOM can change ahead of the document (mid-composition), so a render for a
		// scroll leaves its mutations for the next update to see too.
		this.domChanged = scrolled && domChanged;
		const sets = highlightSets(view);
		const sameSpan = span?.from === prev.span?.from && span?.to === prev.span?.to;
		if (doc === prev.doc && !domChanged && sameSets(sets, prev.sets) && sameSpan) return;

		this.snapshot = nextSnapshot(view, prev, sets, span);
		updateHighlights(this.window, view, this.snapshot.byName);
	}

	highlightsAt(x: number, y: number): Decoration[] {
		const hits = new Set<Decoration>();
		// For browers that support it:
		const { highlights } = this.window.CSS;
		if (highlights.highlightsFromPoint) {
			for (const hit of highlights.highlightsFromPoint(x, y)) {
				for (const range of hit.ranges ?? []) {
					const dec = this.snapshot.decorationByRange.get(range);
					if (dec) hits.add(dec);
				}
			}
			return [...hits];
		}
		const probe = this.view.dom.ownerDocument.createRange();
		for (const [range, dec] of this.snapshot.decorationByRange) {
			if (hits.has(dec)) continue;
			probe.setStart(range.startContainer, range.startOffset);
			probe.setEnd(range.endContainer, range.endOffset);
			if ([...probe.getClientRects()].some(rect => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom)) {
				hits.add(dec);
			}
		}
		return [...hits];
	}
}

function clickableHighlightAt(view: EditorView, event: MouseEvent): Decoration[] {
	return (renderers.get(view)?.highlightsAt(event.clientX, event.clientY) ?? [])
		.filter(dec => typeof dec.spec.onClick === "function");
}

export function cssHighlights({ viewportOnly = true }: CSSHighlightsOptions = {}): Plugin {
	return new Plugin({
		view: view => new HighlightRenderer(view, viewportOnly),
		props: {
			handleClick(view, _pos, event) {
				return clickableHighlightAt(view, event).some(dec => dec.spec.onClick(view, dec, event) === true);
			},
		},
	});
}
