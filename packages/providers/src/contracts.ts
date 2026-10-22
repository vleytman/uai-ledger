import type {z} from 'zod';
import type {ToolDefinition,ToolChoice} from '../../contracts/invocation.js';
export type ProviderBlock=z.infer<typeof import('../../contracts/invocation.js').ContentBlock>;
export type ToolCall=z.infer<typeof import('../../contracts/invocation.js').ToolCallRecord>;
export type Capability = 'embeddings.generate' | 'api.call' | 'text.generate' | 'image.generate' | 'image.vectorize' | 'image.edit' | 'speech.synthesize' | 'search';
export type UsageConditions = Readonly<Record<string, string>>;
export interface BillableItem { dimension: string; quantity: string; unit: string; conditions?: UsageConditions }
export type NormalizedUsage = ({ state: 'known'; items: BillableItem[]; breakdown?: Record<string, string> } | { state: 'unknown'; reason: string; partial_items?: BillableItem[] }) & {model_identity?:{requested:string;actual?:string}};
export interface UsageObservation { event_id: string; kind: 'final' | 'cumulative' | 'delta'; revision: number; usage: NormalizedUsage; provider_request_id?: string; raw_usage: unknown }
export type FailureKind = 'transient' | 'auth' | 'quota' | 'invalid' | 'defect' | 'unknown' | 'canceled' | 'refused';
/** billable=false: the provider refused before doing any work and does not charge for it. Omitted means the cost is unknown. */
export interface ProviderFailure { kind: FailureKind; code: string; retry_after_ms?: number; safe_to_retry?: boolean; billable?: boolean; sent: boolean; validation?:{path:string;reason:string} }
export interface ProviderInput {
 stream?:boolean; parallel_tool_calls?:boolean; service_mode?:'standard';
 tool_execution?:'native'|'schema';
 texts?:string[]; structured?:Record<string,unknown>; api_operation?:import('../../contracts/paid-api.js').ServiceOperation;
  output_limit_policy?:'provider_default'; capability: Capability; model: string; input: string; messages?: {role: 'user'|'assistant'|'system'; content: string|ProviderBlock[]}[]; tools?:z.infer<typeof ToolDefinition>[]; tool_choice?:z.infer<typeof ToolChoice>; instructions?: string; response_schema?: {name: string; schema: Record<string, unknown>}; assets?: {content_type: string; bytes: Uint8Array; filename: string}[]; parameters?: Record<string, unknown>; max_output_tokens?: number }
export interface RateLimitObservation {sent_at:string;received_at:string;status:number;headers:Record<string,string>}
export interface AdapterContext { onRateLimits?(observation:RateLimitObservation):Promise<void>; attempt_id: string; /** Stable across a retry of a timed-out call; adapters with idempotency send it to the provider. */ idempotency_key?: string; signal?: AbortSignal; onDelta?(delta: string): Promise<void>; onRemoteJob?(jobId:string):Promise<void>; onUsage(observation: UsageObservation): Promise<void> }
export type ProviderResult = ({outcome:'refused';refusal:string;failure:ProviderFailure;usage:NormalizedUsage;provider_request_id?:string} | { outcome: 'success'; output: { content_type: string; text?: string; bytes?: Uint8Array; tool_call?:ToolCall; tool_calls?:ToolCall[]; embeddings?:import('./embeddings.js').EmbeddingBatch }; usage: NormalizedUsage; provider_request_id?: string } | { outcome: 'failure'; failure: ProviderFailure; usage: NormalizedUsage; provider_request_id?: string } | { outcome: 'unknown'; failure: ProviderFailure; usage: NormalizedUsage; provider_request_id?: string }) & {limit_usage?:LimitUsage};
export interface AdapterCapabilities { text_usage?:{estimated_actual:boolean;output_limit:'required'|'provider_default'}; operations: Capability[]; streaming: boolean; native_jobs: boolean; lookup: boolean; cancel: boolean; idempotency: boolean; usage: boolean; read_usage: boolean; read_costs: boolean; read_balance: boolean }
export interface UsageEstimate { confidence: 'conservative' | 'unavailable'; maximum: NormalizedUsage }
export interface LimitUsage {[metric:string]:number|undefined;requests:number;tokens?:number;input_tokens?:number;output_tokens?:number;images?:number;audio_seconds?:number}
export interface LimitEstimateOptions {expected_output_tokens?:number}
export interface ProviderAdapter {
  readonly id: string;
  readonly capabilities: AdapterCapabilities;
  validate(input: ProviderInput): void;
  estimateUsage(input: ProviderInput): UsageEstimate;
  estimateLimitUsage(input: ProviderInput,options?:LimitEstimateOptions): LimitUsage;
  normalizeUsage(raw: unknown, input: ProviderInput): NormalizedUsage;
  classifyFailure(status: number | undefined, body?: unknown, headers?: Headers): ProviderFailure;
  readRateLimits(headers: Headers): Record<string, string>;
  execute(input: ProviderInput, context: AdapterContext): Promise<ProviderResult>;
  submitNative?(input:ProviderInput,context:AdapterContext):Promise<{job_id:string}>;
  lookupNative?(jobId:string,context:AdapterContext):Promise<ProviderResult|{outcome:'pending'}>;
  cancelNative?(jobId:string,context:AdapterContext):Promise<void>;
  verifyNativeWebhook?(body:Uint8Array,headers:Record<string,string>):Promise<{job_id:string;event_id:string;result:ProviderResult}>;
}
