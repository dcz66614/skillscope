/**
 * Source graph (P023 T005, S1).
 *
 * A deterministic, portable view of what the identity registry knows:
 * which roots were scanned, which instances live under each root, which
 * access paths alias to the same physical file, and which instances
 * share a logical name or a content hash. Nodes and edges are sorted;
 * no absolute paths appear anywhere (roots are named by sourceRootId,
 * instances by instanceId hash + source-root-relative path).
 */

import type { IdentityRegistry } from "./identity.js";

export const SOURCE_GRAPH_VERSION = "skillscope.source-graph/v1";

export type SourceGraphNodeKind = "root" | "instance";

export interface SourceGraphNode {
  id: string;
  kind: SourceGraphNodeKind;
  sourceRootId?: string;
  sourceScope?: string;
  relativePath?: string;
  logicalName?: string;
  contentSha256?: string;
  status?: string;
}

export type SourceGraphEdgeKind =
  | "CONTAINS"
  | "ALIAS"
  | "SAME_NAME"
  | "DUPLICATE_CONTENT";

export interface SourceGraphEdge {
  from: string;
  to: string;
  kind: SourceGraphEdgeKind;
  /** Alias access path (ALIAS edges only), relative to the source root. */
  path?: string;
}

export interface SourceGraphRoot {
  sourceRootId: string;
  engine: string;
  sourceScope: string;
}

export interface SourceGraphV1 {
  schema: "skillscope.source-graph/v1";
  roots: SourceGraphRoot[];
  nodes: SourceGraphNode[];
  edges: SourceGraphEdge[];
}

function compareStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function buildSourceGraph(
  roots: SourceGraphRoot[],
  registry: IdentityRegistry,
): SourceGraphV1 {
  const sortedRoots = [...roots].sort((a, b) =>
    compareStr(a.sourceRootId, b.sourceRootId),
  );
  const nodes: SourceGraphNode[] = [];
  const edges: SourceGraphEdge[] = [];

  for (const root of sortedRoots) {
    nodes.push({
      id: `root:${root.sourceRootId}`,
      kind: "root",
      sourceRootId: root.sourceRootId,
      sourceScope: root.sourceScope,
    });
  }

  for (const inst of registry.instances()) {
    nodes.push({
      id: inst.instanceId,
      kind: "instance",
      sourceRootId: inst.sourceRootId,
      sourceScope: inst.sourceScope,
      relativePath: inst.relativePath,
      logicalName: inst.logicalName,
      contentSha256: inst.contentSha256,
      status: inst.status,
    });
    edges.push({
      from: `root:${inst.sourceRootId}`,
      to: inst.instanceId,
      kind: "CONTAINS",
    });
    for (const alias of inst.aliases) {
      edges.push({
        from: `root:${inst.sourceRootId}`,
        to: inst.instanceId,
        kind: "ALIAS",
        path: alias,
      });
    }
  }

  for (const group of registry.sameNameCollisions()) {
    for (let i = 0; i < group.instanceIds.length; i += 1) {
      for (let j = i + 1; j < group.instanceIds.length; j += 1) {
        edges.push({
          from: group.instanceIds[i] as string,
          to: group.instanceIds[j] as string,
          kind: "SAME_NAME",
        });
      }
    }
  }

  for (const group of registry.duplicateContentGroups()) {
    for (let i = 0; i < group.instanceIds.length; i += 1) {
      for (let j = i + 1; j < group.instanceIds.length; j += 1) {
        edges.push({
          from: group.instanceIds[i] as string,
          to: group.instanceIds[j] as string,
          kind: "DUPLICATE_CONTENT",
        });
      }
    }
  }

  nodes.sort((a, b) => compareStr(a.id, b.id));
  edges.sort(
    (a, b) =>
      compareStr(a.kind, b.kind) ||
      compareStr(a.from, b.from) ||
      compareStr(a.to, b.to) ||
      compareStr(a.path ?? "", b.path ?? ""),
  );

  return {
    schema: "skillscope.source-graph/v1",
    roots: sortedRoots,
    nodes,
    edges,
  };
}
