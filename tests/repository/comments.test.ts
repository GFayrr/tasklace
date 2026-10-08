import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const MAX_COMMENT_LENGTH = 250;
const CHECKED_FOLDERS = ['src', 'tests'];
const ROOT_FILES = /^[^/]+\.ts$/;
const SCRIPT_BLOCK = /<script[^>]*>([\s\S]*?)<\/script>/g;
const SENTENCE_BREAK = /[.!?]\s+[A-Z]/;
const SENTENCE_END = /[.!?]$/;
const DOC_COMMENT = /^\/\*\*([\s\S]*)\*\/$/;
const COMMENT_LINE_START = /^\s*\*? ?/gm;

/** Comments longer than the limit kept on purpose, by file and function, each with the reason it cannot be shorter without losing meaning. */
const LONG_COMMENTS: Readonly<Record<string, string>> = {
  'src/core/scheduling/schedule-project.ts:scheduleWithRequestedStarts':
    'states which requested starts are kept and that the schedule equals that of the project keeping only them (option A of 2026-09-29)',
  'src/main/close-flush.ts:flushBeforeClosing':
    'covers each state of a page asked to close: saved, crashed or not loaded, not responding (decisions A and B of 2026-10-03)',
  'src/main/file-tasks.ts:saveProject':
    'gives the order of the writes and the three outcomes callers rely on: file failed, local copy failed without file, success with or without copy',
  'src/main/local-copies.ts:readIndex':
    'tells how a missing, damaged or unmovable index is handled (decision D of 2026-10-03)',
  'src/main/log-file.ts:createLogFile':
    'tells how the log rotates, serializes its writes and behaves when it cannot be set aside (decision C of 2026-10-03)',
  'src/main/project-files.ts:saveProject':
    'states that saving automatically never opens a dialog and that a file written by Save as becomes the file of the window even when its copy failed',
  'src/renderer/plan/timeline-geometry.ts:timelineFrame':
    'lists every bound of the period, each decided on its own: anchors, minimum span, canvas limit and marks that give way',
  'src/renderer/project/project-files.ts:createProjectFiles':
    'sums up the guarantees of the file layer: one save and one action at a time, saving before switching, confirmed adoption',
  'src/renderer/schedule/scheduler.ts:createScheduler':
    'sums up the guarantees of the scheduler: latest result only, lazy start, worker replacement and retry limit',
};

interface CommentFinding {
  readonly place: string;
  readonly problem: 'missing' | 'severalSentences' | 'noFinalStop' | 'tooLong';
  readonly length?: number;
}

/** Lists the TypeScript files and Svelte components of the project that Git tracks or is about to track, declaration files excepted. */
function checkedFiles(): string[] {
  const output = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...CHECKED_FOLDERS, '.'],
    { encoding: 'utf8' },
  );
  return output
    .split('\0')
    .filter((path) => path.length > 0 && existsSync(path))
    .filter(
      (path) =>
        CHECKED_FOLDERS.some((folder) => path.startsWith(`${folder}/`)) || ROOT_FILES.test(path),
    )
    .filter(
      (path) => (path.endsWith('.ts') && !path.endsWith('.d.ts')) || path.endsWith('.svelte'),
    );
}

/** Returns the scripts of a file: the whole file for TypeScript, the script blocks of a Svelte component. */
function scriptsOf(path: string, text: string): string[] {
  if (!path.endsWith('.svelte')) {
    return [text];
  }
  return [...text.matchAll(SCRIPT_BLOCK)].map((match) => match[1] ?? '');
}

/** Returns the node whose comment documents a function, with its name, or null for a function value that is not a definition: a callback, an object member, or a variable that a test reassigns. */
function documentedNode(node: ts.Node): { readonly anchor: ts.Node; readonly name: string } | null {
  if (ts.isFunctionDeclaration(node) && node.body !== undefined) {
    return { anchor: node, name: node.name?.text ?? 'default' };
  }
  if (
    (ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node)) &&
    node.body !== undefined &&
    ts.isClassLike(node.parent)
  ) {
    return { anchor: node, name: `${node.parent.name?.text ?? 'class'}.${node.name.getText()}` };
  }
  if (ts.isConstructorDeclaration(node) && node.body !== undefined) {
    return { anchor: node, name: `${node.parent.name?.text ?? 'class'}.constructor` };
  }
  if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) {
    return null;
  }
  const value = node.initializer;
  const isFunctionValue =
    value !== undefined && (ts.isArrowFunction(value) || ts.isFunctionExpression(value));
  const isConstant =
    ts.isVariableDeclarationList(node.parent) && (node.parent.flags & ts.NodeFlags.Const) !== 0;
  if (!isFunctionValue || !isConstant) {
    return null;
  }
  const statement = node.parent.parent;
  return { anchor: ts.isVariableStatement(statement) ? statement : node, name: node.name.text };
}

/** Returns the text of the documentation comment just before a node, without its markers, or null when there is none. */
function docCommentOf(script: string, anchor: ts.Node): string | null {
  const ranges = ts.getLeadingCommentRanges(script, anchor.getFullStart()) ?? [];
  const last = ranges.at(-1);
  const raw = last === undefined ? '' : script.slice(last.pos, last.end);
  const body = DOC_COMMENT.exec(raw)?.[1];
  return body === undefined
    ? null
    : body.replace(COMMENT_LINE_START, ' ').replace(/\s+/g, ' ').trim();
}

/** Tells what is wrong with the comment of a function, or null when it is one sentence of reasonable length or a long one kept on purpose. */
function commentProblem(place: string, comment: string | null): CommentFinding | null {
  if (comment === null || comment.length === 0) {
    return { place, problem: 'missing' };
  }
  if (SENTENCE_BREAK.test(comment)) {
    return { place, problem: 'severalSentences' };
  }
  if (!SENTENCE_END.test(comment)) {
    return { place, problem: 'noFinalStop' };
  }
  if (comment.length > MAX_COMMENT_LENGTH && !Object.hasOwn(LONG_COMMENTS, place)) {
    return { place, problem: 'tooLong', length: comment.length };
  }
  return null;
}

/** Lists the comment of every function of a script, by its place in a file, null standing for a missing comment. */
function functionComments(fileName: string, script: string): (readonly [string, string | null])[] {
  const source = ts.createSourceFile(
    fileName,
    script,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const comments: (readonly [string, string | null])[] = [];
  /** Records the comment of each function met while walking the tree. */
  const visit = (node: ts.Node): void => {
    const documented = documentedNode(node);
    if (documented !== null) {
      comments.push([`${fileName}:${documented.name}`, docCommentOf(script, documented.anchor)]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return comments;
}

/** Lists the problems of the comments of every function of a script, named after a file. */
function commentFindings(fileName: string, script: string): CommentFinding[] {
  return functionComments(fileName, script).flatMap(([place, comment]) => {
    const problem = commentProblem(place, comment);
    return problem === null ? [] : [problem];
  });
}

describe('comments of the functions', () => {
  const files = checkedFiles();
  const comments = files.flatMap((path) =>
    scriptsOf(path, readFileSync(path, 'utf8')).flatMap((script) => functionComments(path, script)),
  );

  it('finds the functions to check', () => {
    expect(comments.length).toBeGreaterThan(0);
  });

  it(`gives every function, inner functions included, one sentence of at most ${String(MAX_COMMENT_LENGTH)} characters unless kept on purpose`, () => {
    const findings = comments.flatMap(([place, comment]) => {
      const problem = commentProblem(place, comment);
      return problem === null ? [] : [problem];
    });
    expect(findings).toEqual([]);
  });

  it('keeps no exception for a comment that is gone or no longer too long', () => {
    const lengths = new Map(comments.map(([place, comment]) => [place, comment?.length ?? 0]));
    const stale = Object.keys(LONG_COMMENTS).filter(
      (place) => (lengths.get(place) ?? 0) <= MAX_COMMENT_LENGTH,
    );
    expect(stale).toEqual([]);
  });

  it('catches a missing comment, several sentences, a missing stop and a comment too long', () => {
    const long = 'a'.repeat(MAX_COMMENT_LENGTH);
    const script = [
      'function bare(): void {}',
      '/** Does one thing. Then another. */',
      'function twice(): void {}',
      '/** Does one thing */',
      'function unfinished(): void {}',
      `/** Does ${long}. */`,
      'function verbose(): void {}',
      '/** Does one thing. */',
      'function fine(): void {',
      '  const inner = (): void => undefined;',
      '  [1].map((value) => value);',
      '}',
    ].join('\n');
    expect(commentFindings('sample.ts', script)).toEqual([
      { place: 'sample.ts:bare', problem: 'missing' },
      { place: 'sample.ts:twice', problem: 'severalSentences' },
      { place: 'sample.ts:unfinished', problem: 'noFinalStop' },
      { place: 'sample.ts:verbose', problem: 'tooLong', length: `Does ${long}.`.length },
      { place: 'sample.ts:inner', problem: 'missing' },
    ]);
  });
});
