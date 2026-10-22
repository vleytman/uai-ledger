import {TypeSafeAdapter} from './typesafe.js';
import {CerebrasAdapter,GroqAdapter} from './chat-completions.js';
import {GoogleCloudAdapter} from './google-cloud.js';
import {ReplicateAdapter} from './replicate.js';
import {QuiverAdapter} from './quiver.js';
import {SerperApiAdapter} from './serper-api.js';
import {VoyageAdapter} from './voyage.js';
import {FirecrawlAdapter} from './firecrawl.js';
import {DomainError} from '../../contracts/src/index.js';
import {FakeAdapter,OpenAIAdapter,AnthropicAdapter,CartesiaAdapter,SerperAdapter,type AdapterOptions} from './index.js';
import type {Capability} from './contracts.js';
// Keep existing versions executable while accepted operations reference them.
const registry={
 'typesafe@1':{provider:'typesafe',capabilities:['api.call'],create:(o:AdapterOptions)=>new TypeSafeAdapter(o)},
 'cerebras@1':{provider:'cerebras',capabilities:['text.generate'],create:(o:AdapterOptions)=>new CerebrasAdapter(o)},
 'groq@1':{provider:'groq',capabilities:['text.generate'],create:(o:AdapterOptions)=>new GroqAdapter(o)},
 'google_cloud@1':{provider:'google_cloud',capabilities:['text.generate'],create:(o:AdapterOptions)=>new GoogleCloudAdapter(o)},
 'replicate@1':{provider:'replicate',capabilities:['image.generate','image.vectorize'],create:(o:AdapterOptions)=>new ReplicateAdapter(o)},
 'quiver@1':{provider:'quiver',capabilities:['image.generate','image.vectorize'],create:(o:AdapterOptions)=>new QuiverAdapter(o)},
 'voyage@1':{provider:'voyage',capabilities:['embeddings.generate'],create:(o:AdapterOptions)=>new VoyageAdapter(o)},
 'fake@1':{provider:'fake',capabilities:['text.generate','image.generate','speech.synthesize','search','api.call'],create:(_o:AdapterOptions)=>new FakeAdapter([])},
 'serper-api@1':{provider:'serper',capabilities:['api.call'],create:(o:AdapterOptions)=>new SerperApiAdapter(o)},
 'firecrawl@1':{provider:'firecrawl',capabilities:['api.call'],create:(o:AdapterOptions)=>new FirecrawlAdapter(o)},
 'synthetic@1':{provider:'fake',capabilities:['api.call'],create:(_o:AdapterOptions)=>new FakeAdapter([])},
 'openai@1':{provider:'openai',capabilities:['embeddings.generate','text.generate','image.generate'],create:(o:AdapterOptions)=>new OpenAIAdapter(o)},
 'anthropic@1':{provider:'anthropic',capabilities:['text.generate'],create:(o:AdapterOptions)=>new AnthropicAdapter(o)},
 'cartesia@1':{provider:'cartesia',capabilities:['speech.synthesize'],create:(o:AdapterOptions)=>new CartesiaAdapter(o)},
 'serper@1':{provider:'serper',capabilities:['search'],create:(o:AdapterOptions)=>new SerperAdapter(o)},
} as const;
export function adapterDefinition(ref:string,provider:string,capabilities:Capability[]=[]){
 const entry=Object.hasOwn(registry,ref)?registry[ref as keyof typeof registry]:undefined;
 if(!entry||entry.provider!==provider||capabilities.some(c=>!(entry.capabilities as readonly string[]).includes(c)))throw new DomainError('incompatible_adapter','Adapter version or capability is not registered.',422);
 return entry;
}
export function createRegisteredAdapter(provider:string,options:AdapterOptions,ref=`${provider}@1`){return adapterDefinition(ref,provider).create(options);}
