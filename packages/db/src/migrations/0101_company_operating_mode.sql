ALTER TABLE "companies"
  ADD COLUMN IF NOT EXISTS "operating_mode" text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS "pilot_allowlist" jsonb NOT NULL DEFAULT '[]'::jsonb;

