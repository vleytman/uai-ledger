import {redisGenerationScript} from './redis-generation.js';
/** Read-only, bounded diagnostic snapshot. Does not restore or open the gate. */
export const quotaSnapshotScript=`${redisGenerationScript}
local clock=redis.call('TIME');local now=tonumber(clock[1])*1000+math.floor(tonumber(clock[2])/1000)
if redis.call('GET',KEYS[1])~=(ARGV[1]..':'..quota_run_id) then return cjson.encode({ready=false,reason='not_ready',at=now}) end
local rules=cjson.decode(ARGV[2]);local result={}
for i,rule in ipairs(rules) do
 local events=redis.call('ZRANGEBYSCORE',KEYS[i+3],'('..(now-rule.window_ms),'+inf','LIMIT',0,10001)
 if #events>10000 then return cjson.encode({ready=false,reason='too_many_events',at=now}) end
 local used=0
 for _,event in ipairs(events) do
  local amount=tonumber(string.match(event,'|(%d+)$'))
  if not amount then return cjson.encode({ready=false,reason='invalid_usage',at=now}) end
  used=used+amount
 end
 if used>9007199254740991 then return cjson.encode({ready=false,reason='invalid_usage',at=now}) end
 local remaining=math.max(0,rule.capacity-used);local available=remaining
 local blocked=tonumber(redis.call('HGET',KEYS[2],rule.key) or '0')
 local observation=redis.call('HGET',KEYS[3],rule.key);local provider=cjson.null
 if observation then
  local o=cjson.decode(observation)
  if o.reset_at>now then
   available=math.min(available,o.remaining)
   provider={remaining=string.format('%.0f',o.remaining),reset_at=o.reset_at,observed_at=o.observed_at or cjson.null}
  end
 end
 if blocked>now then available=0 else blocked=cjson.null end
 result[i]={key=rule.key,used=string.format('%.0f',used),local_remaining=string.format('%.0f',remaining),available=string.format('%.0f',available),blocked_until=blocked,provider=provider}
end
return cjson.encode({ready=true,at=now,rules=result})
`;
export type QuotaSnapshot={ready:false;reason:'not_ready'|'too_many_events'|'invalid_usage';at:number}|{
 ready:true;at:number;rules:Array<{key:string;used:string;local_remaining:string;available:string;blocked_until:number|null;provider:{remaining:string;reset_at:number;observed_at:number|null}|null}>;
};
