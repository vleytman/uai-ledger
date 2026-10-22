/** INFO runs inside the same Lua command as the gate check, including after failover. */
export const redisGenerationScript=`
local quota_run_id=string.match(redis.call('INFO','server'),'run_id:(%w+)')
if not quota_run_id then return redis.error_reply('quota_redis_generation_missing') end
`;
