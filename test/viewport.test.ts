import { afterEach, expect, test } from "vitest";
import { EditorView, DecorationSet } from "prosemirror-view";
import { EditorState, Plugin } from "prosemirror-state";
import { schema } from "prosemirror-schema-basic";
import { cssHighlights, highlight } from "../src/highlights";
import { verifyHighlights } from "./test-utils";
import { createMixedEditor } from "../demo/mixed-editor";

const frame = () => new Promise<number>(resolve => requestAnimationFrame(resolve));

let mount: HTMLElement | undefined;
let destroy: (() => void) | undefined;

afterEach(() => {
	destroy?.();
	mount?.remove();
	destroy = mount = undefined;
});

// 500 paragraphs in a 200px scroller, each with a highlight over its first word.
function setup(options?: Parameters<typeof cssHighlights>[0]) {
	mount = document.body.appendChild(document.createElement("div"));
	mount.style.cssText = "height: 200px; overflow: auto";
	const paragraphs = Array.from({ length: 500 }, (_, i) => schema.node("paragraph", null, schema.text(`paragraph ${i} of the document`)));
	const doc = schema.node("doc", null, paragraphs);
	const starts: number[] = [];
	doc.forEach((_, offset) => starts.push(offset + 1));
	const view = new EditorView(mount, {
		state: EditorState.create({
			doc,
			plugins: [
				new Plugin({ props: { highlights: state => DecorationSet.create(state.doc, starts.map(pos => highlight(pos, pos + 9, { name: "test" }))) } }),
				cssHighlights(options),
			],
		}),
	});
	destroy = () => view.destroy();
	return { view, mount };
}

const registered = () => [...CSS.highlights.get("test") ?? []];
const registeredIn = (element: Element) => registered().some(range => element.contains(range.startContainer));

test("only highlights near the viewport are registered", () => {
	const { view } = setup();
	expect(registered().length).toBeGreaterThan(0);
	expect(registered().length).toBeLessThan(100);
	expect(registeredIn(view.dom.firstElementChild!)).toBe(true);
	expect(registeredIn(view.dom.lastElementChild!)).toBe(false);
	expect(verifyHighlights(view).ok).toBe(true);
});

test("scrolling registers the highlights scrolled to", async () => {
	const { view, mount } = setup();
	mount.scrollTop = mount.scrollHeight;
	await frame();
	expect(registeredIn(view.dom.lastElementChild!)).toBe(true);
	expect(registeredIn(view.dom.firstElementChild!)).toBe(false);
	expect(registered().length).toBeLessThan(100);
	expect(verifyHighlights(view).ok).toBe(true);
});

// The browser fires these around printing; a test can't open the print dialog, so it
// fires them itself.
test("printing registers every highlight", () => {
	setup();
	window.dispatchEvent(new Event("beforeprint"));
	expect(registered().length).toBe(500);
	window.dispatchEvent(new Event("afterprint"));
	expect(registered().length).toBeLessThan(100);
});

test("viewportOnly: false registers every highlight", () => {
	setup({ viewportOnly: false });
	expect(registered().length).toBe(500);
});

test("an editor scrolled out of view registers nothing until it's back", async () => {
	const { view, mount } = setup();
	const spacer = document.body.insertBefore(document.createElement("div"), mount);
	spacer.style.height = `${innerHeight * 3}px`;
	try {
		view.dispatch(view.state.tr.insertText("x", 1));
		expect(registered().length).toBe(0);
		mount.scrollIntoView();
		await frame();
		expect(registered().length).toBeGreaterThan(0);
		expect(verifyHighlights(view).ok).toBe(true);
	} finally {
		spacer.remove();
	}
});

// The fuzzer's documents fit on screen, so here it runs in a scroller a few lines tall,
// scrolled somewhere new before each check, moving highlights in and out of view. Each
// check waits for a frame, since ProseMirror scrolls the selection into view after plugin
// views update and the highlights only follow when the scroll event arrives, before paint.
test.each([7727, 104729, 2001])("fuzz seed %i in a scrolling viewport keeps visible ranges in sync", async seed => {
	mount = document.body.appendChild(document.createElement("div"));
	mount.style.cssText = "height: 60px; overflow: auto";
	const scroller = mount;
	const { view, fuzz } = createMixedEditor(scroller);
	destroy = () => view.destroy();
	const result = await fuzz(seed, 1000, {
		verifyEvery: 5,
		beforeVerify: async () => {
			scroller.scrollTop = Math.random() * scroller.scrollHeight;
			await frame();
		},
	});
	expect(result.failures).toEqual([]);
	expect(result.final.ok).toBe(true);
});
