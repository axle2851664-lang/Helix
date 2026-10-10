import { linkTargets, normalizeTarget, titleFromContent } from './wikilinks.js';

/**
 * The vault as a graph: documents are nodes, wikilinks are edges.
 *
 * ON THE WORD "NOTE", WHICH USED TO BE ALL OVER THIS FILE.
 *
 * Every node here is a file on the user's disk - a markdown or text file in a
 * vault folder, which Havoc reads and never wrote. Calling those "notes" was
 * natural when they were the only note-like thing Havoc knew about. It is
 * wrong now: Havoc has a Notepad, and a note there is a different thing with
 * different rules - Havoc's own storage, written only when asked, deleted
 * outright, and never on the disk at all.
 *
 * Two things that are not the same must not share a word, because the user
 * cannot see which one they have got. So in Havoc a *note* is a Notepad note,
 * and everything in this file is a *document*: a file the user wrote
 * elsewhere and Havoc is reading.
 *
 * Two decisions worth stating:
 *
 * - **A link to a document that does not exist still becomes a node**, marked
 *   `missing`. Dropping them would hide the fact that a document references
 *   something absent, which is exactly the sort of gap worth seeing on a
 *   graph.
 * - **Edges are undirected for layout and degree**, because visually a link is
 *   a relationship either way, but the original direction is retained so the
 *   inspector can say which document pointed at which.
 */

export type VaultDocumentType =
  | 'document'
  | 'client'
  | 'project'
  | 'meeting'
  | 'invoice'
  | 'missing';

export interface VaultNode {
  id: string;
  /** Display title. */
  title: string;
  type: VaultDocumentType;
  /** Source path, for citation. Absent for `missing` nodes. */
  path?: string;
  /** Raw text, for search and the inspector. */
  content?: string;
  sizeBytes?: number;
  /** Number of distinct neighbours. Drives node radius. */
  degree: number;
  /** True when linked to but not present as a file. */
  missing: boolean;
}

export interface VaultEdge {
  /** Normalised ids. */
  source: string;
  target: string;
  /** How many times the link appears, for edge weight. */
  weight: number;
}

export interface VaultDocument {
  path: string;
  fileName: string;
  content: string;
  sizeBytes: number;
  /** Optional explicit type; inferred from the path when omitted. */
  type?: VaultDocumentType;
}

/** Infer a document's type from its folder, so colour-by-type means something. */
export function inferType(path: string): VaultDocumentType {
  const lower = path.toLowerCase();
  if (/(^|[\\/])clients?([\\/]|$)/.test(lower)) return 'client';
  if (/(^|[\\/])projects?([\\/]|$)/.test(lower)) return 'project';
  if (/(^|[\\/])(meetings?|calls?)([\\/]|$)/.test(lower)) return 'meeting';
  if (/(^|[\\/])(invoices?|billing|finance)([\\/]|$)/.test(lower)) return 'invoice';
  return 'document';
}

export interface GraphStats {
  nodes: number;
  edges: number;
  missing: number;
  byType: Record<VaultDocumentType, number>;
  /** Documents with no links in or out. */
  orphans: number;
}

export class VaultGraph {
  readonly #nodes = new Map<string, VaultNode>();
  /** Undirected adjacency, for degree and traversal. */
  readonly #adjacency = new Map<string, Set<string>>();
  readonly #edges = new Map<string, VaultEdge>();
  /** Directed record, so the inspector can say who linked to whom. */
  readonly #outgoing = new Map<string, Set<string>>();

  get nodes(): VaultNode[] {
    return [...this.#nodes.values()];
  }

  get edges(): VaultEdge[] {
    return [...this.#edges.values()];
  }

  get(id: string): VaultNode | undefined {
    return this.#nodes.get(normalizeTarget(id));
  }

  neighbours(id: string): VaultNode[] {
    const key = normalizeTarget(id);
    return [...(this.#adjacency.get(key) ?? [])]
      .map((neighbour) => this.#nodes.get(neighbour))
      .filter((node): node is VaultNode => node !== undefined);
  }

  /** Notes this one links out to. */
  outgoing(id: string): VaultNode[] {
    const key = normalizeTarget(id);
    return [...(this.#outgoing.get(key) ?? [])]
      .map((target) => this.#nodes.get(target))
      .filter((node): node is VaultNode => node !== undefined);
  }

  /** Notes that link to this one. */
  incoming(id: string): VaultNode[] {
    const key = normalizeTarget(id);
    return this.nodes.filter((node) => this.#outgoing.get(node.id)?.has(key) === true);
  }

  /** Build a graph from documents. Replaces any previous contents. */
  static build(documents: readonly VaultDocument[]): VaultGraph {
    const graph = new VaultGraph();

    // Pass one: every real document becomes a node, so links in pass two can
    // tell a present document from an absent one.
    for (const document of documents) {
      const title = titleFromContent(document.fileName, document.content);
      const id = normalizeTarget(title);

      graph.#nodes.set(id, {
        id,
        title,
        type: document.type ?? inferType(document.path),
        path: document.path,
        content: document.content,
        sizeBytes: document.sizeBytes,
        degree: 0,
        missing: false,
      });
    }

    // Pass two: links become edges, creating placeholder nodes for targets
    // that do not exist as files.
    for (const document of documents) {
      const title = titleFromContent(document.fileName, document.content);
      const sourceId = normalizeTarget(title);

      for (const rawTarget of linkTargets(document.content)) {
        const targetId = normalizeTarget(rawTarget);
        // A document linking to itself is not a relationship worth drawing.
        if (targetId === sourceId) continue;

        if (!graph.#nodes.has(targetId)) {
          graph.#nodes.set(targetId, {
            id: targetId,
            title: rawTarget,
            type: 'missing',
            degree: 0,
            missing: true,
          });
        }

        graph.#addEdge(sourceId, targetId);
      }
    }

    graph.#computeDegrees();
    return graph;
  }

  #addEdge(source: string, target: string): void {
    // Undirected key, so A->B and B->A are one edge with a combined weight.
    //
    // The separator is a NUL, because a document id can contain very nearly any
    // other character and a collision there would silently merge two distinct
    // edges. It is written as an escape rather than typed literally: a raw
    // control character in source is invisible in an editor, in a diff and in
    // review, which is exactly how one sat in this file unnoticed.
    const separator = '\u0000';
    const key =
      source < target
        ? `${source}${separator}${target}`
        : `${target}${separator}${source}`;
    const existing = this.#edges.get(key);
    if (existing) existing.weight += 1;
    else this.#edges.set(key, { source, target, weight: 1 });

    if (!this.#adjacency.has(source)) this.#adjacency.set(source, new Set());
    if (!this.#adjacency.has(target)) this.#adjacency.set(target, new Set());
    this.#adjacency.get(source)?.add(target);
    this.#adjacency.get(target)?.add(source);

    if (!this.#outgoing.has(source)) this.#outgoing.set(source, new Set());
    this.#outgoing.get(source)?.add(target);
  }

  #computeDegrees(): void {
    for (const node of this.#nodes.values()) {
      node.degree = this.#adjacency.get(node.id)?.size ?? 0;
    }
  }

  /** Most-connected documents first. Drives node radius and the hub list. */
  hubs(limit = 10): VaultNode[] {
    return this.nodes
      .filter((node) => !node.missing)
      .sort((a, b) => b.degree - a.degree || a.title.localeCompare(b.title))
      .slice(0, limit);
  }

  /** Notes with no connections at all. */
  orphans(): VaultNode[] {
    return this.nodes.filter((node) => !node.missing && node.degree === 0);
  }

  stats(): GraphStats {
    const byType = {
      document: 0,
      client: 0,
      project: 0,
      meeting: 0,
      invoice: 0,
      missing: 0,
    } satisfies Record<VaultDocumentType, number>;

    for (const node of this.#nodes.values()) byType[node.type] += 1;

    return {
      nodes: this.#nodes.size,
      edges: this.#edges.size,
      missing: byType.missing,
      byType,
      orphans: this.orphans().length,
    };
  }

  /**
   * Shortest path between two documents, for shift-click tracing.
   *
   * Breadth-first: edges are unweighted for traversal, so the fewest hops is
   * the shortest path. Returns an empty array when no route exists, which is
   * distinct from a single-node array when source and target are the same.
   */
  shortestPath(fromId: string, toId: string): VaultNode[] {
    const start = normalizeTarget(fromId);
    const goal = normalizeTarget(toId);

    if (!this.#nodes.has(start) || !this.#nodes.has(goal)) return [];
    if (start === goal) {
      const node = this.#nodes.get(start);
      return node ? [node] : [];
    }

    const previous = new Map<string, string>();
    const visited = new Set<string>([start]);
    const queue: string[] = [start];

    while (queue.length > 0) {
      const current = queue.shift() as string;

      for (const neighbour of this.#adjacency.get(current) ?? []) {
        if (visited.has(neighbour)) continue;
        visited.add(neighbour);
        previous.set(neighbour, current);

        if (neighbour === goal) {
          // Walk back to the start, then reverse.
          const path: string[] = [goal];
          let step = goal;
          while (previous.has(step)) {
            step = previous.get(step) as string;
            path.push(step);
          }
          return path
            .reverse()
            .map((id) => this.#nodes.get(id))
            .filter((node): node is VaultNode => node !== undefined);
        }

        queue.push(neighbour);
      }
    }

    return [];
  }
}
