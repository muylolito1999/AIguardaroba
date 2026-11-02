import "server-only";

import { unstable_rethrow } from "next/navigation";
import type { z } from "zod";

import { requireSession, type Session } from "@/lib/auth/dal";
import type { Result } from "@/lib/result";
import { errFromThrown, formDataToObject, publicErr, validationErr } from "@/server/http";

// Not a 'use server' module itself: it exports a plain function, which such a
// module may not. Action files use it like this:
//
//   'use server'
//   export const setDecision = authedAction(setDecisionSchema, async (input) => {
//     return updateDecision(getDb(), input)
//   })
//
// Next accepts that export because the value is an async function.

export type AuthedActionContext = { session: Session };

/**
 * Wraps a Server Action that returns a Result: session check first, then zod
 * validation of the argument (a FormData argument is read as a plain object),
 * then `fn`. Thrown AppErrors become Err results; anything else is logged and
 * returned as INTERNAL, and CONFIG details never reach the client (D-053).
 * redirect() and notFound() inside `fn` still work.
 */
export function authedAction<S extends z.ZodType, T>(
  schema: S,
  fn: (input: z.output<S>, context: AuthedActionContext) => Promise<Result<T>>,
  options: { name?: string } = {},
): (input: z.input<S> | FormData) => Promise<Result<T>> {
  const where = `action ${options.name ?? (fn.name || "anonymous")}`;
  return async (input) => {
    try {
      const session = await requireSession();
      const parsed = schema.safeParse(input instanceof FormData ? formDataToObject(input) : input);
      if (!parsed.success) return validationErr(parsed.error);
      const result = await fn(parsed.data, { session });
      return result.ok ? result : publicErr(result, where);
    } catch (error) {
      unstable_rethrow(error);
      return errFromThrown(error, where);
    }
  };
}
