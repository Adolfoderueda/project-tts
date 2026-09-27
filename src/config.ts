import { readFileSync } from 'node:fs';
import { z } from 'zod';

export interface ProjectConfig {
  id: string;
  name: string;
  baseURL: string;
}

export interface BridgeConfig {
  databasePath: string;
  projects: ProjectConfig[];
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const httpUrl = z.string().url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === 'http:' || protocol === 'https:';
}, 'baseURL must use http or https');

const bridgeConfigSchema = z.object({
  databasePath: z.string().min(1, 'databasePath is required'),
  projects: z.array(z.object({
    id: z.string().min(1, 'project id is required'),
    name: z.string().min(1, 'project name is required'),
    baseURL: httpUrl,
  })).min(1, 'at least one project is required'),
}).superRefine((config, context) => {
  const seenProjectIds = new Set<string>();

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
