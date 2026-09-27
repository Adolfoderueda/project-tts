import { randomUUID } from 'node:crypto';
import type { Event as OpenCodeEvent } from '@opencode-ai/sdk';
import type { ProjectConfig } from './config.js';

export type { ProjectConfig } from './config.js';

export interface CapturedEvent {
  id: string;
  projectId: string;
  projectName: string;
  sessionId: string;
  kind: 'turn-ended' | 'waiting-for-input' | 'error';
  occurredAt: string;
  summary: string;
  rawEventType: string;
}

type AcceptedEvent = Extract<OpenCodeEvent, { type: 'session.idle' | 'permission.updated' | 'session.error' }>;

function getSessionId(event: AcceptedEvent): string | null {
  const sessionId = event.properties.sessionID;
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null;
}

function asAcceptedEvent(event: unknown): AcceptedEvent | null {
  if (typeof event !== 'object' || event === null || !('type' in event) || !('properties' in event)) {
    return null;
  }

  const candidate = event as { type: unknown; properties: unknown };
  if (typeof candidate.properties !== 'object' || candidate.properties === null) {
    return null;
  }

  if (candidate.type === 'session.idle' || candidate.type === 'permission.updated' || candidate.type === 'session.error') {
    return candidate as AcceptedEvent;
  }

  return null;
}

export function mapOpenCodeEvent(project: ProjectConfig, event: unknown, occurredAt: Date, sourceEventId?: string): CapturedEvent | null {
  const acceptedEvent = asAcceptedEvent(event);
  if (acceptedEvent === null) {
    return null;
  }

  const sessionId = getSessionId(acceptedEvent);
  if (sessionId === null) {
    return null;
  }

  const eventDetails = {
    'session.idle': { kind: 'turn-ended', summary: 'OpenCode turn finished' },
    'permission.updated': { kind: 'waiting-for-input', summary: 'OpenCode is waiting for input' },
    'session.error': { kind: 'error', summary: 'OpenCode session error' },
  } as const satisfies Record<AcceptedEvent['type'], Pick<CapturedEvent, 'kind' | 'summary'>>;

  const details = eventDetails[acceptedEvent.type];

  return {
    id: typeof sourceEventId === 'string' && sourceEventId.length > 0 ? JSON.stringify([project.id, sourceEventId]) : randomUUID(),
    projectId: project.id,
    projectName: project.name,
    sessionId,
    kind: details.kind,
    occurredAt: occurredAt.toISOString(),
    summary: details.summary,
    rawEventType: acceptedEvent.type,
  };
}
