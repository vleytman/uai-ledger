/** PA-I01 contracts. These definitions do not register HTTP handlers. */
import {z} from 'zod';
const Key=z.string().regex(/^[a-zA-Z0-9_.:-]{1,200}$/);
const Quantity=z.string().regex(/^(0|[1-9]\d{0,28})(\.\d{1,9})?$/);
const Units=z.string().regex(/^(0|[1-9]\d{0,18})$/);
const Timestamp=z.iso.datetime({offset:true});
const ObjectSchema=z.record(z.string(),z.unknown());
const Calendar=z.strictObject({kind:z.enum(['calendar_month','anniversary_month']),timezone:z.string().min(1),anchor:Timestamp});
const Counter=z.strictObject({key:Key,unit:Key,dimensions:z.array(Key).min(1).max(30).optional(),included:Quantity,rollover:z.strictObject({enabled:z.boolean(),cap:Quantity,expires_after_periods:z.number().int().min(1).max(24)}),overage_usd_per_unit:Quantity.optional()});
const Receipt=z.strictObject({id:Key,revision:z.number().int().positive()});
export const paidApiSchemas={
 Receipt,
 Conflict:z.strictObject({error:z.strictObject({code:z.string(),message:z.string(),details:z.record(z.string(),z.unknown()).optional()})}),
 Quantity,Units,
 ServiceOperation:z.strictObject({key:Key,kind:z.literal('api'),capability:z.literal('api.call'),provider:Key,adapter_ref:z.string().regex(/^[a-zA-Z0-9_.-]+@[1-9]\d*$/),input_schema:ObjectSchema,output_schema:ObjectSchema,files:z.strictObject({media_types:z.array(z.string()).max(30),max_count:z.number().int().min(0).max(100),max_file_bytes:Units,max_total_bytes:Units}),billing_mode:z.enum(['quoted_final','actual_capped']),allowance_mode:z.enum(['subscription','unmetered']),measurements:z.array(z.strictObject({key:Key,unit:Key,source:z.enum(['request','verified_assets','provider_usage']),maximum:Quantity,expression:ObjectSchema.optional()})).min(1),pricing:z.discriminatedUnion('mode',[z.strictObject({mode:z.literal('independent'),expression:ObjectSchema,max_units:Units,rounding_units:Units}),z.strictObject({mode:z.literal('cost_plus'),markup_percent:Quantity,safety_factor:Quantity,max_units:Units,rounding_units:Units})]),samples:z.array(z.strictObject({name:z.string().min(1),input:ObjectSchema,assets:z.strictObject({count:z.number().int().min(0).max(16),bytes:Units}),measurements:z.record(Key,Quantity),expected_price_units:Units})).min(1).max(100)}),
 TariffTemplate:z.strictObject({key:Key,provider:Key,calendar:Calendar,counters:z.array(Counter).min(1).max(20),overage:z.strictObject({enabled:z.boolean(),max_units:Units}),cost_allocation:z.discriminatedUnion('mode',[z.strictObject({mode:z.literal('incremental')}),z.strictObject({mode:z.literal('allocated'),subscription_fee_units:Units,allocation_rates:z.record(Key,Quantity)})])}),
 SubscriptionCreate:z.strictObject({provider_account_id:Key,tariff_version_id:Key,starts_at:Timestamp,installation_share:z.record(Key,Quantity),reason:z.string().min(1).max(1000)}),
 ProviderAccountCreate:z.strictObject({provider:Key,name:z.string().min(1).max(200),external_reference:Key,reason:z.string().min(1).max(1000)}),
 ConnectionBinding:z.strictObject({provider_account_id:Key,subscription_id:Key.nullable(),reason:z.string().min(1).max(1000)}),
 AllowanceDemand:z.strictObject({metric:Key,quantity:Quantity}),
 UsageObservation:z.strictObject({identity:Key,revision:z.number().int().positive(),attempt_id:Key,state:z.enum(['known','unknown']),items:z.array(z.strictObject({metric:Key,quantity:Quantity})),source:z.enum(['provider','adapter','manual']),reason:z.string().optional()}),
 ProviderSnapshot:z.strictObject({supersedes:z.array(Key).min(1).max(20).optional(),identity:Key,provider_account_id:Key,period_id:Key,metric:Key,remaining:Quantity,observed_at:Timestamp,covered_through:Timestamp.nullable(),precision:z.enum(['confirmed','estimated']),scope:z.enum(['provider_account','installation']),reason:z.string().min(1)}),
 AllowanceAdjustment:z.strictObject({period_id:Key,metric:Key,direction:z.enum(['increase','decrease']),quantity:Quantity,reason:z.string().min(1).max(1000),evidence_id:Key}),
 AllowanceState:z.strictObject({subscription_id:Key,period_id:Key,period_start:Timestamp,period_end:Timestamp,metrics:z.array(z.strictObject({metric:Key,unit:Key,included:Quantity,rollover:Quantity,consumed:Quantity,reserved:Quantity,available:Quantity,overdrawn:Quantity,remaining_percent:Quantity.nullable()})),overage:z.strictObject({limit_units:Units,spent_units:Units,reserved_units:Units}),freshness:z.enum(['fresh','stale','unknown']),sampled_at:Timestamp}),
 AllowanceFailure:z.strictObject({error:z.strictObject({code:z.enum(['allowance_exhausted','allowance_period_changed','allowance_maximum_missing','overage_budget_exhausted']),message:z.string(),details:z.strictObject({retryable:z.boolean(),resets_at:Timestamp.nullable()})})}),
 AllowanceRule:z.strictObject({signal:z.enum(['allowance.low','allowance.exhausted','allowance.renewed','usage.snapshot_stale','allowance.discrepancy','overage.budget_low','overage.budget_exhausted']),allowance:z.strictObject({subscription_id:Key,metric:Key.optional(),unit:z.enum(['native','percent','money_units','seconds']),comparison:z.enum(['lt','lte','gt','gte']).optional()}),threshold:Quantity.optional(),minimum_samples:z.number().int().positive().optional(),severity:z.enum(['info','warning','critical']),cooldown_seconds:z.number().int().nonnegative(),recipients:z.array(Key),enabled:z.boolean()}),
};
export type ServiceOperation=z.infer<typeof paidApiSchemas.ServiceOperation>;
export type TariffTemplate=z.infer<typeof paidApiSchemas.TariffTemplate>;
export type AllowanceDemand=z.infer<typeof paidApiSchemas.AllowanceDemand>;
export const paidApiEndpoints=[
 {method:'post',path:'/v1/admin/provider-accounts',body:'ProviderAccountCreate',response:'Receipt',write:true},
 {method:'put',path:'/v1/admin/connections/{id}/provider-account',body:'ConnectionBinding',response:'Receipt',write:true,revision:true},
 {method:'post',path:'/v1/admin/provider-subscriptions',body:'SubscriptionCreate',response:'Receipt',write:true},
 {method:'get',path:'/v1/admin/provider-subscriptions/{id}/allowance',response:'AllowanceState'},
 {method:'post',path:'/v1/admin/allowance-snapshots',body:'ProviderSnapshot',response:'Receipt',write:true},
 {method:'post',path:'/v1/admin/allowance-adjustments',body:'AllowanceAdjustment',response:'Receipt',write:true},
] as const;
