import sharp from 'sharp';
import {DomainError} from '../../contracts/src/index.js';
import type {ProviderInput} from './contracts.js';
export const RECRAFT_STYLES=['recraft-ai/recraft-v4-styles-svg','recraft-ai/recraft-v4-styles-pro-svg'];
export const RECRAFT_VECTORIZE='recraft-ai/recraft-vectorize';
export const QUIVER_MODELS=['arrow-2','arrow-2-telos'];
export const RECRAFT_SIZES=['1024x1024','1536x768','768x1536','1280x832','832x1280','1216x896','896x1216','1152x896','896x1152','832x1344','1280x896','896x1280','1344x768','768x1344'];
export function validateSvgInput(provider:string,input:ProviderInput){
 const fail=()=>{throw new DomainError('unsupported_svg_input','SVG input exceeds registered model capabilities',422)};
 const assets=input.assets??[],p=input.parameters??{},vector=input.capability==='image.vectorize';
 if(!['image.generate','image.vectorize'].includes(input.capability)||input.messages||input.tools||input.response_schema||input.instructions)fail();
 if(vector?(!!input.input||assets.length!==1):(!input.input.trim()||Buffer.byteLength(input.input)>10000))fail();
 if(assets.some(a=>!['image/png','image/jpeg','image/webp'].includes(a.content_type)||!a.bytes?.length||a.bytes.length>(provider==='replicate'?5000000:12582912)))fail();
 if(provider==='replicate'){
  if(vector?input.model!==RECRAFT_VECTORIZE:!RECRAFT_STYLES.includes(input.model)||assets.length<1||assets.length>10)fail();
  if(Object.keys(p).some(k=>!(vector?[]:['size','style_match']).includes(k)))fail();
  if(p.style_match!==undefined&&!['precise','flexible'].includes(String(p.style_match)))fail();
  const sizes=input.model===RECRAFT_STYLES[1]?RECRAFT_SIZES.map(s=>s.split('x').map(n=>Number(n)*2).join('x')):RECRAFT_SIZES;
  if(p.size!==undefined&&!sizes.includes(String(p.size)))fail();
 }else if(provider==='quiver'){
  if(!QUIVER_MODELS.includes(input.model)||assets.length>16||Object.keys(p).some(k=>!(vector?['auto_crop','temperature','top_p']:['reasoning_effort','temperature','top_p']).includes(k)))fail();
  if(!Number.isSafeInteger(input.max_output_tokens)||input.max_output_tokens!<1||input.max_output_tokens!>65536)fail();
  if(p.auto_crop!==undefined&&typeof p.auto_crop!=='boolean'||p.reasoning_effort!==undefined&&!['low','medium','high','xhigh'].includes(String(p.reasoning_effort)))fail();
  for(const [key,max] of [['temperature',2],['top_p',1]] as const)if(p[key]!==undefined&&(typeof p[key]!=='number'||!Number.isFinite(p[key])||Number(p[key])<0||Number(p[key])>max))fail();
 }else fail();
}

/** Verify the exact bytes before submission; original references are never silently resized. */
export async function validateSvgAssets(provider:string,input:ProviderInput){
 validateSvgInput(provider,input);
 for(const asset of input.assets??[]){
  try{const decoder=sharp(asset.bytes,{failOn:'warning',limitInputPixels:16777216,animated:false});const m=await decoder.metadata();
   if(!m.width||!m.height||m.width>4096||m.height>4096||(m.pages??1)>1||asset.content_type!==`image/${m.format}`||provider==='replicate'&&input.capability==='image.vectorize'&&Math.min(m.width,m.height)<256)throw new Error('invalid');
   await decoder.raw().toBuffer();
  }catch{throw new DomainError('invalid_asset','SVG reference exceeds model bounds or cannot be decoded',422);}
 }
}
