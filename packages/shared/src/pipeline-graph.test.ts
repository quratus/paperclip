import { describe, expect, it } from "vitest";
import { compilePipelineGraph, type PipelineGraphDefinitionInput } from "./pipeline-graph.js";

function linearGraph(): PipelineGraphDefinitionInput {
  return {
    entryNodeKey: "frame",
    nodes: [
      { key: "frame", name: "Frame", kind: "working", position: 100, config: { z: 2, a: 1 } },
      { key: "review", name: "Review", kind: "review", position: 200 },
      { key: "done", name: "Done", kind: "done", position: 300 },
      { key: "cancelled", name: "Cancelled", kind: "cancelled", position: 400 },
    ],
    edges: [
      { fromNodeKey: "frame", toNodeKey: "review" },
      { fromNodeKey: "review", toNodeKey: "done", outcome: "approve" },
      { fromNodeKey: "review", toNodeKey: "cancelled", outcome: "cancel" },
    ],
  };
}

describe("compilePipelineGraph", () => {
  it("normalizes ordering into stable canonical JSON", () => {
    const first = compilePipelineGraph(linearGraph());
    const reorderedInput = linearGraph();
    reorderedInput.nodes.reverse();
    reorderedInput.edges.reverse();
    const second = compilePipelineGraph(reorderedInput);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error("expected compiled graphs");
    expect(first.canonicalJson).toBe(second.canonicalJson);
    expect(first.definition.nodes[0]?.config).toEqual({ a: 1, z: 2 });
  });

  it("rejects unknown, unreachable, and dead-end nodes", () => {
    const input = linearGraph();
    input.nodes.push({ key: "orphan", name: "Orphan", kind: "working", position: 500 });
    input.edges.push({ fromNodeKey: "missing", toNodeKey: "done" });

    const result = compilePipelineGraph(input);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid graph");
    expect(result.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining([
      "unknown_edge_endpoint",
      "nonterminal_dead_end",
      "unreachable_node",
    ]));
  });

  it("rejects ambiguous outcomes from one node", () => {
    const input = linearGraph();
    input.edges.push({ fromNodeKey: "review", toNodeKey: "cancelled", outcome: "approve" });
    const result = compilePipelineGraph(input);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid graph");
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "duplicate_edge_outcome" }));
  });

  it("requires a bounded contract for every cycle", () => {
    const input: PipelineGraphDefinitionInput = {
      entryNodeKey: "implement",
      nodes: [
        { key: "implement", name: "Implement", kind: "working", position: 100 },
        { key: "review", name: "Review", kind: "review", position: 200 },
        { key: "done", name: "Done", kind: "done", position: 300 },
      ],
      edges: [
        { fromNodeKey: "implement", toNodeKey: "review", outcome: "submit" },
        { fromNodeKey: "review", toNodeKey: "implement", outcome: "changes_requested" },
        { fromNodeKey: "review", toNodeKey: "done", outcome: "approve" },
      ],
    };

    const missing = compilePipelineGraph(input);
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error("expected invalid graph");
    expect(missing.diagnostics).toContainEqual(expect.objectContaining({ code: "cycle_without_contract" }));

    input.cycleContracts = [{
      key: "review-repair",
      nodeKeys: ["review", "implement"],
      maxIterations: 3,
      noProgressLimit: 2,
      progressField: "artifactHash",
      exitNodeKeys: ["done"],
    }];
    const compiled = compilePipelineGraph(input);
    expect(compiled.ok).toBe(true);
  });

  it("rejects cycle contracts whose exits or limits do not match the graph", () => {
    const input: PipelineGraphDefinitionInput = {
      entryNodeKey: "work",
      nodes: [
        { key: "work", name: "Work", kind: "working", position: 100 },
        { key: "review", name: "Review", kind: "review", position: 200 },
        { key: "done", name: "Done", kind: "done", position: 300 },
      ],
      edges: [
        { fromNodeKey: "work", toNodeKey: "review" },
        { fromNodeKey: "review", toNodeKey: "work", outcome: "retry" },
        { fromNodeKey: "review", toNodeKey: "done", outcome: "approve" },
      ],
      cycleContracts: [{
        key: "repair",
        nodeKeys: ["work", "review"],
        maxIterations: 0,
        noProgressLimit: 2,
        exitNodeKeys: ["work"],
      }],
    };

    const result = compilePipelineGraph(input);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid graph");
    expect(result.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining([
      "cycle_contract_invalid_limit",
      "cycle_contract_invalid_no_progress_limit",
      "cycle_contract_invalid_exit",
    ]));
  });
});
