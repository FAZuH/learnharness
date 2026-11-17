import React from "react";
(globalThis as { React?: typeof React }).React = React;
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { AnsweredCard } from "../components/answered-card.tsx";
import { QuestionDock } from "../components/question-dock.tsx";
import { buildAnswer, type QuestionAnswerData, type QuestionData } from "../src/core/index.ts";

const WRONG_TEXT = "Brightness is not distance, so Venus is a tempting but wrong pick.";
const RIGHT_TEXT = "A tight orbit keeps Mercury closest to the Sun.";
const PREFIXES = ["What you just learned", "Why not this"];

const quiz = (): QuestionData => ({
	id: "q_option_feedback",
	kind: "quiz",
	question: "Which planet is closest to the Sun?",
	mode: "single-select",
	options: [
		{ label: "Mercury", value: "mercury" },
		{ label: "Venus", value: "venus" },
	],
	correctIndices: [1],
	explanation: "Mercury orbits closest.",
	optionFeedback: [
		{ value: "mercury", right: RIGHT_TEXT },
		{ value: "venus", wrong: WRONG_TEXT },
	],
	createdAt: "2026-01-01T00:00:00Z",
});

const feedbackBlocks = (answer: QuestionAnswerData): Array<{ kind: string | null; text: string }> => {
	const doc = parseHTML(`<html><body>${renderToStaticMarkup(<AnsweredCard answer={answer} />)}</body></html>`).document;
	return [...doc.querySelectorAll('[data-testid="option-feedback"]')].map((node) => ({
		kind: node.getAttribute("data-feedback-kind"),
		text: node.textContent ?? "",
	}));
};

// A note must sit inside an option box; a standalone block after all options
// has no such ancestor.
const noteBoxes = (answer: QuestionAnswerData): Array<{ kind: string | null; text: string; optionText: string }> => {
	const doc = parseHTML(`<html><body>${renderToStaticMarkup(<AnsweredCard answer={answer} />)}</body></html>`).document;
	return [...doc.querySelectorAll('[data-testid="option-feedback"]')].map((node) => {
		let box = node.parentElement;
		while (box && !(box.getAttribute("class") ?? "").includes("px-3")) box = box.parentElement;
		return {
			kind: node.getAttribute("data-feedback-kind"),
			text: node.textContent ?? "",
			optionText: box?.textContent ?? "",
		};
	});
};

describe("per-option feedback on the answered card", () => {
	it("a wrong selection shows that option's wrong note", () => {
		const answer = buildAnswer(quiz(), { values: ["venus"] });
		const html = renderToStaticMarkup(<AnsweredCard answer={answer} />);
		assert.ok(html.includes(WRONG_TEXT), "the selected wrong option's note is shown");
		assert.ok(!html.includes(RIGHT_TEXT), "the unselected correct option's note is not shown");
		assert.equal(feedbackBlocks(answer)[0]?.kind, "wrong");
		for (const prefix of PREFIXES) assert.ok(!html.includes(prefix), `no "${prefix}" prefix`);
		const [box] = noteBoxes(answer);
		assert.ok(box?.optionText.includes("Venus"), "the note sits in the selected Venus option box");
		assert.ok(box?.optionText.includes(WRONG_TEXT), "the note text is in that same box");
	});

	it("a confident correct selection shows that option's right note", () => {
		const answer = buildAnswer(quiz(), { values: ["mercury"], confidence: 90 });
		const html = renderToStaticMarkup(<AnsweredCard answer={answer} />);
		assert.ok(html.includes(RIGHT_TEXT), "the correct option's takeaway is shown");
		assert.ok(!html.includes(WRONG_TEXT), "the unselected wrong option's note is not shown");
		assert.equal(feedbackBlocks(answer)[0]?.kind, "right");
		for (const prefix of PREFIXES) assert.ok(!html.includes(prefix), `no "${prefix}" prefix`);
		const [box] = noteBoxes(answer);
		assert.ok(box?.optionText.includes("Mercury"), "the note sits in the selected Mercury option box");
		assert.ok(box?.optionText.includes(RIGHT_TEXT), "the note text is in that same box");
	});

	it("a correct but low-confidence selection shows no right note", () => {
		const answer = buildAnswer(quiz(), { values: ["mercury"], confidence: 50 });
		const html = renderToStaticMarkup(<AnsweredCard answer={answer} />);
		assert.ok(!html.includes(RIGHT_TEXT), "low confidence leaves the tucked explanation to cover it");
		assert.equal(feedbackBlocks(answer).length, 0);
	});

	it("multi-select picks the note per selected option, not from the global verdict", () => {
		const multi: QuestionData = {
			...quiz(),
			mode: "multi-select",
			options: [
				{ label: "Alpha", value: "a" },
				{ label: "Beta", value: "b" },
				{ label: "Gamma", value: "c" },
			],
			correctIndices: [1, 2],
			optionFeedback: [
				{ value: "a", wrong: "A_WRONG: Alpha is one of the correct picks.", right: "A_RIGHT: Alpha is one of the correct picks." },
				{ value: "b", right: "B_RIGHT" },
				{ value: "c", wrong: "C_WRONG: Gamma is a distractor.", right: "C_RIGHT" },
			],
		};
		const answer = buildAnswer(multi, { values: ["a", "c"], confidence: 90 });
		assert.equal(answer.correct, false, "the set is wrong overall");
		const blocks = feedbackBlocks(answer);
		assert.equal(blocks.length, 2, "one note per selected option");
		assert.equal(blocks.find((b) => b.text.includes("A_RIGHT"))?.kind, "right", "the correct pick keeps its right note");
		assert.equal(blocks.find((b) => b.text.includes("C_WRONG"))?.kind, "wrong", "the wrong pick gets the wrong note");
		const boxes = noteBoxes(answer);
		const alpha = boxes.find((b) => b.text.includes("A_RIGHT"));
		const gamma = boxes.find((b) => b.text.includes("C_WRONG"));
		assert.ok(alpha, "Alpha's note rendered");
		assert.ok(gamma, "Gamma's note rendered");
		assert.ok(alpha.optionText.includes("Alpha"), "the right note sits in Alpha's own option box");
		assert.ok(!alpha.optionText.includes("C_WRONG"), "Gamma's note is not in Alpha's box");
		assert.ok(gamma.optionText.includes("Gamma"), "the wrong note sits in Gamma's own option box");
		assert.ok(!gamma.optionText.includes("A_RIGHT"), "Alpha's note is not in Gamma's box");
	});

	it("a stale feedback key yields no note but the explanation still renders", () => {
		const qd = quiz();
		qd.optionFeedback = [{ value: "mars", wrong: "MARS_WRONG" }];
		const answer = buildAnswer(qd, { values: ["venus"] });
		const html = renderToStaticMarkup(<AnsweredCard answer={answer} />);
		assert.equal(feedbackBlocks(answer).length, 0, "no selected answer matches the stale key");
		assert.ok(html.includes("tucked-explanation"), "the explanation-only path still works");
	});

	it("no optionFeedback at all still renders the explanation", () => {
		const qd = quiz();
		delete qd.optionFeedback;
		const answer = buildAnswer(qd, { values: ["venus"] });
		assert.equal(answer.optionFeedback, undefined);
		const html = renderToStaticMarkup(<AnsweredCard answer={answer} />);
		assert.equal(feedbackBlocks(answer).length, 0);
		assert.ok(html.includes("tucked-explanation"));
	});
});

describe("the dock's QuestionData construction", () => {
	it("carries posed optionFeedback into the answer snapshot and drops stale keys", () => {
		const input = {
			question: quiz().question,
			options: [
				{ label: "Mercury", value: "mercury" },
				{ label: "Venus", value: "venus" },
			],
			correctAnswer: "mercury",
			explanation: quiz().explanation,
			optionFeedback: [
				{ value: "mercury", right: RIGHT_TEXT },
				{ value: "venus", wrong: WRONG_TEXT },
				{ value: "mars", wrong: "STALE" },
			],
		};
		let captured: QuestionData | undefined;
		renderToStaticMarkup(
			<QuestionDock
				toolName="quiz"
				toolCallId="call-dock"
				input={input}
				expanded
				onExpand={() => {}}
				onSubmit={() => {}}
				hasPendingInput={(qd) => { captured = qd; return false; }}
			/>,
		);
		assert.deepEqual(captured?.optionFeedback, [
			{ value: "mercury", right: RIGHT_TEXT },
			{ value: "venus", wrong: WRONG_TEXT },
		], "the dock copies valid feedback and drops the stale entry");
	});
});
