import {it,expect} from 'vitest';
import sharp from 'sharp';
import {prepareImage} from '../src/prepare-model-assets.js';
import {contentHash} from '../../storage/src/index.js';
const policy={max_assets:16,max_edge:4096,format:'png' as const};
it.each(['jpeg','png','webp'] as const)('UI-A10 preserves exact %s bytes and EXIF by default',async format=>{
 const original=await sharp({create:{width:91,height:37,channels:3,background:'#abcdef'}}).withMetadata({orientation:6}).toFormat(format).toBuffer();
 const result=await prepareImage(original,`image/${format}`,policy);
 expect(contentHash(result.bytes)).toBe(contentHash(original));expect(result.metadata.orientation).toBe(6);expect(result.metadata.width).toBe(91);
});
it('UI-A10 transforms only when explicitly requested and rotates only with auto_orient',async()=>{
 const original=await sharp({create:{width:91,height:37,channels:3,background:'#abcdef'}}).withMetadata({orientation:6}).jpeg().toBuffer();
 const result=await prepareImage(original,'image/jpeg',{...policy,mode:'transform',max_edge:50,auto_orient:true});
 expect(contentHash(result.bytes)).not.toBe(contentHash(original));expect(result.metadata.format).toBe('png');expect(result.metadata.height).toBe(50);
});
it('UI-A10 rejects media mismatch and corrupt or oversized originals',async()=>{
 const original=await sharp({create:{width:91,height:37,channels:3,background:'#abcdef'}}).png().toBuffer();
 await expect(prepareImage(original,'image/jpeg',policy)).rejects.toMatchObject({code:'invalid_asset'});
 await expect(prepareImage(original,'image/png',{...policy,max_edge:50})).rejects.toMatchObject({code:'unsupported_reference_size'});
 await expect(prepareImage(original.subarray(0,20),'image/png',policy)).rejects.toMatchObject({code:'invalid_asset'});
});
