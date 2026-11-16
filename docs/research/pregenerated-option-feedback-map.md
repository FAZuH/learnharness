# Code map: pre-generated feedback for multiple-choice answers

Scope: the LearnHarness app checkout (Next.js + Electron). All paths are repo-relative. This feature removes the perceived delay after a learner answers a multiple-choice (`quiz`) question by pre-generating feedback for every answer option while the question is posed, so the feedback is available on submit.

Key finding up front: today there is **no per-option feedback** and **no separate "feedback generator"**. The only post-answer text is a single model-authored `explanation` string, written at question-pose time inside the `quiz` tool call and revealed by the client. Any richer feedback (why right/wrong, the trap, what was learned, the bigger picture) is new data that must be added across the schema, pose path, storage, and answered card.

## 1. Multiple-choice question data model / types

All of the core model lives in one deterministic module, `src/core/question-core.ts`:

- `src/core/question-core.ts:27-31` — `QuizOption { label, value, description? }` is the option shape.
- `src/core/question-core.ts:36-48` — `quizOptionProps` (TypeBox, model-facing) carries only `label` + optional `value`. The `description` field was removed for quizzes because models used it to leak correctness; `askOptionProps` at `:50-57` keeps it.
- `src/core/question-core.ts:160-195` — `quizInputBase` is the tool input contract: `question`, `options` (minItems 2), `multiSelect`, `explanation`, `correctAnswer`, `details`. **`:178-183` is the current feedback field**: `explanation` = "Explanation revealed AFTER the learner answers (shown whether they got it right or wrong)", authored BEFORE `correctAnswer` by design. It is one string for the whole question, not keyed by option.
- `src/core/question-core.ts:184-191` — `correctAnswer` is the option `value` (string or array for multi-select), resolved by value, never by position.
- `src/core/question-core.ts:211-212, 244-250, 258-270` — `QUIZ_QUESTION_TYPES = ["predict","check"]`, the `predictCheckType` role enum, and `quizInputObject` (teach quiz = base + required `type` + `nodeId`). `:279` `probeQuizInputSchema` = base with no `type`/`nodeId`; `:288-291` `quizDisplayInputSchema` is the read seam.
- `src/core/question-core.ts:305-320` — `explainInputBase` is the free-recall variant: `question` + one committed `correctAnswer` + `details`, **no options, no explanation field**.
- `src/core/question-core.ts:403-407` `OptionAnswer`; `:409-411` `QuestionKind`/`SelectMode`/`QuestionMode`.
- `src/core/question-core.ts:414-433` — `QuestionData` (stored in the `lh_question` custom entry): `id, kind, questionType?, question, context?, mode, options` (post-shuffle), `correctIndices?`, `committedAnswer?`, `explanation?`, `createdAt`. The three answer-bearing fields are explicitly marked "NEVER send to the client before answering" (`:426-431`).
- `src/core/question-core.ts:438-476` — `QuestionAnswerData` (stored in `lh_question_answered`): `questionText`, `options` snapshot, `answers`, `dontKnow`, `thinking`, `readingThinking`, `confidence`, `correct`, `correctIndices`, `committed`, `explanation`, `dismissed`, `answeredAt`.
- `src/core/question-core.ts:478-486` — `ClientQuestion` deliberately omits answer/correct/explanation fields (leak safety). `:489-497` `AnswerRequest` is the submission payload.
- Pure helpers: `normalizeOptions` `:562-585`, `seededRandom` `:591-606`, `shuffleOptions` `:614-624`, `coerceCorrectAnswer` `:635-656`, `resolveCorrect` (value → 1-based display index) `:661-680`, `isCorrect` `:683-688`, `toClientQuestion` `:692-701`.
- Authoring validation: `optionProblems` `:87-105`, `quizInputProblems` `:114-144` (schema-valid ⇔ gradeable).
- `src/core/tool-parts.ts:80` `parseQuizInput`, `:128` tool-name → parser dispatch; `src/core/answer-presentation.ts:8-57` `answerForPresentation` rehydrates `explanation`/`committed`/option labels from the original persisted tool call when rendering historical cards.

## 2. Answer submission flow (UI + server)

Client:
- `components/question-dock.tsx:296-338` builds `QuestionData` from the tool-call input: mode from `multiSelect`, `normalizeOptions`, `shuffleOptions(options, seededRandom(toolCallId))` (`:311`), `resolveCorrect` → `correctIndices`, and `q.explanation = quizInput.explanation` (`:324-329`). Explain commitment at `:330-336`.
- `components/question-dock.tsx:439-465` `captureRequest()` + `doSubmit()` → `onSubmit(buildAnswer(qd, captureRequest(), toolName))`: **the client grades locally** and never sends the explanation back.
- `components/chat.tsx:642` `requiresReveal = questionNeedsReveal(...)`; `:721-751` `builtinTarget`/`prepareBuiltin` runs the submission through the plugin-submission runner, calls `buildAnswer` (`:745`), then `send({ type: "answer", toolCallId, ... answer })` (`:750`).
- `components/session-core.ts:1095-1100` `submitAnswer()` sends `{type:"answer", toolCallId, answer}`; dismissal is a separate silent POST at `:1102-1128`.

Server:
- `src/core/input-events.ts:249-260` parses the `answer` input; `:299-349` `inputAppends` → `:317` `newAnswerResult(toolCallId, pending.tool, answer)`; `:353-375` `assertNativeSubmissionTarget` occurrence guard (orphan-400 discipline).
- `src/server/chat-handler.ts:228, 350-352, 419, 548, 583` handle the `answer` input, image prep, compaction projection, unresolved-question gate, and side-question ordering.
- `src/core/native-messages.ts:272` `newAnswerResult`; `:835-840` `danglingQuestionOf`; `:846-867` `pendingQuestionOf`; `:885-904` `questionCallsOf` (status machine: streaming/answerable/malformed/failed).
- `src/core/question-core.ts:712-755` `buildAnswer` grades and snapshots `explanation`; `:783-806` `compactAnswerForModel` returns only the learner-added verdict, confidence, and thinking to the model (never the explanation).
- Feedback is shown in two channels: (a) instantly from the saved `explanation` in `components/answered-card.tsx:25-240`, specifically the tucked "Why" toggle at `:204-226`; (b) the teacher's next turn (a full LLM round-trip) delivers the pedagogical reaction. Pre-generated per-option feedback would target channel (a).

## 3. Where feedback/explanation text is generated

- It is an **LLM-authored field in the question tool schema**, not a plugin, artifact, or separate tool: `src/core/question-core.ts:178-183` (`explanation` description). No "explain why"/"trap"/artifact code path exists.
- Tool wiring and description: `src/agent/tools.ts:144-175` `quizDescription` ("marks the learner's selection right/wrong, reveals the correct answer, and can show an explanation"); canonical example body with `explanation` at `:121-138`; `:376-392` `teachQuizToolFor`, `:206-218` `probeQuizTool`, `:435-470` `createTeacherTools`; `src/agent/teacher-agent.ts:401-424` `bareQuestionTools`, `:383-393` `createTeacherAgent`.
- The question pose ends the turn: `src/agent/tool-execute.ts:19-25` `questionResult` (temporary, never-persisted ack); `src/agent/teacher-agent.ts:161-203` `makeQuestionStopper`.
- Prompt doctrine (why feedback is written up front and how wrong options work):
  - `src/agent/prompts/shared/20-question-tools.md:5-12` — MCQ has a separate `explanation` written BEFORE `correctAnswer`; "all reasoning goes in the explanation, shown only after he answers"; each distractor is the answer under a specific wrong model; no asymmetry that flags the right option.
  - `src/agent/prompts/teacher/30-question-principles.md:10` — a miss must name the wrong model; each wrong option is the answer under a specific wrong model.
  - `src/agent/prompts/teacher/28-predictions.md:3, 10` — check vs predict roles and their reveal behaviour.
  - `src/agent/prompts/shared/25-confidence.md:6, 9` — low confidence = "trap suspicion"; wrong + high confidence = committed misconception. `shared/16-mental-model.md:5`, `shared/10-voice.md:6` cover reading thinking and plain verdicts.
- Prompt assembly: `src/agent/system-prompt.md`; `src/agent/teacher-agent.ts:88-95` `composeInstructions`; `src/agent/prompt-segments.ts:62-97` `listSourceSegments`; fragments under `src/agent/prompts/{teacher,prober,shared,practice,side-chat}/NN-*.md`.
- Feedback covering why a choice is right or wrong, the trap behind a wrong choice, the takeaway, and the wider context is **not represented anywhere** in the current model. All of it would have to be added as new schema fields + prompt instructions + UI.

## 4. Teaching methodology docs (what they say about options / post-answer feedback)

- `docs/teaching-methodology.md:82-86` (§9 Checks): every reasoning step ends with a graded check; rhythm = step → check → repair-or-continue. §§1-4 knowledge as propositions/connections; §§5-6 one reasoning step at a time, foundations; §8 clearest presentation; §10 implementation demands. The doc is theory, not a data spec; it says nothing about per-option feedback text.
- `docs/plugin-question-contract.md`: plugin-defined question types share the native lifecycle. Host owns dock/reveal/submission (`:9-20`, `:238-246`); plugin owns payload/answer schemas and optional grading (`:21-46`). Grading (`gradeAnswer`, §6 at `:137-176`) returns arbitrary JSON with **no host result schema, correctness enum, or badge UI**, and "occupies the inline answer POST ... no jobs, queue or extra LLM pass" (`:168-169`). So plugin questions have no standard feedback field either, and are not the natural home for this feature.
- `docs/flashcards-vision.md`: fact-recall Q&A cards with only `question` + `answer` fields (`:17-35`, `:39-47`); review is "think → reveal → Again/Hard/Good/Easy" with no thinking field, typed answer, or agent evaluation (`:95-105`). No multiple-choice options and no generated post-answer feedback. Relevant only as a precedent for background work: generation uses the cheap model slot and host-managed parallel workers, one active batch (`:81-93`).
- `docs/flashcards-implementation-plan.md:10-17` confirms the same review interaction and idempotent model-task dispatch; no MCQ option or feedback concept.
- `docs/plugin-problem-contract.md` / practice prompts (`src/agent/prompts/practice/10-doctrine.md:87-137`) are about conversational practice problems, not teaching MCQs.

## 5. Background / speculative / parallel LLM work (reuse candidates)

Several mechanisms exist; no new one needs inventing:

- **Job tools (best fit for a mid-turn, fire-and-forget generation keyed to the question).** `src/agent/tools/jobs.ts:9-17` — each call creates a job, fires the injected `spawn` background runner, and resolves immediately; the result arrives later as a steer message. `:79-94` `dispatch` dedupes by tool call via `jobStore.findJobByToolCallId` (idempotency pattern for pregeneration keyed to the quiz call). ACK text at `:96-107` ("fire-and-forget ... do not wait"). Wiring: `src/server/chat-handler.ts:177, 753, 766, 782` `spawn: (job,input) => jobRunner.runJob(...)`.
- **Sub-agent runner.** `src/agent/subagents/runner.ts:43, 105, 194, 341, 411, 448, 495, 532` — `runJob` dispatches by kind to researcher/demo/visual/pdf jobs. `src/agent/subagents/pi-run.ts:76-120` `runSubagent` builds a stateless Pi `Agent` per call with `maxTurns`, abort, usage, `workerRequestStream` admission, and `backgroundCaptureStream`. Server-side delivery/steer pump: `src/server/jobs.ts:147, 151, 229, 489, 758`, `src/core/contracts/jobs.ts`.
- **Side-chat (lightest primitive).** `src/agent/side-chat.ts:75-90` `streamSideAnswer` — one tool-less streamed LLM call using the session's conversation model, composed prompt from `src/agent/prompts/side-chat/`, no agent loop or session identity. Good candidate if per-option feedback is a single structured generation.
- **Plugin worker service.** `src/core/plugin-workers.ts:9-134` (`PluginWorkerDefinition` with `resultSchema`/`validateResult`, `start`/`wait`/`subscribe`/`cancel`) and `src/agent/plugin-workers.ts:83+` `createPluginWorkerService` (bounded, durable tasks on the shared Pi runner); ack-now/result-later adapter `src/server/plugin-background-tools.ts:86+`. Note the contract explicitly excludes extra LLM passes from question grading, so use the general worker facility, not the grading hook, for pregeneration.
- **Admission/roles.** `src/agent/worker-request-admission.ts`; role list `config.ts:50-59` (background roles resolve to tier slots, cheap by default).
- `src/agent/background-capture.ts` is **not** a work runner; it is an opt-in diagnostic recorder of background prompts/results (`LH_BACKGROUND_CAPTURE`, `docs/development.md:91-102`).
- Natural trigger point for pregeneration: after the quiz tool call is validated/posed (`src/agent/tools.ts:376-392` `teachQuizToolFor.execute`, or the `questionResult` ack in `src/agent/tool-execute.ts`), using the tool call id as the idempotency key. Results must land somewhere the answered card can read before/without a teacher turn (job store record, persisted question metadata, or client-invisible payload).

## 6. Testing conventions

- Commands: `npm test` (node:test via tsx; injected engines, fixtures, fake transports), `npm run typecheck`, `npm run lint`, `npm run build` (`docs/development.md:106-117`). Suite needs no paid models or real sign-in (`:115`). Wrapper `make check` = typecheck + lint + tests (`Makefile:88-91`).
- Full chat loop with zero tokens: `tests/chat-flow.test.ts:1-13` drives `handleChatRequest` with pi-ai's scripted faux engine (`createFauxCore`, `:20-27, 75-83`), poses a quiz via tool call (`:59-70, 85-100`), grades the client answer (`:110-124`), and submits it (`:870`). This is the canonical place to assert background pregeneration is spawned and results are available before the teacher's next turn.
- Core unit tests: `tests/question-core.test.ts` — `buildAnswer` `:446+`, `toClientQuestion` leak safety `:592+`, `questionNeedsReveal` `:762+`, `resolveCorrect` `:280+`, and a pin that `explanation` is emitted before `correctAnswer` in both schemas `:57-73`. Also `tests/tool-parts.test.ts`, `tests/tool-heal.test.ts` (correctAnswer coercion), `tests/answer-presentation` coverage in `tests/tool-content-presentation.test.tsx:117`.
- Rendering: `tests/render-cards.test.tsx` (AnsweredCard, tucked explanation, explain reveal at `:416-604`), `tests/question-preview.test.tsx`, `tests/plugin-question-components.test.tsx`.
- Plugin question suite: `tests/plugin-question-*.test.ts` (contracts, grading, lifecycle, projection, registrations).
- Golden fixtures: `tests/fixtures/golden-data/README.md:1-46` and `tests/golden-fixtures.test.ts:1-20, 33-36, 70-90` — a real data dir copied to a temp dir, `LH_DATA_DIR` set before dynamic imports, read through production folds and `toLlmMessages`, plus a byte-identical read-only check. Fixture law: intentional format changes update fixtures in the same commit. A new `QuestionData`/answer field likely requires regenerating these.
- Background tests for reference: `tests/background-capture.test.ts`, `tests/jobs.test.ts`, `tests/plugin-workers.test.ts`, `tests/plugin-background-tools.test.ts`, `tests/side-chat.test.ts`.
- Suggested E2E verification: extend the faux-engine scripted lesson to spy on `jobStore`/`spawn` when the quiz is posed, assert per-option feedback is persisted and reachable by tool call id before any answer, submit an answer, and assert the answered card shows the matching option feedback instantly; add schema/parse tests in `question-core.test.ts`, a render test in `render-cards.test.tsx`, and refresh golden fixtures if on-disk shapes change.

## 7. Dev / fixtures data setup; mock agent availability

- Data seam: `config.ts:20-22` `LH_DATA_DIR` (default repo `data/`); `:24-35` `PATHS` (chats/graph/debug); `:157-159` `LH_AUTH_FILE`.
- Wrapper `Makefile:11-13, 29-35`: `DATA=real` sets `LH_DATA_DIR`+`LH_AUTH_FILE` to the app config dir; `DATA=fixtures` sets neither, so the app uses the checkout's own `data/` directory. `HOST`/`PORT`/`NPM` overrides at `:15, 25-27`; run targets `make dev` / `make web` / `make desktop` / `make build` at `:58-84`. Run the npm scripts from the checkout root with no `LH_DATA_DIR`.
- `docs/development.md:5-26`: `npm ci`, `npm run plugins:setup`, `npm run dev`; no key needed to open the UI, but model slots must be configured for model-driven use, and there are no factory model selections. `:73-85` documents safe local work with a disposable `LH_DATA_DIR` + empty `{}` auth file; ambient keys still win, so this is not a credential sandbox.
- **No built-in mock/echo agent runs the whole app without a key.** Automated tests inject pi-ai's scripted faux engine via `AgentBuildOptions.engine` (`tests/chat-flow.test.ts:20-27, 75-83, 106-108`). Browser/native smoke scripts bootstrap saved fixture chat records instead of calling a live model (e.g. `scripts/smoke-plugin-runtime.mjs:609-610`; `scripts/smoke-plugin-browser.mjs:1806`). Custom endpoints / Ollama search (`tests/custom-endpoint.test.ts`, `src/server/search.ts:190`) are not a general LLM mock. Therefore E2E verification of this feature relies on injected faux engines + fixture records; a live model is only needed for a human quality check of generated feedback.

## Constraints to honour when designing the change

- Leak safety: `QuestionData`'s answer fields are "NEVER send to the client before answering" (`src/core/question-core.ts:426-431`), `ClientQuestion` omits them (`:478-486`), and `toClientQuestion` (`:692-701`) enforces it. Pre-generated per-option feedback must not let the learner deduce the correct option before answering.
- Option craft: options must stay "bare claims — zero why" and distractors must not be identifiable cold (`src/agent/prompts/shared/20-question-tools.md:11`; `src/core/question-core.ts:36-40`). Per-option feedback must be delivered only after the answer.
- Reveal law: teach checks collapse behind a reveal but predictions never do (`src/core/question-core.ts:225-237`, `components/chat.tsx:642`); the answered card tucks the explanation behind "Why" (`components/answered-card.tsx:204-226`). New feedback UI should fit this gating.
- Idempotency/occurrence discipline: any background generation should be keyed to the exact tool call id/occurrence (`src/agent/tools/jobs.ts:90-93`, `src/core/input-events.ts:353-375`), and should degrade gracefully when unavailable so the existing instant `explanation` still works.
