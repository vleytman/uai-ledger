import type {ExternalIdentity,StaffRole} from '../../../../../packages/contracts/external-identity.js';
/** Synthetic parent policy. These role names are never sent to UAI. */
export type ProductRole='view'|'chat'|'generate';
export type ProductAction='view'|'chat'|'generate';
export type FixtureUser={teams:Set<string>;productRoles:Record<string,ProductRole>;role?:StaffRole};
const rank:Record<ProductRole,number>={view:0,chat:1,generate:2};
export const allowsProductAction=(role:ProductRole|undefined,action:ProductAction)=>role!==undefined&&rank[role]>=rank[action];
export function fixtureUsers():Record<string,FixtureUser>{return {
 alice:{teams:new Set(['alpha','beta']),productRoles:{alpha:'chat',beta:'generate'}},
 bob:{teams:new Set(['alpha']),productRoles:{alpha:'view'}},
 'team-admin':{teams:new Set(['alpha']),productRoles:{alpha:'generate'}},
 viewer:{teams:new Set(),productRoles:{},role:'viewer'},
 admin:{teams:new Set(),productRoles:{},role:'admin'},
};}
/** Authentication and CSRF are performed by the parent before calling this handler. */
export async function productActionResponse(request:Request,userId:string|null,users:Record<string,FixtureUser>,accounts:Record<string,{id:string}>,run:(identity:Extract<ExternalIdentity,{kind:'user'}>,action:ProductAction)=>Promise<unknown>):Promise<Response>{
 if(!userId||!Object.hasOwn(users,userId))return Response.json({error:'Fixture session expired'},{status:401});
 if(request.method!=='POST')return Response.json({error:'Method not allowed'},{status:405});
 const input:unknown=await request.json();
 if(!input||typeof input!=='object'||Array.isArray(input))return Response.json({error:'Invalid action'},{status:422});
 const {team,action}=input as Record<string,unknown>;
 if(typeof team!=='string'||typeof action!=='string'||!['view','chat','generate'].includes(action))return Response.json({error:'Invalid action'},{status:422});
 const user=users[userId];
 if(!user.teams.has(team)||!Object.hasOwn(accounts,team)||!allowsProductAction(user.productRoles[team],action as ProductAction))return Response.json({error:'Current product permissions do not allow this action'},{status:403});
 const identity:Extract<ExternalIdentity,{kind:'user'}>={version:1,kind:'user',user_id:userId,account_id:accounts[team].id};
 return Response.json(await run(identity,action as ProductAction));
}
