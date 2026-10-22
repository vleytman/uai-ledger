export interface TextOptionsValue {mode:'text'|'schema'|'tool';stream:boolean;definition:string;history:string}
export const defaultTextOptions:TextOptionsValue={mode:'text',stream:false,definition:'{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"],"additionalProperties":false}',history:''};
