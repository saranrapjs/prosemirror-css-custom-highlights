# prosemirror-css-custom-highlights

A ProseMirror plugin that renders ["inline"](https://prosemirror.net/docs/ref/#view.Decoration^inline)-style decorations using the [CSS Custom Highlight API](https://developer.mozilla.org/en-US/docs/Web/API/CSS_Custom_Highlight_API) instead of the DOM.

```ts
import { EditorState } from "prosemirror-state";
import { EditorView, DecorationSet } from "prosemirror-view";
import { schema } from "prosemirror-schema-basic";
import { cssHighlights, highlight } from "prosemirror-css-custom-highlights";

new EditorView(document.querySelector("#editor"), {
	state: EditorState.create({
		doc: schema.node("doc", null, [schema.node("paragraph", null, [schema.text("Hello wrold")])]),
		plugins: [cssHighlights()],
	}),
	highlights: state => DecorationSet.create(state.doc, [
		highlight(1, 6, { name: "comment" }, { onClick: (view, dec, event) => console.log("clicked here!") }),
		highlight(7, 12, { name: "misspelled", priority: 1, type: "spelling-error" }),
	]),
});
// and then, in your CSS:
// ::highlight(comment) { background-color: yellow; }
// ::highlight(misspelled) { text-decoration: wavy underline red; }
```

The API is meant to resemble the [`EditorProps.decorations`](https://prosemirror.net/docs/ref/#view.EditorProps.decorations) prop available for traditional decorations, allowing other ProseMirror plugins to define a set of CSS highlights as a function of incoming state changes.

## Why use CSS Custom Highlights instead of Decoration.inline?

CSS Custom Highlights is admittedly a somewhat green web API! There are a few situations where CSS Custom Highlights may be preferable to `Decoration.inline` though:

- CSS highlights has a slightly more deterministic API (`priority`) for defining how overlapping highlights render, without requiring nested selectors or being aware of ProseMirror internals for how decoration DOM nodes are rendered in which order
- the CSS highlights implementation doesn't interrupt text layout the way the DOM does, which for some use-cases may look more correct (e.g. where avoiding the interruption of a DOM element in the middle of a unicode sequence, or to create the appearance of a smooth spelling error style squiggle across a text range)
- this plugin attempts to only paint those highlights that are on screen by default, which for large documents with lots of "inline"-style decorations may be more performant than the DOM (see "Performance" below)

Here are some reasons to not use it:

- I've observed some browser bugs with specific DOM and range combinations where highlights aren't painted
- The accessibility story isn't great: declaring a `"type":"spelling-error"` is supposed to treat a custom highlight as a spelling error for screen reader purposes, but this doesn't appear to work yet in Safari; DOM-based accessibility properties are more robust

## Demo

See CSS custom highlights, with click handlers, in action:

```sh
npm run dev
```

Then open the printed URL (http://localhost:5173 by default):

- `demo/index.html`: an example schema with a few different node types, where you can add & remove highlight ranges
- `demo/perf.html`: a 5,000 paragraph benchmark, with various modes of rendering on and offscreen

## Tests

The tests are comprehensive, though admittedly nasty:

```sh
npm run test:unit    # regression, click and IME composition tests, no fuzzing
npm run test:fuzz    # fixed-seed fuzz tests that reproduce past errors
```

### Fuzzing

The fuzzer edits the mixed-schema editor with text, marks, splits, joins, undo/redo and new highlights. It also adds and removes inline decorations and widgets (some containing text, some raw text nodes), inserts "mentions" NodeView's, styles text with a link mark view and a heading NodeView that render text outside the node's content, and runs simulated IME compositions.

```sh
npm run test:soak                                     # 25 random seeds x 2,000 steps
FUZZ_SEEDS=100 FUZZ_STEPS=5000 npm run test:soak      # more seeds, longer runs
FUZZ_SEEDS=60 FUZZ_SEED_BASE=1000003 npm run test:soak # reproducible seeds
```

### Benchmarks

```sh
npm run bench:paint                                        # writes bench-results/paint.json
PAINT_BENCH_RUNS="none:2000,highlights:8000:offscreen,highlights:8000:list" npm run bench:paint
```

`PAINT_BENCH_RUNS` is a comma-separated list of `mode:highlightCount[:offscreen][:list]`. `list` puts the 5,000 paragraphs in the items of a single bullet list, each rendered by a task-item node view that holds the paragraph in a `<div>` beside a checkbox, to simulate one performance edge case where the toDOM doesn't align with the lived DOM.

## Offscreen highlights

By default only the highlights in and near the visible part of the editor (about a screen's worth either side) are registered in `CSS.highlights`, and they're updated as the editor or any of its ancestors scrolls.

WebKit repaints every range of a styled highlight on every frame, and we also have to call ProseMirror DOM-aware API's for every highlight (which can be slow with large numbers of highlights).

To register every highlight regardless (e.g. if other code reads `CSS.highlights`):

```ts
cssHighlights({ viewportOnly: false })
```


## Performance

As recorded with Safari on my Mac:

```
PAINT_BENCH_RUNS="none:2000,inline:2000,highlights-all:2000,highlights:2000,inline:8000,highlights-all:8000,highlights:8000,highlights-all:8000:offscreen,highlights:8000:offscreen,inline:8000:list,highlights:8000:list" npm run bench:paint
```

| Mode | Number of highlights | First paint | Typing median / p90 | Dispatch mean | Scrolling median / p90 |
|---|---|---|---|---|---|
| No decorations | — | 151 | 33 / 34 | 5.6 | 33 / 33 |
| `Decoration.inline` | 2,000 | 144 | 34 / 34 | 12.1 | 34 / 34 |
| CSS highlights, all registered | 2,000 | 281 | 133 / 167 | 123.0 | 33 / 34 |
| CSS highlights | 2,000 | 102 | 34 / 35 | 6.5 | 34 / 35 |
| `Decoration.inline` | 8,000 | 244 | 33 / 33 | 22.9 | 33 / 34 |
| CSS highlights, all registered | 8,000 | 799 | 500 / 635 | 483.0 | 83 / 100 |
| CSS highlights | 8,000 | 150 | 34 / 34 | 5.8 | 33 / 34 |
| CSS highlights, all registered, offscreen | 8,000 | 1,198 | 904 / 950 | 888.7 | 83 / 84 |
| CSS highlights, offscreen | 8,000 | 188 | 33 / 35 | 5.1 | 34 / 36 |
| `Decoration.inline`, list | 8,000 | 404 | 34 / 34 | 22.6 | 34 / 35 |
| CSS highlights, list | 8,000 | 287 | 33 / 35 | 5.0 | 33 / 34 |

Times are in milliseconds. Dispatch is the mean time `view.dispatch` takes per keystroke. `offscreen` puts every highlight in paragraphs 4,000 to 4,990, far below the viewport. `highlights-all` is `cssHighlights({ viewportOnly: false })`.
