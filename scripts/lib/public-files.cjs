const path = require('node:path');
// Individually reviewed UI assets; do not allow arbitrary screenshots or user images.
const reviewedImages = new Set([
  'apps/desktop/ui/icon.png',
  'assets/readme/workspace.png',
  'assets/readme/queue.png',
  'assets/readme/setup.png',
  'assets/readme/workspace-en.png',
  'assets/readme/queue-en.png',
  'assets/readme/setup-en.png',
]);

function pathIssues(name) {
  const normalized = name.replaceAll('\\', '/');
  const issues = [];
  if (/^docs(?:\/|$)/i.test(normalized) || /(^|\/)AGENTS(?:\.override)?\.md$/i.test(normalized))
    issues.push('internal-project-document');
  if (
    /(^|\/)(node_modules|dist|\.local|outputs|\.tooling-overlay|\.codex|\.agents|profile|profiles|artifacts|exports)(\/|$)/i.test(
      normalized,
    )
  )
    issues.push('private-or-generated-directory');
  if (
    /(^|\/)(\.env(?:\..+)?|mcp-config\.json|approved-[^/]+\.json)$/i.test(normalized) &&
    !normalized.endsWith('.env.example')
  )
    issues.push('local-configuration');
  if (
    /\.(?:enc|sqlite(?:-wal|-shm)?|db(?:-journal)?|pem|key|log|zip|exe|tmp|bak)$/i.test(normalized)
  )
    issues.push('private-or-build-file');
  if (/\.(?:png|jpe?g|webp|gif)$/i.test(normalized) && !reviewedImages.has(normalized))
    issues.push('image-needs-public-review');
  return issues;
}

function textIssues(text) {
  const patterns = [
    [
      'personal-home-path',
      /(?:[A-Z]:[\\/]+Users[\\/]+[\w.-]+[\\/]|\/home\/[\w.-]+\/|\/Users\/[\w.-]+\/)/i,
    ],
    ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
    [
      'credential',
      /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-(?:proj-)?[A-Za-z0-9_-]{32,}|xox[baprs]-[A-Za-z0-9-]{25,})\b/,
    ],
    ['literal-bearer', /Bearer\s+[A-Za-z0-9_-]{40,}/],
  ];
  return text
    .split(/\r?\n/)
    .flatMap((line, index) =>
      patterns
        .filter(([, pattern]) => pattern.test(line))
        .map(([kind]) => ({ kind, line: index + 1 })),
    );
}

function isText(name) {
  return (
    /\.(?:[cm]?js|ts|cs|json|md|ya?ml|toml|ps1|py|svg|html|css|lock|txt)$/.test(name) ||
    path.basename(name).startsWith('.')
  );
}

module.exports = { pathIssues, textIssues, isText };
