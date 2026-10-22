import {credits} from '@uai/ui/format';

interface Diagnostics {
 customer_charge_units:string;
 attempts:unknown[];
 reason?:string;
 usage:unknown;
 costs:unknown;
 platform_funded_cost_units:string;
}
export function RequestDetails({diagnostics}:{diagnostics:Diagnostics}){
 return <details className="mt-4 min-w-0 max-w-full rounded-lg border p-3">
  <summary className="cursor-pointer text-sm">Расход и выполнение</summary>
  <p className="mt-2 text-sm">Списано {credits(diagnostics.customer_charge_units)} кр. Попыток: {diagnostics.attempts.length}.</p>
  {diagnostics.reason&&<p>{diagnostics.reason}</p>}
  <pre className="mt-3 max-h-72 max-w-full overflow-auto text-xs">{JSON.stringify({attempts:diagnostics.attempts,usage:diagnostics.usage,provider_cost:diagnostics.costs,platform_funded_cost_units:diagnostics.platform_funded_cost_units},null,2)}</pre>
 </details>;
}
