/** Incremental JSON string selection. No complete document or private value is retained. */
export class JsonFieldParser {
 private decoder=new TextDecoder('utf-8',{fatal:true});
 private stack:Array<{kind:'object'|'array';path:string;state:'key'|'colon'|'value'|'comma';key:string;index:number}>=[];
 private root=false;
 private string?:{key:boolean;path:string;value:string;escape:boolean;unicode:string|null;high:string};
 private literal=false;
 private selected:Set<string>;
 constructor(paths:string[]){this.selected=new Set(paths);}
 private path(){const frame=this.stack.at(-1);return !frame?'':frame.path+'/'+(frame.kind==='array'?frame.index:frame.key.replace(/~/g,'~0').replace(/\//g,'~1'));}
 private complete(){const frame=this.stack.at(-1);if(frame){frame.state='comma';if(frame.kind==='array')frame.index++;}else this.root=true;}
 push(chunk:string|Uint8Array):Array<{field_path:string;text:string}>{
  const text=typeof chunk==='string'?chunk:this.decoder.decode(chunk,{stream:true});
  const output:Array<{field_path:string;text:string}>=[];
  const emit=(path:string,value:string)=>{if(!value||!this.selected.has(path))return;const last=output.at(-1);if(last?.field_path===path)last.text+=value;else output.push({field_path:path,text:value});};
  const decoded=(value:string)=>{
   const token=this.string!;
   if(token.key){token.value+=value;if(token.value.length>65536)throw new Error('json_key_too_large');return;}
   for(const char of value){
    const code=char.charCodeAt(0);
    if(token.high){if(code>=0xdc00&&code<=0xdfff){emit(token.path,token.high+char);token.high='';continue;}emit(token.path,token.high);token.high='';}
    if(char.length===1&&code>=0xd800&&code<=0xdbff)token.high=char;else emit(token.path,char);
   }
  };
  for(let i=0;i<text.length;i++){
   const char=text[i],token=this.string;
   if(token){
    if(token.unicode!==null){if(!/[0-9a-f]/i.test(char))throw new Error('invalid_json_escape');token.unicode+=char;if(token.unicode.length===4){decoded(String.fromCharCode(parseInt(token.unicode,16)));token.unicode=null;}continue;}
    if(token.escape){token.escape=false;if(char==='u'){token.unicode='';continue;}const escapes:Record<string,string>={'"':'"','\\':'\\','/':'/','b':'\b','f':'\f','n':'\n','r':'\r','t':'\t'};if(!Object.hasOwn(escapes,char))throw new Error('invalid_json_escape');decoded(escapes[char]);continue;}
    if(char==='\\'){token.escape=true;continue;}
    if(char==='"'){
     if(token.high)emit(token.path,token.high);
     this.string=undefined;
     if(token.key){const frame=this.stack.at(-1)!;frame.key=token.value;frame.state='colon';}else this.complete();
     continue;
    }
    if(char<' ')throw new Error('invalid_json_string');decoded(char);continue;
   }
   if(this.literal){if(!/[\s,\]}]/.test(char))continue;this.literal=false;this.complete();i--;continue;}
   if(/\s/.test(char))continue;
   const frame=this.stack.at(-1);
   if(char==='}'||char===']'){
    if(!frame||frame.kind!==(char==='}'?'object':'array')||!['key','value','comma'].includes(frame.state))throw new Error('invalid_json_close');
    this.stack.pop();this.complete();continue;
   }
   if(frame?.state==='comma'){if(char!==',')throw new Error('invalid_json_separator');frame.state=frame.kind==='object'?'key':'value';continue;}
   if(frame?.state==='colon'){if(char!==':')throw new Error('invalid_json_colon');frame.state='value';continue;}
   const key=frame?.kind==='object'&&frame.state==='key';
   if(key&&char!=='"'||!frame&&this.root)throw new Error('invalid_json_value');
   if(char==='"'){this.string={key:!!key,path:this.path(),value:'',escape:false,unicode:null,high:''};continue;}
   if(char==='{'||char==='['){if(this.stack.length>=64)throw new Error('json_too_deep');this.stack.push({kind:char==='{'?'object':'array',path:this.path(),state:char==='{'?'key':'value',key:'',index:0});continue;}
   if(!/[tfn\-0-9]/.test(char))throw new Error('invalid_json_value');this.literal=true;
  }
  return output;
 }
}
