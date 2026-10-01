import type { ProjectConfig } from './config.js';
import { normalizeProjectDirectory } from './project-paths.js';

export function assertSessionLocation(session: unknown, project: ProjectConfig, sessionId: string): void {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error('OpenCode session ID is missing');
  }
  const expectedDirectory = normalizeProjectDirectory(project.directory);
  if (typeof session !== 'object' || session === null || !('id' in session) || session.id !== sessionId ||
    !('location' in session) || typeof session.location !== 'object' || session.location === null ||
    !('directory' in session.location) || typeof session.location.directory !== 'string') {
    throw new Error('OpenCode session ID or location could not be verified');
  }
  let actualDirectory: string;
  try {
    actualDirectory = normalizeProjectDirectory(session.location.directory);
  } catch {
    throw new Error('OpenCode session location could not be verified');
  }
  if (actualDirectory !== expectedDirectory) {
    throw new Error('OpenCode session location does not match the configured project');
  }
}
