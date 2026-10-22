import type {AttemptEvent,DeltaEvent} from './generated/types.js';
export class AttemptCursor {
 number=0;generation=0n;sequence=0;attemptId='';incomplete=false;
 accept(event:AttemptEvent|DeltaEvent):Array<AttemptEvent|DeltaEvent>{
  const generation=BigInt(event.generation);
  if(event.attempt_number<this.number||event.attempt_number===this.number&&generation<this.generation)return [];
  const changed=event.attempt_number>this.number||generation>this.generation;
  const output:Array<AttemptEvent|DeltaEvent>=[];
  if(changed){
   this.number=event.attempt_number;this.generation=generation;this.sequence=0;this.attemptId=event.attempt_id;
   this.incomplete=event.type==='delta'||!!event.gap;
   output.push({type:'attempt',request_id:event.request_id,attempt_id:event.attempt_id,attempt_number:event.attempt_number,generation:event.generation,gap:this.incomplete});
  }
  if(event.attempt_id!==this.attemptId)return [];
  if(event.type==='attempt'){
   if(event.gap)this.incomplete=true;
   if((event.sequence??0)>this.sequence){this.sequence=event.sequence!;this.incomplete=true;}
   if(output.length)output[0]={...output[0],sequence:this.sequence,gap:this.incomplete} as AttemptEvent;
   return output;
  }
  if(event.sequence<=this.sequence)return output;
  if(event.sequence!==this.sequence+1)this.incomplete=true;
  this.sequence=event.sequence;output.push(event);return output;
 }
}
export async function* sseData(response:Response):AsyncGenerator<unknown>{
 if(!response.body)throw new Error('Missing SSE stream');
 const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
 try{while(true){
  const chunk=await reader.read();buffer+=decoder.decode(chunk.value,{stream:!chunk.done});buffer=buffer.replace(/\r\n/g,'\n');
  if(buffer.length>1048576)throw new Error('SSE frame too large');
  let boundary:number;while((boundary=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);const data=frame.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');if(data)yield JSON.parse(data);}
  if(chunk.done)break;
 }}finally{try{await reader.cancel()}finally{reader.releaseLock()}}
}
