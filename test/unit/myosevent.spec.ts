/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/ban-ts-comment */
import { describe, expect, it } from 'vitest';
import { Blue } from '@blue-labs/language';
import { repository } from '@blue-repository/types';
import { loadMyosFixtureResolved } from '../fixtures/myos';

const blue = new Blue({
  repositories: [repository]
});

const myosEventString = loadMyosFixtureResolved('document-updated-event_round-requested.json');

describe('Parse MyOS Event', () => {
  it('should parse MyOS Event', () => {
    const myosEvent = JSON.parse(myosEventString);
    expect(myosEvent.type).toBe('DOCUMENT_EPOCH_ADVANCED');
    const epoch = myosEvent.object;
    const documentNode = blue.jsonValueToNode(epoch.document);
    // @ts-ignore mismatch between Blue inference and runtime shape is acceptable in test
    const emittedEventsNodes = epoch.emitted.map(event => blue.jsonValueToNode(event));
    // @ts-ignore
    const { name, description, contracts, ...state } = blue.nodeToJson(
      blue.restoreInlineTypes(documentNode),
      'original'
    );
    // @ts-ignore
    const emittedEvents = emittedEventsNodes.map(event =>
      blue.nodeToJson(blue.restoreInlineTypes(event), 'original')
    );

    expect(state).toMatchInlineSnapshot(`
      {
        "categories": [
          "History",
          "Science",
        ],
        "level": 1,
        "roundIndex": 0,
        "roundsTotal": 2,
        "status": {
          "type": "Conversation/Status In Progress",
        },
      }
    `);
    expect(emittedEvents).toMatchInlineSnapshot(`
      [
        {
          "type": "Core/Document Processing Initiated",
        },
        {
          "kind": "Status Change",
          "status": {
            "type": "Conversation/Status In Progress",
          },
          "type": "Conversation/Event",
        },
        {
          "kind": "Round Requested",
          "nextRoundIndex": 0,
          "type": "Conversation/Event",
        },
        {
          "op": "replace",
          "path": "/status",
          "type": "Core/Document Update",
          "val": {
            "type": "Conversation/Status In Progress",
          },
        },
      ]
    `);
  });
});
