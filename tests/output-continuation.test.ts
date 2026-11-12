/**
 * Premature-stop recovery (2026-11): a provider that cuts a response at its
 * output limit (stopReason "length") or returns a blank/thinking-only
 * answer used to end the turn mid-thought — the learner had to type
 * "resume" repeatedly. The agent now asks pi for bounded explicit
 * continuations with a model-facing note between them.
 *
 * Scripted faux provider, zero network.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	type FauxResponseStep,
} from "@earendil-works/pi-ai";
import { createTeacherAgent } from "../src/agent/teacher-agent.ts";
import { runSubagent } from "../src/agent/subagents/pi-run.ts";
import type { PiEngine } from "../src/agent/models.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import { prematureStopOf } from "../src/core/native-messages.ts";

function scriptedEngine(steps: FauxResponseStep[]): { engine: PiEngine; calls: () => number } {
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses(steps);
	return { engine: { model: faux.getModel(), streamFn: faux.streamSimple }, calls: () => faux.state.callCount };
}

function record(agent: { state: { messages: unknown[] } }): LhMessage[] {
	return agent.state.messages.filter((m) => (m as { role?: string }).role !== "system") as LhMessage[];
}

describe("prematureStopOf", () => {
	it("classifies length, blank, and thinking-only stops; ignores real content and hard failures", () => {
		assert.equal(prematureStopOf({ stopReason: "length", content: [fauxText("cut")] }), "length");
		assert.equal(prematureStopOf({ stopReason: "stop", content: [] }), "empty");
		assert.equal(prematureStopOf({ stopReason: "stop", content: [{ type: "thinking", thinking: "hmm" }] }), "empty");
		assert.equal(prematureStopOf({ stopReason: "stop", content: [fauxText("done")] }), null);
		assert.equal(prematureStopOf({ stopReason: "toolUse", content: [{ type: "toolCall" }] }), null);
		assert.equal(prematureStopOf({ stopReason: "error", content: [] }), null);
		assert.equal(prematureStopOf({ stopReason: "aborted", content: [] }), null);
	});
});

describe("teacher premature-stop recovery", () => {
	it("continues an output-limit stop inside the same turn and records a hidden note", async () => {
		const { engine, calls } = scriptedEngine([
			fauxAssistantMessage([fauxText("The plan is: first we inventory, then")], { stopReason: "length" }),
			fauxAssistantMessage([fauxText(" we enumerate the demand outcomes.")]),
		]);
		const agent = createTeacherAgent(undefined, { engine });
		await agent.prompt("teach me");

		assert.equal(calls(), 2, "one extra provider request for the continuation");
		const messages = record(agent);
		const note = messages.find((m) => m.role === "custom" && m.customType === "continuation");
		assert.ok(note, "the continuation marker is persisted");
		assert.deepEqual((note as { details: unknown }).details, { reason: "length" });
		assert.equal((note as { display: boolean }).display, false, "the learner never sees the note");
		assert.match(
			messages
				.filter((m) => m.role === "assistant")
				.map((m) => (m.content as Array<{ type: string; text?: string }>).map((b) => b.text ?? "").join(""))
				.join(""),
			/inventory, then we enumerate/,
			"both halves of the answer are in the record",
		);
	});

	it("continues a blank/thinking-only stop instead of ending the turn", async () => {
		const { engine, calls } = scriptedEngine([
			fauxAssistantMessage([fauxThinking("I should answer…")], { stopReason: "stop" }),
			fauxAssistantMessage([fauxText("Here is the lesson.")]),
		]);
		const agent = createTeacherAgent(undefined, { engine });
		await agent.prompt("teach me");

		assert.equal(calls(), 2);
		assert.ok(
			record(agent).some(
				(m) => m.role === "custom" && (m.details as { reason?: string } | undefined)?.reason === "empty",
			),
			"the empty-stop note is recorded",
		);
	});

	it("stops at the continuation budget when the provider never recovers", async () => {
		const { engine, calls } = scriptedEngine(
			Array.from({ length: 8 }, () => fauxAssistantMessage([fauxText("still cut")], { stopReason: "length" })),
		);
		const agent = createTeacherAgent(undefined, { engine });
		await agent.prompt("teach me");

		assert.equal(calls(), 5, "initial request + 4 continuations, then the turn ends");
		assert.equal(
			record(agent).filter((m) => m.role === "custom" && m.customType === "continuation").length,
			4,
			"one note per continuation",
		);
	});

	it("does not add a continuation to a normal completion", async () => {
		const { engine, calls } = scriptedEngine([fauxAssistantMessage([fauxText("All done.")])]);
		const agent = createTeacherAgent(undefined, { engine });
		await agent.prompt("teach me");

		assert.equal(calls(), 1);
		assert.equal(record(agent).filter((m) => m.role === "custom").length, 0);
	});
});

describe("sub-agent premature-stop recovery", () => {
	it("recovers a truncated sub-agent answer rather than returning it incomplete", async () => {
		const { engine, calls } = scriptedEngine([
			fauxAssistantMessage([fauxText("Brief part one —")], { stopReason: "length" }),
			fauxAssistantMessage([fauxText(" brief part two.")]),
		]);
		const result = await runSubagent([], {
			role: "researcher" as never,
			engine,
			systemPrompt: "You are a researcher.",
			prompt: "Write a brief.",
			maxTurns: 8,
		});

		assert.equal(calls(), 2);
		assert.equal(result.text, " brief part two.");
		assert.equal(
			result.newMessages.filter((m) => (m as { role?: string }).role === "assistant").length,
			2,
			"both the truncated and completed assistant messages are in the run",
		);
	});
});
