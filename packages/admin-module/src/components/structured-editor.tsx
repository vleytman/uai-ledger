import {ApiOperationPanel} from './api-operation-panel';
import {modelLabel} from './configuration-labels';
import { ModelCalculationEditor } from './model-calculation-editor';
import { useId, useState, useRef, useEffect } from 'react';
import { Button } from '@uai/ui/components/button';
import { Input } from '@uai/ui/components/input';
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldSet,
  FieldLegend,
} from '@uai/ui/components/field';
import { type EditorSchema, defaultValue } from './editor-schema';
import { unitsToCredits, creditsToUnits, unitsToUsd, usdToUnits, updateProperty } from './form-values';
export type Options = Record<string, { value: string; label: string }[]>;
export function Choice({
  id,
  value,
  onChange,
  options = [],
  required = false,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  options?: { value: string; label: string }[];
  required?: boolean;
}) {
  const [manual, setManual] = useState(false);
  return (
    <>
      <select
        id={manual ? undefined : id}
        aria-label={manual ? 'Choose a saved value' : undefined}
        className="admin-select"
        value={manual ? '__manual' : (value ?? '')}
        required={!manual && required}
        onChange={(e) => {
          if (e.target.value === '__manual') setManual(true);
          else onChange(e.target.value);
        }}
      >
        <option value="">Select…</option>
        {value && !options.some((o) => o.value === value) && (
          <option value={value}>{value}</option>
        )}
        {options.map((o) => (
          <option value={o.value} key={o.value}>
            {o.label}
          </option>
        ))}
        <option value="__manual">Enter an ID or key…</option>
      </select>
      {manual && (
        <Input
          id={id}
          value={value ?? ''}
          required={required}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </>
  );
}
function Scalar({
  schema,
  value,
  onChange,
  options,
}: {
  schema: EditorSchema;
  value: any;
  onChange: (v: any) => void;
  options: Options;
}) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  // Keep invalid local input visible and let native form validation stop submission.
  useEffect(() => {
    setDraft(null);
    input.current?.setCustomValidity('');
  }, [value]);
  const label = <FieldLabel htmlFor={id}>{schema.label}</FieldLabel>;
  if (schema.type === 'boolean')
    return (
      <Field orientation="horizontal">
        <input
          id={id}
          type="checkbox"
          checked={!!value}
          onChange={(e) => onChange(e.target.checked)}
        />
        {label}
      </Field>
    );
  if (schema.type === 'strings') {
    if (value != null && !Array.isArray(value))
      return (
        <p role="alert">
          {schema.label} must be a list. Use Edit JSON to correct it.
        </p>
      );
    if (schema.options)
      return (
        <FieldSet>
          <FieldLegend>{schema.label}</FieldLegend>
          {[
            ...new Set([
              ...schema.options,
              ...(Array.isArray(value) ? value : []),
            ]),
          ].map((item) => (
            <label key={item} className="admin-check">
              <input
                type="checkbox"
                checked={(value ?? []).includes(item)}
                onChange={(e) =>
                  onChange(
                    e.target.checked
                      ? [...(value ?? []), item]
                      : (value ?? []).filter((v: string) => v !== item),
                  )
                }
              />
              {item}
            </label>
          ))}
        </FieldSet>
      );
    return (
      <Field className="admin-field">
        {label}
        <textarea
          id={id}
          rows={3}
          value={(value ?? []).join('\n')}
          onChange={(e) => onChange(e.target.value.split('\n'))}
          onBlur={(e) =>
            onChange(
              e.target.value
                .split('\n')
                .map((v) => v.trim())
                .filter(Boolean),
            )
          }
        />
        {schema.help && <p className="uai-footnote">{schema.help}</p>}
      </Field>
    );
  }
  const timestamp =
    schema.type === 'datetime' && value ? new Date(value) : null;
  const display =
    timestamp && !Number.isNaN(timestamp.getTime())
      ? new Date(timestamp.getTime() - timestamp.getTimezoneOffset() * 60000)
          .toISOString()
          .slice(0, 19)
      : schema.type === 'credits' && value != null ? unitsToCredits(value) : schema.type === 'usd' && value != null
        ? unitsToUsd(value)
        : (value ?? '');
  return (
    <Field className="admin-field">
      {label}
      {schema.lookup ? (
        <Choice
          id={id}
          value={value ?? ''}
          options={options[schema.lookup]}
          onChange={(v) =>
            onChange(v === '' && schema.optional ? undefined : v)
          }
        />
      ) : schema.options ? (
        <select
          id={id}
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value)}
        >
          {!schema.options.includes(value) && (
            <option value={value ?? ''}>{value || 'Select…'}</option>
          )}
          {schema.options.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      ) : (
        <Input
          ref={input}
          id={id}
          type={
            schema.type === 'datetime'
              ? 'datetime-local'
              : schema.type === 'number' || schema.type === 'seconds'
                ? 'number'
                : 'text'
          }
          step="any"
          inputMode={['usd','credits'].includes(schema.type??'') ? 'decimal' : undefined}
          value={draft ?? display}
          onChange={(e) => {
            const next = e.target.value;
            if (schema.type === 'usd'||schema.type === 'credits') {
              setDraft(next);
              try {
                const amount = schema.type === 'credits'?creditsToUnits(next):usdToUnits(next);
                e.target.setCustomValidity('');
                onChange(amount);
              } catch (error) {
                e.target.setCustomValidity((error as Error).message);
              }
            } else if (next === '' && (schema.nullable || schema.optional))
              onChange(schema.nullable ? null : undefined);
            else if (schema.type === 'datetime')
              onChange(next ? new Date(next).toISOString() : undefined);
            else if (schema.type === 'number' || schema.type === 'seconds')
              onChange(next === '' ? '' : Number(next));
            else onChange(next);
          }}
        />
      )}{' '}
      {schema.type === 'seconds' && (
        <span className="uai-footnote">
          Seconds{Number(value) >= 60 ? ` · ${Number(value) / 60} minutes` : ''}
        </span>
      )}
      {schema.help && <p className="uai-footnote">{schema.help}</p>}
    </Field>
  );
}
function Quantity({
  value,
  onChange,
}: {
  value: any;
  onChange: (v: any) => void;
}) {
  const id = useId();
  const mode =
    value && Object.keys(value).length === 1 && 'constant' in value
      ? 'constant'
      : value && Object.keys(value).length === 1 && 'input' in value
        ? 'input'
        : 'expression';
  return (
    <FieldGroup>
      <Field className="admin-field">
        <FieldLabel htmlFor={id}>Quantity source</FieldLabel>
        <select
          id={id}
          value={mode}
          onChange={(e) =>
            onChange(
              e.target.value === 'constant'
                ? { constant: 1 }
                : e.target.value === 'input'
                  ? { input: '' }
                  : { sum: [{ constant: 1 }] },
            )
          }
        >
          <option value="constant">Fixed quantity</option>
          <option value="input">Recipe input</option>
          <option value="expression">Advanced expression</option>
        </select>
      </Field>
      {mode === 'expression' ? (
        <JsonInput
          value={JSON.stringify(value, null, 2)}
          onChange={(text) => onChange(JSON.parse(text))}
          label="Quantity expression"
        />
      ) : (
        <Scalar
          schema={{
            label: mode === 'constant' ? 'Quantity' : 'Input parameter',
            type: mode === 'constant' ? 'number' : 'text',
          }}
          value={value?.[mode]}
          onChange={(v) => onChange({ [mode]: v })}
          options={{}}
        />
      )}
    </FieldGroup>
  );
}
function JsonInput({
  value,
  onChange,
  label,
  allowInvalid = false,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  allowInvalid?: boolean;
}) {
  const id = useId();
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    setDraft(value);
    ref.current?.setCustomValidity('');
  }, [value]);
  return (
    <Field className="admin-field">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <textarea
        id={id}
        ref={ref}
        className="admin-code"
        rows={9}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          if (allowInvalid) onChange(e.target.value);
          try {
            JSON.parse(e.target.value);
            onChange(e.target.value);
            e.target.setCustomValidity('');
          } catch {
            e.target.setCustomValidity('Enter valid JSON before saving.');
          }
        }}
      />
    </Field>
  );
}
function Node({
  schema,
  value,
  onChange,
  options,
  context,
}: {
  schema: EditorSchema;
  value: any;
  onChange: (v: any) => void;
  options: Options;
  context?: any;
}) {
  const [newKey, setNewKey] = useState('');
  const [newRow, setNewRow] = useState<string | null>(null);
  const keyId = useId();
  if (schema.type === 'model_calculation') return <ModelCalculationEditor value={value} onChange={onChange} options={options} model={context?.id} rateId={context?.rate_card_version_id}/>;
  if (schema.type === 'object') {
    if (value == null && schema.optional)
      return (
        <Button
          type="button"
          variant="outline"
          onClick={() => onChange(defaultValue(schema))}
        >
          Add {schema.label.toLowerCase()}
        </Button>
      );
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return (
        <p className="uai-footnote">
          Use Edit JSON to correct the {schema.label.toLowerCase()} object.
        </p>
      );
    const fields = Object.entries(schema.fields ?? {}).filter(([key]) => {
      if (key === 'allowed_parameters' && value.calculation) return false;
      // Published model settings supply these values for final-price recipes.
      if (['quoted_final','estimated_actual'].includes(value.pricing_mode) && ['limits', 'rate_card_version_id'].includes(key)) return false;
      return true;
    });
    const render = ([key, s]: [string, EditorSchema]) => {
      const node = <Node
        key={key}
        schema={s}
        value={value[key]}
        onChange={(next) => onChange(key === 'calculation' && next ? {...value,calculation:next,allowed_parameters:Object.keys(next.parameters)} : updateProperty(value, key, next))}
        context={value}
        options={
          key === 'model' && value.catalog_version_id
            ? {
                ...options,
                modelNames:
                  options[`catalogModels:${value.catalog_version_id}`] ?? [],
              }
            : options
        }
      />;
      return ['Pricing','Rate'].includes(schema.label)?<div key={key} data-editor-field={key}>{node}</div>:node;
    };
    const extra = Object.keys(value).filter((k) => !schema.fields?.[k]);
    return (
      <FieldSet className="admin-editor-section" data-editor-label={schema.label}>
        <FieldLegend>{schema.label}</FieldLegend>
        <FieldGroup>
          {schema.fields?.identity_kind && value.identity_kind !== 'snapshot' && <p role="note" className="uai-footnote">{value.identity_kind === 'alias' ? 'This alias can change at the provider without a new catalog version. Recheck its cost calculation when behavior changes.' : 'Model version pinning is unconfirmed. A floating alias can change behavior and costs without a new catalog version.'}</p>}
          {fields.length === 0 && (
            <p className="uai-footnote">No input parameters are required.</p>
          )}
          {fields.filter(([, s]) => !s.advanced).map(render)}
          {fields.some(([, s]) => s.advanced) && (
            <details className="admin-disclosure">
              <summary>
                Additional {schema.label.toLowerCase()} settings
              </summary>
              <FieldGroup>
                {fields.filter(([, s]) => s.advanced).map(render)}
              </FieldGroup>
            </details>
          )}
          {extra.length > 0 && (
            <p className="uai-footnote">
              {extra.length} additional{' '}
              {extra.length === 1 ? 'setting is' : 'settings are'} preserved.
              See the full configuration JSON for details.
            </p>
          )}
          {schema.optional && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => onChange(undefined)}
            >
              Remove {schema.label.toLowerCase()}
            </Button>
          )}
        </FieldGroup>
      </FieldSet>
    );
  }
  if (schema.type === 'array' || schema.type === 'map') {
    if (
      value != null &&
      (schema.type === 'array'
        ? !Array.isArray(value)
        : typeof value !== 'object' || Array.isArray(value))
    )
      return (
        <p role="alert">
          {schema.label} has a custom value. Use Edit JSON to inspect it.
        </p>
      );
    const entries: [string, any][] =
      schema.type === 'array'
        ? (Array.isArray(value) ? value : []).map((v: any, i: number) => [
            String(i),
            v,
          ])
        : Object.entries(value ?? {});
    if(schema.type==='array'&&schema.label==='Rates')return <section className="admin-rates-list" aria-label="Rates">
      <h3>Rates <span className="uai-footnote">{entries.length}</span></h3>
      {entries.map(([key,item])=><section className="admin-rate-card" key={key}>
        <div className="admin-rate-heading"><h4>{item.dimension||item.id||`Rate ${Number(key)+1}`}</h4><Button type="button" size="sm" variant="ghost" aria-label={`Remove Rate ${Number(key)+1}`} onClick={()=>onChange(value.filter((_:any,i:number)=>i!==Number(key)))}>Remove</Button></div>
        <Node schema={schema.item!} value={item} options={options} onChange={next=>onChange(value.map((v:any,i:number)=>i===Number(key)?next:v))}/>
      </section>)}
      <Button type="button" variant="outline" onClick={()=>onChange([...(value??[]),defaultValue(schema.item!)])}>Add rate</Button>
    </section>;
    return (
      <FieldSet className="admin-editor-section">
        <FieldLegend>{schema.label}</FieldLegend>
        <FieldGroup>
          {entries.map(([key, item]) => (
            <details
              key={key}
              className="admin-editor-row"
              open={entries.length === 1 || newRow === key}
            >
              <summary>
                {schema.type === 'map'
                  ? key
                  : schema.label === 'Models' && item?.id ? modelLabel(item.id) : schema.label === 'Price combinations' ? `${Object.entries(item?.parameters??{}).map(([k,v])=>`${k}: ${v}`).join(' · ')} · ${unitsToCredits(item?.units)} credits` : item?.id ||
                    item?.key ||
                    `${schema.item?.label ?? 'Item'} ${Number(key) + 1}`}
                {schema.label === 'Rates' && item?.amount && (
                  <span className="uai-footnote">
                    {' '}
                    · {item.amount} USD / {item.unit_size} {item.unit}
                  </span>
                )}
              </summary>
              <div className="admin-editor-row-heading">
                <strong>
                  {schema.type === 'map'
                    ? key
                    : `${schema.item?.label ?? 'Item'} ${Number(key) + 1}`}
                </strong>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove ${schema.type === 'map' ? key : `${schema.item?.label} ${Number(key) + 1}`}`}
                  onClick={() =>
                    onChange(
                      schema.type === 'array'
                        ? value.filter((_: any, i: number) => i !== Number(key))
                        : updateProperty(value, key, undefined),
                    )
                  }
                >
                  Remove
                </Button>
              </div>
              <Node
                schema={
                  schema.type === 'map' &&
                  !schema.item?.type &&
                  ['boolean', 'number'].includes(typeof item)
                    ? {
                        ...schema.item!,
                        type: typeof item === 'boolean' ? 'boolean' : 'number',
                      }
                    : schema.item!
                }
                value={item}
                options={options}
                onChange={(next) =>
                  onChange(
                    schema.type === 'array'
                      ? value.map((v: any, i: number) =>
                          i === Number(key) ? next : v,
                        )
                      : updateProperty(value, key, next),
                  )
                }
              />
            </details>
          ))}
          {schema.type === 'map' && (
            <Field className="admin-field">
              <FieldLabel htmlFor={keyId}>
                New {schema.item?.label.toLowerCase()} name
              </FieldLabel>
              <Input
                id={keyId}
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
              />
            </Field>
          )}
          <Button
            type="button"
            variant="outline"
            disabled={
              schema.type === 'map' &&
              (!newKey.trim() || Object.hasOwn(value ?? {}, newKey.trim()))
            }
            onClick={() => {
              onChange(
                schema.type === 'array'
                  ? [...(value ?? []), defaultValue(schema.item!)]
                  : updateProperty(
                      value ?? {},
                      newKey.trim(),
                      defaultValue(schema.item!),
                    ),
              );
              setNewRow(
                schema.type === 'array'
                  ? String(entries.length)
                  : newKey.trim(),
              );
              setNewKey('');
            }}
          >
            Add {schema.item?.label.toLowerCase()}
          </Button>
        </FieldGroup>
      </FieldSet>
    );
  }
  if (schema.type === 'json')
    return <Quantity value={value} onChange={onChange} />;
  // Unexpected custom values remain accessible in the lossless JSON editor.
  if (value != null && typeof value === 'object' && schema.type !== 'strings')
    return (
      <p className="uai-footnote">
        {schema.label}: custom value. Edit it in JSON.
      </p>
    );
  return (
    <Scalar
      schema={schema}
      value={value}
      onChange={onChange}
      options={options}
    />
  );
}
function ModelCatalogEditor({schema,value,onChange,options,readOnly=false}:{schema:EditorSchema;value:any;onChange:(v:any)=>void;options:Options;readOnly?:boolean}) {
  const [selected,setSelected] = useState(0);
  const id = useId();
  const models = value.models;
  const index = Math.min(selected,Math.max(0,models.length-1));
  const modelSchema = schema.fields!.models.item!;
  const fields = modelSchema.fields!;
  const updateModel = (i:number,next:any) => onChange({...value,models:models.map((m:any,j:number)=>i===j?next:m)});
  const field = (model:any,i:number,key:string) => <Node key={key} schema={fields[key]} value={model[key]} context={model} options={options} onChange={next=>updateModel(i,key==='calculation'&&next?{...model,calculation:next,allowed_parameters:Object.keys(next.parameters)}:updateProperty(model,key,next))}/>;
  return <div className="admin-catalog-editor">
    <div className="admin-model-picker">
      <div className="admin-field"><label htmlFor={id}>Model <span className="uai-footnote">{models.length} in catalog</span></label>
        <select id={id} className="admin-select" value={index} onChange={e=>setSelected(Number(e.target.value))}>
          {!models.length&&<option value={0}>No models yet</option>}
          {models.map((m:any,i:number)=><option key={i} value={i}>{m.id?modelLabel(m.id):`New model ${i+1}`}</option>)}
        </select>
      </div>
      {!readOnly&&<Button type="button" variant="outline" onClick={()=>{onChange({...value,models:[...models,defaultValue(modelSchema)]});setSelected(models.length)}}>Add model</Button>}
    </div>
    {models.map((model:any,i:number)=><div key={i} hidden={index!==i} onInvalidCapture={e=>{setSelected(i);const target=e.target as HTMLElement;requestAnimationFrame(()=>target.focus())}}>
      <fieldset disabled={readOnly} className="admin-model-fields">
        <section className="admin-model-section">
          <div className="admin-model-section-heading"><h3>Model settings</h3>{!readOnly&&<Button type="button" size="sm" variant="ghost" onClick={()=>{onChange({...value,models:models.filter((_:any,j:number)=>j!==i)});setSelected(Math.max(0,i-1))}}>Remove model</Button>}</div>
          <div className="admin-model-basics">
            <div className="admin-model-wide">{field(model,i,'id')}</div>
            {['provider','status','identity_kind'].map(key=>field(model,i,key))}
            {model.adapter_ref&&<p className="uai-footnote">Adapter version: {model.adapter_ref}</p>}
            <div className="admin-model-wide">{field(model,i,'capabilities')}</div>
            <div className="admin-model-wide">{field(model,i,'rate_card_version_id')}</div>
          </div>
          {model.identity_kind!=='snapshot'&&<p className="uai-footnote">An alias can change at the provider. Recheck the calculation when its behavior changes.</p>}
        </section>
        {!readOnly&&<section className="admin-model-section">{field(model,i,'calculation')}</section>}
        {!model.calculation&&<section className="admin-model-section">{field(model,i,'allowed_parameters')}</section>}
        {Object.keys(model).some(key=>!fields[key])&&<p className="uai-footnote">Additional model settings are preserved and available in JSON.</p>}
      </fieldset>
      {readOnly&&model.api&&<ApiOperationPanel operation={model.api} catalogId={value.preview_catalog_id} model={model.id}/>}
      {readOnly&&model.calculation&&<section className="admin-model-section"><ModelCalculationEditor value={model.calculation} options={options} model={model.id} rateId={model.rate_card_version_id} readOnly onChange={()=>{}}/></section>}
    </div>)}
  </div>;
}
export function StructuredFields(props:{schema:EditorSchema;value:any;onChange:(v:any)=>void;options?:Options}) {return <Node {...props} options={props.options??{}}/>}
export function StructuredEditor({
  value,
  onChange,
  schema,
  options = {},
  readOnly = false,
}: {
  readOnly?: boolean;
  value: string;
  onChange: (v: string) => void;
  schema: EditorSchema;
  options?: Options;
}) {
  const [raw, setRaw] = useState(false);
  let parsed: any;
  let error = '';
  try {
    parsed = JSON.parse(value);
  } catch {
    error = 'Invalid JSON. Open Edit JSON to correct it.';
  }
  const expected =
    schema.type === 'array' || schema.type === 'strings' ? 'array' : 'object';
  if (
    !error &&
    (expected === 'array'
      ? !Array.isArray(parsed)
      : !parsed || typeof parsed !== 'object' || Array.isArray(parsed))
  )
    error = `Expected an ${expected}. Open Edit JSON to correct it.`;
  const isCatalog = schema.label === 'Models' && Array.isArray(parsed?.models) && parsed.models.every((m:any)=>m&&typeof m==='object'&&!Array.isArray(m));
  return (
    <div className="admin-structured-editor">
      {!readOnly&&<div className="admin-editor-mode">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-pressed={raw}
          onClick={(event) => {
            const invalid = event.currentTarget
              .closest('.admin-structured-editor')
              ?.querySelector<HTMLInputElement>(':invalid');
            if (invalid) {
              invalid.reportValidity();
              return;
            }
            setRaw(!raw);
          }}
        >
          {raw ? 'Use fields' : 'Edit JSON'}
        </Button>
      </div>}
      {raw ? (
        <JsonInput
          value={value}
          onChange={onChange}
          label={`${schema.label} JSON`}
          allowInvalid
        />
      ) : error ? (
        <p role="alert">{error}</p>
      ) : isCatalog ? (
        <ModelCatalogEditor schema={schema} value={parsed} options={options} readOnly={readOnly} onChange={next=>onChange(JSON.stringify(next,null,2))}/>
      ) : (
        <fieldset className="admin-form-fields" disabled={readOnly}>
          <Node
            schema={schema}
            value={parsed}
            options={options}
            onChange={(next) => onChange(JSON.stringify(next, null, 2))}
          />
        </fieldset>
      )}
    </div>
  );
}
