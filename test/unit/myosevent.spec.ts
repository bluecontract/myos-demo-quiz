/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/ban-ts-comment */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Blue } from '@blue-labs/language';
import { repository as coreRepository } from '@blue-repository/core-dev';
import { repository as myosRepository } from '@blue-repository/myos-dev';

const blue = new Blue({
  repositories: [coreRepository, myosRepository]
});

const myosEventString = readFileSync(
  join(__dirname, '..', 'fixtures', 'myos', 'document-updated-event_round-requested.json'),
  'utf8'
).trim();

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
          "type": "Status In Progress",
        },
      }
    `);
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
  });
});
