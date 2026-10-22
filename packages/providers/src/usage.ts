import type { BillableItem, NormalizedUsage, ProviderInput, UsageConditions } from './contracts.js';
export const unknownUsage=(reason='missing_usage'):NormalizedUsage=>({state:'unknown',reason});
export const object=(v:unknown):Record<string,any> => v && typeof v==='object' && !Array.isArray(v) ? v as Record<string,any>:{};
export function counter(v:unknown):bigint|null { if(typeof v==='number' && Number.isSafeInteger(v) && v>=0) return BigInt(v); if(typeof v==='string' && /^(0|[1-9]\d*)$/.test(v)) return BigInt(v);return null; }
const item=(dimension:string,q:bigint,conditions?:UsageConditions):BillableItem=>({dimension,quantity:q.toString(),unit:'tokens',...(conditions?{conditions}:{})});
export function normalizeOpenAI(raw:unknown,input:ProviderInput):NormalizedUsage {
  const u=object(raw); const inputCount=counter(u.input_tokens), output=counter(u.output_tokens); if(inputCount===null || output===null) return unknownUsage();
  const d=object(u.input_tokens_details);
  if(input.capability==='image.generate' || input.capability==='image.edit') {
    const text=counter(d.text_tokens),image=counter(d.image_tokens);if(text===null || image===null || text+image!==inputCount) return unknownUsage('incomplete_image_usage');
    // Cached image tokens need modality-specific attribution. Never guess a split.
    if(counter(d.cached_tokens)!==null && counter(d.cached_tokens)!==0n) return unknownUsage('image_cache_split_unavailable');
    return {state:'known',items:[item('input.uncached',text,{modality:'text'}),item('input.uncached',image,{modality:'image'}),item('output.image',output,{modality:'image'})]};
  }
  const cached=counter(d.cached_tokens); if(cached===null) return unknownUsage('cache_read_unknown');
  // Current generation families report writes separately; omitted write counters are not guessed for them.
  const requiresWrites=/^gpt-(5\.6|6)(?:-|$)/.test(input.model);
  const writes=d.cache_write_tokens===undefined && !requiresWrites ? 0n:counter(d.cache_write_tokens);
  if(writes===null || cached+writes>inputCount) return unknownUsage('invalid_cache_breakdown');
  const items=[item('input.uncached',inputCount-cached-writes),item('input.cache_read',cached),item('output.text',output)];
  if(writes>0n) items.push(item('input.cache_write',writes,{cache_ttl:String(input.parameters?.prompt_cache_retention??'in_memory')}));
  if(input.model==='gpt-6-luna')for(const entry of items)entry.conditions={...entry.conditions,context_window:inputCount>272000n?'long':'short'};
  const reasoning=counter(object(u.output_tokens_details).reasoning_tokens);
  return {state:'known',items,...(reasoning!==null ? {breakdown:{reasoning_tokens:reasoning.toString()}}:{})};
}
export function normalizeAnthropic(raw:unknown):NormalizedUsage {
  const u=object(raw);const input=counter(u.input_tokens),output=counter(u.output_tokens),read=counter(u.cache_read_input_tokens),write=counter(u.cache_creation_input_tokens);
  if(input===null || output===null || read===null || write===null) return unknownUsage();
  const items=[item('input.uncached',input),item('input.cache_read',read),item('output.text',output)];
  if(write>0n) {
    const ttl=object(u.cache_creation); const five=counter(ttl.ephemeral_5m_input_tokens),hour=counter(ttl.ephemeral_1h_input_tokens);
    if(five===null || hour===null || five+hour!==write) return {state:'unknown',reason:'cache_write_ttl_unknown',partial_items:items};
    if(five>0n) items.push(item('input.cache_write',five,{cache_ttl:'5m'})); if(hour>0n) items.push(item('input.cache_write',hour,{cache_ttl:'1h'}));
  }
  return {state:'known',items};
}
