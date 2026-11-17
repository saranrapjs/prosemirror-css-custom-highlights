import { afterEach, expect, inject, test } from "vitest";
import { createMixedEditor } from "../demo/mixed-editor";
import { verifyHighlights } from "./test-utils";

let mount: HTMLElement;
let destroy: (() => void) | undefined;

afterEach(() => {
	destroy?.();
	mount?.remove();
});

function freshEditor() {
	mount = document.body.appendChild(document.createElement("div"));
	const editor = createMixedEditor(mount);
	destroy = () => editor.view.destroy();
	return editor;
}

test("initial highlights match the decorations", () => {
	const { view } = freshEditor();
	expect(verifyHighlights(view)).toMatchObject({ ok: true, expected: 13 });
});

test("highlights paint nothing outside textblocks", () => {
	const { view } = freshEditor();
	const label = view.dom.querySelector(".callout-label")!;
	const painted = [...CSS.highlights.get("comment")!].some(range => {
		const live = document.createRange();
		live.setStart(range.startContainer, range.startOffset);
		live.setEnd(range.endContainer, range.endOffset);
		return live.intersectsNode(label);
	});
	expect(painted).toBe(false);
});

const seeds = [7727, 15454, 23181, 30908, 104729, 314187, 523645, 1001, 2001];

test.each(seeds)("fuzz seed %i keeps every range in sync", async seed => {
	const { fuzz } = freshEditor();
	const result = await fuzz(seed, 1500);
	expect(result.failures).toEqual([]);
	expect(result.final.ok).toBe(true);
});

test("a long run on one degenerating document stays in sync", { timeout: 300_000 }, async () => {
	const { fuzz } = freshEditor();
	for (const seed of seeds) {
		const result = await fuzz(seed, 2000);
		expect(result.failures, `seed ${seed}`).toEqual([]);
	}
});

// Found by a soak run: a split at step 3315 leaves an element whose content is unchanged
// standing for a different, identical block, which only the check for siblings a
// childList change could have shifted catches.
test("a split that shifts identical blocks through unchanged elements", { timeout: 300_000 }, async () => {
	const { fuzz } = freshEditor();
	const result = await fuzz(2277168, 3320);
	expect(result.failures).toEqual([]);
	expect(result.final.ok).toBe(true);
});

const soakSeeds = inject("fuzzSeeds");
const soakSteps = inject("fuzzSteps");
const soakSeedBase = inject("fuzzSeedBase");

test.runIf(soakSeeds > 0)(`soak: ${soakSeeds} random seeds x ${soakSteps} steps`, { timeout: 0 }, async () => {
	for (let i = 0; i < soakSeeds; i++) {
		const seed = soakSeedBase === null ? Math.floor(Math.random() * 2 ** 31) : soakSeedBase + i * 7919;
		const { fuzz, view } = freshEditor();
		const result = await fuzz(seed, soakSteps);
		expect(result.failures, `seed ${seed}`).toEqual([]);
		view.destroy();
		mount.remove();
	}
	destroy = undefined;
});
