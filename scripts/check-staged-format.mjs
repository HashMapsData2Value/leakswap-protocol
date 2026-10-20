import { execFileSync } from 'node:child_process';
import path from 'node:path';
import * as prettier from 'prettier';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
process.chdir(root);
const base = process.env.FORMAT_BASE_REF ? [process.env.FORMAT_BASE_REF] : [];
const files = execFileSync('git', [
  'diff',
  '--cached',
  '--name-only',
  '--diff-filter=ACMR',
  '-z',
  ...base,
  '--',
])
  .toString('utf8')
  .split('\0')
  .filter(Boolean);
let failed = false;
for (const file of files) {
  const info = await prettier.getFileInfo(file, { ignorePath: ['.gitignore', '.prettierignore'] });
  if (info.ignored || (!info.inferredParser && !file.endsWith('.rs'))) continue;
  const source = execFileSync('git', ['show', `:${file}`], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  let valid;
  if (file.endsWith('.rs')) {
    const formatted = execFileSync(
      'rustfmt',
      ['--edition', '2021', '--emit', 'stdout', '--config', 'skip_children=true'],
      { input: source, encoding: 'utf8' },
    );
    valid = source === formatted;
  } else {
    const options = await prettier.resolveConfig(path.resolve(file), { editorconfig: true });
    valid = await prettier.check(source, { ...options, filepath: file });
  }
  if (!valid) {
    console.error(`Unformatted staged file: ${file}`);
    failed = true;
  }
}
if (failed) {
  console.error(
    'Run npm run format, review the result, and stage the intended changes again. No files or staged content were modified.',
  );
  process.exitCode = 1;
}
