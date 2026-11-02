-- Runs once, when the container starts with an empty data volume (the
-- postgres image's /docker-entrypoint-initdb.d hook). POSTGRES_DB already
-- created "wardrobe" for local development; Playwright gets its own database
-- so e2e runs can truncate freely (D-003).
CREATE DATABASE wardrobe_e2e OWNER wardrobe;
