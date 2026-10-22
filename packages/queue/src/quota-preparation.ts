/** Bounded derived-cache maintenance. No permits or observations are consumed here. */
export const quotaPreparationScript=`
local workLeft=4096
local function saveTotal(aggregate,used,count,window)
 redis.call('HSET',aggregate,'used',string.format('%.0f',used),'count',count,'window',window)
 redis.call('HINCRBY',aggregate,'revision',1)
 redis.call('HDEL',aggregate,'building','denial')
 redis.call('PEXPIRE',aggregate,window+60000)
end
local function prepareRule(key,aggregate,rule,now)
 local cached=redis.call('HMGET',aggregate,'used','count','window')
 local count=redis.call('ZCARD',key)
 local valid=cached[1] and tonumber(cached[2])==count and tonumber(cached[3])==rule.window_ms
 local used=valid and tonumber(cached[1]) or 0
 local expiredCount=redis.call('ZCOUNT',key,'-inf',now-rule.window_ms)
 if expiredCount==count and count>0 then
  redis.call('UNLINK',key);redis.call('DEL',aggregate)
  count=0;used=0;valid=true;saveTotal(aggregate,used,count,rule.window_ms)
 elseif expiredCount>0 then
  if workLeft==0 then return nil end
  local expired=redis.call('ZRANGEBYSCORE',key,'-inf',now-rule.window_ms,'LIMIT',0,math.min(workLeft,expiredCount))
  workLeft=workLeft-#expired
  if valid then for _,event in ipairs(expired) do used=used-tonumber(string.match(event,'|(%d+)$')) end end
  redis.call('ZREM',key,unpack(expired));count=count-#expired
  if valid then saveTotal(aggregate,used,count,rule.window_ms) else redis.call('DEL',aggregate) end
  if #expired<expiredCount then return nil end
 end
 if not valid then
  local building=redis.call('HGET',aggregate,'building')
  local state=building and cjson.decode(building) or {count=-1}
  if state.count~=count or state.window~=rule.window_ms then state={count=count,window=rule.window_ms,offset=0,used=0} end
  state.used=tonumber(state.used)
  if state.offset<count then
   if workLeft==0 then return nil end
   local events=redis.call('ZRANGE',key,state.offset,state.offset+math.min(workLeft,count-state.offset)-1)
   for _,event in ipairs(events) do state.used=state.used+tonumber(string.match(event,'|(%d+)$')) end
   state.offset=state.offset+#events;workLeft=workLeft-#events
  end
  if state.offset<count then
   state.used=string.format('%.0f',state.used)
   redis.call('HSET',aggregate,'building',cjson.encode(state));redis.call('PEXPIRE',aggregate,rule.window_ms+60000)
   return nil
  end
  used=state.used;saveTotal(aggregate,used,count,rule.window_ms)
 end
 local availableAt=now
 if used+rule.amount>rule.capacity then
  local revision=redis.call('HGET',aggregate,'revision') or '0'
  local raw=redis.call('HGET',aggregate,'denial')
  local state=raw and cjson.decode(raw) or {revision=false}
  if state.revision~=revision or state.count~=count or state.used~=string.format('%.0f',used) or state.amount~=string.format('%.0f',rule.amount) or state.capacity~=string.format('%.0f',rule.capacity) or state.window~=rule.window_ms then
   state={revision=revision,count=count,used=string.format('%.0f',used),amount=string.format('%.0f',rule.amount),capacity=string.format('%.0f',rule.capacity),window=rule.window_ms,offset=0,remaining=used,at=now}
  end
  state.remaining=tonumber(state.remaining)
  while state.remaining+rule.amount>rule.capacity do
   if workLeft==0 then
    state.remaining=string.format('%.0f',state.remaining)
    redis.call('HSET',aggregate,'denial',cjson.encode(state));return nil
   end
   local events=redis.call('ZRANGE',key,state.offset,state.offset+math.min(workLeft,128)-1,'WITHSCORES')
   workLeft=workLeft-#events/2
   -- A valid total must be backed by events. Never admit from an inconsistent cache.
   if #events==0 then redis.call('DEL',aggregate);return nil end
   for j=1,#events,2 do
    state.remaining=state.remaining-tonumber(string.match(events[j],'|(%d+)$'))
    state.offset=state.offset+1;state.at=tonumber(events[j+1])+rule.window_ms
    if state.remaining+rule.amount<=rule.capacity then break end
   end
  end
  if state.at<=now then redis.call('HDEL',aggregate,'denial');return nil end
  state.remaining=string.format('%.0f',state.remaining)
  redis.call('HSET',aggregate,'denial',cjson.encode(state));availableAt=state.at
 end
 return {used=used,available_at=availableAt}
end
`;
