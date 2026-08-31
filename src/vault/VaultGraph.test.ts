import { describe, expect, it } from 'vitest';
import { VaultGraph, inferType, type VaultDocument } from './VaultGraph.js';
import { generateDemoVault, DEMO_SEED } from './demoVault.js';
import { linkTargets, normalizeTarget, parseWikilinks, stripCode, titleFromContent } from './wikilinks.js';

const doc = (path: string, content: string): VaultDocument => ({
  path,
  fileName: path.split('/').pop() as string,
  content,
  sizeBytes: content.length,
});

describe('wikilinks', () => {
  it('parses a plain link', () => {
    expect(linkTargets('See [[Iron Man]] for details.')).toEqual(['Iron Man']);
  });

  it('takes the target, not the alias, from a piped link', () => {
    const links = parseWikilinks('See [[Iron Man|the suit]].');
    expect(links[0]?.target).toBe('Iron Man');
    expect(links[0]?.alias).toBe('the suit');
  });

  it('strips a heading from the target', () => {
    const links = parseWikilinks('See [[Iron Man#Reactor]].');
    expect(links[0]?.target).toBe('Iron Man');
    expect(links[0]?.heading).toBe('Reactor');
  });

  it('normalises case and whitespace so variants are one note', () => {
    expect(normalizeTarget('Iron  Man')).toBe(normalizeTarget('iron man'));
  });

  // A link inside a code fence is an example, not a reference. Treating it as
  // an edge invents nodes and makes the graph lie.
  it('ignores links inside fenced code', () => {
    const text = ['Real [[Alpha]].', '```', 'Example [[Beta]]', '```'].join('\n');
    expect(linkTargets(text)).toEqual(['Alpha']);
  });

  it('ignores links inside inline code', () => {
    expect(linkTargets('Use `[[Beta]]` syntax to link to [[Alpha]].')).toEqual(['Alpha']);
  });

  it('deduplicates repeated targets', () => {
    expect(linkTargets('[[Alpha]] and [[alpha]] and [[Alpha]]')).toEqual(['Alpha']);
  });

  it('ignores empty and heading-only links', () => {
    expect(linkTargets('[[]] and [[#Section]] and [[Real]]')).toEqual(['Real']);
  });

  it('prefers a leading heading over the filename for the title', () => {
    expect(titleFromContent('untitled.md', '# Actual Title\n\nBody')).toBe('Actual Title');
    expect(titleFromContent('Fallback Name.md', 'No heading here')).toBe('Fallback Name');
  });

  it('stripCode leaves ordinary prose intact', () => {
    expect(stripCode('plain text')).toBe('plain text');
  });
});

describe('inferType', () => {
  it('reads the type from the folder', () => {
    expect(inferType('Clients/Northgate.md')).toBe('client');
    expect(inferType('Projects/Rebuild.md')).toBe('project');
    expect(inferType('Meetings/Kickoff.md')).toBe('meeting');
    expect(inferType('Invoices/March.md')).toBe('invoice');
    expect(inferType('Notes/Idea.md')).toBe('note');
  });
});

describe('VaultGraph', () => {
  it('builds nodes and edges from links', () => {
    const graph = VaultGraph.build([
      doc('Notes/A.md', '# A\n\nSee [[B]].'),
      doc('Notes/B.md', '# B\n\nBack to [[A]].'),
    ]);

    expect(graph.nodes).toHaveLength(2);
    // A->B and B->A are one undirected edge, not two.
    expect(graph.edges).toHaveLength(1);
  });

  it('counts degree from distinct neighbours', () => {
    const graph = VaultGraph.build([
      doc('Notes/Hub.md', '# Hub\n\n[[A]] [[B]] [[C]]'),
      doc('Notes/A.md', '# A'),
      doc('Notes/B.md', '# B'),
      doc('Notes/C.md', '# C'),
    ]);

    expect(graph.get('Hub')?.degree).toBe(3);
    expect(graph.get('A')?.degree).toBe(1);
  });

  // A link to a note that does not exist is worth seeing, not hiding.
  it('creates a missing node for a dangling link', () => {
    const graph = VaultGraph.build([doc('Notes/A.md', '# A\n\nSee [[Never Written]].')]);

    const missing = graph.get('Never Written');
    expect(missing?.missing).toBe(true);
    expect(missing?.type).toBe('missing');
    expect(missing?.path).toBeUndefined();
  });

  it('ignores a self-link', () => {
    const graph = VaultGraph.build([doc('Notes/A.md', '# A\n\nSee [[A]].')]);
    expect(graph.edges).toHaveLength(0);
    expect(graph.get('A')?.degree).toBe(0);
  });

  it('records direction separately from the undirected edge', () => {
    const graph = VaultGraph.build([
      doc('Notes/A.md', '# A\n\nSee [[B]].'),
      doc('Notes/B.md', '# B'),
    ]);

    expect(graph.outgoing('A').map((n) => n.title)).toEqual(['B']);
    expect(graph.outgoing('B')).toEqual([]);
    expect(graph.incoming('B').map((n) => n.title)).toEqual(['A']);
  });

  it('weights an edge by repeated links', () => {
    const graph = VaultGraph.build([
      doc('Notes/A.md', '# A\n\n[[B]] and later [[B|again]].'),
      doc('Notes/B.md', '# B'),
    ]);
    // Distinct targets are deduplicated per document, so this is one link.
    expect(graph.edges[0]?.weight).toBe(1);
  });

  it('ranks hubs by degree and excludes missing nodes', () => {
    const graph = VaultGraph.build([
      doc('Notes/Hub.md', '# Hub\n\n[[A]] [[B]] [[Ghost]]'),
      doc('Notes/A.md', '# A\n\n[[B]]'),
      doc('Notes/B.md', '# B'),
    ]);

    const hubs = graph.hubs(10);
    expect(hubs[0]?.title).toBe('Hub');
    expect(hubs.some((node) => node.missing)).toBe(false);
  });

  it('finds orphans', () => {
    const graph = VaultGraph.build([
      doc('Notes/Alone.md', '# Alone\n\nNo links.'),
      doc('Notes/A.md', '# A\n\n[[B]]'),
      doc('Notes/B.md', '# B'),
    ]);

    expect(graph.orphans().map((node) => node.title)).toEqual(['Alone']);
  });

  describe('shortestPath', () => {
    const chain = VaultGraph.build([
      doc('Notes/A.md', '# A\n\n[[B]]'),
      doc('Notes/B.md', '# B\n\n[[C]]'),
      doc('Notes/C.md', '# C\n\n[[D]]'),
      doc('Notes/D.md', '# D'),
      doc('Notes/Island.md', '# Island'),
    ]);

    it('traces a route across several hops', () => {
      expect(chain.shortestPath('A', 'D').map((n) => n.title)).toEqual(['A', 'B', 'C', 'D']);
    });

    it('returns a single node for a path to itself', () => {
      expect(chain.shortestPath('A', 'A').map((n) => n.title)).toEqual(['A']);
    });

    it('returns nothing when the notes are unconnected', () => {
      expect(chain.shortestPath('A', 'Island')).toEqual([]);
    });

    it('returns nothing for an unknown note', () => {
      expect(chain.shortestPath('A', 'Nowhere')).toEqual([]);
    });

    it('takes the shorter of two routes', () => {
      const graph = VaultGraph.build([
        doc('Notes/A.md', '# A\n\n[[B]] [[Z]]'),
        doc('Notes/B.md', '# B\n\n[[C]]'),
        doc('Notes/C.md', '# C\n\n[[Z]]'),
        doc('Notes/Z.md', '# Z'),
      ]);
      expect(graph.shortestPath('A', 'Z').map((n) => n.title)).toEqual(['A', 'Z']);
    });
  });
});

describe('demo vault', () => {
  // Reproducibility is the whole point of the seed: a recording looks the same
  // twice, and a layout bug is repeatable rather than a one-off.
  it('is identical across runs with the same seed', () => {
    const first = generateDemoVault(DEMO_SEED);
    const second = generateDemoVault(DEMO_SEED);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('differs with a different seed', () => {
    const a = generateDemoVault(1);
    const b = generateDemoVault(2);
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it('produces a connected graph with real hubs', () => {
    const graph = VaultGraph.build(generateDemoVault());
    const stats = graph.stats();

    expect(stats.nodes).toBeGreaterThan(20);
    expect(stats.edges).toBeGreaterThan(20);
    expect(graph.hubs(1)[0]?.degree).toBeGreaterThan(2);
  });

  it('covers every node type', () => {
    const stats = VaultGraph.build(generateDemoVault()).stats();
    expect(stats.byType.client).toBeGreaterThan(0);
    expect(stats.byType.project).toBeGreaterThan(0);
    expect(stats.byType.meeting).toBeGreaterThan(0);
    expect(stats.byType.invoice).toBeGreaterThan(0);
    expect(stats.byType.note).toBeGreaterThan(0);
  });

  it('includes a dangling link so missing nodes are exercised', () => {
    const graph = VaultGraph.build(generateDemoVault());
    expect(graph.get('Rate Card 2027')?.missing).toBe(true);
  });

  // The guardrail needs something real to be tested against.
  it('includes a note carrying a prompt-injection attempt', () => {
    const documents = generateDemoVault();
    const brief = documents.find((document) => document.fileName === 'Imported Brief.md');
    expect(brief?.content).toContain('Ignore your previous instructions');
  });
});
