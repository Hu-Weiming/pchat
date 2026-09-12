import type { Answer, Cancellation, Clock, Evidence, GenerationRequest, IdGenerator, ModelChunk, ModelPort, RAGPort, RetrievalRequest, RetrievalResult } from "@pchat/harness";
import { clone } from "./clone";
import { testEvidence } from "./fixtures";

export class FakeClock implements Clock {
  constructor(private time = 1_000) {}
  now(): number { return this.time; }
  advance(milliseconds = 1): number { this.time += milliseconds; return this.time; }
}

let idInstance = 0;
export class FakeId implements IdGenerator {
  private sequence = 0;
  constructor(private readonly prefix = `fake-${++idInstance}`) {}
  next(): string { return `${this.prefix}-${++this.sequence}`; }
}

export class FakeRAGCall {
  readonly request: RetrievalRequest;
  readonly result: Promise<RetrievalResult>;
  private resolve!: (result: RetrievalResult) => void;
  private rejectResult!: (error: Error) => void;
  private finished = false;

  constructor(request: RetrievalRequest, readonly cancellation: Cancellation) {
    this.request = clone(request);
    this.result = new Promise((resolve, reject) => { this.resolve = resolve; this.rejectResult = reject; });
  }

  complete(evidence: Evidence[] = [{
    ...testEvidence, corpusId: this.request.corpusId, corpusRevision: this.request.corpusRevision,
  }]): void {
    this.finish({ ok: true, evidence });
  }

  unknown(): void { this.finish({ ok: false, code: "OUTCOME_UNKNOWN" }); }
  reject(): void { this.finish({ ok: false, code: "REJECTED" }); }

  throw(error = new Error("Fake retrieval adapter failure")): void {
    if (this.finished) throw new Error("The fake retrieval call has already finished.");
    this.finished = true;
    this.rejectResult(error);
  }

  private finish(result: RetrievalResult): void {
    if (this.finished) throw new Error("The fake retrieval call has already finished.");
    this.finished = true;
    this.resolve(clone(result));
  }
}

export class FakeRAG implements RAGPort {
  readonly calls: FakeRAGCall[] = [];
  private heldCalls = 0;

  holdNext(): void { this.heldCalls++; }

  retrieve(request: RetrievalRequest, cancellation: Cancellation): Promise<RetrievalResult> {
    const call = new FakeRAGCall(request, cancellation);
    this.calls.push(call);
    if (this.heldCalls > 0) this.heldCalls--;
    else call.complete();
    return call.result;
  }
}

/** Cancellation is observable but deliberately does not suppress late provider data. */
export class FakeModelCall implements AsyncIterable<ModelChunk> {
  readonly request: GenerationRequest;
  private readonly chunks: ModelChunk[] = [];
  private finished = false;
  private wake: (() => void) | undefined;
  private failure: Error | undefined;

  constructor(request: GenerationRequest, readonly cancellation: Cancellation) {
    this.request = clone(request);
  }

  delta(text: string): void {
    this.push({ type: "delta", text });
  }

  complete(answer: Answer = {
    text: `A test paraphrase about: ${this.request.context.question.text}`,
    kind: "PARAPHRASE", evidenceIds: this.request.evidence.map((evidence) => evidence.id),
  }): void {
    this.push({ type: "complete", answer }, true);
  }

  unknown(): void { this.push({ type: "failure", code: "OUTCOME_UNKNOWN" }, true); }
  reject(): void { this.push({ type: "failure", code: "REJECTED" }, true); }

  throw(error = new Error("Fake model adapter failure")): void {
    if (this.finished) throw new Error("The fake model call has already finished.");
    this.finished = true;
    this.failure = error;
    this.wake?.();
  }

  private push(chunk: ModelChunk, terminal = false): void {
    if (this.finished) throw new Error("The fake model call has already finished.");
    this.chunks.push(clone(chunk));
    this.finished = terminal;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<ModelChunk> {
    while (true) {
      const chunk = this.chunks.shift();
      if (chunk) { yield chunk; continue; }
      if (this.failure) throw this.failure;
      if (this.finished) return;
      await new Promise<void>((resolve) => { this.wake = resolve; });
      this.wake = undefined;
    }
  }
}

export class FakeModel implements ModelPort {
  readonly calls: FakeModelCall[] = [];
  private heldCalls = 0;

  holdNext(): void { this.heldCalls++; }

  generate(request: GenerationRequest, cancellation: Cancellation): AsyncIterable<ModelChunk> {
    const call = new FakeModelCall(request, cancellation);
    this.calls.push(call);
    if (this.heldCalls > 0) this.heldCalls--;
    else call.complete();
    return call;
  }
}
