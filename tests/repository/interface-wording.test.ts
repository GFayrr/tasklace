import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const MESSAGES_PATH = 'src/renderer/locales/en.json';
const QUARTER_HOUR_TIME = 'on a quarter hour (:00, :15, :30 or :45)';
const QUARTER_HOUR_DURATION = 'a whole number of quarter hours';
const QUARTER_HOUR = /quarter hours?/gi;
const AVOIDED_WORDING: readonly (readonly [RegExp, string])[] = [
  [/\bcomput(e|es|ed|ing|ation)\b/i, 'the dates are “worked out”, not computed'],
  [/\bcalculat(e|es|ed|ing|ion)\b/i, 'the dates are “worked out”, not calculated'],
  [/\bplease\b/i, 'messages say what to do without “please”'],
  [/\b\w+n't\b/i, 'messages write words in full, as “do not”'],
];

/** Lists every text of a translation file with the path of its key. */
function textsOf(value: unknown, path = ''): (readonly [string, string])[] {
  if (typeof value === 'string') {
    return [[path, value]];
  }
  if (typeof value !== 'object' || value === null) {
    return [];
  }
  return Object.entries(value).flatMap(([key, child]) =>
    textsOf(child, path === '' ? key : `${path}.${key}`),
  );
}

/** Lists where a text words things the way the interface avoids, with the reason. */
function wordingProblems(path: string, text: string): string[] {
  const problems = AVOIDED_WORDING.filter(([pattern]) => pattern.test(text)).map(
    ([, reason]) => `${path}: ${reason}`,
  );
  const mentions = text.match(QUARTER_HOUR)?.length ?? 0;
  const agreed =
    text.split(QUARTER_HOUR_TIME).length - 1 + text.split(QUARTER_HOUR_DURATION).length - 1;
  if (mentions !== agreed) {
    problems.push(
      `${path}: quarter hours are written “${QUARTER_HOUR_TIME}” or “${QUARTER_HOUR_DURATION}”`,
    );
  }
  return problems;
}

describe('wording of the interface', () => {
  const texts = textsOf(JSON.parse(readFileSync(MESSAGES_PATH, 'utf8')));

  it('finds the texts to check', () => {
    expect(texts.length).toBeGreaterThan(0);
  });

  it('keeps one vocabulary in every text of the interface', () => {
    expect(texts.flatMap(([path, text]) => wordingProblems(path, text))).toEqual([]);
  });

  it('catches each wording the interface avoids', () => {
    expect(wordingProblems('a', 'The schedule could not be computed.')).toEqual([
      'a: the dates are “worked out”, not computed',
    ]);
    expect(wordingProblems('b', 'Please try again.')).toEqual([
      'b: messages say what to do without “please”',
    ]);
    expect(wordingProblems('c', "Don't save")).toEqual([
      'c: messages write words in full, as “do not”',
    ]);
    expect(wordingProblems('d', 'Times go by quarter hours.')).toEqual([
      `d: quarter hours are written “${QUARTER_HOUR_TIME}” or “${QUARTER_HOUR_DURATION}”`,
    ]);
    expect(wordingProblems('e', `Write 08:30, ${QUARTER_HOUR_TIME}.`)).toEqual([]);
    expect(wordingProblems('f', `It has to be ${QUARTER_HOUR_DURATION}.`)).toEqual([]);
    expect(wordingProblems('g', 'The dates were calculated.')).toEqual([
      'g: the dates are “worked out”, not calculated',
    ]);
  });
});
