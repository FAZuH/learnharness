/**
 * End-to-end check for pre-generated per-option feedback, using DEV data only.
 *
 * A scripted (zero-token) teacher poses a quiz whose tool call already carries
 * feedback for every option. The test drives the REAL chat handler and checks
 * the whole pose -> answer -> persist -> view -> render path:
 *
 *   1. the pre-generated feedback is persisted in the posed quiz call before
 *      the learner answers (it is authored while the agent is responding);
 *   2. the answer is graded from the PROJECTED part's input, then submitted
 *      through the real handler and snapshots the feedback into its result;
 *   3. the client view exposes the posed input and the graded output, and the
 *      real AnsweredCard renders the matching note instantly, with no extra
 *      agent turn.
 *
 * All records live in a throwaway temp data dir via the LH_DATA_DIR seam; no
 * live profile, key, or network is touched.
 */

import React from "react";
(globalThis as { React?: typeof React }).React = React;
import assert from "node:assert/strict";
import type { QuestionAnswerData, QuestionData } from "../src/core/question-core.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	fauxToolCall,
} from "@earendil-works/pi-ai";

// ── dev data seam, set BEFORE any config-loading import ───────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-option-feedback-e2e-"));
process.env.LH_DATA_DIR = TMP;
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");
process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const { createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { handleChatRequest } = await import("../src/server/chat-handler.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { projectView } = await import("../src/core/view.ts");
const { danglingQuestionOf } = await import("../src/core/native-messages.ts");
const { buildAnswer, normalizeOptions, resolveCorrect, filterOptionFeedback } = await import("../src/core/question-core.ts");
const { parseQuizInput } = await import("../src/core/tool-parts.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
const { PATHS } = await import("../config.ts");
const { renderToStaticMarkup } = await import("react-dom/server");
const { AnsweredCard } = await import("../components/answered-card.tsx");

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// ── the posed question, with feedback authored for every option up front ──
const QUIZ = {
	type: "check",
	nodeId: "planet-order",
	question: "Which planet is closest to the Sun?",
	options: [
		{ label: "Venus", value: "venus" },
		{ label: "Mercury", value: "mercury" },
		{ label: "Mars", value: "mars" },
	],
	optionFeedback: [
		{
			value: "venus",
			wrong: "Venus is often picked because it is the hottest planet, but being closest is about orbit order, not temperature. Mercury sits inside every other orbit.",
			right: "You separated orbital order from surface temperature: proximity to the Sun sets the orbit, while Venus's greenhouse effect sets the heat.",
		},
		{
			value: "mercury",
			wrong: "Mercury is in fact the closest planet: its orbit is the innermost one.",
			right: "You anchored on the innermost orbit. The whole inner-planet order then follows from distance to the Sun, which is the bigger idea this check is testing.",
		},
		{
			value: "mars",
			wrong: "Mars is the fourth planet, not the first. Count outward from the Sun: Mercury, Venus, Earth, then Mars.",
			right: "You counted outward from the Sun and placed Mars fourth. That same ordering rule gives every planet's position.",
		},
	],
	correctAnswer: "mercury",
	explanation: "Mercury is the innermost planet, so it is closest to the Sun.",
};

type PoseInput = typeof QUIZ | (Omit<typeof QUIZ, "optionFeedback"> & { optionFeedback: string });

function teacher(pose: PoseInput = QUIZ): { engine: any } {
	const faux = createFauxCore({});
	faux.setResponses([
		() => fauxAssistantMessage([fauxThinking("Pose with feedback ready."), fauxToolCall("quiz", pose, { id: "call-fb" })], { stopReason: "toolUse" }),
		() => fauxAssistantMessage([fauxText("Mercury is closest — well reasoned.")]),
	]);
	const engine = { model: faux.getModel(), streamFn: faux.streamSimple } as any;
	return { engine };
}

function factory(engine: any): Parameters<typeof handleChatRequest>[1] {
	return (opts) => createTeacherAgent(undefined, { engine, messages: opts.messages });
}

async function drain(req: Request, makeAgent: Parameters<typeof handleChatRequest>[1]): Promise<void> {
	const cloned = req.clone();
	const ack = await handleChatRequest(req, makeAgent);
	assert.equal(ack.status, 200, `ack status: ${await ack.text().catch(() => "")}`);
	const { chatId } = (await cloned.json()) as { chatId: string };
	const handle = runningTurn(chatId);
	if (handle) await new Response(handle.subscribe()).text();
}

function post(chatId: string, input: unknown): Request {
	return new Request("http://test/api/chat", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ chatId, input }),
	});
}

type QuizPart = { input: unknown; output?: QuestionAnswerData; state?: string };

async function poseAndPart(pose: PoseInput = QUIZ) {
	const { engine } = teacher(pose);
	const chat = chatStore.createChat("Test: pre-generated feedback");
	chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	chatStore.saveTree(chat.id, {
		nodes: [{ id: "planet-order", title: "Planet order" }],
		edges: [],
		version: 1,
	});
	await drain(post(chat.id, { type: "text", text: "teach me the planets" }), factory(engine));
	const posed = chatStore.getChat(chat.id)!;
	const blocks = posed.messages[1]!.content as Array<{ type: string; name?: string; arguments?: unknown }>;
	const call = blocks.find((b) => b.type === "toolCall" && b.name === "quiz");
	assert.ok(call, "quiz tool call persisted");
	assert.equal(danglingQuestionOf(posed.messages)?.toolCallId, "call-fb");
	const part = projectView(posed.messages).flatMap((m) => m.parts).find((p) => p.type === "tool-quiz") as QuizPart | undefined;
	assert.ok(part, "posed quiz is in the client view");
	return { chat, call: call as { arguments: unknown }, part: part!, engine };
}

function gradeFromPart(part: QuizPart, values: string[], confidence: number): QuestionAnswerData {
	const parsed = parseQuizInput(part.input);
	assert.ok(parsed, "the posed input parses at the display seam");
	const options = normalizeOptions(parsed.options);
	const qd: QuestionData = {
		id: "call-fb",
		kind: "quiz",
		question: parsed.question,
		mode: "single-select",
		options,
		correctIndices: resolveCorrect(parsed.correctAnswer, options).indices,
		explanation: parsed.explanation,
		optionFeedback: filterOptionFeedback(parsed.optionFeedback, options.map((o) => o.value)),
		createdAt: new Date().toISOString(),
	};
	return buildAnswer(qd, { values, confidence });
}

async function submitAndCard(chatId: string, answer: QuestionAnswerData, engine: any) {
	await drain(post(chatId, { type: "answer", toolCallId: "call-fb", answer }), factory(engine));
	const saved = chatStore.getChat(chatId)!;
	const part = projectView(saved.messages).flatMap((m) => m.parts).find((p) => p.type === "tool-quiz") as QuizPart | undefined;
	assert.ok(part, "answered quiz part is in the client view");
	assert.equal(part!.state, "output-available", "answered card state");
	assert.ok(part!.output, "graded answer rides the projected output");
	return { part: part!, html: renderToStaticMarkup(React.createElement(AnsweredCard, { answer: part!.output, input: part!.input })) };
}

describe("pre-generated option feedback (e2e, dev data)", () => {
	it("renders the wrong note from the real view after a low-confidence miss", async () => {
		const { chat, call, part, engine } = await poseAndPart();
		assert.deepEqual(call.arguments, QUIZ, "all per-option feedback was authored at pose time");
		assert.deepEqual(part.input, QUIZ, "posed feedback reaches the view input");

		const wrong = gradeFromPart(part, ["venus"], 30);
		assert.equal(wrong.correct, false);
		assert.equal(wrong.confidence, 30);
		const { part: answered, html } = await submitAndCard(chat.id, wrong, engine);
		assert.ok(answered.output!.optionFeedback, "feedback is available to the answered card instantly");
		assert.ok(html.includes(QUIZ.optionFeedback[0]!.wrong), "the selected wrong option's note renders");
		assert.match(html, /data-feedback-kind="wrong"/);
		assert.ok(PATHS.chats.startsWith(TMP), "all writes stayed under the temp dev data dir");
	});

	it("renders the right note after a confident correct answer", async () => {
		const { chat, part, engine } = await poseAndPart();
		const right = gradeFromPart(part, ["mercury"], 90);
		assert.equal(right.correct, true);
		assert.equal(right.confidence, 90);
		const { html } = await submitAndCard(chat.id, right, engine);
		assert.ok(html.includes(QUIZ.optionFeedback[1]!.right), "the correct option's takeaway renders");
		assert.match(html, /data-feedback-kind="right"/);
	});

	it("a string-encoded optionFeedback poses and renders through both seams", async () => {
		const encoded = { ...QUIZ, optionFeedback: JSON.stringify(QUIZ.optionFeedback) };
		const { chat, call, part, engine } = await poseAndPart(encoded);
		assert.deepEqual(call.arguments, encoded, "the raw string is what the tool call persisted");
		const parsed = parseQuizInput(part.input);
		assert.deepEqual(parsed?.optionFeedback, QUIZ.optionFeedback, "the display seam heals the encoded array");

		const answer = gradeFromPart(part, ["mercury"], 90);
		const { html } = await submitAndCard(chat.id, answer, engine);
		assert.ok(html.includes(QUIZ.optionFeedback[1]!.right), "the healed feedback renders from the projected output");
	});
});
