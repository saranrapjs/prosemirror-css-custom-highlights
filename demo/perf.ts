import "prosemirror-view/style/prosemirror.css";
import "./demo.css";
import { DecorationSet } from "prosemirror-view";
import { TextSelection } from "prosemirror-state";
import { highlight } from "../src/highlights";
import { verifyHighlights } from "../test/test-utils";
import { createPerfEditor, Mode, Shape, spansKey } from "../test/perf-setup";

const params = new URLSearchParams(location.search);
const mode = (params.get("mode") ?? "highlights") as Mode;
const paragraphCount = Number(params.get("paras") ?? 5000);
const highlightCount = Number(params.get("count") ?? 2000);
const shape = (params.get("shape") ?? "flat") as Shape;

const initStart = performance.now();
const { view, textPosition } = createPerfEditor(document.querySelector("#editor")!, { mode, paragraphCount, highlightCount, shape });
const initialRender = performance.now() - initStart;

// Safari's performance.now() is coarsened to 1ms here, so operations are timed in batches
// and reported as a mean, with the slowest single operation alongside.
function timeBatch(count: number, run: () => void) {
	let max = 0;
	const start = performance.now();
	for (let i = 0; i < count; i++) {
		const opStart = performance.now();
		run();
		max = Math.max(max, performance.now() - opStart);
	}
	return { meanMs: +((performance.now() - start) / count).toFixed(3), maxMs: +max.toFixed(1) };
}

// Paint isn't timed here (see test/paint.test.ts, which runs in a visible window), but
// forcing layout captures the cost of the extra wrapper spans.
function forceLayout() {
	return (view.dom as HTMLElement).offsetHeight + view.coordsAtPos(view.state.selection.from).top;
}

async function bench() {
	const scale = mode === "highlights-fresh" ? 0.05 : 1;
	const n = (count: number) => Math.max(5, Math.round(count * scale));
	const results: Record<string, unknown> = { mode, shape, paragraphCount, highlightCount, initialRender: +initialRender.toFixed(1) };

	const createStart = performance.now();
	DecorationSet.create(view.state.doc, spansKey.getState(view.state)!.find().map(d => highlight(d.from, d.to, { name: "perf" })));
	results.decorationSetCreate = +(performance.now() - createStart).toFixed(2);

	results.typeScattered = timeBatch(n(500), () => view.dispatch(view.state.tr.insertText("x", textPosition())));

	let typingPos = textPosition();
	results.typeInPlace = timeBatch(n(500), () => view.dispatch(view.state.tr.insertText("y", typingPos++)));

	results.selectionOnly = timeBatch(n(500), () =>
		view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, textPosition()))));

	results.splitParagraph = timeBatch(n(100), () => view.dispatch(view.state.tr.split(textPosition())));

	results.typeWithLayout = timeBatch(n(200), () => {
		view.dispatch(view.state.tr.insertText("z", textPosition()));
		forceLayout();
	});

	const layoutStart = performance.now();
	(view.dom as HTMLElement).style.width = "700px";
	forceLayout();
	results.fullRelayout = +(performance.now() - layoutStart).toFixed(2);

	if (mode.startsWith("highlights")) {
		const verify = verifyHighlights(view);
		results.verify = { ok: verify.ok, ranges: verify.actual, mismatches: verify.mismatches.slice(0, 3) };
	}
	return results;
}

Object.assign(window, { view, benchResult: null });
bench().then(result => {
	(window as any).benchResult = result;
	document.querySelector("#result")!.textContent = JSON.stringify(result, null, 2);
});
