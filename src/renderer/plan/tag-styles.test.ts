import { describe, expect, it } from 'vitest';
import type { Tag } from '../../core/model/project';
import { project } from '../../core/testing/project-builder';
import { paleColor, tagStylesOf } from './tag-styles';

const DESIGN: Tag = {
  id: 'design',
  name: 'Design',
  color: '#3366AA',
  representsPersonOrTeam: false,
};
const NEAR: Tag = { id: 'near', name: 'Near', color: '#3366AB', representsPersonOrTeam: false };

describe('tagStylesOf', () => {
  it('gives every tag its color, its pale color and a pattern for a tag too close to another', () => {
    const styles = tagStylesOf(project([], [], { tags: [DESIGN, NEAR] }));
    expect(styles.get('design')).toEqual({
      color: '#3366AA',
      pale: paleColor('#3366AA'),
      pattern: null,
    });
    expect(styles.get('near')?.pattern).not.toBeNull();
  });

  it('gives every tag a pattern when patterns are always shown', () => {
    const always = project([], [], {
      tags: [DESIGN],
      options: {
        criticalPathEnabled: false,
        dateConstraintsEnabled: false,
        alwaysShowPatterns: true,
      },
    });
    expect(tagStylesOf(always).get('design')?.pattern).not.toBeNull();
  });

  it('gives no style without a project, or when a color cannot be read', () => {
    expect(tagStylesOf(null).size).toBe(0);
    const broken = project([], [], { tags: [{ ...DESIGN, color: 'blue' }] });
    expect(tagStylesOf(broken).size).toBe(0);
  });
});

describe('paleColor', () => {
  it('mixes a color with white', () => {
    expect(paleColor('#000000', 0.5)).toBe('#808080');
    expect(paleColor('#FFFFFF')).toBe('#ffffff');
    expect(paleColor('#3366AA', 0)).toBe('#3366aa');
  });
});
