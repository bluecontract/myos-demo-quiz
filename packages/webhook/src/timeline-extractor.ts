const CHANNEL_PATHS: Array<Array<string>> = [
  ['contracts', 'adminChannel', 'timelineId'],
  ['contracts', 'playerAChannel', 'timelineId'],
  ['contracts', 'playerBChannel', 'timelineId']
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function extractTimelineIds(snapshot: unknown): string[] {
  const ids = new Set<string>();
  if (!snapshot || typeof snapshot !== 'object') {
    return [];
  }

  const asRecord = snapshot as Record<string, unknown>;

  const snapshotIds = readArray(asRecord.timelineIds);
  snapshotIds.forEach(id => ids.add(id));

  const doc = deriveDocument(asRecord);

  for (const path of CHANNEL_PATHS) {
    const value = lookup(doc, path);
    const timelineId = coerceTimelineId(value);
    if (timelineId) {
      ids.add(timelineId);
    }
  }

  return Array.from(ids);
}

function deriveDocument(snapshot: Record<string, unknown>): Record<string, unknown> {
  const doc = snapshot.document;
  if (isRecord(doc)) {
    return doc;
  }
  return snapshot;
}

function lookup(source: unknown, segments: string[]): unknown {
  let current: unknown = source;
  for (const segment of segments) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function coerceTimelineId(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }

  if (isRecord(value)) {
    const raw = value.value;
    if (typeof raw === 'string' && raw.trim()) {
      return raw.trim();
    }
  }

  return undefined;
}

function readArray(source: unknown): string[] {
  if (!Array.isArray(source)) {
    return [];
  }
  return source
    .map(item => (typeof item === 'string' ? item.trim() : undefined))
    .filter((value): value is string => Boolean(value));
}
