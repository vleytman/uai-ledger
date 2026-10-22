import type {JevInput,JevQuestions,JevResult} from '../../contracts/jev.js';
import {validateJevInput,validateJevResult} from '../../contracts/jev.js';
import type {UaiClient,RunOptions,RequestResult} from './index.js';
export type {JevInput,JevQuestions,JevQuestion,JevResult,JevAnswer,JevContent,JsonValue} from '../../contracts/jev.js';
/** All JSON services use the same structured manifest representation. */
export function serviceJson(result:RequestResult):unknown {
 const content=result.result?.content as {type?:string;value?:unknown}|undefined;
 if(content?.type!=='structured'||!Object.hasOwn(content,'value'))throw new Error('No structured service result available');
 return content.value;
}
export function jev(client:UaiClient,scope:{account_id:string;wallet_id?:string;profile?:string}){
 const body={...scope,profile:scope.profile??'typesafe.jev-1.13.0'};
 return {
  quote<const Q extends JevQuestions>(input:JevInput<Q>,key:string){validateJevInput(input);return client.services.quote({...body,input},key);},
  async run<const Q extends JevQuestions>(input:JevInput<Q>,options:RunOptions&{budget:{max_units:string}}):Promise<Awaited<ReturnType<UaiClient['services']['run']>>&{value:JevResult<Q>|undefined}>{
   validateJevInput(input);
   const checkedOptions=options.persist?{...options,persist:async(result:RequestResult)=>{validateJevResult(serviceJson(result),input.questions);await options.persist!(result);}}:options;
   const result=await client.services.run({...body,input,budget:options.budget},checkedOptions);
   return {...result,value:result.result?validateJevResult(serviceJson(result),input.questions):undefined};
  }
 };
}
