import { expect, inject, test } from "vitest";
import { commands } from "vitest/browser";
import { createPerfEditor, Mode, Shape } from "./perf-setup";

const frame = () => new Promise<number>(resolve => requestAnimationFrame(resolve));

function summarize(samples: number[]) {
	const sorted = [...samples].sort((a, b) => a - b);
	const at = (q: number) => +sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))].toFixed(1);
	return { median: at(0.5), p90: at(0.9), max: at(1) };
}

// Timed from just before dispatch to the second animation frame after it, by which point
// the first frame containing the change has been styled, laid out and painted.
async function timeToPaint(change: () => void) {
	await frame();
	const start = performance.now();
	change();
	await frame();
	await frame();
	return performance.now() - start;
}

async function measure(mode: Mode, highlightCount = 2000, offscreen = false, shape: Shape = "flat") {
	const style = document.head.appendChild(document.createElement("style"));
	style.textContent = `
		::highlight(perf) { background-color: rgb(255 213 79 / 0.6); }
		.perf-inline { background-color: rgb(255 213 79 / 0.6); }
	`;
	const mount = document.body.appendChild(document.createElement("div"));
	mount.style.cssText = "height: 700px; overflow: auto; font: 16px/1.5 sans-serif";

	const createStart = performance.now();
	const { view, visibleTextPosition } = createPerfEditor(mount, { mode, paragraphCount: 5000, highlightCount, highlightParagraphs: offscreen ? [4000, 4990] : undefined, shape });
	await frame();
	await frame();
	const firstPaint = performance.now() - createStart;

	const typing: number[] = [];
	const dispatching: number[] = [];
	for (let i = 0; i < 60; i++) {
		typing.push(await timeToPaint(() => {
			const start = performance.now();
			view.dispatch(view.state.tr.insertText("x", visibleTextPosition(15)));
			dispatching.push(performance.now() - start);
		}));
	}

	const scrolling: number[] = [];
	for (let i = 0; i < 40; i++) {
		scrolling.push(await timeToPaint(() => { mount.scrollTop += 500; }));
	}

	view.destroy();
	mount.remove();
	style.remove();
	return { mode, highlightCount, offscreen, shape, firstPaint: +firstPaint.toFixed(0), typing: summarize(typing), dispatchMeanMs: +(dispatching.reduce((a, b) => a + b, 0) / dispatching.length).toFixed(2), scrolling: summarize(scrolling) };
}

test.runIf(inject("paintBench"))("time to paint: none vs inline decorations vs CSS highlights", { timeout: 0 }, async () => {
	const baseline = await Promise.resolve().then(async () => {
		const samples = [];
		for (let i = 0; i < 30; i++) samples.push(await timeToPaint(() => {}));
		return summarize(samples);
	});
	const results = [];
	const runs: [Mode, number, boolean, Shape][] = (inject("paintBenchRuns") || "none:2000,inline:2000,highlights:2000,none:2000,inline:2000,highlights:2000")
		.split(",").map(run => {
			const [mode, count, ...flags] = run.split(":");
			return [mode as Mode, Number(count), flags.includes("offscreen"), flags.includes("list") ? "list" : "flat"];
		});
	for (const [mode, count, offscreen, shape] of runs) results.push(await measure(mode, count, offscreen, shape));
	await commands.writeFile("bench-results/paint.json", JSON.stringify({ emptyFrames: baseline, results }, null, 2));
	expect(results).toHaveLength(runs.length);
});
