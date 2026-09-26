import type { Dependency, SchedulableTask } from '../model/project';
import { failure, success, type Result } from '../result';

export interface ResolvedDependency {
  readonly dependency: Dependency;
  readonly predecessorIndex: number;
  readonly successorIndex: number;
}

export interface GraphNode {
  readonly index: number;
  readonly task: SchedulableTask;
}

export interface DependencyGraph {
  readonly order: readonly GraphNode[];
  readonly incoming: readonly (readonly ResolvedDependency[])[];
  readonly outgoing: readonly (readonly ResolvedDependency[])[];
}

/** Orders tasks so that every predecessor comes first, or returns the tasks caught in or behind a cycle. */
export function buildDependencyGraph(
  nodes: readonly GraphNode[],
  taskCount: number,
  dependencies: readonly ResolvedDependency[],
): Result<DependencyGraph, GraphNode[]> {
  const incoming = groupDependencies(taskCount, dependencies, (link) => link.successorIndex);
  const outgoing = groupDependencies(taskCount, dependencies, (link) => link.predecessorIndex);
  const remainingPredecessors = incoming.map((links) => links.length);
  const nodeByIndex = new Array<GraphNode | undefined>(taskCount);
  nodes.forEach((node) => (nodeByIndex[node.index] = node));
  const ready = nodes.filter((node) => remainingPredecessors[node.index] === 0);
  const order: GraphNode[] = [];
  for (let node = ready.pop(); node !== undefined; node = ready.pop()) {
    order.push(node);
    releaseSuccessors(outgoing[node.index] ?? [], remainingPredecessors, nodeByIndex, ready);
  }
  if (order.length < nodes.length) {
    return failure(nodes.filter((node) => (remainingPredecessors[node.index] ?? 0) > 0));
  }
  return success({ order, incoming, outgoing });
}

/** Decrements the predecessor count of each successor and queues those left with none. */
function releaseSuccessors(
  links: readonly ResolvedDependency[],
  remainingPredecessors: number[],
  nodeByIndex: readonly (GraphNode | undefined)[],
  ready: GraphNode[],
): void {
  for (const link of links) {
    const count = (remainingPredecessors[link.successorIndex] ?? 0) - 1;
    remainingPredecessors[link.successorIndex] = count;
    const successor = nodeByIndex[link.successorIndex];
    if (count === 0 && successor !== undefined) {
      ready.push(successor);
    }
  }
}

/** Groups dependencies by the task index returned by a key function. */
function groupDependencies(
  taskCount: number,
  dependencies: readonly ResolvedDependency[],
  keyOf: (link: ResolvedDependency) => number,
): ResolvedDependency[][] {
  const groups = Array.from({ length: taskCount }, (): ResolvedDependency[] => []);
  for (const link of dependencies) {
    groups[keyOf(link)]?.push(link);
  }
  return groups;
}
