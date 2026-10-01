import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, test } from 'vitest';
import type { ChatLanguage, ProjectConfig } from '../src/config.js';
import { resolveChatLanguage } from '../src/chat-language.js';

const project: ProjectConfig = {
  id: 'alpha',
  name: 'Alpha',
  directory: join(tmpdir(), 'project-tts-language-alpha'),
};

describe('resolveChatLanguage', () => {
  test.each(['en', 'es'] as const)('uses declared project language %s', (chatLanguage) => {
    expect(resolveChatLanguage({ ...project, chatLanguage })).toBe(chatLanguage);
  });

  test('command override takes precedence without mutating the project', () => {
    expect(resolveChatLanguage({ ...project, chatLanguage: 'en' }, 'es')).toBe('es');
    const configuredProject: ProjectConfig = { ...project, chatLanguage: 'en' };
    resolveChatLanguage(configuredProject, 'es');
    expect(configuredProject.chatLanguage).toBe('en');
  });

  test('override supplies a missing project language', () => {
    expect(resolveChatLanguage(project, 'en')).toBe('en');
  });

  test('fails when neither project nor override declares a language', () => {
    expect(() => resolveChatLanguage(project)).toThrow(/language/iu);
  });

  test('rejects unsupported project language at runtime', () => {
    expect(() => resolveChatLanguage({ ...project, chatLanguage: 'fr' as ChatLanguage })).toThrow(/language/iu);
  });

  test('rejects unsupported override instead of falling back to the project', () => {
    expect(() => resolveChatLanguage({ ...project, chatLanguage: 'en' }, 'fr' as ChatLanguage)).toThrow(/language/iu);
  });
});
