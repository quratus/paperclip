export const PIPELINE_GRAPH_SCHEMA_VERSION = 1 as const;
export const PIPELINE_GRAPH_ASSIGNMENT_SCHEMA_VERSION = 1 as const;

export type PipelineGraphNodeKind = "working" | "review" | "done" | "cancelled";

export interface PipelineGraphNodeInput {
  key: string;
  name: string;
  kind: PipelineGraphNodeKind;
  position: number;
  config?: Record<string, unknown>;
}

export interface PipelineGraphEdgeInput {
  fromNodeKey: string;
  toNodeKey: string;
  outcome?: string | null;
}

export interface PipelineGraphCycleContractInput {
  key: string;
  nodeKeys: string[];
  maxIterations: number;
  noProgressLimit?: number | null;
  progressField?: string | null;
  exitNodeKeys: string[];
}

export interface PipelineGraphDefinitionInput {
  entryNodeKey: string;
  nodes: PipelineGraphNodeInput[];
  edges: PipelineGraphEdgeInput[];
  cycleContracts?: PipelineGraphCycleContractInput[];
}

export interface PipelineGraphDefinitionV1 {
  schemaVersion: typeof PIPELINE_GRAPH_SCHEMA_VERSION;
  entryNodeKey: string;
  nodes: Array<{
    key: string;
    name: string;
    kind: PipelineGraphNodeKind;
    position: number;
    config: Record<string, unknown>;
  }>;
  edges: Array<{
    fromNodeKey: string;
    toNodeKey: string;
    outcome: string;
  }>;
  cycleContracts: Array<{
    key: string;
    nodeKeys: string[];
    maxIterations: number;
    noProgressLimit: number | null;
    progressField: string | null;
    exitNodeKeys: string[];
  }>;
}

/**
 * The durable hand-off from a graph node to one agent heartbeat.
 *
 * Policy remains node configuration owned by the caller; the kernel only
 * transports the resolved responsibility, allowed outcomes, and completion
 * contract without interpreting role- or product-specific policy.
 */
export interface PipelineGraphAssignmentV1 {
  schemaVersion: typeof PIPELINE_GRAPH_ASSIGNMENT_SCHEMA_VERSION;
  id: string;
  graphVersionId: string;
  runId: string;
  runRevision: number;
  caseId: string;
  nodeKey: string;
  nodeKind: PipelineGraphNodeKind;
  responsibilityOwner: string;
  targetAgentId: string | null;
  instruction: string | null;
  acceptanceCriteria: string[];
  allowedOutcomes: string[];
  completion: {
    method: "POST";
    path: string;
    requiredFields: ["expectedRevision", "idempotencyKey", "outcome", "checkpoint"];
  };
}

export type PipelineGraphDiagnosticCode =
  | "empty_graph"
  | "duplicate_node_key"
  | "unknown_entry_node"
  | "unknown_edge_endpoint"
  | "duplicate_edge_outcome"
  | "terminal_has_outgoing_edge"
  | "nonterminal_dead_end"
  | "unreachable_node"
  | "duplicate_cycle_contract_key"
  | "cycle_contract_unknown_node"
  | "cycle_contract_invalid_limit"
  | "cycle_contract_invalid_no_progress_limit"
  | "cycle_contract_missing_exit"
  | "cycle_contract_invalid_exit"
  | "cycle_without_contract"
  | "cycle_contract_without_cycle";

export interface PipelineGraphDiagnostic {
  code: PipelineGraphDiagnosticCode;
  message: string;
  nodeKeys?: string[];
  edge?: {
    fromNodeKey: string;
    toNodeKey: string;
    outcome: string;
  };
  contractKey?: string;
}

export type PipelineGraphCompileResult =
  | {
    ok: true;
    definition: PipelineGraphDefinitionV1;
    canonicalJson: string;
    diagnostics: [];
  }
  | {
    ok: false;
    definition: null;
    canonicalJson: null;
    diagnostics: PipelineGraphDiagnostic[];
  };

function normalizedKey(value: string): string {
  return value.trim();
}

function canonicalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalizeValue(entry)]),
    );
  }
  return value;
}

function cycleIdentity(nodeKeys: string[]): string {
  return [...nodeKeys].sort().join("\u0000");
}

function stronglyConnectedComponents(
  nodeKeys: string[],
  adjacency: Map<string, string[]>,
): string[][] {
  let nextIndex = 0;
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];

  const visit = (nodeKey: string) => {
    indices.set(nodeKey, nextIndex);
    lowLinks.set(nodeKey, nextIndex);
    nextIndex += 1;
    stack.push(nodeKey);
    onStack.add(nodeKey);

    for (const targetKey of adjacency.get(nodeKey) ?? []) {
      if (!indices.has(targetKey)) {
        visit(targetKey);
        lowLinks.set(nodeKey, Math.min(lowLinks.get(nodeKey)!, lowLinks.get(targetKey)!));
      } else if (onStack.has(targetKey)) {
        lowLinks.set(nodeKey, Math.min(lowLinks.get(nodeKey)!, indices.get(targetKey)!));
      }
    }

    if (lowLinks.get(nodeKey) !== indices.get(nodeKey)) return;
    const component: string[] = [];
    while (stack.length > 0) {
      const current = stack.pop()!;
      onStack.delete(current);
      component.push(current);
      if (current === nodeKey) break;
    }
    components.push(component.sort());
  };

  for (const nodeKey of [...nodeKeys].sort()) {
    if (!indices.has(nodeKey)) visit(nodeKey);
  }
  return components;
}

export function compilePipelineGraph(input: PipelineGraphDefinitionInput): PipelineGraphCompileResult {
  const diagnostics: PipelineGraphDiagnostic[] = [];
  if (input.nodes.length === 0) {
    diagnostics.push({ code: "empty_graph", message: "A graph must contain at least one node." });
    return { ok: false, definition: null, canonicalJson: null, diagnostics };
  }

  const normalizedNodes = input.nodes.map((node) => ({
    key: normalizedKey(node.key),
    name: node.name.trim(),
    kind: node.kind,
    position: node.position,
    config: (canonicalizeValue(node.config ?? {}) ?? {}) as Record<string, unknown>,
  }));
  const nodeByKey = new Map<string, (typeof normalizedNodes)[number]>();
  for (const node of normalizedNodes) {
    if (nodeByKey.has(node.key)) {
      diagnostics.push({
        code: "duplicate_node_key",
        message: `Node key "${node.key}" is duplicated.`,
        nodeKeys: [node.key],
      });
    } else {
      nodeByKey.set(node.key, node);
    }
  }

  const entryNodeKey = normalizedKey(input.entryNodeKey);
  if (!nodeByKey.has(entryNodeKey)) {
    diagnostics.push({
      code: "unknown_entry_node",
      message: `Entry node "${entryNodeKey}" does not exist.`,
      nodeKeys: [entryNodeKey],
    });
  }

  const normalizedEdges = input.edges.map((edge) => ({
    fromNodeKey: normalizedKey(edge.fromNodeKey),
    toNodeKey: normalizedKey(edge.toNodeKey),
    outcome: normalizedKey(edge.outcome ?? "continue") || "continue",
  }));
  const validEdges: typeof normalizedEdges = [];
  const outcomeKeys = new Set<string>();
  for (const edge of normalizedEdges) {
    const missing = [edge.fromNodeKey, edge.toNodeKey].filter((nodeKey) => !nodeByKey.has(nodeKey));
    if (missing.length > 0) {
      diagnostics.push({
        code: "unknown_edge_endpoint",
        message: `Edge "${edge.fromNodeKey}" → "${edge.toNodeKey}" references an unknown node.`,
        nodeKeys: missing,
        edge,
      });
      continue;
    }
    validEdges.push(edge);
    const outcomeKey = `${edge.fromNodeKey}\u0000${edge.outcome}`;
    if (outcomeKeys.has(outcomeKey)) {
      diagnostics.push({
        code: "duplicate_edge_outcome",
        message: `Node "${edge.fromNodeKey}" has more than one edge for outcome "${edge.outcome}".`,
        nodeKeys: [edge.fromNodeKey],
        edge,
      });
    }
    outcomeKeys.add(outcomeKey);
  }

  const adjacency = new Map<string, string[]>();
  for (const nodeKey of nodeByKey.keys()) adjacency.set(nodeKey, []);
  for (const edge of validEdges) adjacency.get(edge.fromNodeKey)!.push(edge.toNodeKey);

  for (const node of nodeByKey.values()) {
    const outgoing = adjacency.get(node.key) ?? [];
    const isTerminal = node.kind === "done" || node.kind === "cancelled";
    if (isTerminal && outgoing.length > 0) {
      diagnostics.push({
        code: "terminal_has_outgoing_edge",
        message: `Terminal node "${node.key}" cannot have outgoing edges.`,
        nodeKeys: [node.key],
      });
    }
    if (!isTerminal && outgoing.length === 0) {
      diagnostics.push({
        code: "nonterminal_dead_end",
        message: `Nonterminal node "${node.key}" has no exit edge.`,
        nodeKeys: [node.key],
      });
    }
  }

  if (nodeByKey.has(entryNodeKey)) {
    const reachable = new Set<string>();
    const queue = [entryNodeKey];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (reachable.has(current)) continue;
      reachable.add(current);
      queue.push(...(adjacency.get(current) ?? []));
    }
    for (const nodeKey of [...nodeByKey.keys()].sort()) {
      if (!reachable.has(nodeKey)) {
        diagnostics.push({
          code: "unreachable_node",
          message: `Node "${nodeKey}" is not reachable from entry node "${entryNodeKey}".`,
          nodeKeys: [nodeKey],
        });
      }
    }
  }

  const contracts = (input.cycleContracts ?? []).map((contract) => ({
    key: normalizedKey(contract.key),
    nodeKeys: [...new Set(contract.nodeKeys.map(normalizedKey))].sort(),
    maxIterations: contract.maxIterations,
    noProgressLimit: contract.noProgressLimit ?? null,
    progressField: contract.progressField?.trim() || null,
    exitNodeKeys: [...new Set(contract.exitNodeKeys.map(normalizedKey))].sort(),
  }));
  const contractKeys = new Set<string>();
  for (const contract of contracts) {
    if (contractKeys.has(contract.key)) {
      diagnostics.push({
        code: "duplicate_cycle_contract_key",
        message: `Cycle contract key "${contract.key}" is duplicated.`,
        contractKey: contract.key,
      });
    }
    contractKeys.add(contract.key);
    const unknownNodes = [...contract.nodeKeys, ...contract.exitNodeKeys]
      .filter((nodeKey) => !nodeByKey.has(nodeKey));
    if (unknownNodes.length > 0) {
      diagnostics.push({
        code: "cycle_contract_unknown_node",
        message: `Cycle contract "${contract.key}" references unknown nodes.`,
        nodeKeys: [...new Set(unknownNodes)].sort(),
        contractKey: contract.key,
      });
    }
    if (!Number.isInteger(contract.maxIterations) || contract.maxIterations < 1 || contract.maxIterations > 100) {
      diagnostics.push({
        code: "cycle_contract_invalid_limit",
        message: `Cycle contract "${contract.key}" must set maxIterations between 1 and 100.`,
        contractKey: contract.key,
      });
    }
    if (
      contract.noProgressLimit !== null
      && (
        !Number.isInteger(contract.noProgressLimit)
        || contract.noProgressLimit < 1
        || contract.noProgressLimit > contract.maxIterations
      )
    ) {
      diagnostics.push({
        code: "cycle_contract_invalid_no_progress_limit",
        message: `Cycle contract "${contract.key}" must set noProgressLimit between 1 and maxIterations.`,
        contractKey: contract.key,
      });
    }
  }

  const cyclicComponents = stronglyConnectedComponents([...nodeByKey.keys()], adjacency)
    .filter((component) => component.length > 1 || (adjacency.get(component[0]!) ?? []).includes(component[0]!));
  const cycleByIdentity = new Map(cyclicComponents.map((component) => [cycleIdentity(component), component]));
  const contractByCycle = new Map<string, (typeof contracts)[number]>();
  for (const contract of contracts) {
    const identity = cycleIdentity(contract.nodeKeys);
    if (!cycleByIdentity.has(identity)) {
      diagnostics.push({
        code: "cycle_contract_without_cycle",
        message: `Cycle contract "${contract.key}" does not match one complete graph cycle.`,
        nodeKeys: contract.nodeKeys,
        contractKey: contract.key,
      });
      continue;
    }
    contractByCycle.set(identity, contract);
    const cycleNodes = new Set(contract.nodeKeys);
    const actualExitNodeKeys = [...new Set(validEdges
      .filter((edge) => cycleNodes.has(edge.fromNodeKey) && !cycleNodes.has(edge.toNodeKey))
      .map((edge) => edge.toNodeKey))]
      .sort();
    if (actualExitNodeKeys.length === 0) {
      diagnostics.push({
        code: "cycle_contract_missing_exit",
        message: `Cycle contract "${contract.key}" has no edge leaving the cycle.`,
        nodeKeys: contract.nodeKeys,
        contractKey: contract.key,
      });
    } else if (
      actualExitNodeKeys.length !== contract.exitNodeKeys.length
      || actualExitNodeKeys.some((nodeKey, index) => nodeKey !== contract.exitNodeKeys[index])
    ) {
      diagnostics.push({
        code: "cycle_contract_invalid_exit",
        message: `Cycle contract "${contract.key}" exitNodeKeys do not match the graph's cycle exits.`,
        nodeKeys: contract.exitNodeKeys,
        contractKey: contract.key,
      });
    }
  }
  for (const [identity, component] of cycleByIdentity) {
    if (!contractByCycle.has(identity)) {
      diagnostics.push({
        code: "cycle_without_contract",
        message: `Cycle containing ${component.join(", ")} requires an explicit cycle contract.`,
        nodeKeys: component,
      });
    }
  }

  if (diagnostics.length > 0) {
    return { ok: false, definition: null, canonicalJson: null, diagnostics };
  }

  const definition: PipelineGraphDefinitionV1 = {
    schemaVersion: PIPELINE_GRAPH_SCHEMA_VERSION,
    entryNodeKey,
    nodes: normalizedNodes.sort((left, right) => (
      left.position - right.position || left.key.localeCompare(right.key)
    )),
    edges: normalizedEdges.sort((left, right) => (
      left.fromNodeKey.localeCompare(right.fromNodeKey)
      || left.outcome.localeCompare(right.outcome)
      || left.toNodeKey.localeCompare(right.toNodeKey)
    )),
    cycleContracts: contracts.sort((left, right) => left.key.localeCompare(right.key)),
  };
  return {
    ok: true,
    definition,
    canonicalJson: JSON.stringify(canonicalizeValue(definition)),
    diagnostics: [],
  };
}
