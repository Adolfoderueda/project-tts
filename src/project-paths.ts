import path from 'node:path';

export function normalizeProjectDirectory(directory: string, platform: NodeJS.Platform = process.platform): string {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  if (!pathApi.isAbsolute(directory)) {
    throw new TypeError('project directory must be absolute');
  }

  const normalized = pathApi.normalize(directory);
  const root = pathApi.parse(normalized).root;
  const trailingSeparators = platform === 'win32' ? /[\\/]+$/u : /\/+$/u;
  const withoutTrailingSeparators = normalized.replace(trailingSeparators, '');
  const result = withoutTrailingSeparators.length < root.length ? root : withoutTrailingSeparators;

  return platform === 'win32' ? result.toLowerCase() : result;
}
