import { ModelBindingSchema, ModelInputSnapshotSchema } from "@pchat/contracts";
import type { ModelBinding } from "@pchat/contracts";
import type { Cancellation, GenerationRequest, ModelChunk, ModelPort } from "@pchat/harness";
import type { JsonObject, SecureNetworkPort } from "./network";
import { AnswerStream } from "./answer-stream";
import { SseDecoder } from "./sse";
import { CancellationScope, closeStream } from "./cancellation";
import { parseDeepSeekFrame } from "./deepseek-frame";
import { renderDeepSeekPrompt } from "./deepseek-prompt";

export interface DeepSeekModelConfiguration {
  binding: ModelBinding;
  maxOutputTokens: number;
  temperature?: number;
  topP?: number;
}
export interface DeepSeekConfigurationResolver {
  resolve(binding: ModelBinding): DeepSeekModelConfiguration | undefined;
}
export interface DeepSeekOptions { network: SecureNetworkPort; configurations: DeepSeekConfigurationResolver }

export class DeepSeekModel implements ModelPort {
  constructor(private readonly options: DeepSeekOptions) {}

  async *generate(request: GenerationRequest, cancellation: Cancellation): AsyncIterable<ModelChunk> {
    let sent = false;
    const scope = new CancellationScope(cancellation);
    let responseStream: AsyncIterator<string> | undefined;
    let closed = false;
    const releaseResponse = () => { closeStream(responseStream); responseStream = undefined; };
    try {
      scope.check();
      const binding = ModelBindingSchema.parse(request.context.settings.model);
      const input = request.input ? ModelInputSnapshotSchema.parse(request.input) : null;
      const policy = input?.context.executionPolicy;
      if (input && (!policy || JSON.stringify(input.context) !== JSON.stringify(request.context) || JSON.stringify(input.evidence) !== JSON.stringify(request.evidence) ||
        JSON.stringify(policy.binding) !== JSON.stringify(binding) || input.audit.windowTokens !== policy.windowTokens || input.audit.outputReserveTokens !== policy.outputReserveTokens ||
        input.audit.policyVersion !== policy.policyVersion || input.audit.counterVersion !== policy.counterVersion || input.audit.promptVersion !== policy.promptVersion || input.audit.countMode !== policy.countMode ||
        input.audit.inputTokens > policy.windowTokens - policy.outputReserveTokens)) {
        yield { type: "failure", code: "REJECTED" }; return;
      }
      const config = this.options.configurations.resolve({ ...binding });
      if (!config || config.binding.connectionId !== binding.connectionId || config.binding.modelId !== binding.modelId || config.binding.configRevision !== binding.configRevision ||
        !Number.isSafeInteger(config.maxOutputTokens) || config.maxOutputTokens < 1 ||
        (config.temperature !== undefined && (!Number.isFinite(config.temperature) || config.temperature < 0 || config.temperature > 2)) ||
        (config.topP !== undefined && (!Number.isFinite(config.topP) || config.topP <= 0 || config.topP > 1))) {
        yield { type: "failure", code: "REJECTED" }; return;
      }
      const body: JsonObject = {
        model: binding.modelId,
        stream: true, response_format: { type: "json_object" }, max_tokens: policy?.outputReserveTokens ?? config.maxOutputTokens,
        ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
        ...(config.topP !== undefined ? { top_p: config.topP } : {}),
        messages: renderDeepSeekPrompt(input ?? { context: request.context, evidence: request.evidence, checkpoint: null }),
      };
      scope.check();
      sent = true;
      const pendingResponse = this.options.network.request({ operation: "deepseek.chat", connectionId: binding.connectionId, attemptId: request.attemptId, body }, cancellation).then((response) => {
        if (response.ok) {
          responseStream = response.body[Symbol.asyncIterator]();
          if (closed || cancellation.cancelled) releaseResponse();
        }
        return response;
      });
      void pendingResponse.catch(() => {});
      const response = await scope.wait(pendingResponse);
      if (!response.ok) { yield { type: "failure", code: response.code === "REJECTED" ? "REJECTED" : "OUTCOME_UNKNOWN" }; return; }
      if (!responseStream) throw new Error("Missing response stream");
      if (response.status !== 200) {
        let chars = 0;
        while (true) {
          const next = await scope.wait(responseStream.next());
          if (next.done) break;
          chars += next.value.length;
          if (chars > 8_000_000) throw new Error("Response limit");
        }
        yield { type: "failure", code: Number.isInteger(response.status) && response.status >= 400 && response.status < 500 ? "REJECTED" : "OUTCOME_UNKNOWN" };
        return;
      }
      const sse = new SseDecoder(8_000_000, 1_000_000);
      const answerStream = new AnswerStream(2_000_000);
      let finishReason: string | null = null;
      while (true) {
        const next = await scope.wait(responseStream.next());
        if (next.done) break;
        for (const data of sse.push(next.value)) {
          scope.check();
          if (data === "[DONE]") {
            if (finishReason !== "stop") {
              yield { type: "failure", code: finishReason === "length" || finishReason === "content_filter" || finishReason === "tool_calls" ? "REJECTED" : "OUTCOME_UNKNOWN" };
              return;
            }
            const answer = answerStream.finish();
            yield { type: "complete", answer };
            return;
          }
          const frame = parseDeepSeekFrame(data);
          if (!frame) continue;
          if (finishReason !== null) throw new Error("Data after terminal frame");
          if (frame.content) {
            const text = answerStream.push(frame.content);
            if (text) yield { type: "delta", text };
          }
          finishReason = frame.finishReason;
        }
      }
      yield { type: "failure", code: "OUTCOME_UNKNOWN" };
    } catch {
      yield { type: "failure", code: sent ? "OUTCOME_UNKNOWN" : "REJECTED" };
    } finally {
      closed = true;
      scope.close();
      releaseResponse();
    }
  }
}
