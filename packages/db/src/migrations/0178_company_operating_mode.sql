ALTER TABLE "companies"
  ADD COLUMN IF NOT EXISTS "operating_mode" text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS "pilot_allowlist" jsonb NOT NULL DEFAULT '[]'::jsonb;

DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM "pg_constraint" WHERE "conname" = 'companies_operating_mode_check') THEN
		ALTER TABLE "companies"
			ADD CONSTRAINT "companies_operating_mode_check"
			CHECK ("operating_mode" IN ('active', 'frozen', 'pilot'));
	END IF;
END $$;
