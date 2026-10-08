import { describe, expect, it } from 'vitest';
import { MAX_TAGS } from '../../core/limits';
import type { Project, Tag } from '../../core/model/project';
import { createSharedDocument } from '../../core/shared/shared-document';
import { openSharedSession } from '../../core/shared/shared-session';
import { project, summary, TEST_DOCUMENT_ID, workTask } from '../../core/testing/project-builder';
import { TAG_PALETTE } from '../../core/tags/tag-palette';
import { buildPlanOutline } from './plan-outline';
import {
  addTag,
  removeTag,
  renameTag,
  setTagColor,
  setTagRepresentsPerson,
  isSameColor,
  tagsByName,
  tagsInShownOrder,
  tasksUsingTag,
} from './tag-commands';
import type { EditContext } from './task-commands';

const DESIGN: Tag = {
  id: 'design',
  name: 'Design',
  color: '#2a78d6',
  representsPersonOrTeam: false,
};
const ALICE: Tag = { id: 'alice', name: 'Alice', color: '#eb6834', representsPersonOrTeam: true };
const PLAN = project(
  [
    summary('s'),
    workTask('a', { parentId: 's', tagId: 'design' }),
    workTask('b', { tagId: 'design' }),
    workTask('c', { tagId: 'alice' }),
  ],
  [],
  { tags: [DESIGN, ALICE] },
);

/** Builds the edit context of a plan, with its tags replaced when asked. */
function contextOf(tags: readonly Tag[] = PLAN.tags): EditContext {
  const plan: Project = { ...PLAN, tags };
  return {
    project: plan,
    outline: buildPlanOutline(plan.tasks, new Set()),
    createId: () => 'new',
    dayHours: 9,
  };
}

describe('addTag', () => {
  it('adds a category tag with the first free palette color and a free name', () => {
    expect(addTag(contextOf(), 'New tag')).toEqual({
      ok: true,
      value: [
        {
          type: 'putTag',
          tag: { id: 'new', name: 'New tag', color: TAG_PALETTE[2], representsPersonOrTeam: false },
        },
      ],
    });
    const named = [DESIGN, { ...ALICE, name: 'New tag' }, { ...ALICE, id: 'x', name: 'New tag 2' }];
    const added = addTag(contextOf(named), 'New tag');
    expect(added.ok && added.value[0]).toMatchObject({ tag: { name: 'New tag 3' } });
  });

  it('takes a color as used whatever its case', () => {
    const added = addTag(contextOf([{ ...DESIGN, color: '#2A78D6' }]), 'New tag');
    expect(added.ok && added.value[0]).toMatchObject({ tag: { color: TAG_PALETTE[1] } });
  });

  it('refuses a tag beyond the limit', () => {
    const full = Array.from({ length: MAX_TAGS }, (_unused, index) => ({
      ...DESIGN,
      id: `t${String(index)}`,
    }));
    expect(addTag(contextOf(full), 'New tag')).toEqual({ ok: false, error: 'TOO_MANY_TAGS' });
    expect(addTag(contextOf(full.slice(1)), 'New tag').ok).toBe(true);
  });

  it('cycles through the palette once every color is taken', () => {
    const full = TAG_PALETTE.map((color, index) => ({ ...DESIGN, id: `t${String(index)}`, color }));
    const added = addTag(contextOf([...full, { ...DESIGN, id: 'extra' }]), 'New tag');
    expect(added.ok && added.value[0]).toMatchObject({ tag: { color: TAG_PALETTE[1] } });
  });
});

describe('changing a tag', () => {
  it('renames a tag, refusing an empty name and the name of another tag', () => {
    expect(renameTag(contextOf(), 'design', ' Build ')).toEqual({
      ok: true,
      value: [{ type: 'putTag', tag: { ...DESIGN, name: 'Build' } }],
    });
    expect(renameTag(contextOf(), 'design', ' Design ')).toEqual({ ok: true, value: [] });
    expect(renameTag(contextOf(), 'design', '  ')).toEqual({
      ok: false,
      error: 'EMPTY_TAG_NAME',
    });
    expect(renameTag(contextOf(), 'design', 'Alice')).toEqual({
      ok: false,
      error: 'DUPLICATE_TAG_NAME',
    });
    expect(renameTag(contextOf(), 'gone', 'Build')).toEqual({ ok: false, error: 'NOT_POSSIBLE' });
  });

  it('gives a tag a color in lower case, and tells whether it represents a person', () => {
    expect(setTagColor(contextOf(), 'design', '#A0B0C0')).toEqual({
      ok: true,
      value: [{ type: 'putTag', tag: { ...DESIGN, color: '#a0b0c0' } }],
    });
    expect(setTagRepresentsPerson(contextOf(), 'design', true)).toEqual({
      ok: true,
      value: [{ type: 'putTag', tag: { ...DESIGN, representsPersonOrTeam: true } }],
    });
    expect(setTagColor(contextOf(), 'design', '#2A78D6')).toEqual({ ok: true, value: [] });
    expect(setTagRepresentsPerson(contextOf(), 'alice', true)).toEqual({ ok: true, value: [] });
    expect(setTagColor(contextOf(), 'gone', '#a0b0c0')).toEqual({
      ok: false,
      error: 'NOT_POSSIBLE',
    });
  });

  it('removes a tag that exists, and counts the tasks that use a tag', () => {
    expect(removeTag(contextOf(), 'design')).toEqual({
      ok: true,
      value: [{ type: 'removeTag', id: 'design' }],
    });
    expect(removeTag(contextOf(), 'gone')).toEqual({ ok: false, error: 'NOT_POSSIBLE' });
    expect(['design', 'alice', 'gone'].map((id) => tasksUsingTag(PLAN, id))).toEqual([2, 1, 0]);
  });
});

describe('tagsByName', () => {
  it('sorts tags by name in a language, then by identifier', () => {
    const tags = [
      { ...DESIGN, id: 'z', name: 'émile' },
      { ...DESIGN, id: 'b', name: 'Zoe' },
      { ...DESIGN, id: 'y', name: 'Emma' },
      { ...DESIGN, id: 'a', name: 'Zoe' },
    ];
    expect(tagsByName(tags, 'fr').map((tag) => tag.id)).toEqual(['z', 'y', 'a', 'b']);
  });
});

describe('comparing colors and keeping the order shown', () => {
  it('compares colors whatever their case', () => {
    expect([isSameColor('#2A78D6', '#2a78d6'), isSameColor('#2a78d6', '#2a78d7')]).toEqual([
      true,
      false,
    ]);
  });

  it('keeps the tags in the order first shown, gone ones left out and new ones at the end by name', () => {
    const tags = [
      { ...DESIGN, id: 'a', name: 'Zoe' },
      { ...DESIGN, id: 'b', name: 'Anna' },
      { ...DESIGN, id: 'n2', name: 'Paul' },
      { ...DESIGN, id: 'n1', name: 'Marc' },
    ];
    expect(tagsInShownOrder(tags, ['gone', 'a', 'b'], 'en').map((tag) => tag.id)).toEqual([
      'a',
      'b',
      'n1',
      'n2',
    ]);
  });
});

describe('a tag change applied to a session', () => {
  it('removes the tag from the tasks that used it', () => {
    const opened = openSharedSession(createSharedDocument(PLAN, TEST_DOCUMENT_ID));
    if (!opened.ok) {
      throw new Error(JSON.stringify(opened.error));
    }
    const edit = removeTag(contextOf(), 'design');
    expect(edit.ok && opened.value.applyAll(edit.value)).toEqual({ ok: true, value: undefined });
    const after = opened.value.project();
    expect(after.tags).toEqual([ALICE]);
    const tagOf = new Map(
      after.tasks.map((task) => [task.id, task.kind === 'summary' ? null : task.tagId]),
    );
    expect(['s', 'a', 'b', 'c'].map((id) => tagOf.get(id))).toEqual([null, null, null, 'alice']);
  });
});
