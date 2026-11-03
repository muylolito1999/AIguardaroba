import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import type {
  Message,
  MessageCreateParamsNonStreaming,
  MessageStreamEvent,
} from "@anthropic-ai/sdk/resources/messages";
import type {
  BatchCreateParams,
  MessageBatch,
  MessageBatchIndividualResponse,
} from "@anthropic-ai/sdk/resources/messages/batches";

import { aiEnv } from "@/env";

/** Per-request options we pass: the deadline signal and a request timeout. */
export type AnthropicRequestOptions = { signal?: AbortSignal; timeout?: number };

/** The part of a streamed message callStructured needs. */
export type MessageStreamLike = {
  finalMessage(): Promise<Message>;
  /** Available once the response headers arrived. */
  readonly request_id?: string | null | undefined;
  /**
   * Every SSE event with the message as streamed so far: callStructured keeps
   * the usage message_start reported, for an attempt that breaks off (D-163).
   */
  on(event: "streamEvent", listener: (event: MessageStreamEvent, snapshot: Message) => void): unknown;
};

/**
 * The slice of the SDK client that the AI layer uses: synchronous and
 * streamed messages plus Message Batches. Services take this type, so tests
 * inject test/fakes/anthropic.ts and the real client stays behind getAnthropic().
 */
export type AnthropicLike = {
  messages: {
    create(
      params: MessageCreateParamsNonStreaming,
      options?: AnthropicRequestOptions,
    ): Promise<Message & { _request_id?: string | null | undefined }>;
    stream(params: MessageCreateParamsNonStreaming, options?: AnthropicRequestOptions): MessageStreamLike;
    batches: {
      create(params: BatchCreateParams, options?: AnthropicRequestOptions): Promise<MessageBatch>;
      retrieve(batchId: string, params?: undefined, options?: AnthropicRequestOptions): Promise<MessageBatch>;
      results(
        batchId: string,
        params?: undefined,
        options?: AnthropicRequestOptions,
      ): Promise<AsyncIterable<MessageBatchIndividualResponse>>;
    };
  };
};

let instance: AnthropicLike | undefined;

/**
 * The shared SDK client, created on first use so the app builds and runs
 * without a key until something calls Claude (a missing key is a CONFIG
 * error here). The SDK's own retries are off: callStructured() is the only
 * retry loop, so attempts cannot multiply (D-019).
 */
export function getAnthropic(): AnthropicLike {
  instance ??= new Anthropic({ apiKey: aiEnv().ANTHROPIC_API_KEY, maxRetries: 0 });
  return instance;
}
