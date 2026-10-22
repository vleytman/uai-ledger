/** Server-asserted identity. Contains no session credentials or product roles. */
export type StaffRole = 'admin' | 'viewer';
export type ExternalIdentity = Readonly<
 | {version:1;kind:'user';user_id:string;account_id:string}
 | {version:1;kind:'staff';user_id:string;role:StaffRole}
>;
export const EXTERNAL_IDENTITY_HEADER = 'x-uai-context';
export const EXTERNAL_IDENTITY_VERSION = 1;
const MAX_HEADER_LENGTH = 4096;
const validId = (value:unknown):value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);

/** Validate exact fields and return an immutable copy, never the caller's object. */
export function parseExternalIdentity(value:unknown):ExternalIdentity {
 if(!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid external identity');
 const record = value as Record<string,unknown>;
 const fields = record.kind === 'user' ? ['version','kind','user_id','account_id'] : ['version','kind','user_id','role'];
 if(Object.keys(record).length !== fields.length || !fields.every(key=>Object.hasOwn(record,key)) || record.version !== 1 || !validId(record.user_id)) throw new Error('Invalid external identity');
 if(record.kind === 'user' && validId(record.account_id)) return Object.freeze({version:1,kind:'user',user_id:record.user_id,account_id:record.account_id});
 if(record.kind === 'staff' && (record.role === 'admin' || record.role === 'viewer')) return Object.freeze({version:1,kind:'staff',user_id:record.user_id,role:record.role});
 throw new Error('Invalid external identity');
}
export function encodeExternalIdentity(identity:ExternalIdentity):string {
 const encoded = encodeURIComponent(JSON.stringify(parseExternalIdentity(identity)));
 if(encoded.length > MAX_HEADER_LENGTH) throw new Error('External identity header too large');
 return encoded;
}
export function decodeExternalIdentity(header:string):ExternalIdentity {
 if(typeof header !== 'string' || !header || header.length > MAX_HEADER_LENGTH || /[^\x21-\x7e]/.test(header)) throw new Error('Invalid external identity header');
 return parseExternalIdentity(JSON.parse(decodeURIComponent(header)));
}
