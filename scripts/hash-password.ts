// `pnpm hash-password [--with-secret] [--stdin]`
//
// Asks for the login password twice without echoing it and prints the line to
// put in .env.local and the Vercel dashboard:
//
//   APP_PASSWORD_HASH=<base64 of a bcrypt hash>
//
// --with-secret also prints SESSION_SECRET=<32 random bytes, base64url>.
// --stdin reads the password from the first line of standard input instead
// (for scripted use; nothing is echoed). Prompts and errors go to stderr, so
// stdout carries only the KEY=value lines. The plaintext is never printed.
// Runs under `tsx --conditions=react-server` (D-017).

import { randomBytes } from "node:crypto";

import { assertPasswordAcceptable, hashForEnv } from "@/lib/auth/password";
import { isAppError } from "@/lib/result";

class Cancelled extends Error {}

const CTRL_C = "\u0003";
const CTRL_D = "\u0004";
const BACKSPACE = "\u0008";
const DELETE = "\u007f";
const ESCAPE = "\u001b";

function promptHidden(question: string): Promise<string> {
  const input = process.stdin;
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (outcome: () => void) => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
      process.stderr.write("\n");
      outcome();
    };
    const onData = (chunk: string) => {
      // Arrow keys and other escape sequences arrive as one chunk; ignore them
      // rather than adding their printable tail to the password.
      if (chunk.startsWith(ESCAPE)) return;
      for (const char of chunk) {
        if (char === "\r" || char === "\n") return finish(() => resolve(value));
        if (char === CTRL_C || (char === CTRL_D && value === "")) return finish(() => reject(new Cancelled()));
        if (char === BACKSPACE || char === DELETE) value = [...value].slice(0, -1).join("");
        else if (char >= " ") value += char;
      }
    };
    process.stderr.write(question);
    input.setEncoding("utf8");
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

async function readFirstStdinLine(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString("utf8").split(/\r?\n/, 1)[0] ?? "";
}

async function readPassword(fromStdin: boolean): Promise<string> {
  if (fromStdin) return readFirstStdinLine();
  if (!process.stdin.isTTY) {
    throw new Error("No terminal to prompt on. Run it in a terminal, or pipe the password in with --stdin.");
  }
  const first = await promptHidden("Password: ");
  assertPasswordAcceptable(first);
  const second = await promptHidden("Repeat password: ");
  if (first !== second) throw new Error("The passwords do not match.");
  return first;
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const unrecognized = [...args].filter((arg) => arg !== "--stdin" && arg !== "--with-secret");
  if (unrecognized.length > 0) {
    throw new Error(`Unknown option ${unrecognized.join(", ")}. Options: --with-secret, --stdin.`);
  }

  const password = await readPassword(args.has("--stdin"));
  assertPasswordAcceptable(password);
  const encoded = await hashForEnv(password);

  console.log(`APP_PASSWORD_HASH=${encoded}`);
  if (args.has("--with-secret")) console.log(`SESSION_SECRET=${randomBytes(32).toString("base64url")}`);
}

main().catch((error: unknown) => {
  if (error instanceof Cancelled) {
    console.error("Cancelled.");
    process.exitCode = 130;
    return;
  }
  // Every message raised here describes a rule or a mismatch, never the input.
  if (isAppError(error)) console.error(`Password rejected: ${error.message}`);
  else console.error(error instanceof Error ? error.message : "hash-password failed.");
  process.exitCode = 1;
});
