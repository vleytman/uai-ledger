/** Formula and bounds verified against OpenAI's public image calculator on 2026-09-19.
 * https://developers.openai.com/api/docs/guides/image-generation#cost-and-latency
 * These are output estimates, not provider promises or customer markup. */
export const imageRatios=[[1,1],[4,3],[3,4],[3,2],[2,3],[16,9],[9,16],[2,1],[1,2],[21,9]] as const;
export function validImageSize(width:number,height:number){return Number.isInteger(width)&&Number.isInteger(height)&&width>0&&height>0&&width%16===0&&height%16===0&&Math.max(width,height)<=3840&&Math.max(width,height)<=3*Math.min(width,height)&&width*height>=655360&&width*height<=8294400;}
export function imagePresets(){return [1024,2048,3840].flatMap((edge,index)=>imageRatios.map(([w,h])=>{const width=w>=h?edge:Math.round(edge*w/h/16)*16,height=h>=w?edge:Math.round(edge*h/w/16)*16;return {tier:['1K','2K','4K'][index],ratio:`${w}:${h}`,size:`${width}x${height}`,supported:validImageSize(width,height)};}));}
export function imageOutputTokens(model:string,size:string,quality:string){
 const [width,height]=size.split('x').map(Number);if(!validImageSize(width,height))throw new Error('Unsupported image size');
 const grid=(model.startsWith('gpt-image-2.5')?{low:16,medium:24,high:48,xhigh:64,max:96}:{low:16,medium:48,high:96}) as Record<string,number>;
 const edge=grid[quality];if(!edge)throw new Error('Unsupported image quality');
 // Round the short grid edge to nearest integer, ties to even.
 const short=edge*Math.min(width,height)/Math.max(width,height),floor=Math.floor(short);
 const rounded=short-floor===0.5?floor+floor%2:Math.round(short);
 return Math.ceil(edge*rounded*(2000000+width*height)/4000000);
}

/** Area-based resolution tiers, clamped to the provider's edge and pixel limits.
 * 4K means up to 3840x2160 pixels, not a 3840-square image. Legacy presets stay unchanged. */
export function demoImagePresets(){
 return [1024*1024,2048*2048,3840*2160].flatMap((area,index)=>imageRatios.map(([w,h])=>{
  const ratio=w/h,scale=Math.min(1,3840/Math.sqrt(area*Math.max(ratio,1/ratio)));
  const width=Math.floor(Math.sqrt(area*ratio)*scale/16)*16,height=Math.floor(Math.sqrt(area/ratio)*scale/16)*16;
  return {tier:['1K','2K','4K'][index],ratio:`${w}:${h}`,size:`${width}x${height}`,supported:validImageSize(width,height)};
 }));
}
