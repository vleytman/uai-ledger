import {ADMIN_API_PATH} from '../client';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@uai/ui/components/button';
import { Input } from '@uai/ui/components/input';
import { StructuredFields, type Options } from './structured-editor';
import type { EditorSchema } from './editor-schema';
import type {
  ModelCalculation,
  CalculationComponent,
  ParameterSpec,
  Expression,
} from '../../../model-pricing/src/index';
import { unitsToCredits } from './form-values';

const field = (
  label: string,
  extra: Partial<EditorSchema> = {},
): EditorSchema => ({ label, ...extra });
const number = (label: string, extra: Partial<EditorSchema> = {}) =>
  field(label, { type: 'number', ...extra });
const select = (label: string, options: string[]) => field(label, { options });
const strings = (label: string) => field(label, { type: 'strings' });
const object = (
  label: string,
  fields: Record<string, EditorSchema>,
): EditorSchema => ({ label, type: 'object', fields });
function Form({
  value,
  onChange,
  fields,
  label = 'Settings',
}: {
  value: any;
  onChange: (value: any) => void;
  fields: Record<string, EditorSchema>;
  label?: string;
}) {
  return (
    <StructuredFields
      value={Object.fromEntries(
        Object.entries(value).filter(([key]) => key in fields),
      )}
      onChange={(next) =>
        onChange({
          ...Object.fromEntries(
            Object.entries(value).filter(([key]) => !(key in fields)),
          ),
          ...next,
        })
      }
      schema={object(label, fields)}
    />
  );
}
function Select({
  label,
  value,
  values,
  onChange,
}: {
  label: string;
  value: string;
  values: string[];
  onChange: (v: string) => void;
}) {
  const id = useId();
  return (
    <div className="admin-field">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        className="admin-select"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {values.map((v) => (
          <option key={v} value={v}>
            {v.replaceAll('_', ' ')}
          </option>
        ))}
      </select>
    </div>
  );
}
function Text({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const id = useId();
  return (
    <div className="admin-field">
      <label htmlFor={id}>{label}</label>
      <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
const zero = (): Expression => ({ op: 'constant', value: '0' });
function expressionDefault(op: Expression['op']): Expression {
  switch (op) {
    case 'constant':
      return zero();
    case 'field':
      return { op, path: 'input.asset_count' };
    case 'tokenize':
      return {op,tokenizer:'o200k_base',input_mode:'prompt'};
    case 'lookup':
      return {op,parameters:[],rows:[],unit:'scalar'};
    case 'add':
    case 'multiply':
    case 'min':
    case 'max':
      return { op, args: [zero(), zero()] };
    case 'subtract':
    case 'divide':
      return { op, left: zero(), right: { op: 'constant', value: '1' } };
    case 'round':
      return { op, value: zero(), step: '1', mode: 'ceil' };
    case 'if':
      return {
        op,
        comparison: 'eq',
        left: zero(),
        right: zero(),
        then: zero(),
        else: zero(),
      };
    default:
      return { op, value: zero() };
  }
}
function ExpressionEditor({
  value,
  onChange,
  fields,
  parameters = {},
  inAsset = false,
  depth = 0,
}: {
  value: Expression;
  onChange: (v: Expression) => void;
  fields: string[];
  parameters?: Record<string,ParameterSpec>;
  inAsset?: boolean;
  depth?: number;
}) {
  const saved = useRef<Record<string, Expression>>({});
  if (depth > 16)
    return (
      <p role="alert">
        Expression is too deeply nested. Use Edit JSON to shorten it.
      </p>
    );
  const update = (key: string, next: unknown) =>
    onChange({ ...value, [key]: next } as Expression);
  const child = (key: string, e: Expression) => (
    <div key={key} className="admin-formula-child">
      <span>{key}</span>
      <ExpressionEditor
        value={e}
        onChange={(v) => update(key, v)}
        fields={fields}
        parameters={parameters}
        inAsset={inAsset || value.op === 'sum_assets'}
        depth={depth + 1}
      />
    </div>
  );
  return (
    <div className="admin-formula-node">
      <Select
        label="Operation"
        value={value.op}
        values={[
          'constant',
          'field',
          'lookup',
          ...(!inAsset ? ['tokenize'] : []),
          'add',
          'subtract',
          'multiply',
          'divide',
          'min',
          'max',
          'ceil',
          'floor',
          'round',
          'if',
          ...(!inAsset ? ['sum_assets'] : []),
        ]}
        onChange={(op) => {
          saved.current[value.op] = structuredClone(value);
          onChange(
            saved.current[op] ?? expressionDefault(op as Expression['op']),
          );
        }}
      />
      {value.op === 'constant' && (
        <Text
          label="Constant"
          value={value.value}
          onChange={(v) => update('value', v)}
        />
      )}
      {value.op === 'tokenize' && <Form label="Tokenization operation" value={value} onChange={onChange} fields={{tokenizer:select('Tokenizer',['o200k_base','cl100k_base','utf8_upper_bound']),input_mode:select('Input counting',['prompt','messages_json','compiled_messages_json','embedding_batch'])}} />}
      {value.op === 'lookup' && <>
        <Form label="Expression table" value={value} onChange={onChange} fields={{parameters:{...strings('Lookup parameters'),options:Object.keys(parameters).filter(k=>parameters[k].values?.length)},unit:select('Lookup result unit',['scalar','usd','tokens','images','seconds','characters','calls'])}} />
        <Button type="button" variant="outline" onClick={()=>{
          let rows:Record<string,string>[]=[{}];
          for(const key of value.parameters){const choices=parameters[key]?.values??[];if(rows.length*choices.length>10000)return;rows=rows.flatMap(row=>choices.map(choice=>({...row,[key]:String(choice)})));}
          update('rows',rows.map(p=>({parameters:p,value:value.rows.find(r=>value.parameters.every(k=>r.parameters[k]===p[k]))?.value??'0'})));
        }}>Fill expression table</Button>
        <div className="admin-pricing-table"><table><caption>Versioned expression table</caption><thead><tr>{value.parameters.map(k=><th key={k}>{k}</th>)}<th>Value</th></tr></thead><tbody>{value.rows.map((row,i)=><tr key={i}>{value.parameters.map(k=><td key={k}>{row.parameters[k]}</td>)}<td><Input aria-label={`Expression table value ${Object.values(row.parameters).join(' ')||i+1}`} value={row.value} onChange={e=>update('rows',value.rows.map((r,j)=>j===i?{...r,value:e.target.value}:r))}/></td></tr>)}</tbody></table></div>
      </>}
      {value.op === 'field' && (
        <Select
          label="Numeric field"
          value={value.path}
          values={[
            ...new Set([
              value.path,
              ...fields,
              ...(inAsset ? ['asset.width', 'asset.height'] : []),
            ]),
          ]}
          onChange={(v) => update('path', v)}
        />
      )}
      {'args' in value && (
        <>
          {value.args.map((e, i) => (
            <div key={i} className="admin-formula-child">
              <ExpressionEditor
                value={e}
                onChange={(v) =>
                  update(
                    'args',
                    value.args.map((a, j) => (i === j ? v : a)),
                  )
                }
                fields={fields}
                parameters={parameters}
                inAsset={inAsset}
                depth={depth + 1}
              />
              <Button
                type="button"
                variant="ghost"
                disabled={value.args.length === 1}
                onClick={() =>
                  update(
                    'args',
                    value.args.filter((_, j) => j !== i),
                  )
                }
              >
                Remove operand
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            disabled={value.args.length >= 32}
            onClick={() => update('args', [...value.args, zero()])}
          >
            Add operand
          </Button>
        </>
      )}
      {'left' in value && child('left', value.left)}
      {'right' in value && child('right', value.right)}
      {'value' in value &&
        typeof value.value === 'object' &&
        child('value', value.value)}
      {value.op === 'round' && (
        <>
          <Text
            label="Rounding step"
            value={value.step}
            onChange={(v) => update('step', v)}
          />
          <Select
            label="Rounding"
            value={value.mode}
            values={['ceil', 'floor', 'half_up']}
            onChange={(v) => update('mode', v)}
          />
        </>
      )}
      {value.op === 'if' && (
        <>
          <Select
            label="Comparison"
            value={value.comparison}
            values={['lt', 'lte', 'eq', 'gte', 'gt']}
            onChange={(v) => update('comparison', v)}
          />
          {child('then', value.then)}
          {child('else', value.else)}
        </>
      )}
    </div>
  );
}
export function newCostComponent(
  type: CalculationComponent['type'],
  index: number,
): CalculationComponent {
  const base = {
    key: `component${index}`,
    label: `Component ${index}`,
    covers: [`category${index}`],
    maximum: '100000',
    result: {
      kind: 'quantity' as const,
      dimension: 'input_tokens',
      unit: 'tokens' as const,
    },
  };
  switch (type) {
    case 'tokens':
      return {
        ...base,
        type,
        direction: 'input',
        tokenizer: 'o200k_base',
        input_mode: 'prompt',
        overhead: 0,
        per_message: 0,
        per_asset: 0,
      };
    case 'per_unit':
      return {
        ...base,
        type,
        source: 'constant',
        constant: '1',
        step: '1',
        rounding: 'ceil',
        result: { kind: 'quantity', dimension: 'calls', unit: 'calls' },
      };
    case 'lookup':
      return {
        ...base,
        type,
        parameters: [],
        rows: [{ parameters: {}, value: '0' }],
        result: { kind: 'usd' },
      };
    case 'formula':
      return { ...base, type, expression: zero() };
  }
}
export function newModelCalculation(): ModelCalculation {
  return {
    version: 1,
    source: '',
    verification: 'approximate',
    verified_at: new Date().toISOString(),
    parameters: {},
    preparation: { max_assets: 0, max_edge: 1024, format: 'png' },
    components: [],
    pricing: { safety_factor: '1', markup_percent: '0', rounding_units: '1' },
    samples: [],
  };
}
function ParameterEditor({
  value,
  onChange,
}: {
  value: ParameterSpec;
  onChange: (v: ParameterSpec) => void;
}) {
  const textId = useId();
  const typed = (v: string): string | number | boolean =>
    value.type === 'number'
      ? Number(v)
      : value.type === 'boolean'
        ? v === 'true'
        : v;
  return (
    <>
      <Select
        label="Parameter type"
        value={value.type}
        values={['string', 'number', 'boolean']}
        onChange={(type) =>
          onChange({
            type: type as ParameterSpec['type'],
            ...(type === 'number' ? { minimum: 0, maximum: 1 } : {}),
            required: value.required,
          })
        }
      />
      <Form
        value={value}
        onChange={onChange}
        fields={{
          required: field('Required', { type: 'boolean' }),
          default: field('Default', {
            type:
              value.type === 'number'
                ? 'number'
                : value.type === 'boolean'
                  ? 'boolean'
                  : 'text',
            optional: true,
          }),
          ...(value.type === 'number'
            ? { minimum: number('Minimum'), maximum: number('Maximum') }
            : {}),
        }}
      />
      <div className="admin-field">
        <label htmlFor={textId}>
          Allowed values, one per line. Empty means any value within bounds.
        </label>
        <textarea
          id={textId}
          rows={3}
          value={value.values?.join('\n') ?? ''}
          onChange={(e) => {
            const lines = e.target.value.split('\n');
            if (
              value.type === 'number' &&
              lines.some((l) => l.trim() && !Number.isFinite(Number(l)))
            ) {
              e.target.setCustomValidity('Use numeric values.');
              return;
            }
            e.target.setCustomValidity('');
            const values = e.target.value === '' ? undefined : lines.map(typed);
            onChange({ ...value, values });
          }}
        />
      </div>
    </>
  );
}
function ComponentEditor({
  value,
  onChange,
  parameters,
  previous,
}: {
  value: CalculationComponent;
  onChange: (v: CalculationComponent) => void;
  parameters: ModelCalculation['parameters'];
  previous: string[];
}) {
  const variants = useRef<Record<string, CalculationComponent>>({});
  const update = (v: Record<string, unknown>) =>
    onChange({ ...value, ...v } as CalculationComponent);
  const parameterNames = Object.keys(parameters),
    numeric = parameterNames.filter((k) => parameters[k].type === 'number');
  const changeType = (type: string) => {
    variants.current[value.type] = structuredClone(value);
    const next =
      variants.current[type] ??
      newCostComponent(type as CalculationComponent['type'], 1);
    onChange({
      ...next,
      key: value.key,
      label: value.label,
      covers: value.covers,
    });
  };
  let fields: Record<string, EditorSchema> = {};
  if (value.type === 'tokens' && value.direction === 'input')
    fields = {
      tokenizer: select('Tokenizer', ['o200k_base', 'cl100k_base', 'utf8_upper_bound']),
      input_mode: select('Input content', ['prompt', 'messages_json', 'compiled_messages_json', 'embedding_batch']),
      overhead: number('Request overhead, tokens'),
      per_message: number('Additional tokens per message'),
      per_asset: number('Additional text tokens per reference'),
    };
  if (value.type === 'tokens' && value.direction === 'output')
    fields = {
      policy: select('Output estimate', [
        'configured_expected',
        'requested_maximum',
        'estimated_parameter',
      ]),
      ...(value.policy === 'configured_expected'
        ? { expected: number('Expected output tokens') }
        : {}),
      limit_parameter: select(value.type==='tokens'&&value.direction==='output'&&value.policy==='estimated_parameter'?'Output forecast parameter':'Executed output limit parameter', numeric),
    };
  if (value.type === 'per_unit')
    fields = {
      source: select('Quantity source', [
        'constant',
        'parameter',
        'characters',
        'assets',
      ]),
      ...(value.source === 'constant' ? { constant: field('Quantity') } : {}),
      ...(value.source === 'parameter'
        ? { parameter: select('Quantity parameter', numeric) }
        : {}),
      ...(value.source === 'characters'
        ? { character_mode: select('Character count', ['unicode', 'utf16']) }
        : {}),
      step: field('Quantity rounding step'),
      rounding: select('Quantity rounding', ['ceil', 'floor', 'half_up']),
    };
  return (
    <>
      <Select
        label="Calculation type"
        value={value.type}
        values={['tokens', 'per_unit', 'lookup', 'formula']}
        onChange={changeType}
      />
      <Form
        label="Cost component"
        value={value}
        onChange={onChange}
        fields={{
          key: field('Component key'),
          label: field('Label'),
          covers: strings('Covered costs'),
          maximum: field('Maximum result value'),
        }}
      />
      <p className="uai-footnote">
        Use distinct coverage categories, such as text_input, image_input and
        image_output. A table including input must declare those categories too.
      </p>
      {value.type === 'tokens' && (
        <Select
          label="Token direction"
          value={value.direction}
          values={['input', 'output']}
          onChange={(direction) => {
            variants.current[`tokens:${value.direction}`] =
              structuredClone(value);
            const next =
              variants.current[`tokens:${direction}`] ??
              (direction === 'input'
                ? newCostComponent('tokens', 1)
                : {
                    ...value,
                    type: 'tokens',
                    direction: 'output',
                    policy: 'configured_expected',
                    expected: 100,
                    limit_parameter: numeric[0] ?? '',
                  });
            onChange({
              ...next,
              key: value.key,
              label: value.label,
              covers: value.covers,
              result: value.result,
            } as CalculationComponent);
          }}
        />
      )}
      {Object.keys(fields).length > 0 && (
        <Form
          label="Counting rules"
          value={value}
          onChange={onChange}
          fields={fields}
        />
      )}
      {value.type === 'lookup' && (
        <>
          <Form
            label="Table selection"
            value={value}
            onChange={onChange}
            fields={{
              parameters: {
                ...strings('Price parameters'),
                options: parameterNames.filter(
                  (k) => parameters[k].values?.length,
                ),
              },
              multiplier_parameter: {
                ...select('Multiply by quantity', numeric),
                optional: true,
              },
            }}
          />
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              let rows: Record<string, string>[] = [{}];
              for (const key of value.parameters) {
                const choices = parameters[key]?.values ?? [];
                if (rows.length * choices.length > 10000) return;
                rows = rows.flatMap((r) =>
                  choices.map((v) => ({ ...r, [key]: String(v) })),
                );
              }
              update({
                rows: rows.map((p) => ({
                  parameters: p,
                  value:
                    value.rows.find((r) =>
                      value.parameters.every((k) => r.parameters[k] === p[k]),
                    )?.value ?? '0',
                })),
              });
            }}
          >
            Fill all parameter combinations
          </Button>
          <div className="admin-pricing-table">
            <table>
              <caption>Generation table</caption>
              <thead>
                <tr>
                  {value.parameters.map((k) => (
                    <th key={k}>{k}</th>
                  ))}
                  <th>
                    {value.result.kind === 'usd'
                      ? 'Provider cost, USD'
                      : 'Quantity'}
                  </th>
                </tr>
              </thead>
              <tbody>
                {value.rows.map((r, i) => (
                  <tr key={i}>
                    {value.parameters.map((k) => (
                      <td key={k}>{r.parameters[k]}</td>
                    ))}
                    <td>
                      <Input
                        aria-label={`Table value ${Object.values(r.parameters).join(' ') || i + 1}`}
                        value={r.value}
                        onChange={(e) =>
                          update({
                            rows: value.rows.map((row, j) =>
                              j === i ? { ...row, value: e.target.value } : row,
                            ),
                          })
                        }
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {value.type === 'formula' && (
        <ExpressionEditor
          parameters={parameters}
          value={value.expression}
          onChange={(expression) => update({ expression })}
          fields={[
            'input.characters',
            'input.asset_count',
            ...numeric.map((k) => `parameters.${k}`),
            ...previous.map((k) => `components.${k}`),
          ]}
        />
      )}
      <Select
        label="Result"
        value={value.result.kind}
        values={value.type === 'tokens' ? ['quantity'] : ['quantity', 'usd']}
        onChange={(kind) =>
          update({
            result:
              kind === 'usd'
                ? { kind }
                : { kind, dimension: 'input_tokens', unit: 'tokens' },
          })
        }
      />
      {value.result.kind === 'quantity' && (
        <Form
          label="Provider rate mapping"
          value={value.result}
          onChange={(result) => update({ result })}
          fields={{
            dimension: field('Billing dimension'),
            unit: select(
              'Billing unit',
              value.type === 'tokens'
                ? ['tokens']
                : ['tokens', 'images', 'seconds', 'characters', 'calls'],
            ),
            conditions: {
              label: 'Rate conditions',
              type: 'map',
              item: field('Value'),
              optional: true,
            },
          }}
        />
      )}
    </>
  );
}
function inputSchema(policy: ModelCalculation): Record<string, EditorSchema> {
  return {
    input: object('Request content', {
      prompt: field('Prompt', { optional: true }),
      text: field('Text', { optional: true }),
      instructions: field('Instructions', { optional: true }),
      messages: {
        label: 'Messages',
        type: 'array',
        optional: true,
        item: object('Message', {
          role: select('Role', ['user', 'assistant', 'system']),
          content: field('Content'),
        }),
      },
    }),
    parameters: object(
      'Request parameters',
      Object.fromEntries(
        Object.entries(policy.parameters).map(([k, p]) => [
          k,
          field(k, {
            type:
              p.type === 'number'
                ? 'number'
                : p.type === 'boolean'
                  ? 'boolean'
                  : 'text',
            ...(p.type === 'string' && p.values
              ? { options: p.values.map(String) }
              : {}),
            optional: !p.required,
            default: p.default,
          }),
        ]),
      ),
    ),
    assets: {
      label: 'Prepared reference metadata',
      type: 'array',
      item: object('Reference', {
        id: field('Reference ID'),
        sha256: field('Content hash'),
        width: number('Width'),
        height: number('Height'),
        format: select('Format', ['png', 'jpeg', 'webp']),
      }),
    },
  };
}
function initialInput(policy: ModelCalculation) {
  return {
    input: { prompt: 'Hello' },
    parameters: Object.fromEntries(
      Object.entries(policy.parameters)
        .filter(([, p]) => p.default !== undefined)
        .map(([k, p]) => [k, p.default]),
    ),
    assets: [],
  };
}
export function ModelCalculationEditor({
  value,
  onChange,
  options,
  model,
  rateId,
  readOnly = false,
}: {
  value?: ModelCalculation;
  onChange: (v: ModelCalculation | undefined) => void;
  options: Options;
  model?: string;
  rateId?: string;
  readOnly?: boolean;
}) {
  const [newParameter, setNewParameter] = useState(''),
    [copyFrom, setCopyFrom] = useState('');
  const [preview, setPreview] = useState<any>(null),
    [previewInput, setPreviewInput] = useState<any>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    setPreview(null);
    setError('');
  }, [value, model, rateId]);
  const update = (v: Partial<ModelCalculation>) =>
    onChange({ ...value!, ...v });
  async function copy() {
    setBusy(true);
    setError('');
    try {
      const [catalogId, modelId] = copyFrom.split('|');
      const response = await fetch(`${ADMIN_API_PATH}?view=models`);
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error?.message ?? 'Could not load catalog');
      const catalog = result.data?.find((c: any) => c.id === catalogId);
      const source = catalog?.payload?.models?.find(
        (m: any) => m.id === modelId && m.calculation,
      );
      if (!source) throw new Error('This catalog has no model calculation.');
      onChange(structuredClone(source.calculation));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!value)
    return (
      <div className="admin-editor-section">
        <Button
          type="button"
          variant="outline"
          onClick={() => onChange(newModelCalculation())}
        >
          Add cost calculation
        </Button>
        <div className="admin-field">
          <label>
            Copy calculation from model
            <select
              className="admin-select"
              value={copyFrom}
              onChange={(e) => setCopyFrom(e.target.value)}
            >
              <option value="">Select a model</option>
              {options.calculations?.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <Button
            type="button"
            variant="outline"
            disabled={!copyFrom || busy}
            onClick={copy}
          >
            Copy calculation
          </Button>
        </div>
        {error && <p role="alert">{error}</p>}
      </div>
    );
  const currentInput = previewInput ?? initialInput(value);
  async function calculate() {
    setBusy(true);
    setError('');
    setPreview(null);
    try {
      const response = await fetch(ADMIN_API_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'model_preview',
          key: crypto.randomUUID(),
          data: {
            model,
            rate_card_version_id: rateId,
            calculation: value,
            input: currentInput,
          },
        }),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(
          typeof result.error === 'string'
            ? result.error
            : (result.error?.message ?? 'Calculation failed'),
        );
      setPreview(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="admin-model-calculation"
      aria-label="Model cost calculation"
    >
      <h3>Cost calculation</h3>
      <fieldset disabled={readOnly} className="admin-form-fields">
      <Form
        label="Model price"
        value={value.pricing}
        onChange={(pricing) => update({ pricing })}
        fields={{
          safety_factor: field('Safety factor', {
            help: '1 means no extra allowance.',
          }),
          markup_percent: field('Markup, %', {
            help: 'Percentage added after the safety factor. This is markup, not gross margin.',
          }),
          rounding_units: field('Price rounding, credit units', {
            help: '1 credit = 1,000,000 units. Applied once to the total.',
          }),
        }}
      />
      <details className="admin-disclosure">
        <summary>Parameters and reference preparation</summary>
        {Object.entries(value.parameters).map(([key, p]) => (
          <details className="admin-disclosure" key={key}>
            <summary>
              {key} · {p.type}
            </summary>
            <ParameterEditor
              value={p}
              onChange={(v) =>
                update({ parameters: { ...value.parameters, [key]: v } })
              }
            />
            <Button
              type="button"
              variant="ghost"
              onClick={() =>
                update({
                  parameters: Object.fromEntries(
                    Object.entries(value.parameters).filter(([k]) => k !== key),
                  ),
                })
              }
            >
              Remove parameter
            </Button>
          </details>
        ))}
        <Text
          label="New parameter name"
          value={newParameter}
          onChange={setNewParameter}
        />
        <Button
          type="button"
          variant="outline"
          disabled={
            !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(newParameter) ||
            Object.hasOwn(value.parameters, newParameter)
          }
          onClick={() => {
            update({
              parameters: {
                ...value.parameters,
                [newParameter]: { type: 'string', required: true },
              },
            });
            setNewParameter('');
          }}
        >
          Add parameter
        </Button>
        <Form
          label="Reference preparation"
          value={value.preparation}
          onChange={(preparation) => update({ preparation })}
          fields={{
            mode: {...select('Image handling', ['preserve','transform']),optional:true,help:'Preserve original bytes by default. Transform explicitly enables resizing and format conversion.'},
            auto_orient: {label:'Apply EXIF orientation during transform',type:'boolean',optional:true},
            max_assets: number('Maximum references'),
            max_edge: number('Maximum reference edge, pixels'),
            format: select('Prepared format', ['png', 'jpeg', 'webp']),
            fit: {...select('Resize mode', ['inside','contain']),optional:true,help:'Contain adds a white background to reach the exact square size. Inside preserves dimensions within the maximum edge.'},
            allowed_dimensions: {
              ...strings('Verified prepared dimensions'),
              optional: true,
              help: 'For example 512x512. Leave absent to allow any dimensions within the maximum edge.',
            },
          }}
        />
      </details>
      {value.components.map((c, i) => (
        <details
          className="admin-disclosure"
          key={i}
          open={value.components.length === 1 ? true : undefined}
        >
          <summary>
            {c.label} · {c.type}
          </summary>
          <ComponentEditor
            value={c}
            parameters={value.parameters}
            previous={value.components.slice(0, i).map((c) => c.key)}
            onChange={(next) =>
              update({
                components: value.components.map((r, j) =>
                  j === i ? next : r,
                ),
              })
            }
          />
          <Button
            type="button"
            variant="ghost"
            onClick={() =>
              update({ components: value.components.filter((_, j) => j !== i) })
            }
          >
            Remove cost component
          </Button>
        </details>
      ))}
      <Button
        type="button"
        variant="outline"
        disabled={value.components.length >= 32}
        onClick={() =>
          update({
            components: [
              ...value.components,
              newCostComponent('tokens', value.components.length + 1),
            ],
          })
        }
      >
        Add cost component
      </Button>
      <details className="admin-disclosure">
        <summary>Source and verification</summary>
        <Form
          label="Verification"
          value={value}
          onChange={onChange}
          fields={{
            source: field('Source and scope of verification'),
            verification: select('Verification status', [
              'documented',
              'empirically_validated',
              'approximate',
            ]),
            verified_at: field('Checked at', { type: 'datetime' }),
          }}
        />
      </details>
      <details className="admin-disclosure">
        <summary>Test cases · {value.samples.length}</summary>
        {value.samples.map((sample, i) => (
          <details className="admin-disclosure" key={i}>
            <summary>{sample.name}</summary>
            <Text
              label="Test name"
              value={sample.name}
              onChange={(name) =>
                update({
                  samples: value.samples.map((s, j) =>
                    j === i ? { ...s, name } : s,
                  ),
                })
              }
            />
            <Form
              label="Test input"
              value={sample.input}
              fields={inputSchema(value)}
              onChange={(input) =>
                update({
                  samples: value.samples.map((s, j) =>
                    j === i ? { ...s, input } : s,
                  ),
                })
              }
            />
            <Form
              label="Expected component values"
              value={sample.expected}
              fields={Object.fromEntries(
                value.components.map((c) => [c.key, field(c.label)]),
              )}
              onChange={(expected) =>
                update({
                  samples: value.samples.map((s, j) =>
                    j === i ? { ...s, expected } : s,
                  ),
                })
              }
            />
            <Form
              label="Expected cost and source"
              value={sample}
              fields={{source:{...field('Sample source'),optional:true,help:'If omitted, the calculation source applies.'},expected_cost_usd:{...field('Expected provider cost, USD'),optional:true},cost_tolerance_usd:{...field('Provider cost tolerance, USD'),optional:true,help:'Absolute tolerance. Omit for an exact comparison.'},expected_price_units:{...field('Expected final price, credit units'),optional:true,help:'Exact integer units after all factors and rounding.'}}}
              onChange={(next)=>update({samples:value.samples.map((s,j)=>j===i?next:s)})}
            />
            <Form
              label="Component tolerances"
              value={sample.tolerance??{}}
              fields={Object.fromEntries(value.components.map(c=>[c.key,{...field(c.label),optional:true,help:'Absolute tolerance. Omit for exact equality.'}]))}
              onChange={(tolerance)=>update({samples:value.samples.map((s,j)=>j===i?{...s,tolerance}:s)})}
            />
            <Button
              type="button"
              variant="ghost"
              onClick={() =>
                update({ samples: value.samples.filter((_, j) => j !== i) })
              }
            >
              Remove test case
            </Button>
          </details>
        ))}
        <Button
          type="button"
          variant="outline"
          onClick={() =>
            update({
              samples: [
                ...value.samples,
                {
                  name: `Test ${value.samples.length + 1}`,
                  input: initialInput(value),
                  expected: Object.fromEntries(
                    value.components.map((c) => [c.key, '0']),
                  ),
                },
              ],
            })
          }
        >
          Add test case
        </Button>
      </details>
      </fieldset>
      <details className="admin-disclosure">
        <summary>Preview price</summary>
        <p className="uai-footnote">
          Uses the displayed calculation and selected provider rates. No model request is
          sent. Saved test cases are checked separately when publishing.
        </p>
        <Form
          label="Preview input"
          value={currentInput}
          onChange={(v) => {
            setPreviewInput(v);
            setPreview(null);
          }}
          fields={inputSchema(value)}
        />
        <Button
          type="button"
          variant="outline"
          disabled={busy || !rateId || !model}
          onClick={calculate}
        >
          {busy ? 'Calculating…' : 'Calculate price'}
        </Button>
        {!rateId && <p>Select provider rates for this model first.</p>}
        {error && <p role="alert">{error}</p>}
        {preview && (
          <div className="admin-calculation" role="status">
            {preview.normalized_input && <details className="admin-disclosure" open>
              <summary>Normalized calculation input</summary>
              <dl>{Object.entries(preview.normalized_input.parameters??{}).map(([key,value])=><div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>)}</dl>
              {Object.entries(preview.normalized_input.input??{}).map(([key,value])=>typeof value==='string'?<p key={key}>{key}: {value}</p>:key==='messages'&&Array.isArray(value)?<div key={key}>{value.map((message:any,i:number)=><p key={i}>{message.role}: {message.content}</p>)}</div>:<details key={key}><summary>{key}</summary><pre>{JSON.stringify(value,null,2)}</pre></details>)}
              <p>Prepared references: {(preview.normalized_input.assets??[]).length}</p>
              {(preview.normalized_input.assets??[]).length>0&&<table><thead><tr><th>Reference</th><th>Dimensions</th><th>Format</th></tr></thead><tbody>{preview.normalized_input.assets.map((asset:any,i:number)=><tr key={i}><td>{i+1}</td><td>{asset.width} × {asset.height}</td><td>{asset.format}</td></tr>)}</tbody></table>}
              <p className="uai-footnote">Preview uses the reference metadata entered above. Actual quotes verify and prepare uploaded files on the server.</p>
            </details>}
            <table>
              <thead>
                <tr>
                  <th>Component</th>
                  <th>Quantity / value</th>
                  <th>Provider cost, USD</th>
                </tr>
              </thead>
              <tbody>
                {preview.components?.map((r: any) => (
                  <tr key={r.key}>
                    <td>{r.label}</td>
                    <td>
                      {r.value}{' '}
                      {r.result.kind === 'usd' ? 'USD' : r.result.unit}
                    </td>
                    <td>{r.cost_usd}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p>Estimated provider cost: ${preview.provider_estimate_usd}</p>
            <p>
              Safety factor: {preview.pricing?.safety_factor} · Markup:{' '}
              {preview.pricing?.markup_percent}%
            </p>
            <p>Final price: {unitsToCredits(preview.price_units)} credits</p>
            <p>Verification: {preview.verification}</p>
          </div>
        )}
      </details>
      {!readOnly&&<Button type="button" variant="ghost" onClick={() => onChange(undefined)}>
        Remove cost calculation
      </Button>}
    </section>
  );
}
