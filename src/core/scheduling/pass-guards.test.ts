import { describe, expect, it } from 'vitest';
import type { Project } from '../model/project';
import { unwrap } from '../testing/arbitraries';
import { compileOrThrow } from '../testing/civil-time';
import { link, milestone, project, splitTask, workTask } from '../testing/project-builder';
import { END_PROJECT_HOUR } from '../time';
import { runBackwardPass } from './backward-pass';
import type { DependencyGraph, ScheduleUnit } from './dependency-graph';
import { runForwardPass, type PlacementsByIndex, type SchedulingContext } from './forward-pass';
import { analyzeProjectStructure } from './project-structure';

const PLAN: Project = project(
  [
    workTask('a'),
    splitTask('b', [
      [7, 0],
      [7, 1],
    ]),
    milestone('m'),
  ],
  [link('a', 'b'), link('b', 'm')],
);
const INVALID = 'INVALID_INSTANT';

/** Builds the scheduling context, the dependency graph and the early placements of a project. */
function prepared(plan: Project = PLAN) {
  const context: SchedulingContext = {
    calendar: compileOrThrow(plan.calendar),
    projectStart: plan.startDate,
    dateConstraintsEnabled: true,
  };
  const { graph, tasks } = unwrap(analyzeProjectStructure(plan));
  const { placements } = unwrap(runForwardPass(context, graph));
  return { context, graph, placements, tasks };
}

/** Returns the unit of a task block in a graph, failing the test when it is missing. */
function unitOf(graph: DependencyGraph, taskId: string, block = 0): ScheduleUnit {
  const unit = graph.units.find((each) => each.task.id === taskId && each.block === block);
  if (unit === undefined) {
    throw new Error(`Missing unit ${taskId}#${String(block)}`);
  }
  return unit;
}

/** Returns a graph whose order leaves out one unit, as if it had never been placed. */
function withoutInOrder(graph: DependencyGraph, unit: ScheduleUnit): DependencyGraph {
  return { ...graph, order: graph.order.filter((each) => each.index !== unit.index) };
}

/** Returns placements in which one task has an instant outside the plannable range. */
function withBrokenPlacement(
  placements: PlacementsByIndex,
  taskIndex: number,
  part: 'start' | 'end',
): PlacementsByIndex {
  return placements.map((placement, index) => {
    if (index !== taskIndex || placement === undefined) {
      return placement;
    }
    const segments = placement.segments.map((segment) => ({
      ...segment,
      [part]: END_PROJECT_HOUR,
    }));
    return { ...placement, [part]: END_PROJECT_HOUR, segments };
  });
}

describe('the forward pass facing inconsistent inputs', () => {
  it('refuses a block placed before the previous block of its task', () => {
    const { context, graph } = prepared();
    const placed = runForwardPass(context, withoutInOrder(graph, unitOf(graph, 'b', 0)));
    expect(placed).toEqual({ ok: false, error: { code: INVALID, taskId: 'b' } });
  });

  it('refuses a block placed before what it waits for', () => {
    const { context, graph } = prepared();
    const placed = runForwardPass(context, withoutInOrder(graph, unitOf(graph, 'a')));
    expect(placed).toEqual({ ok: false, error: { code: INVALID, taskId: 'b' } });
  });

  it('refuses a later block that its task does not have', () => {
    const { context, graph } = prepared();
    const second = unitOf(graph, 'b', 1);
    const shortened = {
      ...second.task,
      segments: second.task.kind === 'task' ? second.task.segments.slice(0, 1) : [],
    };
    const units = graph.units.map((unit) =>
      unit.index === second.index ? { ...unit, task: shortened } : unit,
    );
    const order = graph.order.map((unit) => units[unit.index] ?? unit);
    const placed = runForwardPass(context, { ...graph, units, order });
    expect(placed).toEqual({ ok: false, error: { code: INVALID, taskId: 'b' } });
  });

  it('refuses to put together a split task whose first block is unknown', () => {
    const { context, graph } = prepared();
    const taskIndex = unitOf(graph, 'b').taskIndex;
    const firstUnitOfTask = graph.firstUnitOfTask.map((first, index) =>
      index === taskIndex ? undefined : first,
    );
    const placed = runForwardPass(context, { ...graph, firstUnitOfTask });
    expect(placed).toEqual({ ok: false, error: { code: INVALID, taskId: 'b' } });
  });
});

describe('the backward pass facing inconsistent inputs', () => {
  it('refuses a block whose next block has no latest placement', () => {
    const { context, graph, placements } = prepared();
    const floats = runBackwardPass(
      context,
      withoutInOrder(graph, unitOf(graph, 'b', 1)),
      placements,
    );
    expect(floats).toEqual({ ok: false, error: { code: INVALID, taskId: 'b' } });
  });

  it('refuses a block whose successor has no latest placement', () => {
    const { context, graph, placements } = prepared();
    const floats = runBackwardPass(context, withoutInOrder(graph, unitOf(graph, 'm')), placements);
    expect(floats).toEqual({ ok: false, error: { code: INVALID, taskId: 'b' } });
  });

  it('refuses a task without early placement or without a known first block', () => {
    const { context, graph, placements } = prepared();
    const taskIndex = unitOf(graph, 'a').taskIndex;
    const missing = placements.map((placement, index) =>
      index === taskIndex ? undefined : placement,
    );
    expect(runBackwardPass(context, graph, missing)).toEqual({
      ok: false,
      error: { code: INVALID, taskId: 'a' },
    });
    const firstUnitOfTask = graph.firstUnitOfTask.map((first, index) =>
      index === taskIndex ? undefined : first,
    );
    expect(runBackwardPass(context, { ...graph, firstUnitOfTask }, placements)).toEqual({
      ok: false,
      error: { code: INVALID, taskId: 'a' },
    });
    const beyond = graph.firstUnitOfTask.map((first, index) =>
      index === taskIndex ? graph.units.length : first,
    );
    expect(runBackwardPass(context, { ...graph, firstUnitOfTask: beyond }, placements)).toEqual({
      ok: false,
      error: { code: INVALID, taskId: 'a' },
    });
  });

  it('refuses a successor without early placement when measuring free float', () => {
    const { context, graph, placements } = prepared();
    const taskIndex = unitOf(graph, 'm').taskIndex;
    const missing = placements.map((placement, index) =>
      index === taskIndex ? undefined : placement,
    );
    const floats = runBackwardPass(context, graph, missing);
    expect(floats.ok).toBe(false);
    expect(!floats.ok && floats.error.code).toBe(INVALID);
  });

  it.each(['start', 'end'] as const)('reports an early %s outside the plannable range', (part) => {
    const { context, graph, placements } = prepared();
    for (const taskId of ['a', 'm']) {
      const broken = withBrokenPlacement(placements, unitOf(graph, taskId).taskIndex, part);
      expect(runBackwardPass(context, graph, broken).ok).toBe(false);
    }
  });

  it('refuses a task whose block was never placed late', () => {
    const lone = project([workTask('a'), workTask('z')]);
    const { context, graph, placements } = prepared(lone);
    expect(runBackwardPass(context, withoutInOrder(graph, unitOf(graph, 'z')), placements)).toEqual(
      {
        ok: false,
        error: { code: INVALID, taskId: 'z' },
      },
    );
  });

  it('reports a free float that cannot be measured for a task without successor', () => {
    const lone = project([workTask('a'), workTask('z')]);
    const { context, graph, placements } = prepared(lone);
    const broken = withBrokenPlacement(placements, unitOf(graph, 'a').taskIndex, 'end');
    expect(runBackwardPass(context, graph, broken).ok).toBe(false);
  });
});
