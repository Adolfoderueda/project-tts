import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { normalizeProjectDirectory } from './project-paths.js';

export type ChatLanguage = 'en' | 'es';

export interface TranslationConfig {
  model: 'gemma4:e2b';
  digest: string;
}

export interface ProjectConfig {
  id: string;
  name: string;
  directory: string;
  chatLanguage?: ChatLanguage;
}

export interface BridgeConfig {
  databasePath: string;
  projects: ProjectConfig[];
  translation?: TranslationConfig;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const absoluteProjectDirectory = z.string().min(1, 'project directory is required').refine((value) => {
  try {
    normalizeProjectDirectory(value);
    return true;
  } catch {
    return false;
  }
}, 'project directory must be absolute');

const bridgeConfigSchema = z.object({
  databasePath: z.string().min(1, 'databasePath is required'),
  translation: z.object({
    model: z.literal('gemma4:e2b'),
    digest: z.string().length(64).regex(/^[0-9a-f]+$/u, 'digest must be exactly 64 lowercase hexadecimal characters'),
  }).optional(),
  projects: z.array(z.object({
    id: z.string().min(1, 'project id is required'),
    name: z.string().min(1, 'project name is required'),
    directory: absoluteProjectDirectory,
    chatLanguage: z.enum(['en', 'es']).optional(),
  })).min(1, 'at least one project is required'),
}).superRefine((config, context) => {
  const seenProjectIds = new Set<string>();
  const seenProjectDirectories = new Set<string>();

  config.projects.forEach((project, index) => {
    if (seenProjectIds.has(project.id)) {
      context.addIssue({
        code: 'custom',
        message: `duplicate project id: ${project.id}`,
        path: ['projects', index, 'id'],
      });
      return;
    }

    seenProjectIds.add(project.id);

    let normalizedDirectory: string;
    try {
      normalizedDirectory = normalizeProjectDirectory(project.directory);
    } catch {
      return;
    }
    if (seenProjectDirectories.has(normalizedDirectory)) {
      context.addIssue({
        code: 'custom',
        message: `duplicate project directory: ${project.directory}`,
        path: ['projects', index, 'directory'],
      });
      return;
    }

    seenProjectDirectories.add(normalizedDirectory);
  });
});

export function loadConfig(path: string): BridgeConfig {
  let parsedJson: unknown;

  try {
    parsedJson = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`Unable to read configuration ${path}: ${message}`);
  }

  const result = bridgeConfigSchema.safeParse(parsedJson);
  if (!result.success) {
    throw new ConfigError(`Invalid configuration ${path}: ${z.prettifyError(result.error)}`);
  }

  return result.data;
}
