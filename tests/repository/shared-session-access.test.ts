import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const GUARDED_NAMES: ReadonlySet<string> = new Set([
  'sessionDocument',
  'LOCAL_ORIGIN',
  'REMOTE_ORIGIN',
  'REPAIR_ORIGIN',
]);
const GUARDED_MODULE = /(^|\/)shared\/(shared-session|shared-document)$/;
const ALLOWED_PLACES = [/^src\/core\/shared\//, /^src\/core\/testing\//, /\.test\.ts$/];
const SCRIPT_BLOCK = /<script[^>]*>([\s\S]*?)<\/script>/g;

/** Lists the TypeScript and Svelte files of the source that are not tests. */
function sourceFiles(): string[] {
  const output = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'src'],
    { encoding: 'utf8' },
  );
  return output.split('\0').filter((path) => path.endsWith('.ts') || path.endsWith('.svelte'));
}

/** Returns the names a piece of TypeScript imports from the shared session or the shared document, of those kept for the shared model. */
function guardedImports(code: string): string[] {
  const file = ts.createSourceFile('code.ts', code, ts.ScriptTarget.Latest);
  return file.statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      return [];
    }
    const bindings = statement.importClause?.namedBindings;
    if (!GUARDED_MODULE.test(statement.moduleSpecifier.text) || bindings === undefined) {
      return [];
    }
    return ts.isNamedImports(bindings)
      ? bindings.elements
          .map((element) => (element.propertyName ?? element.name).text)
          .filter((name) => GUARDED_NAMES.has(name))
      : ['*'];
  });
}

/** Returns the TypeScript of a source file, the scripts alone for a Svelte component. */
function codeOf(path: string): string {
  const text = readFileSync(path, 'utf8');
  return path.endsWith('.svelte')
    ? [...text.matchAll(SCRIPT_BLOCK)].map((match) => match[1] ?? '').join('\n')
    : text;
}

describe('access to the document behind a shared session', () => {
  it('finds the names kept for the shared model in an import, renamed or whole', () => {
    expect(
      guardedImports(
        [
          "import { sessionDocument as raw, type SharedSession } from '../core/shared/shared-session';",
          "import { LOCAL_ORIGIN } from '../../core/shared/shared-document';",
          "import * as shared from './shared/shared-document';",
          "import { readDocumentId } from '../core/shared/shared-document';",
        ].join('\n'),
      ),
    ).toEqual(['sessionDocument', 'LOCAL_ORIGIN', '*']);
  });

  it('is kept to the shared model and the tests, so that nothing else writes into a session without its checks and repairs', () => {
    const misuses = sourceFiles()
      .filter((path) => !ALLOWED_PLACES.some((place) => place.test(path)))
      .flatMap((path) => guardedImports(codeOf(path)).map((name) => `${path}: ${name}`));
    expect(misuses).toEqual([]);
  });
});
