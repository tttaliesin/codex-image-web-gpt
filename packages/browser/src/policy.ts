export function allowedNavigation(raw: string, fixtureOrigin?: string): boolean {
  try {
    const url = new URL(raw);
    if (fixtureOrigin && url.origin === fixtureOrigin) return true;
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      [
        'chatgpt.com',
        'auth.openai.com',
        'auth0.openai.com',
        'accounts.google.com',
        'appleid.apple.com',
        'login.live.com',
        'login.microsoftonline.com',
      ].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

export function allowedDownload(raw: string, fixtureOrigin?: string): boolean {
  try {
    const url = new URL(raw);
    if (fixtureOrigin && url.origin === fixtureOrigin) return true;
    if (url.protocol === 'blob:') return url.origin === (fixtureOrigin ?? 'https://chatgpt.com');
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      (url.hostname === 'chatgpt.com' ||
        url.hostname === 'files.oaiusercontent.com' ||
        url.hostname.endsWith('.oaiusercontent.com'))
    );
  } catch {
    return false;
  }
}

export function conversationUrl(raw: string, fixtureOrigin?: string): boolean {
  try {
    const url = new URL(raw);
    return fixtureOrigin
      ? url.origin === fixtureOrigin &&
          /^\/c\/[a-zA-Z0-9-]+$/.test(url.pathname) &&
          !url.search &&
          !url.hash
      : url.origin === 'https://chatgpt.com' &&
          /^\/c\/[a-zA-Z0-9-]+$/.test(url.pathname) &&
          !url.search &&
          !url.hash;
  } catch {
    return false;
  }
}
