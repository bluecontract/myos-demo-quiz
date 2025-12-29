import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Blue } from '@blue-labs/language';
import { repository } from '@blue-repository/types';

const blue = new Blue({ repositories: [repository] });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const fixturesDir = __dirname;

export const loadMyosFixtureRaw = (file: string): string =>
  readFileSync(join(fixturesDir, file), 'utf8').trim();

export const loadMyosFixtureJson = (file: string): Record<string, unknown> =>
  JSON.parse(loadMyosFixtureRaw(file)) as Record<string, unknown>;

const resolveBlueJson = (value: unknown): unknown => {
  const node = blue.jsonValueToNode(value);
  return blue.nodeToJson(node, 'original');
};

export const resolveMyosFixturePayload = (payload: unknown): unknown => {
  if (!isRecord(payload)) {
    return payload;
  }

  const object = isRecord(payload.object) ? payload.object : undefined;
  if (!object) {
    return payload;
  }

  const resolvedObject: Record<string, unknown> = { ...object };

  if (object.document !== undefined) {
    resolvedObject.document = resolveBlueJson(object.document);
  }

  if (Array.isArray(object.emitted)) {
    resolvedObject.emitted = object.emitted.map(resolveBlueJson);
  }

  return {
    ...payload,
    object: resolvedObject
  };
};

export const loadMyosFixtureResolvedJson = (file: string): Record<string, unknown> =>
  resolveMyosFixturePayload(loadMyosFixtureJson(file)) as Record<string, unknown>;

export const loadMyosFixtureResolved = (file: string): string =>
  JSON.stringify(loadMyosFixtureResolvedJson(file));
