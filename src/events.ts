import type { ProjectConfig } from './config.js';
import { normalizeProjectDirectory } from './project-paths.js';

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

interface AcceptedEvent {
  id: string;
  type: 'session.idle' | 'permission.asked' | 'permission.v2.asked' | 'session.error';
  data: { sessionID: string };
  location: { directory: string };
}

function asAcceptedEvent(event: unknown): AcceptedEvent | null {
  if (typeof event !== 'object' || event === null || !('type' in event) || !('data' in event) || !('location' in event) || !('id' in event)) {
    return null;
  }

  const candidate = event as { id: unknown; type: unknown; data: unknown; location: unknown };
  if (typeof candidate.id !== 'string' || candidate.id.length === 0) {
    return null;
  }

  if (candidate.type !== 'session.idle' && candidate.type !== 'permission.asked' && candidate.type !== 'permission.v2.asked' && candidate.type !== 'session.error') {
    return null;
  }

  if (typeof candidate.data !== 'object' || candidate.data === null || !('sessionID' in candidate.data)) {
    return null;
  }
  const sessionID = (candidate.data as { sessionID: unknown }).sessionID;
  if (typeof sessionID !== 'string' || sessionID.trim().length === 0) {
    return null;
  }

  if (typeof candidate.location !== 'object' || candidate.location === null || !('directory' in candidate.location)) {
    return null;
  }
  const directory = (candidate.location as { directory: unknown }).directory;
  if (typeof directory !== 'string' || directory.length === 0) {
    return null;
  }

  return candidate as AcceptedEvent;
}

export function mapOpenCodeEvent(projects: readonly ProjectConfig[], event: unknown, occurredAt: Date): CapturedEvent | null {
  const acceptedEvent = asAcceptedEvent(event);
  if (acceptedEvent === null) {
    return null;
  }

  let eventDirectory: string;
  try {
    eventDirectory = normalizeProjectDirectory(acceptedEvent.location.directory);
  } catch {
    return null;
  }

  const project = projects.find((configuredProject) => {
    try {
      return normalizeProjectDirectory(configuredProject.directory) === eventDirectory;
    } catch {
      return false;
    }
  });
  if (project === undefined) {
    return null;
  }

  const eventDetails = {
    'session.idle': { kind: 'turn-ended', summary: 'OpenCode turn finished' },
    'permission.asked': { kind: 'waiting-for-input', summary: 'OpenCode is waiting for input' },
    'permission.v2.asked': { kind: 'waiting-for-input', summary: 'OpenCode is waiting for input' },
    'session.error': { kind: 'error', summary: 'OpenCode session error' },
  } as const satisfies Record<AcceptedEvent['type'], Pick<CapturedEvent, 'kind' | 'summary'>>;

  const details = eventDetails[acceptedEvent.type];

  return {
    id: JSON.stringify([project.id, acceptedEvent.id]),
    projectId: project.id,
    projectName: project.name,
    sessionId: acceptedEvent.data.sessionID,
    kind: details.kind,
    occurredAt: occurredAt.toISOString(),
    summary: details.summary,
    rawEventType: acceptedEvent.type,
  };
}
