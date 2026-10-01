import { ConfigError, type ChatLanguage, type ProjectConfig } from './config.js';

export function resolveChatLanguage(project: ProjectConfig, override?: ChatLanguage): ChatLanguage {
  const language = override !== undefined ? override : project.chatLanguage;
  if (language === undefined) {
    throw new ConfigError('Chat language is required: set project chatLanguage or supply --chat-language en|es.');
  }
  if (language !== 'en' && language !== 'es') {
    throw new ConfigError('Unsupported chat language: use en or es.');
  }
  return language;
}
