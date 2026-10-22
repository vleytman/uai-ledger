import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
export class SessionError extends Error { constructor(public status:number,message:string){super(message)} }
const equal=(a:string,b:string)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y)};
export function sessions(name:string,secret:string,password:string,locale:'ru'|'en'='ru'){
 const messages=locale==='en'?{password:'Incorrect password.',signin:'Sign in to continue.',invalid:'Invalid session.',expired:'Your session has expired.',origin:'This request origin is not allowed.',json:'JSON is required.'}:{password:'Неверный пароль.',signin:'Войдите в тестовое приложение.',invalid:'Недействительная сессия.',expired:'Сессия истекла.',origin:'Недопустимый источник запроса.',json:'Требуется JSON.'};
 if(secret.length<32||password.length<16)throw new Error('Session secret and login password must be configured');
 const sign=(payload:string)=>createHmac('sha256',secret).update(payload).digest('base64url');
 return {
  login(request:Request,supplied:string){if(!equal(password,supplied))throw new SessionError(401,messages.password);const payload=Buffer.from(JSON.stringify({expires:Date.now()+8*3600000,nonce:randomBytes(16).toString('hex')})).toString('base64url');return `${name}=${payload}.${sign(payload)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800${new URL(request.url).protocol==='https:'?'; Secure':''}`},
  verify(request:Request){const value=(request.headers.get('cookie')??'').split(';').map(s=>s.trim()).find(s=>s.startsWith(`${name}=`))?.slice(name.length+1);const[payload,signature]=value?.split('.')??[];if(!payload||!signature||!equal(signature,sign(payload)))throw new SessionError(401,messages.signin);let data:{expires:number};try{data=JSON.parse(Buffer.from(payload,'base64url').toString())}catch{throw new SessionError(401,messages.invalid)}if(typeof data.expires!=='number'||data.expires<=Date.now())throw new SessionError(401,messages.expired);},
  csrf(request:Request){if(request.method==='GET')return;const origin=request.headers.get('origin');if(!origin||origin!==new URL(request.url).origin)throw new SessionError(403,messages.origin);if(!request.headers.get('content-type')?.startsWith('application/json'))throw new SessionError(415,messages.json);}
 };
}
