-- Local development roles. The POSTGRES_USER remains an admin used only by
-- initialization and TEST_DATABASE_ADMIN_URL; application traffic uses the
-- runtime role and migrations use the migration role.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'sovara_migration') THEN
    CREATE ROLE sovara_migration LOGIN PASSWORD 'sovara_migration';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'sovara_runtime') THEN
    CREATE ROLE sovara_runtime LOGIN PASSWORD 'sovara_runtime';
  END IF;
END
$$;

ALTER DATABASE sovara OWNER TO sovara_migration;
\connect sovara

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON DATABASE sovara FROM PUBLIC;
ALTER SCHEMA public OWNER TO sovara_migration;
GRANT CONNECT ON DATABASE sovara TO sovara_runtime;
GRANT USAGE ON SCHEMA public TO sovara_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE sovara_migration IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO sovara_runtime;
