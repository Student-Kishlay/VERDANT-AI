import * as mockProvider from './mock-provider.js';
import * as groqProvider from './groq-provider.js';

// Picks the real provider only when explicitly configured with a key —
// otherwise the app works out of the box with zero external dependencies.
export function getProvider(cfg) {
  if (cfg.aiProvider === 'groq' && cfg.groqApiKey) {
    return { name: groqProvider.PROVIDER_NAME, generateReply: groqProvider.generateReply };
  }
  return { name: mockProvider.PROVIDER_NAME, generateReply: mockProvider.generateReply };
}
