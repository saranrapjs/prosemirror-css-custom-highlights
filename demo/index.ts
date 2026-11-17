import "prosemirror-view/style/prosemirror.css";
import "./demo.css";
import { EditorView, Decoration } from "prosemirror-view";
import { createMixedEditor, addComment, removeComment, addSpellingError, Comment } from "./mixed-editor";
import { verifyHighlights } from "../test/test-utils";

const popover = document.querySelector<HTMLElement>("#popover")!;

function showCommentPopover(view: EditorView, dec: Decoration, event: MouseEvent) {
	const comment: Comment = dec.spec.comment;
	popover.replaceChildren();
	const author = popover.appendChild(document.createElement("strong"));
	author.textContent = comment.author;
	popover.append(` ${comment.text} `);
	const resolve = popover.appendChild(document.createElement("button"));
	resolve.textContent = "Resolve";
	resolve.onclick = () => {
		view.dispatch(removeComment(view.state.tr, dec));
		popover.hidden = true;
	};
	popover.style.left = `${event.pageX}px`;
	popover.style.top = `${event.pageY + 12}px`;
	popover.hidden = false;
}

document.addEventListener("mousedown", event => {
	if (!popover.contains(event.target as Node)) popover.hidden = true;
});

const { view, commentHighlight, fuzz } = createMixedEditor(document.querySelector("#editor")!, showCommentPopover);

document.querySelector("#comment-selection")!.addEventListener("click", () => {
	const { from, to } = view.state.selection;
	if (from === to) return;
	const text = prompt("Comment") ?? "";
	view.dispatch(addComment(view.state.tr, commentHighlight(from, to, { author: "you", text })));
	view.focus();
});

document.querySelector("#add-spelling-error")!.addEventListener("click", () => {
	const { from, to } = view.state.selection;
	if (from === to) return;
	view.dispatch(addSpellingError(view.state.tr, from, to));
	view.focus();
});

Object.assign(window, { view, verifyHighlights: () => verifyHighlights(view), fuzz });
