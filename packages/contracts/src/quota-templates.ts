/** Public baselines, not confirmation of a particular OpenAI project's limits. */
export interface QuotaTemplate {
 id:string;name:string;provider:string;capability:string;models:string[];
 source:string;checked_at:string;
 rules:{key:string;metric:'requests'|'tokens'|'images';capacity:string;provider_capacity:string;window_ms:number}[];
}
const model=(id:string,name:string,tokens:string,count:string,image=false,snapshots:string[]=[]):QuotaTemplate=>({
 id:`openai-tier4-${id}`,name:`${name} · Tier 4`,provider:'openai',capability:image?'image.generate':'text.generate',models:[id,...snapshots],
 source:`https://developers.openai.com/api/docs/models/${id} · Public Tier 4 baseline; verify project overrides and shared limits separately`,
 checked_at:'2026-09-20T00:00:00.000Z',
 rules:[{key:image?'ipm':'rpm',metric:image?'images':'requests',capacity:count,provider_capacity:count,window_ms:60000},{key:'tpm',metric:'tokens',capacity:tokens,provider_capacity:tokens,window_ms:60000}],
});
export const openaiTier4QuotaTemplates:QuotaTemplate[]=[
 {...model('gpt-6-luna','GPT-6 Luna','10000000','10000'),checked_at:'2026-09-26T00:00:00.000Z'},
 model('gpt-5.6-sol','GPT-5.6 Sol','4000000','10000',false,['gpt-5.6']),
 model('gpt-5.6-terra','GPT-5.6 Terra','4000000','10000'),
 model('gpt-4.1','GPT-4.1','2000000','10000',false,['gpt-4.1-2025-04-14']),
 model('gpt-4.1-nano','GPT-4.1 nano','10000000','10000',false,['gpt-4.1-nano-2025-04-14']),
 model('gpt-image-2','GPT-Image 2','3000000','150',true,['gpt-image-2-2026-04-21']),
 model('gpt-image-2.5-sunburst','GPT-Image 2.5 Sunburst','3000000','150',true,['gpt-image-2.5-sunburst-2026-09-08']),
 model('gpt-image-2.5-flare','GPT-Image 2.5 Flare','3000000','150',true,['gpt-image-2.5-flare-2026-09-08']),
];
/** Public reference only. Confirm account settings before applying; keys share one account group. */
export const typesafeQuotaTemplate:QuotaTemplate={
 id:'typesafe-jev-1.13',name:'TypeSafe Jev 1.13',provider:'typesafe',capability:'api.call',models:['typesafe.systemone'],
 source:'https://docs.typesafe.ai/models · Dynamic public limits; verify the provider account allocation before applying',checked_at:'2026-09-26T00:00:00.000Z',
 rules:[{key:'rpm',metric:'requests',capacity:'1200',provider_capacity:'1200',window_ms:60000},{key:'tps',metric:'tokens',capacity:'250000',provider_capacity:'250000',window_ms:1000}],
};
