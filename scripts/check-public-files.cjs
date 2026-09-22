// Scan only Git's publication candidates. Never read ignored profiles or print matched secrets.
const { execFileSync } = require('node:child_process');
const { readFileSync, lstatSync } = require('node:fs');
const path = require('node:path');
const { pathIssues, textIssues, isText } = require('./lib/public-files.cjs');
const root = path.resolve(__dirname, '..');
function git(args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
}
try {
  const files = [
    ...new Set(
      git(['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
        .split('\0')
        .filter(Boolean),
    ),
  ].sort();
  const findings = [];
  for (const file of files) {
    const absolute = path.join(root, file);
    let stat;
    try {
      stat = lstatSync(absolute);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    for (const kind of pathIssues(file)) findings.push({ file, kind });
    if (stat.isSymbolicLink() || !stat.isFile()) findings.push({ file, kind: 'nonregular-file' });
    else if (stat.size > 1024 * 1024) findings.push({ file, kind: 'large-file-needs-review' });
    else if (isText(file))
      for (const issue of textIssues(readFileSync(absolute, 'utf8')))
        findings.push({ file, ...issue });
  }
  console.log(
    JSON.stringify(
      { result: findings.length ? 'failed' : 'passed', files: files.length, findings },
      null,
      2,
    ),
  );
  process.exitCode = findings.length ? 1 : 0;
} catch {
  console.error('PUBLIC_FILE_CHECK_FAILED');
  process.exitCode = 1;
}
