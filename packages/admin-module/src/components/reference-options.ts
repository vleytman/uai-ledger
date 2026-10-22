import {configurationLabel,modelLabel} from './configuration-labels';
import type { Options } from './structured-editor';
import { listRows } from './form-values';
export function buildOptions(resources: Record<string, any[]>): Options {
  const result: Options = {};
  for (const [view, rows] of Object.entries(resources))
    result[view] = rows
      .filter(
        (r) =>
          !['models', 'rates', 'routes'].includes(view) ||
          r.status === 'published',
      )
      .map((r) => ({
        value: r.id,
        label: r.name ?? r.url ?? `${configurationLabel(r)} · v${r.version}`,
      }));
  for (const catalog of resources.models ?? []) {
    result[`catalogModels:${catalog.id}`] = (catalog.payload?.models ?? [])
      .filter((m: any) => m.status === 'active')
      .map((m: any) => ({ value: m.id, label: modelLabel(m.id) }));
  }
  result.calculations=(resources.models??[]).flatMap(catalog=>(catalog.payload?.models??[]).filter((model:any)=>model.calculation).map((model:any)=>({value:`${catalog.id}|${model.id}`,label:`${modelLabel(model.id)} · ${configurationLabel(catalog)} v${catalog.version}`})));
  result.modelNames = [
    ...new Set(
      (resources.models ?? [])
        .filter((r) => r.status === 'published')
        .flatMap((r) => r.payload?.models ?? [])
        .map((m) => m.id),
    ),
  ].map((id) => ({ value: id, label: modelLabel(id) }));
  result.limiters = (resources.limiters ?? []).map((r) => ({
    value: r.limiter_key,
    label: r.limiter_key,
  }));
  result.limiterKeys = [
    ...new Set([
      ...(resources.limiters ?? []).map((r) => r.limiter_key),
      ...(resources.routes ?? [])
        .flatMap((r) => [
          r.payload?.primary?.limiter_key,
          r.payload?.fallback?.limiter_key,
        ])
        .filter(Boolean),
    ]),
  ].map((key) => ({ value: key, label: key }));
  result.periods = [
    ...new Set(
      (resources.recipes ?? [])
        .map((r) => r.definition?.period_budget_key)
        .filter(Boolean),
    ),
  ].map((key) => ({ value: key, label: key }));
  result.budgetTargets = [...(result.providers ?? []), ...result.periods];
  return result;
}
export function referenceViews(action: string): string[] {
  if (
    action.startsWith('connection_') ||
    action === 'report_credential' ||
    action === 'report_import'
  )
    return [];
  if (action.startsWith('rule_')) return ['destinations'];
  if (action.startsWith('routes_')) return ['providers', 'models', 'limiters'];
  if (action.startsWith('recipes_')) return ['routes', 'rates', 'recipes'];
  if (action.startsWith('models_')) return ['rates', 'models'];
  if (action.startsWith('rates_')) return ['providers'];
  if (action === 'budget_update') return ['providers', 'recipes'];
  if (action === 'limiter_update') return ['limiters', 'routes'];
  if (action === 'reconcile' || action === 'snapshot_create')
    return ['providers'];
  return [];
}
export { listRows };
