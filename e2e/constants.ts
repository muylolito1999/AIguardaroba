// Fixed values for local e2e runs only. None of them is a secret: the password
// unlocks nothing but the throwaway server Playwright starts, and the database
// credentials are the fixed local ones from docker-compose.yml.

/** The e2e server's password; playwright.config.ts hashes it into APP_PASSWORD_HASH. */
export const E2E_PASSWORD = "e2e-correct-horse-battery";

/** The Docker database the e2e server uses, so runs can truncate it freely (D-003). */
export const E2E_DATABASE_URL = "postgres://wardrobe:wardrobe@localhost:5433/wardrobe_e2e";
