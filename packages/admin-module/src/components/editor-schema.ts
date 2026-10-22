export interface EditorSchema {
  label: string;
  type?:
    | 'text'
    | 'number'
    | 'boolean'
    | 'strings'
    | 'object'
    | 'array'
    | 'map'
    | 'credits'
    | 'usd'
    | 'seconds'
    | 'json'
    | 'datetime'
    | 'model_calculation';
  fields?: Record<string, EditorSchema>;
  item?: EditorSchema;
  options?: string[];
  lookup?: string;
  help?: string;
  optional?: boolean;
  nullable?: boolean;
  default?: any;
  advanced?: boolean;
}
const text = (
  label: string,
  extra: Partial<EditorSchema> = {},
): EditorSchema => ({ label, ...extra });
const number = (
  label: string,
  extra: Partial<EditorSchema> = {},
): EditorSchema => ({ label, type: 'number', ...extra });
const object = (
  label: string,
  fields: Record<string, EditorSchema>,
  extra: Partial<EditorSchema> = {},
): EditorSchema => ({ label, type: 'object', fields, ...extra });
export const capabilityOptions = [
  'text.generate',
  'image.generate',
  'speech.synthesize',
  'search',
];
export const scopeSchema = object('Account scope', {
  organization_id: text('Organization ID', { optional: true }),
  project_id: text('Project ID', { optional: true }),
  workspace_id: text('Workspace ID', { optional: true, advanced: true }),
  api_key_id: text('API key ID', { optional: true, advanced: true }),
  provider_account: text('Provider account', { optional: true }),
  installation: text('Installation', { optional: true, advanced: true }),
});
const target = object('Primary provider', {
  connection_id: text('Connection', { lookup: 'providers' }),
  catalog_version_id: text('Model catalog', { lookup: 'models' }),
  model: text('Model', { lookup: 'modelNames' }),
  max_cost_units: text('Maximum cost, USD', { type: 'usd' }),
  limiter_key: text('Rate limit group', { lookup: 'limiters', optional: true }),
});
const limits = object('Input and output limits', {
  input_tokens: number('Input tokens', { optional: true }),
  output_tokens: number('Output tokens', { optional: true }),
  input_characters: number('Input characters', { optional: true }),
  image_count: number('Images', { optional: true }),
  image_sizes: text('Image sizes', { type: 'strings', optional: true }),
  image_qualities: text('Image qualities', { type: 'strings', optional: true }),
  max_assets: number('Maximum input assets', { optional: true }),
  image_input_tokens_per_asset: number('Tokens per input asset', {
    optional: true,
  }),
});
export const editorSchemas: Record<string, EditorSchema> = {
  scope: scopeSchema,
  capabilities: object('Reporting', {
    usage_reporting: { label: 'Usage reports', type: 'boolean' },
    cost_reporting: { label: 'Cost reports', type: 'boolean' },
    balance_reporting: { label: 'Balance reports', type: 'boolean' },
    request_cost_lookup: { label: 'Cost lookup by request', type: 'boolean' },
    reporting_granularity: {
      label: 'Report granularity',
      type: 'strings',
      help: 'One supported value per line.',
    },
    reporting_lag_seconds: {
      label: 'Reporting delay',
      type: 'seconds',
      nullable: true,
      help: 'Leave blank if unknown.',
    },
  }),
  models: object('Models', {
    models: {
      label: 'Models',
      type: 'array',
      item: object('Model', {
        id: text('Model ID'),
        identity_kind: text('Model identifier type', {options:['snapshot','alias'],optional:true,help:'Select snapshot only when the provider guarantees this ID pins a model version.'}),
        provider: text('Provider', {
          options: ['cerebras', 'groq', 'google_cloud', 'openai', 'anthropic', 'cartesia', 'serper', 'fake'],
        }),
        status: text('Status', { options: ['active', 'disabled'] }),
        capabilities: text('Capabilities', {
          type: 'strings',
          options: capabilityOptions,
        }),
        rate_card_version_id: text('Provider rates', {lookup:'rates',optional:true}),
        calculation: {label:'Cost calculation',type:'model_calculation',optional:true},
        allowed_parameters: text('Allowed parameters', {
          type: 'strings',
          help: 'One parameter per line.',
        }),
      }),
      default: [],
    },
  }),
  rates: object('Pricing', {
    id: text('Rate card ID'),
    currency: text('Currency', { options: ['USD'] }),
    source: text('Pricing source'),
    checked_at: text('Source checked at', {
      type: 'datetime',
      help: 'Your local time. Saved with a time zone.',
    }),
    rates: {
      label: 'Rates',
      type: 'array',
      item: object('Rate', {
        id: text('Rate ID'),
        dimension: text('Dimension'),
        unit: text('Unit'),
        unit_size: text('Units per price', {
          help: 'For example, 1000 for a price per 1,000 tokens.',
        }),
        amount: text('Price, USD', {
          help: 'Exact decimal amount per the number of units above.',
        }),
        effective_from: text('Effective from', {
          type: 'datetime',
          help: 'Your local time.',
        }),
        effective_to: text('Effective until', {
          type: 'datetime',
          optional: true,
          nullable: true,
        }),
        connection_id: text('Connection override', {
          lookup: 'providers',
          optional: true,
          advanced: true,
        }),
        conditions: {
          label: 'Conditions',
          type: 'map',
          item: text('Value'),
          optional: true,
          advanced: true,
        },
      }),
      default: [],
    },
  }),
  routes: object('Route', {
    execution: {...object('Execution', {max_attempts:number('Maximum attempts'),deadline_seconds:number('Deadline, seconds')}),optional:true},
    capability: text('Capability', { options: capabilityOptions }),
    primary: target,
    fallback: {
      ...target,
      label: 'Fallback provider',
      optional: true,
      default: {
        catalog_version_id: '',
        model: '',
        connection_id: '',
        max_cost_units: '0',
      },
    },
    deadline_seconds: { label: 'Maximum wait', type: 'seconds' },
    platform_risk_budget_units: {
      label: 'Platform risk budget, USD',
      type: 'usd',
    },

  }),
  recipes: object('Recipe', {
    period_budget_key: text('Period budget', { lookup: 'periods' }),
    deadline_seconds: {
      label: 'Maximum wait',
      type: 'seconds',
      optional: true,
    },
    inputs: {
      label: 'Input parameters',
      type: 'map',
      optional: true,
      item: object('Parameter', {
        type: text('Type', { options: ['integer'] }),
        minimum: number('Minimum'),
        maximum: number('Maximum'),
      }),
    },
    components: {
      label: 'Components',
      type: 'array',
      item: object('Component', {
        key: text('Component name'),
        capability: text('Capability', { options: capabilityOptions }),
        route_version_id: text('Route', { lookup: 'routes' }),
        rate_card_version_id: text('Pricing version', { lookup: 'rates' }),
        count: {
          label: 'Quantity',
          type: 'json',
          help: 'Use a constant quantity, an input parameter, or an advanced expression.',
          default: { constant: 1 },
        },
        limits,
        pricing_mode: text('Model billing mode', {options:['quoted_final','estimated_actual'],optional:true,help:'Quoted final fixes the price. Estimated actual uses an output forecast only, bills actual usage with markup and allows debt. Requires published usage counters and the model output-limit policy.'}),
        billing: object('Fixed customer pricing', {
          mode: text('Mode', { options: ['fixed'] }),
          source: text('Price basis'),
          price_parameters: text('Parameters affecting price', { type: 'strings', help: 'Only these parameters select a price row. Other allowed settings do not change the price.' }),
          prices: { label: 'Price combinations', type: 'array', item: object('Price', {
            parameters: { label: 'Price parameters', type: 'map', item: text('Value') },
            units: text('Fixed price, credits', { type: 'credits' }),
            estimation: { label: 'Provider cost bound', type: 'json', optional: true, advanced: true },
          }) },
        }, { optional: true }),
        estimation: object('Cost estimate', {
          version: number('Rule version', { default: 1 }),
          tokenizer: text('Tokenizer', { optional: true, options: ['o200k_base', 'cl100k_base', 'utf8_upper_bound'] }),
          source: text('Source and assumptions'),
          rules: {
            label: 'Billable quantities', type: 'array',
            item: object('Quantity', {
              dimension: text('Billing dimension'),
              unit: text('Unit', { options: ['tokens', 'images', 'seconds', 'characters', 'calls'] }),
              source: text('Quantity source', { options: ['input_tokens', 'output_tokens', 'characters', 'fixed', 'duration'] }),
              maximum: number('Maximum quantity'),
              expected: number('Expected quantity', { optional: true }),
              conditions: { label: 'Price conditions', type: 'json', optional: true, advanced: true },
            }),
          },
        }, { optional: true, help: 'Estimate the request separately from its spending limit. Published recipes keep their original rules.' }),
      }),
      default: [],
    },
    content_ttl_seconds: {
      label: 'Result retention',
      type: 'seconds',
      optional: true,
      advanced: true,
    },
  }),
};
export function defaultValue(schema: EditorSchema): any {
  if (schema.default !== undefined) return structuredClone(schema.default);
  if (schema.type === 'object')
    return Object.fromEntries(
      Object.entries(schema.fields ?? {})
        .filter(([, s]) => !s.optional)
        .map(([k, s]) => [k, defaultValue(s)]),
    );
  if (schema.type === 'array' || schema.type === 'strings') return [];
  if (schema.type === 'map') return {};
  if (schema.type === 'boolean') return false;
  if (schema.type === 'number' || schema.type === 'seconds')
    return schema.nullable ? null : 0;
  return schema.options?.[0] ?? (schema.type === 'usd' ? '0' : '');
}
