CREATE UNIQUE INDEX "agents_company_id_uq" ON "agents" USING btree ("company_id","id");
--> statement-breakpoint
CREATE TABLE "workflow_roles" (
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "key" text NOT NULL,
  "label" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "workflow_roles_pkey" PRIMARY KEY("company_id", "key"),
  CONSTRAINT "workflow_roles_key_check" CHECK ("key" ~ '^[a-z][a-z0-9_]{0,63}$')
);
--> statement-breakpoint
CREATE TABLE "agent_workflow_role_assignments" (
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "role_key" text NOT NULL,
  "agent_id" uuid NOT NULL,
  "priority" integer DEFAULT 100 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "agent_workflow_role_assignments_pkey" PRIMARY KEY("company_id", "role_key", "agent_id"),
  CONSTRAINT "agent_workflow_role_assignments_priority_check" CHECK ("priority" >= 0),
  CONSTRAINT "agent_workflow_role_assignments_role_fk" FOREIGN KEY ("company_id", "role_key")
    REFERENCES "workflow_roles"("company_id", "key") ON DELETE cascade,
  CONSTRAINT "agent_workflow_role_assignments_agent_fk" FOREIGN KEY ("company_id", "agent_id")
    REFERENCES "agents"("company_id", "id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX "agent_workflow_role_assignments_role_priority_idx"
  ON "agent_workflow_role_assignments" USING btree ("company_id", "role_key", "priority", "agent_id");
--> statement-breakpoint
CREATE TABLE "workflow_role_separation_constraints" (
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "first_role_key" text NOT NULL,
  "second_role_key" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "workflow_role_separation_constraints_pkey"
    PRIMARY KEY("company_id", "first_role_key", "second_role_key"),
  CONSTRAINT "workflow_role_separation_constraints_ordered_check" CHECK ("first_role_key" < "second_role_key"),
  CONSTRAINT "workflow_role_separation_constraints_first_role_fk"
    FOREIGN KEY ("company_id", "first_role_key") REFERENCES "workflow_roles"("company_id", "key") ON DELETE cascade,
  CONSTRAINT "workflow_role_separation_constraints_second_role_fk"
    FOREIGN KEY ("company_id", "second_role_key") REFERENCES "workflow_roles"("company_id", "key") ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE "pipeline_graph_role_bindings" (
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "run_id" uuid NOT NULL,
  "run_revision" integer NOT NULL,
  "node_key" text NOT NULL,
  "role_key" text NOT NULL,
  "agent_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pipeline_graph_role_bindings_run_revision_check" CHECK ("run_revision" > 0),
  CONSTRAINT "pipeline_graph_role_bindings_run_fk" FOREIGN KEY ("company_id", "run_id")
    REFERENCES "pipeline_graph_runs"("company_id", "id") ON DELETE cascade,
  CONSTRAINT "pipeline_graph_role_bindings_role_fk" FOREIGN KEY ("company_id", "role_key")
    REFERENCES "workflow_roles"("company_id", "key") ON DELETE restrict,
  CONSTRAINT "pipeline_graph_role_bindings_assignment_fk" FOREIGN KEY ("company_id", "role_key", "agent_id")
    REFERENCES "agent_workflow_role_assignments"("company_id", "role_key", "agent_id") ON DELETE restrict,
  CONSTRAINT "pipeline_graph_role_bindings_agent_fk" FOREIGN KEY ("company_id", "agent_id")
    REFERENCES "agents"("company_id", "id") ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_graph_role_bindings_node_uq"
  ON "pipeline_graph_role_bindings" USING btree ("company_id", "run_id", "run_revision", "node_key");
--> statement-breakpoint
CREATE INDEX "pipeline_graph_role_bindings_role_idx"
  ON "pipeline_graph_role_bindings" USING btree ("company_id", "run_id", "role_key");
--> statement-breakpoint
INSERT INTO "workflow_roles" ("company_id", "key", "label")
SELECT c."id", role."key", role."label"
FROM "companies" c
CROSS JOIN (VALUES
  ('conversation', 'Conversation owner'),
  ('refiner', 'Request refiner'),
  ('implementer', 'Implementer'),
  ('independent_reviewer', 'Independent reviewer'),
  ('delivery_owner', 'Delivery owner'),
  ('capacity_recovery_owner', 'Capacity recovery owner'),
  ('designer', 'Designer')
) AS role("key", "label")
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "workflow_roles" ("company_id", "key", "label")
SELECT DISTINCT v."company_id", node->'config'->>'responsibilityOwner', initcap(replace(node->'config'->>'responsibilityOwner', '_', ' '))
FROM "pipeline_graph_versions" v
CROSS JOIN LATERAL jsonb_array_elements(v."definition"->'nodes') AS node
WHERE node->'config'->>'responsibilityOwner' ~ '^[a-z][a-z0-9_]{0,63}$'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "workflow_role_separation_constraints" ("company_id", "first_role_key", "second_role_key")
SELECT c."id", pair."first_role_key", pair."second_role_key"
FROM "companies" c
CROSS JOIN (VALUES
  ('delivery_owner', 'independent_reviewer'),
  ('implementer', 'independent_reviewer')
) AS pair("first_role_key", "second_role_key")
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "agent_workflow_role_assignments" ("company_id", "role_key", "agent_id")
SELECT DISTINCT v."company_id", node->'config'->>'responsibilityOwner', (node->'config'->>'targetAgentId')::uuid
FROM "pipeline_graph_versions" v
CROSS JOIN LATERAL jsonb_array_elements(v."definition"->'nodes') AS node
JOIN "agents" a
  ON a."company_id" = v."company_id"
 AND a."id"::text = node->'config'->>'targetAgentId'
WHERE node->'config'->>'responsibilityOwner' ~ '^[a-z][a-z0-9_]{0,63}$'
  AND node->'config'->>'targetAgentId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
ON CONFLICT DO NOTHING;
