import { MAX_TAGS } from '../../core/limits';
import type { Project, Tag, TagId } from '../../core/model/project';
import { failure, success } from '../../core/result';
import { nextPaletteColor, TAG_PALETTE } from '../../core/tags/tag-palette';
import type { Edit, EditContext } from './task-commands';

const FIRST_NUMBERED_COPY = 2;

/** Adds a category tag named after a base name, numbered when that name is taken, with the first palette color no tag has whatever its case, or the palette color matching the tag count when all are used, refusing a project that has as many tags as allowed. */
export function addTag(context: EditContext, baseName: string): Edit {
  const tags = context.project.tags;
  if (tags.length >= MAX_TAGS) {
    return failure('TOO_MANY_TAGS');
  }
  const used = new Set(tags.map((tag) => tag.color.toLowerCase()));
  const color = TAG_PALETTE.find((candidate) => !used.has(candidate));
  const tag: Tag = {
    id: context.createId(),
    name: freeName(tags, baseName),
    color: color ?? nextPaletteColor(tags.length),
    representsPersonOrTeam: false,
  };
  return success([{ type: 'putTag', tag }]);
}

/** Renames a tag with the trimmed text, refusing an empty name and a name another tag already has, case counting as in the CSV; this is a rule of the settings only, since a merge may still bring two tags of the same name. */
export function renameTag(context: EditContext, id: TagId, text: string): Edit {
  const name = text.trim();
  if (name === '') {
    return failure('EMPTY_TAG_NAME');
  }
  const taken = context.project.tags.some((tag) => tag.id !== id && tag.name === name);
  return taken ? failure('DUPLICATE_TAG_NAME') : changeTag(context, id, { name });
}

/** Gives a tag a color written as "#RRGGBB", stored in lower case like the palette, the shared session refusing any other text. */
export function setTagColor(context: EditContext, id: TagId, color: string): Edit {
  return changeTag(context, id, { color: color.toLowerCase() });
}

/** Sets whether a tag represents a person or a team, whose overlapping tasks are then reported as conflicts. */
export function setTagRepresentsPerson(
  context: EditContext,
  id: TagId,
  representsPersonOrTeam: boolean,
): Edit {
  return changeTag(context, id, { representsPersonOrTeam });
}

/** Deletes a tag, the shared session leaving the tasks that used it without a tag. */
export function removeTag(context: EditContext, id: TagId): Edit {
  return context.project.tags.some((tag) => tag.id === id)
    ? success([{ type: 'removeTag', id }])
    : failure('NOT_POSSIBLE');
}

/** Counts the tasks of a project that use a tag. */
export function tasksUsingTag(project: Project, id: TagId): number {
  return project.tasks.filter((task) => task.kind !== 'summary' && task.tagId === id).length;
}

/** Tells whether two colors written as "#RRGGBB" are the same, whatever their case. */
export function isSameColor(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/** Returns the tags sorted by name in the order of a language, ties kept in a fixed order by identifier. */
export function tagsByName(tags: readonly Tag[], locale: string): readonly Tag[] {
  const collator = new Intl.Collator(locale);
  return [...tags].sort(
    (left, right) => collator.compare(left.name, right.name) || collator.compare(left.id, right.id),
  );
}

/** Returns the tags in the order they were first shown, those added since at the end sorted by name, so that a row never moves while it is being edited. */
export function tagsInShownOrder(
  tags: readonly Tag[],
  shown: readonly TagId[],
  locale: string,
): readonly Tag[] {
  const byId = new Map(tags.map((tag) => [tag.id, tag]));
  const kept = shown.flatMap((id) => byId.get(id) ?? []);
  const known = new Set(shown);
  return [
    ...kept,
    ...tagsByName(
      tags.filter((tag) => !known.has(tag.id)),
      locale,
    ),
  ];
}

/** Changes some fields of a tag, changing nothing when they already have these values, and refusing a tag that no longer exists. */
function changeTag(context: EditContext, id: TagId, fields: Partial<Omit<Tag, 'id'>>): Edit {
  const tag = context.project.tags.find((candidate) => candidate.id === id);
  if (tag === undefined) {
    return failure('NOT_POSSIBLE');
  }
  const changed: Tag = { ...tag, ...fields };
  const same = (Object.keys(fields) as (keyof typeof fields)[]).every(
    (key) => changed[key] === tag[key],
  );
  return success(same ? [] : [{ type: 'putTag', tag: changed }]);
}

/** Returns a base name, or the base name followed by the first number that no tag has as its name. */
function freeName(tags: readonly Tag[], baseName: string): string {
  const names = new Set(tags.map((tag) => tag.name));
  let name = baseName;
  for (let number = FIRST_NUMBERED_COPY; names.has(name); number += 1) {
    name = `${baseName} ${String(number)}`;
  }
  return name;
}
