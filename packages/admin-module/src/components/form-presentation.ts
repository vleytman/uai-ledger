import type { CommandForm, FormField } from './command-dialog';
import { editorSchemas, scopeSchema } from './editor-schema';
import { unitsToUsd } from './form-values';
export function presentForm(form: CommandForm): CommandForm {
  const kind = form.action.split('_')[0];
  return {
    ...form,
    fields: form.fields.map((original) => {
      const field: FormField = { ...original };
      if (field.type === 'json') {
        if (['account_scope', 'credential_scope'].includes(field.key))
          field.schema = scopeSchema;
        if (field.key === 'capabilities') {
          field.schema = editorSchemas.capabilities;
          field.section = 'Reporting';
        }
        if (field.key === 'payload' && editorSchemas[kind])
          field.schema = editorSchemas[kind];
        if (field.key === 'recipients') {
          field.type = 'multiselect';
          field.lookup = 'destinations';
          field.label = 'Webhook recipients';
        }
        if (['limits', 'risk_policy'].includes(field.key)) {
          field.section = 'Advanced metadata';
          field.advanced = true;
        }
      }
      if (field.key === 'connection_id') {
        field.lookup = 'providers';
        field.label = 'Connection';
      }
      if (field.key === 'budget_key') {
        field.lookup = 'budgetTargets';
        field.label = 'Connection or recipe period';
      }
      if (field.key === 'key' && form.action === 'limiter_update') {
        field.lookup = 'limiterKeys';
        field.label = 'Rate limit group';
      }
      if (
        (form.action === 'budget_update' && field.key === 'limit_units') ||
        (form.action === 'reconcile' && field.key === 'provider_units')
      ) {
        field.type = 'usd';
        field.label =
          field.key === 'limit_units'
            ? 'Budget limit, USD'
            : 'Provider cost, USD';
        field.value = field.value == null ? '' : unitsToUsd(field.value);
        field.help = 'Exact USD amount. Up to 9 decimal places.';
      }
      if (field.key === 'window_ms') {
        field.type = 'duration';
        field.scale = 1000;
        field.label = 'Time window';
      }
      if (['cooldown_seconds', 'stale_after_seconds'].includes(field.key)) {
        field.type = 'duration';
        field.label =
          field.key === 'cooldown_seconds'
            ? 'Notification cooldown'
            : 'Freshness window';
      }
      if (['external_reference', 'identity'].includes(field.key)) {
        field.advanced = true;
        field.section = 'References';
      }
      return field;
    }),
  };
}
