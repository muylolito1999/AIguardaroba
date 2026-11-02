import "server-only";

import { modelLabel, type TaggingSetup } from "@/components/add/cost-quote";
import { aiSettingsEnv } from "@/env";
import { getBudgetStatus } from "@/lib/ai/budget";
import { estimateTaggingDryRunUsd, taggingCostRates } from "@/lib/ai/cost";
import { requireSession } from "@/lib/auth/dal";
import type { Db } from "@/lib/db/client";
import { AppError, ok, toErrorPayload, type Result } from "@/lib/result";

/**
 * The tagging model, its per-item rates and the month's budget, for the add
 * and review pages. The client components cannot load the pricing table
 * (D-074), so they get these numbers and extend them to any count. Throws
 * CONFIG for an invalid model or budget setting; needs no API key (D-064).
 */
export async function getTaggingSetup(db: Db, now: Date): Promise<TaggingSetup> {
  await requireSession();
  const model = aiSettingsEnv().models.tagging;
  const budget = await getBudgetStatus(db, now);
  return {
    model: { id: model, label: modelLabel(model) },
    costQuote: {
      standard: taggingCostRates(model),
      batch: taggingCostRates(model, { batch: true }),
      dryRunUsd: estimateTaggingDryRunUsd(model),
    },
    budget: { budgetUsd: budget.budgetUsd, remainingUsd: budget.remainingUsd, resetsAt: budget.resetsAt },
  };
}

/**
 * getTaggingSetup for a page that works without tagging: a CONFIG error (an
 * invalid model or budget setting) becomes an Err with the safe message, so
 * only the tagging controls are disabled while uploads keep working. It is
 * logged here, because the payload hides what is wrong. Anything else (no
 * session, a database failure) still throws.
 */
export async function getTaggingSetupResult(db: Db, now: Date): Promise<Result<TaggingSetup>> {
  await requireSession();
  try {
    return ok(await getTaggingSetup(db, now));
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== "CONFIG") throw error;
    console.error("[tagging-setup] the tagging settings could not be read:", error);
    return { ok: false, error: toErrorPayload(error) };
  }
}
