/* eslint-disable @typescript-eslint/ban-ts-comment */
/* eslint-disable @typescript-eslint/no-unused-vars */
import { Blue } from '@blue-labs/language';
import { repository as coreRepository } from '@blue-repository/core-dev';
import { repository as myosRepository } from '@blue-repository/myos-dev';
import { BlueDocumentProcessor } from '@blue-labs/document-processor';

const blue = new Blue({
  repositories: [
    coreRepository,
    myosRepository,
  ],
});

const documentProcessor = new BlueDocumentProcessor(blue);

const gameDocument = `
name: AI Multiplayer Quiz
description: Multiplayer MCQ quiz orchestrated by MyOS + AI

# ----------------- Contracts (channels & ops) -----------------
contracts:

  # Lifecycle and internal triggers
  initLifecycleChannel:
    type: Lifecycle Event Channel

  triggeredEventsChannel:
    type: Triggered Event Channel

  # Participants' channels
  adminChannel:
    type: MyOS Timeline Channel
    description: Game admin (X)
    timelineId: timeline-id-x-admin
  playerAChannel:
    type: MyOS Timeline Channel
    description: Player A
    timelineId: timeline-id-player-a
  playerBChannel:
    type: MyOS Timeline Channel
    description: Player B
    timelineId: timeline-id-player-b

  # ---------- Operations ----------
  startRound:
    type: Operation
    channel: adminChannel
    description: Starts a round by setting question/options (no correct answer here!)
    request:
      roundIndex:
        type: Integer
      question:
        questionId:
          type: Text
        category:
          type: Text
        level:
          type: Integer
        prompt:
          type: Text
        options:
          type: Dictionary
          keyType: Text   # "A" | "B" | "C" | "D"
          valueType: Text # option text


  startRoundImpl:
    type: Sequential Workflow Operation
    operation: startRound
    steps:
      # Guard + Emit only. All mutations happen in onRoundStarted.
      - name: GuardAndEmitRoundStarted
        type: JavaScript Code
        code: |
          const phase = document('/phase');
          if (phase === 'IN_ROUND' || phase === 'GAME_COMPLETED') {
            return {};
          }

          const req = event.message.request || {};
          if (!req || typeof req !== 'object') return {};

          const requestedIndex = Number.isInteger(req.roundIndex) ? req.roundIndex : null;
          if (requestedIndex === null) {
            return {};
          }

          const roundsTotal = document('/roundsTotal') ?? 1;
          if (requestedIndex < 0 || requestedIndex >= roundsTotal) {
            return {};
          }

          const currentIndex = document('/roundIndex') ?? 0;
          const expectedIndex = phase === 'BETWEEN_ROUNDS' ? currentIndex + 1 : currentIndex;
          if (requestedIndex !== expectedIndex) {
            return {};
          }

          const question = req.question;
          if (!question || typeof question !== 'object') {
            return {};
          }

          const { questionId, category, level, prompt, options } = question;
          if (typeof questionId !== 'string' || !questionId.trim()) {
            return {};
          }
          if (typeof category !== 'string' || !category.trim()) {
            return {};
          }
          if (typeof prompt !== 'string' || !prompt.trim()) {
            return {};
          }

          const normalizedQuestionId = questionId.trim();
          const normalizedCategory = category.trim();
          const normalizedPrompt = prompt.trim();

          const allowedCategories = document('/categories');
          if (Array.isArray(allowedCategories) && allowedCategories.length > 0) {
            const normalizedAllowed = allowedCategories
              .filter(cat => typeof cat === 'string')
              .map(cat => cat.trim().toLowerCase());
            if (!normalizedAllowed.includes(normalizedCategory.toLowerCase())) {
              return {};
            }
          }

          const normalizedLevel = Number.isInteger(level) ? level : null;
          if (normalizedLevel === null) {
            return {};
          }

          const allowedChoices = ['A', 'B', 'C', 'D'];
          if (!options || typeof options !== 'object') {
            return {};
          }
          const normalizedOptions = {};
          for (const choice of allowedChoices) {
            const value = options[choice];
            if (typeof value !== 'string' || !value.trim()) {
              return {};
            }
            normalizedOptions[choice] = value;
          }

          return {
            events: [
              {
                type: "Event",
                kind: "Round Started",
                roundIndex: requestedIndex,
                question: {
                  questionId: normalizedQuestionId,
                  category: normalizedCategory,
                  level: normalizedLevel,
                  prompt: normalizedPrompt,
                  options: normalizedOptions,
                },
              },
            ],
          };

  completeRound:
    type: Operation
    channel: adminChannel
    description: Completes the round with the authoritative correct option
    request:
      roundIndex:
        type: Integer
      questionId:
        type: Text
      correctOption:
        type: Text   # "A" | "B" | "C" | "D"
      explanation:
        type: Text

  completeRoundImpl:
    type: Sequential Workflow Operation
    operation: completeRound
    steps:
      - name: GuardComputeAndEmit
        type: JavaScript Code
        code: |
          // ---- Guards ----
          const phase = document('/phase');
          if (phase !== 'IN_ROUND') return {};  // must be in a live round
          const curQ = document('/currentQuestion');
          if (!curQ) return {};
          const req = event.message.request;
          const docIdx = document('/roundIndex') ?? 0;
          if (req.roundIndex !== docIdx) return {};
          if (req.questionId !== curQ.questionId) return {};
          const correct = (req.correctOption || '').trim().toUpperCase();
          if (!['A','B','C','D'].includes(correct)) return {};

          // ---- Compute results (answers may be missing; timeouts OK) ----
          const answers = document('/answers') || {};
          const aAns = answers.playerA ?? null;
          const bAns = answers.playerB ?? null;

          const scoreboard = document('/scoreboard') || { playerA: 0, playerB: 0 };
          const aPoint = aAns === correct ? 1 : 0;
          const bPoint = bAns === correct ? 1 : 0;
          const newBoard = {
            playerA: (scoreboard.playerA || 0) + aPoint,
            playerB: (scoreboard.playerB || 0) + bPoint,
          };

          const roundsTotal = document('/roundsTotal') || 1;
          const nextIndex = req.roundIndex + 1;
          const hasMore = nextIndex < roundsTotal;

          const results = {
            roundIndex: req.roundIndex,
            questionId: req.questionId,
            correctOption: correct,
            explanation: req.explanation,
            answers: { playerA: aAns, playerB: bAns },
            pointsAwarded: { playerA: aPoint, playerB: bPoint },
            scoreboard: newBoard
          };

          const events = [{ type: "Event", kind: "Round Completed", results }];
          if (hasMore) {
            events.push({ type: "Event", kind: "Round Requested", nextRoundIndex: nextIndex });
          } else {
            const maxScore = Math.max(newBoard.playerA, newBoard.playerB);
            const winners = [];
            if (newBoard.playerA === maxScore) winners.push("playerA");
            if (newBoard.playerB === maxScore) winners.push("playerB");
            events.push({ type: "Event", kind: "Game Completed", scoreboard: newBoard, winners });
          }
          return { events };

  # Players answer operations (one per player channel)
  answerA:
    type: Operation
    channel: playerAChannel
    description: Player A answers current question
    request:
      type: Text # "A" | "B" | "C" | "D"

  answerAImpl:
    type: Sequential Workflow Operation
    operation: answerA
    steps:
      - name: GuardAndEmitAnswerA
        type: JavaScript Code
        code: |
          const phase = document('/phase');
          if (phase !== 'IN_ROUND') return {};
          const curQ = document('/currentQuestion');
          if (!curQ) return {};
          const prev = document('/answers/playerA');
          if (prev !== undefined && prev !== null) return {};   // already answered
          const raw = (event.message.request || '').trim().toUpperCase();
          if (!['A','B','C','D'].includes(raw)) return {};
          if (!curQ.options || !(raw in curQ.options)) return {}; // must match existing option
          return { events: [{ type: "Event", kind: "Answer Submitted", player: "playerA", choice: raw }] };

  answerB:
    type: Operation
    channel: playerBChannel
    description: Player B answers current question
    request:
      type: Text # "A" | "B" | "C" | "D"

  answerBImpl:
    type: Sequential Workflow Operation
    operation: answerB
    steps:
      - name: GuardAndEmitAnswerB
        type: JavaScript Code
        code: |
          const phase = document('/phase');
          if (phase !== 'IN_ROUND') return {};
          const curQ = document('/currentQuestion');
          if (!curQ) return {};
          const prev = document('/answers/playerB');
          if (prev !== undefined && prev !== null) return {};   // already answered
          const raw = (event.message.request || '').trim().toUpperCase();
          if (!['A','B','C','D'].includes(raw)) return {};
          if (!curQ.options || !(raw in curQ.options)) return {};
          return { events: [{ type: "Event", kind: "Answer Submitted", player: "playerB", choice: raw }] };

  # ---------- Workflows listening to lifecycle & events ----------
  validateOnInit:
    type: Sequential Workflow
    channel: initLifecycleChannel
    event:
      type: Document Processing Initiated
    steps:
      - name: ValidateInputs
        type: JavaScript Code
        code: |
          const issues = [];
          const roundsTotal = document('/roundsTotal');
          const categories = document('/categories');
          const level = document('/level');
          if (!roundsTotal || roundsTotal < 1) issues.push("roundsTotal must be >= 1");
          if (!Array.isArray(categories) || categories.length === 0) issues.push("categories must be a non-empty list");
          if (typeof level !== 'number' || level < 0 || level > 2) issues.push("level must be 0..2");
          if (issues.length > 0) {
            return { events: [ { type: "Event", kind: "Status Change", status: { type: "Status Failed" }, issues } ] };
          }
          return { events: [
            { type: "Event", kind: "Status Change", status: { type: "Status In Progress" } },
            { type: "Event", kind: "Round Requested", nextRoundIndex: 0 }
          ] };

  onStatusChange:
    type: Sequential Workflow
    channel: triggeredEventsChannel
    event:
      type: Event
      kind: Status Change
    steps:
      - name: UpdateStatus
        type: Update Document
        changeset:
          - op: replace
            path: /status
            val: \${event.status}

  onRoundStarted:
    type: Sequential Workflow
    channel: triggeredEventsChannel
    event:
      type: Event
      kind: Round Started
    steps:
      - name: ApplyRoundStart
        type: Update Document
        changeset:
          - op: replace
            path: /status
            val: { type: Status In Progress }
          - op: replace
            path: /roundIndex
            val: \${event.roundIndex}
          - op: replace
            path: /currentQuestion
            val: \${event.question}
          - op: replace
            path: /answers
            val: {}
          - op: replace
            path: /phase
            val: "IN_ROUND"

  onAnswerSubmittedA:
    type: Sequential Workflow
    channel: triggeredEventsChannel
    event:
      type: Event
      kind: Answer Submitted
      player: playerA
    steps:
      - name: RecordA
        type: Update Document
        changeset:
          - op: add
            path: /answers/playerA
            val: \${event.choice}

  onAnswerSubmittedB:
    type: Sequential Workflow
    channel: triggeredEventsChannel
    event:
      type: Event
      kind: Answer Submitted
      player: playerB
    steps:
      - name: RecordB
        type: Update Document
        changeset:
          - op: add
            path: /answers/playerB
            val: \${event.choice}

  onRoundCompleted:
    type: Sequential Workflow
    channel: triggeredEventsChannel
    event:
      type: Event
      kind: Round Completed
    steps:
      - name: ApplyResults
        type: Update Document
        changeset:
          - op: replace
            path: /scoreboard
            val: \${event.results.scoreboard}
          - op: replace
            path: /lastRoundResult
            val: \${event.results}
          - op: replace
            path: /phase
            val: "BETWEEN_ROUNDS"
          - op: remove
            path: /currentQuestion
          - op: replace
            path: /answers
            val: {}

  onGameCompleted:
    type: Sequential Workflow
    channel: triggeredEventsChannel
    event:
      type: Event
      kind: Game Completed
    steps:
      - name: Finish
        type: Update Document
        changeset:
          - op: replace
            path: /status
            val: { type: Status Completed }
          - op: replace
            path: /winners
            val: \${event.winners}
          - op: replace
            path: /phase
            val: "GAME_COMPLETED"

# ----------------- Document fields -----------------
roundsTotal: 2
categories:
  - History
  - Science
level: 1
roundIndex: 0
status:
  type: Status Pending
`
// types of fields added during documents lifecycle
// phase:
//   type: Text
//   description: IN_ROUND | BETWEEN_ROUNDS | GAME_COMPLETED
// scoreboard:
//   type: Dictionary
//   keyType: Text # "playerA" | "playerB"
//   valueType: Integer # 0 | 1
// currentQuestion:
//   description: Visible to all; no correctOption stored here
// answers:
//   description: Per-round collected answers ("playerA"/"playerB" -> "A" | "B" | "C" | "D")
// lastRoundResult:
//   description: Snapshot for the last completed round
// winners:
//   type: List
//   itemType: Text

// This unit test is to help design & debug the "AI Multiplayer Quiz" Blue document

// pnpm test:spec unit/blue-document.spec.ts

describe('AI Multiplayer Quiz document', () => {
  it('should handle game', async () => {
    // Initialize document
    const documentNode = blue.resolve(blue.yamlToNode(gameDocument));
    let results = await documentProcessor.initialize(documentNode);
    let emittedEvents = results.emitted.map(event => blue.nodeToJson(blue.restoreInlineTypes(event), 'original'));
    expect(emittedEvents.length).toBeGreaterThan(1)
    expect(emittedEvents).toMatchInlineSnapshot(`
      [
        {
          "type": "Document Processing Initiated",
        },
        {
          "kind": "Status Change",
          "status": {
            "type": "Status In Progress",
          },
          "type": "Event",
        },
        {
          "kind": "Round Requested",
          "nextRoundIndex": 0,
          "type": "Event",
        },
        {
          "op": "replace",
          "path": "/status",
          "type": "Document Update",
          "val": {
            "type": "Status In Progress",
          },
        },
      ]
    `);

    let event = `
type: MyOS Timeline Entry
message:
  type: Operation Request
  operation: startRound
  request:
    roundIndex: 0
    question:
      questionId: id1
      category: science
      level: 1
      prompt: What is 1+1?
      options:
        A: '2'
        B: '3'
        C: '1'
        D: '0'
timeline:
  timelineId: timeline-id-x-admin
timestamp: 1
`

    // Process startRound event
    let eventNode = blue.resolve(blue.yamlToNode(event));
    results = await documentProcessor.processEvents(results.state, [
      eventNode,
    ]);
    

    // @ts-ignore
    let { name, description, contracts,...state } = blue.nodeToJson(blue.restoreInlineTypes(results.state), 'original');
    expect(state).toMatchInlineSnapshot(`
      {
        "answers": {},
        "categories": [
          "History",
          "Science",
        ],
        "currentQuestion": {
          "category": "science",
          "level": 1,
          "options": {
            "A": "2",
            "B": "3",
            "C": "1",
            "D": "0",
          },
          "prompt": "What is 1+1?",
          "questionId": "id1",
        },
        "level": 1,
        "phase": "IN_ROUND",
        "roundIndex": 0,
        "roundsTotal": 2,
        "status": {
          "mode": {
            "description": "Defines the high-level phase of the document's lifecycle. Must be one of:
        pending: The document is waiting for a pre-condition before its core logic begins.
        active: The document is in its main operational phase, actively processing events.
        terminated: The document has reached a final, conclusive state.",
            "type": "Text",
            "value": "active",
          },
          "type": "Status In Progress",
        },
      }
    `)

    emittedEvents = results.emitted.map(event => blue.nodeToJson(blue.restoreInlineTypes(event), 'original'));
    expect(emittedEvents.length).toBeGreaterThan(1)
    expect(emittedEvents).toMatchInlineSnapshot(`
      [
        {
          "kind": "Round Started",
          "question": {
            "category": "science",
            "level": 1,
            "options": {
              "A": "2",
              "B": "3",
              "C": "1",
              "D": "0",
            },
            "prompt": "What is 1+1?",
            "questionId": "id1",
          },
          "roundIndex": 0,
          "type": "Event",
        },
        {
          "op": "replace",
          "path": "/status",
          "type": "Document Update",
          "val": {
            "mode": {
              "description": "Defines the high-level phase of the document's lifecycle. Must be one of:
        pending: The document is waiting for a pre-condition before its core logic begins.
        active: The document is in its main operational phase, actively processing events.
        terminated: The document has reached a final, conclusive state.",
              "type": "Text",
              "value": "active",
            },
            "type": "Status In Progress",
          },
        },
        {
          "op": "replace",
          "path": "/roundIndex",
          "type": "Document Update",
          "val": 0,
        },
        {
          "op": "replace",
          "path": "/currentQuestion",
          "type": "Document Update",
          "val": {
            "category": "science",
            "level": 1,
            "options": {
              "A": "2",
              "B": "3",
              "C": "1",
              "D": "0",
            },
            "prompt": "What is 1+1?",
            "questionId": "id1",
          },
        },
        {
          "op": "replace",
          "path": "/answers",
          "type": "Document Update",
          "val": {},
        },
        {
          "op": "replace",
          "path": "/phase",
          "type": "Document Update",
          "val": "IN_ROUND",
        },
      ]
    `)

    event = `
type: MyOS Timeline Entry
message:
  type: Operation Request
  operation: answerB
  request: A
timeline:
  timelineId: timeline-id-player-b
timestamp: 2
`

    eventNode = blue.resolve(blue.yamlToNode(event));
    results = await documentProcessor.processEvents(results.state, [
      eventNode,
    ]);

    // @ts-ignore
    ({ name, description, contracts,...state } = blue.nodeToJson(blue.restoreInlineTypes(results.state), 'original'));
    expect(state).toMatchInlineSnapshot(`
      {
        "answers": {
          "playerB": "A",
        },
        "categories": [
          "History",
          "Science",
        ],
        "currentQuestion": {
          "category": "science",
          "level": 1,
          "options": {
            "A": "2",
            "B": "3",
            "C": "1",
            "D": "0",
          },
          "prompt": "What is 1+1?",
          "questionId": "id1",
        },
        "level": 1,
        "phase": "IN_ROUND",
        "roundIndex": 0,
        "roundsTotal": 2,
        "status": {
          "mode": {
            "description": "Defines the high-level phase of the document's lifecycle. Must be one of:
        pending: The document is waiting for a pre-condition before its core logic begins.
        active: The document is in its main operational phase, actively processing events.
        terminated: The document has reached a final, conclusive state.",
            "type": "Text",
            "value": "active",
          },
          "type": "Status In Progress",
        },
      }
    `)

    emittedEvents = results.emitted.map(event => blue.nodeToJson(blue.restoreInlineTypes(event), 'original'));
    expect(emittedEvents).toMatchInlineSnapshot(`
      [
        {
          "choice": "A",
          "kind": "Answer Submitted",
          "player": "playerB",
          "type": "Event",
        },
        {
          "op": "add",
          "path": "/answers/playerB",
          "type": "Document Update",
          "val": "A",
        },
      ]
    `)

    event = `
type: MyOS Timeline Entry
message:
  type: Operation Request
  operation: answerA
  request: B
timeline:
  timelineId: timeline-id-player-a
timestamp: 3
`

    eventNode = blue.resolve(blue.yamlToNode(event));
    results = await documentProcessor.processEvents(results.state, [
      eventNode,
    ]);

    // @ts-ignore
    ({ name, description, contracts,...state } = blue.nodeToJson(blue.restoreInlineTypes(results.state), 'original'));
    expect(state).toMatchInlineSnapshot(`
      {
        "answers": {
          "playerA": "B",
          "playerB": "A",
        },
        "categories": [
          "History",
          "Science",
        ],
        "currentQuestion": {
          "category": "science",
          "level": 1,
          "options": {
            "A": "2",
            "B": "3",
            "C": "1",
            "D": "0",
          },
          "prompt": "What is 1+1?",
          "questionId": "id1",
        },
        "level": 1,
        "phase": "IN_ROUND",
        "roundIndex": 0,
        "roundsTotal": 2,
        "status": {
          "mode": {
            "description": "Defines the high-level phase of the document's lifecycle. Must be one of:
        pending: The document is waiting for a pre-condition before its core logic begins.
        active: The document is in its main operational phase, actively processing events.
        terminated: The document has reached a final, conclusive state.",
            "type": "Text",
            "value": "active",
          },
          "type": "Status In Progress",
        },
      }
    `)

    emittedEvents = results.emitted.map(event => blue.nodeToJson(blue.restoreInlineTypes(event), 'original'));
    expect(emittedEvents).toMatchInlineSnapshot(`
      [
        {
          "choice": "B",
          "kind": "Answer Submitted",
          "player": "playerA",
          "type": "Event",
        },
        {
          "op": "add",
          "path": "/answers/playerA",
          "type": "Document Update",
          "val": "B",
        },
      ]
    `)

    event = `
type: MyOS Timeline Entry
message:
  type: Operation Request
  operation: completeRound
  request:
    roundIndex: 0
    questionId: id1
    correctOption: A
    explanation: "Because 1+1=2"
timeline:
  timelineId: timeline-id-x-admin
timestamp: 4
`

    eventNode = blue.resolve(blue.yamlToNode(event));
    results = await documentProcessor.processEvents(results.state, [
      eventNode,
    ]);

    // @ts-ignore
    ({ name, description, contracts,...state } = blue.nodeToJson(blue.restoreInlineTypes(results.state), 'original'));
    expect(state).toMatchInlineSnapshot(`
      {
        "answers": {},
        "categories": [
          "History",
          "Science",
        ],
        "lastRoundResult": {
          "answers": {
            "playerA": "B",
            "playerB": "A",
          },
          "correctOption": "A",
          "explanation": "Because 1+1=2",
          "pointsAwarded": {
            "playerA": 0,
            "playerB": 1,
          },
          "questionId": "id1",
          "roundIndex": 0,
          "scoreboard": {
            "playerA": 0,
            "playerB": 1,
          },
        },
        "level": 1,
        "phase": "BETWEEN_ROUNDS",
        "roundIndex": 0,
        "roundsTotal": 2,
        "scoreboard": {
          "playerA": 0,
          "playerB": 1,
        },
        "status": {
          "mode": {
            "description": "Defines the high-level phase of the document's lifecycle. Must be one of:
        pending: The document is waiting for a pre-condition before its core logic begins.
        active: The document is in its main operational phase, actively processing events.
        terminated: The document has reached a final, conclusive state.",
            "type": "Text",
            "value": "active",
          },
          "type": "Status In Progress",
        },
      }
    `)

    emittedEvents = results.emitted.map(event => blue.nodeToJson(blue.restoreInlineTypes(event), 'original'));
    expect(emittedEvents).toMatchInlineSnapshot(`
      [
        {
          "kind": "Round Completed",
          "results": {
            "answers": {
              "playerA": "B",
              "playerB": "A",
            },
            "correctOption": "A",
            "explanation": "Because 1+1=2",
            "pointsAwarded": {
              "playerA": 0,
              "playerB": 1,
            },
            "questionId": "id1",
            "roundIndex": 0,
            "scoreboard": {
              "playerA": 0,
              "playerB": 1,
            },
          },
          "type": "Event",
        },
        {
          "kind": "Round Requested",
          "nextRoundIndex": 1,
          "type": "Event",
        },
        {
          "op": "replace",
          "path": "/scoreboard",
          "type": "Document Update",
          "val": {
            "playerA": 0,
            "playerB": 1,
          },
        },
        {
          "op": "replace",
          "path": "/lastRoundResult",
          "type": "Document Update",
          "val": {
            "answers": {
              "playerA": "B",
              "playerB": "A",
            },
            "correctOption": "A",
            "explanation": "Because 1+1=2",
            "pointsAwarded": {
              "playerA": 0,
              "playerB": 1,
            },
            "questionId": "id1",
            "roundIndex": 0,
            "scoreboard": {
              "playerA": 0,
              "playerB": 1,
            },
          },
        },
        {
          "op": "replace",
          "path": "/phase",
          "type": "Document Update",
          "val": "BETWEEN_ROUNDS",
        },
        {
          "op": "remove",
          "path": "/currentQuestion",
          "type": "Document Update",
          "val": null,
        },
        {
          "op": "replace",
          "path": "/answers",
          "type": "Document Update",
          "val": {},
        },
      ]
    `)

 // Next round
 event = `
type: MyOS Timeline Entry
message:
  type: Operation Request
  operation: startRound
  request:
    roundIndex: 1
    question:
      questionId: id2
      category: history
      level: 1
      prompt: Who wrote the Declaration of Independence?
      options:
        A: 'Thomas Jefferson'
        B: 'George Washington'
        C: 'Benjamin Franklin'
        D: 'John Adams'
timeline:
  timelineId: timeline-id-x-admin
timestamp: 9
 `

    eventNode = blue.resolve(blue.yamlToNode(event));
    results = await documentProcessor.processEvents(results.state, [
      eventNode,
    ]);

    // @ts-ignore
    ({ name, description, contracts,...state } = blue.nodeToJson(blue.restoreInlineTypes(results.state), 'original'));
    expect(state).toMatchInlineSnapshot(`
      {
        "answers": {},
        "categories": [
          "History",
          "Science",
        ],
        "currentQuestion": {
          "category": "history",
          "level": 1,
          "options": {
            "A": "Thomas Jefferson",
            "B": "George Washington",
            "C": "Benjamin Franklin",
            "D": "John Adams",
          },
          "prompt": "Who wrote the Declaration of Independence?",
          "questionId": "id2",
        },
        "lastRoundResult": {
          "answers": {
            "playerA": "B",
            "playerB": "A",
          },
          "correctOption": "A",
          "explanation": "Because 1+1=2",
          "pointsAwarded": {
            "playerA": 0,
            "playerB": 1,
          },
          "questionId": "id1",
          "roundIndex": 0,
          "scoreboard": {
            "playerA": 0,
            "playerB": 1,
          },
        },
        "level": 1,
        "phase": "IN_ROUND",
        "roundIndex": 1,
        "roundsTotal": 2,
        "scoreboard": {
          "playerA": 0,
          "playerB": 1,
        },
        "status": {
          "mode": {
            "description": "Defines the high-level phase of the document's lifecycle. Must be one of:
        pending: The document is waiting for a pre-condition before its core logic begins.
        active: The document is in its main operational phase, actively processing events.
        terminated: The document has reached a final, conclusive state.",
            "type": "Text",
            "value": "active",
          },
          "type": "Status In Progress",
        },
      }
    `)

    emittedEvents = results.emitted.map(event => blue.nodeToJson(blue.restoreInlineTypes(event), 'original'));
    expect(emittedEvents).toMatchInlineSnapshot(`
      [
        {
          "kind": "Round Started",
          "question": {
            "category": "history",
            "level": 1,
            "options": {
              "A": "Thomas Jefferson",
              "B": "George Washington",
              "C": "Benjamin Franklin",
              "D": "John Adams",
            },
            "prompt": "Who wrote the Declaration of Independence?",
            "questionId": "id2",
          },
          "roundIndex": 1,
          "type": "Event",
        },
        {
          "op": "replace",
          "path": "/status",
          "type": "Document Update",
          "val": {
            "mode": {
              "description": "Defines the high-level phase of the document's lifecycle. Must be one of:
        pending: The document is waiting for a pre-condition before its core logic begins.
        active: The document is in its main operational phase, actively processing events.
        terminated: The document has reached a final, conclusive state.",
              "type": "Text",
              "value": "active",
            },
            "type": "Status In Progress",
          },
        },
        {
          "op": "replace",
          "path": "/roundIndex",
          "type": "Document Update",
          "val": 1,
        },
        {
          "op": "replace",
          "path": "/currentQuestion",
          "type": "Document Update",
          "val": {
            "category": "history",
            "level": 1,
            "options": {
              "A": "Thomas Jefferson",
              "B": "George Washington",
              "C": "Benjamin Franklin",
              "D": "John Adams",
            },
            "prompt": "Who wrote the Declaration of Independence?",
            "questionId": "id2",
          },
        },
        {
          "op": "replace",
          "path": "/answers",
          "type": "Document Update",
          "val": {},
        },
        {
          "op": "replace",
          "path": "/phase",
          "type": "Document Update",
          "val": "IN_ROUND",
        },
      ]
    `)

    event = `
type: MyOS Timeline Entry
message:
  type: Operation Request
  operation: answerB
  request: A
timeline:
  timelineId: timeline-id-player-b
timestamp: 6
`

    eventNode = blue.resolve(blue.yamlToNode(event));
    results = await documentProcessor.processEvents(results.state, [
      eventNode,
    ]);

    // @ts-ignore
    ({ name, description, contracts,...state } = blue.nodeToJson(blue.restoreInlineTypes(results.state), 'original'));
    expect(state).toMatchInlineSnapshot(`
      {
        "answers": {
          "playerB": "A",
        },
        "categories": [
          "History",
          "Science",
        ],
        "currentQuestion": {
          "category": "history",
          "level": 1,
          "options": {
            "A": "Thomas Jefferson",
            "B": "George Washington",
            "C": "Benjamin Franklin",
            "D": "John Adams",
          },
          "prompt": "Who wrote the Declaration of Independence?",
          "questionId": "id2",
        },
        "lastRoundResult": {
          "answers": {
            "playerA": "B",
            "playerB": "A",
          },
          "correctOption": "A",
          "explanation": "Because 1+1=2",
          "pointsAwarded": {
            "playerA": 0,
            "playerB": 1,
          },
          "questionId": "id1",
          "roundIndex": 0,
          "scoreboard": {
            "playerA": 0,
            "playerB": 1,
          },
        },
        "level": 1,
        "phase": "IN_ROUND",
        "roundIndex": 1,
        "roundsTotal": 2,
        "scoreboard": {
          "playerA": 0,
          "playerB": 1,
        },
        "status": {
          "mode": {
            "description": "Defines the high-level phase of the document's lifecycle. Must be one of:
        pending: The document is waiting for a pre-condition before its core logic begins.
        active: The document is in its main operational phase, actively processing events.
        terminated: The document has reached a final, conclusive state.",
            "type": "Text",
            "value": "active",
          },
          "type": "Status In Progress",
        },
      }
    `)

    emittedEvents = results.emitted.map(event => blue.nodeToJson(blue.restoreInlineTypes(event), 'original'));
    expect(emittedEvents).toMatchInlineSnapshot(`
      [
        {
          "choice": "A",
          "kind": "Answer Submitted",
          "player": "playerB",
          "type": "Event",
        },
        {
          "op": "add",
          "path": "/answers/playerB",
          "type": "Document Update",
          "val": "A",
        },
      ]
    `)

    event = `
type: MyOS Timeline Entry
message:
  type: Operation Request
  operation: answerA
  request: A
timeline:
  timelineId: timeline-id-player-a
timestamp: 7
`

    eventNode = blue.resolve(blue.yamlToNode(event));
    results = await documentProcessor.processEvents(results.state, [
      eventNode,
    ]);

    // @ts-ignore
    ({ name, description, contracts,...state } = blue.nodeToJson(blue.restoreInlineTypes(results.state), 'original'));
    expect(state).toMatchInlineSnapshot(`
      {
        "answers": {
          "playerA": "A",
          "playerB": "A",
        },
        "categories": [
          "History",
          "Science",
        ],
        "currentQuestion": {
          "category": "history",
          "level": 1,
          "options": {
            "A": "Thomas Jefferson",
            "B": "George Washington",
            "C": "Benjamin Franklin",
            "D": "John Adams",
          },
          "prompt": "Who wrote the Declaration of Independence?",
          "questionId": "id2",
        },
        "lastRoundResult": {
          "answers": {
            "playerA": "B",
            "playerB": "A",
          },
          "correctOption": "A",
          "explanation": "Because 1+1=2",
          "pointsAwarded": {
            "playerA": 0,
            "playerB": 1,
          },
          "questionId": "id1",
          "roundIndex": 0,
          "scoreboard": {
            "playerA": 0,
            "playerB": 1,
          },
        },
        "level": 1,
        "phase": "IN_ROUND",
        "roundIndex": 1,
        "roundsTotal": 2,
        "scoreboard": {
          "playerA": 0,
          "playerB": 1,
        },
        "status": {
          "mode": {
            "description": "Defines the high-level phase of the document's lifecycle. Must be one of:
        pending: The document is waiting for a pre-condition before its core logic begins.
        active: The document is in its main operational phase, actively processing events.
        terminated: The document has reached a final, conclusive state.",
            "type": "Text",
            "value": "active",
          },
          "type": "Status In Progress",
        },
      }
    `)

    emittedEvents = results.emitted.map(event => blue.nodeToJson(blue.restoreInlineTypes(event), 'original'));
    expect(emittedEvents).toMatchInlineSnapshot(`
      [
        {
          "choice": "A",
          "kind": "Answer Submitted",
          "player": "playerA",
          "type": "Event",
        },
        {
          "op": "add",
          "path": "/answers/playerA",
          "type": "Document Update",
          "val": "A",
        },
      ]
    `)

    event = `
type: MyOS Timeline Entry
message:
  type: Operation Request
  operation: completeRound
  request:
    roundIndex: 1
    questionId: id2
    correctOption: A
    explanation: "Because 2+2=4"
timeline:
  timelineId: timeline-id-x-admin
timestamp: 8
`

    eventNode = blue.resolve(blue.yamlToNode(event));
    results = await documentProcessor.processEvents(results.state, [
      eventNode,
    ]);

        // @ts-ignore
    ({ name, description, contracts,...state } = blue.nodeToJson(blue.restoreInlineTypes(results.state), 'original'));
    expect(state).toMatchInlineSnapshot(`
      {
        "answers": {},
        "categories": [
          "History",
          "Science",
        ],
        "lastRoundResult": {
          "answers": {
            "playerA": "A",
            "playerB": "A",
          },
          "correctOption": "A",
          "explanation": "Because 2+2=4",
          "pointsAwarded": {
            "playerA": 1,
            "playerB": 1,
          },
          "questionId": "id2",
          "roundIndex": 1,
          "scoreboard": {
            "playerA": 1,
            "playerB": 2,
          },
        },
        "level": 1,
        "phase": "GAME_COMPLETED",
        "roundIndex": 1,
        "roundsTotal": 2,
        "scoreboard": {
          "playerA": 1,
          "playerB": 2,
        },
        "status": {
          "mode": {
            "description": "Defines the high-level phase of the document's lifecycle. Must be one of:
        pending: The document is waiting for a pre-condition before its core logic begins.
        active: The document is in its main operational phase, actively processing events.
        terminated: The document has reached a final, conclusive state.",
            "type": "Text",
            "value": "terminated",
          },
          "type": "Status Completed",
        },
        "winners": [
          "playerB",
        ],
      }
    `)

    emittedEvents = results.emitted.map(event => blue.nodeToJson(blue.restoreInlineTypes(event), 'original'));
    expect(emittedEvents).toMatchInlineSnapshot(`
      [
        {
          "kind": "Round Completed",
          "results": {
            "answers": {
              "playerA": "A",
              "playerB": "A",
            },
            "correctOption": "A",
            "explanation": "Because 2+2=4",
            "pointsAwarded": {
              "playerA": 1,
              "playerB": 1,
            },
            "questionId": "id2",
            "roundIndex": 1,
            "scoreboard": {
              "playerA": 1,
              "playerB": 2,
            },
          },
          "type": "Event",
        },
        {
          "kind": "Game Completed",
          "scoreboard": {
            "playerA": 1,
            "playerB": 2,
          },
          "type": "Event",
          "winners": [
            "playerB",
          ],
        },
        {
          "op": "replace",
          "path": "/scoreboard",
          "type": "Document Update",
          "val": {
            "playerA": 1,
            "playerB": 2,
          },
        },
        {
          "op": "replace",
          "path": "/lastRoundResult",
          "type": "Document Update",
          "val": {
            "answers": {
              "playerA": "A",
              "playerB": "A",
            },
            "correctOption": "A",
            "explanation": "Because 2+2=4",
            "pointsAwarded": {
              "playerA": 1,
              "playerB": 1,
            },
            "questionId": "id2",
            "roundIndex": 1,
            "scoreboard": {
              "playerA": 1,
              "playerB": 2,
            },
          },
        },
        {
          "op": "replace",
          "path": "/phase",
          "type": "Document Update",
          "val": "BETWEEN_ROUNDS",
        },
        {
          "op": "remove",
          "path": "/currentQuestion",
          "type": "Document Update",
          "val": null,
        },
        {
          "op": "replace",
          "path": "/answers",
          "type": "Document Update",
          "val": {},
        },
        {
          "op": "replace",
          "path": "/status",
          "type": "Document Update",
          "val": {
            "mode": {
              "description": "Defines the high-level phase of the document's lifecycle. Must be one of:
        pending: The document is waiting for a pre-condition before its core logic begins.
        active: The document is in its main operational phase, actively processing events.
        terminated: The document has reached a final, conclusive state.",
              "type": "Text",
              "value": "terminated",
            },
            "type": "Status Completed",
          },
        },
        {
          "op": "replace",
          "path": "/winners",
          "type": "Document Update",
          "val": [
            "playerB",
          ],
        },
        {
          "op": "replace",
          "path": "/phase",
          "type": "Document Update",
          "val": "GAME_COMPLETED",
        },
      ]
    `)
  });
});
