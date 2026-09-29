import type { ProjectConfig } from './config.js';
import type { CapturedEvent } from './events.js';
import type { EventStore } from './store.js';

export function selectEvent(
  store: Pick<EventStore, 'get'>,
  projects: readonly ProjectConfig[],
  id: string,
): { event: CapturedEvent; project: ProjectConfig } {
  const event = store.get(id);
  if (event === undefined) {
    throw new Error(`Unknown event ID: ${id}`);
  }

  const project = projects.find((candidate) => candidate.id === event.projectId);
  if (project === undefined || project.name !== event.projectName) {
    throw new Error(`Configured project does not match stored event: ${id}`);
  }

  return { event, project };
}
