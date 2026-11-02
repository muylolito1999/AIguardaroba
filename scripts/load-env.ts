import { loadEnvConfig } from "@next/env";

// Side-effect module: loads .env.local (and the other .env files Next would
// load) into process.env the same way `next start` does. Scripts import it
// first, before anything that reads the environment.
loadEnvConfig(process.cwd());
