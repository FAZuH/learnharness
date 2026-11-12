import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { serverExecute } from "../tool-execute.ts";
import type { PiEngine } from "../models.ts";
import { runSubagent } from "./pi-run.ts";
import type { DemoResult } from "../../core/contracts.ts";
import { getHeadless, type DemoRunResult, type HeadlessApi } from "./headless.ts";
import { healToolRecord } from "../tools/heal.ts";

/**
 * The demo-builder sub-agent (vision §2 interactive demos + §2.5 "sub-agents
 * verify; they never one-shot"): given a brief it writes a self-contained
 * single-file HTML/JS demo, TESTS IT HEADLESSLY (run_demo), and iterates
 * fix → re-run until clean — before anything reaches the lesson.
 *
 * Shape: a ToolLoopAgent with two executable tools (write_demo / run_demo) —
 * the engine is injectable (tests use a scripted faux engine) and the headless
 * API is injectable (tests use a fake; production uses the app's own
 * Chromium browser service, system Chrome as fallback).
 *
 * Failure semantics (decided in the W6 brief): `tested: true` means "the
 * verify loop ran"; on failure the result is { title, html: "", tested: true,
 * notes: "FAILED: <reason>" } — the card renders the failure note, no iframe.
 * The job wrapper treats html === "" as failure and marks the job error.
 */

export interface DemoBuilderInput {
	title: string;
	brief: string;
}

export interface DemoBuilderOptions {
	/** Test seam: scripted engine; production uses the demoBuilder role. */
	engine?: PiEngine;
	headless?: HeadlessApi;
	/** Max agent steps (each write/run/fix is one step). Default 24 ≈ 6 cycles. */
	maxSteps?: number;
	/** Total build attempts when the result is a failure (no HTML written or
	 *  the final headless verification failed). Each retry starts a fresh
	 *  conversation carrying the previous failure back to the builder.
	 *  Default 3; headless-unavailable and aborted runs never retry. */
	maxAttempts?: number;
	/** Live activity-line callback (updates the job record). */
	onActivity?: (line: string) => void;
	/** Kills the run mid-model-call (2026-09 real-kill abort semantics). */
	abortSignal?: AbortSignal;
	/** Money channel: one call per agent step, folded into JobRecord.usage. */
	onUsage?: (usage: Usage) => void;
	/** Debug: raw provider-event recording key (LH_PROVIDER_EVENTS=1). */
	chatId?: string;
}

const INSTRUCTIONS = `You are a demo builder — a specialist sub-agent inside a learning application. You
receive a brief for ONE interactive teaching instrument and deliver a single self-contained HTML document
that runs it. You never see the lesson; the brief is everything you know.

Runtime contract (the document runs in a sandboxed iframe, sandbox="allow-scripts", opaque origin):
- Single file. Vanilla JS + Canvas 2D or SVG. CDN imports (e.g. a plotting or math library) are allowed
  when they genuinely help — but prefer dependency-free; you own the failure if a CDN import fails.
- NO localStorage, sessionStorage, or document.cookie — the sandbox makes them throw.
- The parent sizes the iframe to the document height automatically; just build normal flowing layout.
  Make the demo fill the width and size its own height sensibly.

Build quality:
- The demo must directly serve the brief: every control named in the brief must exist and do the thing.
- Controls need labels; sliders/inputs need current-value readouts. A learner should operate it unguided.
- Smooth enough interaction; requestAnimationFrame for animation, not setInterval when it matters.
- Dark-mode neutral: pick a clean light background for the demo area so it reads on any card.

THE HOUSE RULE — never deliver untested:
1. Call write_demo with the complete HTML document.
2. Call run_demo. It loads the file in a headless browser, waits ~2s, and reports console errors, uncaught
   errors (window.onerror), and failed requests. Optionally pass a probe: a JS expression evaluated in
   the page (e.g. "typeof window.simulate === 'function'" or a state assertion) to check deeper.
3. If run_demo reports problems, FIX the document and call write_demo again, then run_demo again.
   Iterate until run_demo reports PASSED.
4. Only then finish. Your final message is 1-3 sentences of NOTES for the teacher (what the demo shows,
   its controls, what to try) — NEVER the HTML itself.

Never claim success you did not see: a PASSED run_demo is the only definition of done.`;

interface BuilderState {
	html: string | null;
	/** The html that the last run_demo tested (null = never tested). */
	testedHtml: string | null;
	lastResult: DemoRunResult | null;
}

const writeDemoInput = Type.Object({
	html: Type.String({ description: "The complete HTML document: <!doctype html>…</html>, all JS inline." }),
});

const runDemoInput = Type.Object({
	probe: Type.Optional(
		Type.String({
			description:
				"Optional JS expression evaluated in the page after settling, e.g. \"document.querySelectorAll('input').length\".",

		}),
	),
});

export function createDemoBuilderTools(
	state: BuilderState,
	headless: HeadlessApi,
	onActivity?: (line: string) => void,
): Record<string, AgentTool<any>> {
	return healToolRecord({
		write_demo: {
			name: "write_demo",
			label: "write_demo",
			description:
				"Write the complete self-contained HTML document for the demo (overwrites any previous version). " +
				"Always follow with run_demo to test it headlessly.",
			parameters: writeDemoInput,
			execute: serverExecute("write_demo", writeDemoInput, async ({ html }) => {
				if (!html || html.trim().length === 0) return "ERROR: empty document — write the full HTML.";
				state.html = html;
				onActivity?.(`write_demo: ${(html.length / 1024).toFixed(1)} KB`);
				return `Saved (${html.length} bytes). Now call run_demo to test it — never deliver untested.`;
			}),
		},
		run_demo: {
			name: "run_demo",
			label: "run_demo",
			description:
				"Headlessly execute the current demo in a browser and report console errors, uncaught errors, and failed requests. " +
				"Optionally pass a probe expression to assert on page state.",
			parameters: runDemoInput,
			execute: serverExecute("run_demo", runDemoInput, async ({ probe }) => {
				if (!state.html) return "ERROR: nothing to run — call write_demo first.";
				const reason = headless.unavailableReason();
				if (reason) return `HEADLESS UNAVAILABLE: ${reason}`;
				let result: DemoRunResult;
				try {
					result = await headless.runDemo(state.html, probe ? { probe } : undefined);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					onActivity?.("run_demo: browser error");
					return `HEADLESS ERROR (retrying may help): ${msg}`;
				}
				state.testedHtml = state.html;
				state.lastResult = result;
				onActivity?.(
					result.ok ? "run_demo: clean" : `run_demo: ${summarizeCounts(result)}`,
				);
				return formatRunResult(result);
			}),
		},
	});
}

function summarizeCounts(result: DemoRunResult): string {
	const counts = [
		result.consoleErrors.length > 0 ? `${result.consoleErrors.length} console error${result.consoleErrors.length === 1 ? "" : "s"}` : null,
		result.pageErrors.length > 0 ? `${result.pageErrors.length} page error${result.pageErrors.length === 1 ? "" : "s"}` : null,
		result.failedRequests.length > 0 ? `${result.failedRequests.length} failed request${result.failedRequests.length === 1 ? "" : "s"}` : null,
	].filter(Boolean);
	return counts.length > 0 ? counts.join(", ") : "ok";
}

function formatRunResult(result: DemoRunResult): string {
	if (result.ok) {
		const probe =
			result.probeResult !== undefined
				? ` Probe result: ${JSON.stringify(result.probeResult) ?? "undefined"}.`
				: "";
		return `PASSED: no console errors, no uncaught errors, no failed requests.${probe} If you are satisfied, finish with your notes; otherwise keep improving and re-test.`;
	}
	const sections: string[] = [`FAILED: ${summarizeCounts(result)}.`];
	if (result.consoleErrors.length > 0)
		sections.push(`Console errors:\n${result.consoleErrors.slice(0, 10).map((e) => `- ${e}`).join("\n")}`);
	if (result.pageErrors.length > 0)
		sections.push(`Uncaught errors:\n${result.pageErrors.slice(0, 10).map((e) => `- ${e}`).join("\n")}`);
	if (result.failedRequests.length > 0)
		sections.push(`Failed requests:\n${result.failedRequests.slice(0, 10).map((r) => `- ${r}`).join("\n")}`);
	sections.push("Fix the document (write_demo) and re-test (run_demo).");
	return sections.join("\n");
}

/** Short summary of a run for failure notes. */
function failureSummary(result: DemoRunResult | null): string {
	if (!result) return "never tested";
	const details = [...result.consoleErrors, ...result.pageErrors, ...result.failedRequests].slice(0, 5);
	return details.length > 0 ? `${summarizeCounts(result)} — ${details.join(" | ")}` : summarizeCounts(result);
}

export async function runDemoBuilder(input: DemoBuilderInput, opts: DemoBuilderOptions = {}): Promise<DemoResult> {
	const headless = opts.headless ?? getHeadless();
	const title = input.title.trim() || "Interactive demo";
	const brief = input.brief.trim() || "(no brief)";
	const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);

	const reason = headless.unavailableReason();
	if (reason) {
		return { title, html: "", tested: true, notes: `FAILED: ${reason}` };
	}

	const failures: string[] = [];
	let feedback: string | undefined;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const outcome = await attemptDemoBuilder({ title, brief }, opts, headless, feedback);
		if (outcome.result.html.length > 0) {
			return attempt === 1
				? outcome.result
				: { ...outcome.result, notes: outcome.result.notes ?? `Built on attempt ${attempt} of ${maxAttempts}.` };
		}
		failures.push(outcome.result.notes ?? "unknown failure");
		// A retry cannot fix a missing browser or a learner abort.
		if (!outcome.retryable || attempt === maxAttempts || opts.abortSignal?.aborted) {
			return failures.length === 1
				? outcome.result
				: {
						...outcome.result,
						notes:
							`${outcome.result.notes ?? "FAILED: the demo could not be built."}\n\n` +
							`Gave up after ${attempt} attempts. Earlier failures:\n` +
							failures
								.slice(0, -1)
								.map((failure, index) => `${index + 1}. ${failure}`)
								.join("\n"),
					};
		}
		opts.onActivity?.(`retry ${attempt + 1}/${maxAttempts}: ${firstLine(outcome.result.notes ?? "failed")}`);
		feedback = demoRetryFeedback(outcome.result.notes ?? "", outcome.failureHtml);
	}

	// Unreachable: the loop always returns on the last attempt.
	return { title, html: "", tested: true, notes: "FAILED: the demo could not be built." };
}

/** One complete builder attempt. `failureHtml` is whatever the model wrote
 *  before the attempt failed (null = it never wrote) — the retry prompt
 *  shows it back to the model so the next attempt fixes real code instead
 *  of guessing. */
interface DemoAttemptOutcome {
	result: DemoResult;
	failureHtml: string | null;
	retryable: boolean;
}

async function attemptDemoBuilder(
	input: DemoBuilderInput,
	opts: DemoBuilderOptions,
	headless: HeadlessApi,
	feedback: string | undefined,
): Promise<DemoAttemptOutcome> {
	const title = input.title;
	const brief = input.brief;
	const notes = (text: string) => (text.trim() ? text.trim() : undefined);

	const state: BuilderState = { html: null, testedHtml: null, lastResult: null };

	const prompt = [
		`Demo title: ${title}`,
		`Brief (all you know about the lesson — this comes from the teacher, verbatim):`,
		brief,
		feedback ? `Retry context — a previous attempt failed:\n${feedback}` : null,
		"",
		"Build the demo, test it with run_demo, iterate until PASSED, then finish with your notes.",
	]
		.filter((line): line is string => line !== null)
		.join("\n");

	let finalText = "";
	try {
		const result = await runSubagent(Object.values(createDemoBuilderTools(state, headless, opts.onActivity)), {
			role: "demoBuilder",
			engine: opts.engine,
			systemPrompt: INSTRUCTIONS,
			prompt,
			maxTurns: opts.maxSteps ?? 24,
			abortSignal: opts.abortSignal,
			onUsage: (usage) => opts.onUsage?.(usage),
			onToolStart: (toolName) => opts.onActivity?.(toolName),
			chatId: opts.chatId,
		});
		finalText = result.text;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			result: { title, html: "", tested: true, notes: `FAILED: the builder crashed — ${msg}` },
			failureHtml: state.html,
			retryable: !opts.abortSignal?.aborted,
		};
	}

	// The model produced nothing.
	if (!state.html) {
		return {
			result: {
				title,
				html: "",
				tested: true,
				notes: `FAILED: the builder never wrote a demo.${finalText ? ` (${finalText.slice(0, 300)})` : ""}`,
			},
			failureHtml: null,
			retryable: true,
		};
	}

	// The verify gate: the delivered html must have a clean headless run —
	// even when the model claims success or forgets the final run_demo.
	if (state.testedHtml !== state.html || !state.lastResult?.ok) {
		opts.onActivity?.("final verification");
		let verify: DemoRunResult;
		try {
			verify = await headless.runDemo(state.html);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return {
				result: { title, html: "", tested: true, notes: `FAILED: final verification crashed — ${msg}` },
				failureHtml: state.html,
				retryable: !opts.abortSignal?.aborted,
			};
		}
		state.lastResult = verify;
		if (!verify.ok) {
			return {
				result: {
					title,
					html: "",
					tested: true,
					notes: `FAILED: the demo never passed headless verification (${failureSummary(verify)}).`,
				},
				failureHtml: state.html,
				retryable: true,
			};
		}
	}

	return { result: { title, html: state.html, tested: true, notes: notes(finalText) }, failureHtml: null, retryable: true };
}

/** The retry prompt's failure block: what went wrong, the class-specific
 *  corrective instruction, and (when one existed) the failed document. */
function demoRetryFeedback(notes: string, html: string | null): string {
	const lines = [
		`Failure: ${notes}`,
		"Diagnose this before writing. Do not resubmit the same document unchanged.",
	];
	if (/never wrote a demo/i.test(notes)) {
		lines.push(
			"Your FIRST action must be write_demo with the complete single-file HTML document. A prose-only reply is a failure.",
		);
	} else if (/never passed headless verification|final verification crashed|headless error/i.test(notes)) {
		lines.push(
			"The HTML failed the headless browser check. Fix the exact errors above, then call write_demo and run_demo again.",
		);
	}
	if (html && html.trim()) {
		const shown = html.length > 12_000 ? `${html.slice(0, 12_000)}\n… [truncated]` : html;
		lines.push(`Previous HTML (fix or replace it — it failed):\n\`\`\`html\n${shown}\n\`\`\``);
	}
	return lines.join("\n\n");
}

function firstLine(text: string): string {
	return (text.split("\n")[0] ?? "").slice(0, 120);
}
