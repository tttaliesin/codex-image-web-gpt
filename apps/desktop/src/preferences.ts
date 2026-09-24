import path from 'node:path';
import { readFileSync } from 'node:fs';
import { durableJson } from '../../../packages/storage/src/files';

// Choices live with the profile so an update or reinstall keeps them.
const preferencesFile = (profile: string) => path.join(profile, 'preferences.json');

export function readPreferences(profile: string): Record<string, unknown> {
  try {
    const value = JSON.parse(readFileSync(preferencesFile(profile), 'utf8'));
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

export async function savePreference(profile: string, key: string, value: unknown) {
  await durableJson(preferencesFile(profile), { ...readPreferences(profile), [key]: value });
}
