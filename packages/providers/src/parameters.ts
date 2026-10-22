import type {Capability} from './contracts.js';

/** The same allowlist governs publication and the actual HTTP adapters. */
const supported:Record<string,Partial<Record<Capability,readonly string[]>>>={
 cerebras:{'text.generate':['temperature','top_p','seed','reasoning_effort']},
 groq:{'text.generate':['temperature','top_p','seed','reasoning_effort']},
 google_cloud:{'text.generate':['temperature','top_p','seed','thinking_level']},
 replicate:{'image.generate':['size','style_match'],'image.vectorize':[]},
 quiver:{'image.generate':['max_output_tokens','reasoning_effort','temperature','top_p'],'image.vectorize':['max_output_tokens','auto_crop','temperature','top_p']},
 voyage:{'embeddings.generate':['dimensions','input_type']},
 openai:{'embeddings.generate':['dimensions'],'text.generate':['temperature','service_tier','reasoning','reasoning_effort','prompt_cache_retention','prompt_cache_key'],'image.generate':['size','quality','background','output_format']},
 anthropic:{'text.generate':['temperature','service_tier']},
 cartesia:{'speech.synthesize':['voice','output_format','language','generation_config']},
 serper:{search:['gl','hl','num','page']},
};
export function providerParameters(provider:string,capability:Capability):readonly string[]|undefined{return supported[provider]?.[capability]}
export function registeredHttpProvider(provider:string){return Object.hasOwn(supported,provider)}
