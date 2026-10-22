import type {FileSource} from '../../../configuration/src/ownership';
import {api,command} from '../client';
export {api,command} from '../client';
import { takeActionTrigger } from './action-focus';
import { Field, FieldGroup, FieldLabel } from '@uai/ui/components/field';
import { StructuredEditor, Choice, type Options } from './structured-editor';
import type { EditorSchema } from './editor-schema';
import { presentForm } from './form-presentation';
import { referenceViews, buildOptions, listRows } from './reference-options';
import { usdToUnits, thresholdUnit, durationToUnits } from './form-values';
import { useEffect, useRef, useState, useMemo } from 'react';
import { Button } from '@uai/ui/components/button';
import { Input } from '@uai/ui/components/input';
import { Alert, AlertTitle, AlertDescription } from '@uai/ui/components/alert';
import { ConfigurationDiff } from './configuration-diff';
export interface FormField {
  schema?: EditorSchema;
  lookup?: string;
  advanced?: boolean;
  section?: string;
  scale?: number;
  key: string;
  label: string;
  type?:
    | 'text'
    | 'password'
    | 'number'
    | 'textarea'
    | 'json'
    | 'select'
    | 'checkbox'
    | 'datetime-local'
    | 'usd'
    | 'duration'
    | 'multiselect';
  value?: unknown;
  required?: boolean;
  options?: { value: string; label: string }[];
  help?: string;
}
export interface CommandForm {
  provenance?:FileSource;
  readOnly?: boolean;
  comparison?: {before: unknown; after: unknown; previousVersion?: number};
  title: string;
  description: string;
  action: string;
  id?: string;
  revision?: number;
  fields: FormField[];
  submit?: string;
  destructive?: boolean;
  map?: (values: Record<string, any>) => Record<string, unknown>;
}
export function CommandDialog({
  form: source,
  onClose,
  onDone,
}: {
  form: CommandForm;
  onClose: () => void;
  onDone: (result: any) => void;
}) {
  const form = useMemo(() => presentForm(source), [source]);
  const ref = useRef<HTMLDialogElement>(null);
  const [values, setValues] = useState<Record<string, any>>(() =>
    Object.fromEntries(
      form.fields.map((f) => [
        f.key,
        f.type === 'json'
          ? JSON.stringify(f.value ?? {}, null, 2)
          : (f.value ??
            (f.type === 'checkbox'
              ? false
              : f.type === 'multiselect'
                ? []
                : '')),
      ]),
    ),
  );
  const [error, setError] = useState(''),
    [pending, setPending] = useState(false),
    [options, setOptions] = useState<Options>({}),
    [lookupError, setLookupError] = useState('');
  const [resources, setResources] = useState<Record<string, any[]>>({});
  const [loadingOptions, setLoadingOptions] = useState(false);
  const retry = useRef<{ body: string; key: string } | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    returnFocus.current ??=
      takeActionTrigger() ?? (document.activeElement as HTMLElement | null);
    const dialog = ref.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
      requestAnimationFrame(() => {
        if (!dialog?.open && returnFocus.current?.isConnected)
          returnFocus.current.focus();
      });
    };
  }, []);
  useEffect(() => {
    let active = true;
    const views = referenceViews(form.action);
    setLoadingOptions(views.length > 0);
    Promise.allSettled(views.map((view) => api(view))).then((results) => {
      if (!active) return;
      const loaded: Record<string, any[]> = {};
      const failed: string[] = [];
      results.forEach((result, i) => {
        if (result.status === 'fulfilled')
          loaded[views[i]] = listRows(result.value);
        else failed.push(views[i]);
      });
      setResources(loaded);
      setOptions(buildOptions(loaded));
      setLookupError(
        failed.length
          ? `Could not load ${failed.join(', ')}. Existing values are retained; you can enter IDs manually.`
          : '',
      );
      setLoadingOptions(false);
    });
    return () => {
      active = false;
    };
  }, [form.action]);
  const setValue = (field: FormField, next: any) =>
    setValues((current) => {
      const updated = { ...current, [field.key]: next };
      if (
        field.key === 'connection_id' &&
        ['reconcile', 'snapshot_create'].includes(form.action)
      ) {
        const connection = resources.providers?.find((r) => r.id === next);
        if (connection)
          updated.account_scope = JSON.stringify(
            connection.account_scope ?? {},
            null,
            2,
          );
      }
      return updated;
    });
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if(form.readOnly)return;
    setError('');
    setPending(true);
    try {
      const parsed = { ...values };
      for (const field of form.fields) {
        if (field.type === 'json')
          try {
            parsed[field.key] = JSON.parse(String(values[field.key]));
          } catch {
            throw new Error(
              `The "${field.label}" field contains invalid JSON.`,
            );
          }
        if (field.type === 'number')
          parsed[field.key] = Number(values[field.key]);
        if (field.type === 'usd')
          parsed[field.key] = usdToUnits(String(values[field.key]));
        if (field.type === 'duration') {
          const numeric = Number(values[field.key]);
          if (!Number.isSafeInteger(numeric) || numeric < 0)
            throw new Error(
              `${field.label} must resolve to a whole number of ${field.scale === 1000 ? 'milliseconds' : 'seconds'}.`,
            );
          parsed[field.key] = numeric;
        }
        if (field.type === 'datetime-local')
          parsed[field.key] = values[field.key]
            ? new Date(values[field.key]).toISOString()
            : null;
      }
      const data = form.map ? form.map(parsed) : parsed;
      const body = JSON.stringify(data);
      if (retry.current?.body !== body)
        retry.current = { body, key: crypto.randomUUID() };
      const result = await command(
        form.action,
        data,
        retry.current.key,
        form.id,
        form.revision,
      );
      onDone(result);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }
  const renderField = (field: FormField) => {
    if(form.readOnly&&field.key==='key')return <p key={field.key} className="uai-footnote admin-catalog-key">{String(values[field.key])}</p>;
    const id = `field-${field.key}`,
      help = field.help ? `help-${field.key}` : undefined;
    if (field.schema)
      return (
        <div key={field.key}>
          <StructuredEditor
            readOnly={form.readOnly}
            schema={field.schema}
            value={values[field.key]}
            onChange={(v) => setValue(field, v)}
            options={options}
          />
          {field.help && <p className="uai-footnote">{field.help}</p>}
        </div>
      );
    if (field.type === 'multiselect')
      return (
        <fieldset key={field.key} className="admin-editor-section">
          <legend>{field.label}</legend>
          {[
            ...(options[field.lookup!] ?? []),
            ...(values[field.key] ?? [])
              .filter(
                (v: string) =>
                  !options[field.lookup!]?.some((o) => o.value === v),
              )
              .map((v: string) => ({ value: v, label: v })),
          ].map((o) => (
            <label className="admin-check" key={o.value}>
              <input
                type="checkbox"
                checked={(values[field.key] ?? []).includes(o.value)}
                onChange={(e) =>
                  setValue(
                    field,
                    e.target.checked
                      ? [...(values[field.key] ?? []), o.value]
                      : values[field.key].filter((v: string) => v !== o.value),
                  )
                }
              />
              {o.label}
            </label>
          ))}
          {!options[field.lookup!]?.length && (
            <p className="uai-footnote">
              {loadingOptions
                ? 'Loading destinations…'
                : 'No saved webhooks. Create one in Notifications → Webhooks.'}
            </p>
          )}
          {field.help && <p className="uai-footnote">{field.help}</p>}
        </fieldset>
      );
    return (
      <Field key={field.key} className="admin-field">
        <FieldLabel htmlFor={id}>
          {field.label}
          {field.key === 'threshold'
            ? ` (${(values.allowance_subscription?values.allowance_unit:thresholdUnit(values.signal))})`
            : ''}
          {field.required ? ' *' : ''}
        </FieldLabel>
        {field.lookup ? (
          <Choice
            id={id}
            value={values[field.key]}
            required={field.required}
            options={
              field.lookup === 'budgetTargets'
                ? values.kind === 'provider'
                  ? options.providers
                  : options.periods
                : options[field.lookup]
            }
            onChange={(v) => setValue(field, v)}
          />
        ) : field.type === 'duration' ? (
          <DurationInput
            id={id}
            value={values[field.key]}
            scale={field.scale ?? 1}
            onChange={(v) => setValue(field, v)}
            required={field.required}
          />
        ) : field.type === 'textarea' || field.type === 'json' ? (
          <textarea
            id={id}
            className={field.type === 'json' ? 'admin-code' : ''}
            rows={field.type === 'json' ? 8 : 3}
            value={values[field.key]}
            required={field.required}
            onChange={(e) => setValue(field, e.target.value)}
            aria-describedby={help}
          />
        ) : field.type === 'select' ? (
          <select
            id={id}
            value={values[field.key]}
            required={field.required}
            onChange={(e) => setValue(field, e.target.value)}
          >
            {field.options?.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        ) : field.type === 'checkbox' ? (
          <input
            id={id}
            type="checkbox"
            checked={!!values[field.key]}
            onChange={(e) => setValue(field, e.target.checked)}
          />
        ) : (
          <Input
            id={id}
            type={field.type === 'usd' ? 'text' : (field.type ?? 'text')}
            inputMode={field.type === 'usd' ? 'decimal' : undefined}
            value={values[field.key]}
            required={field.required}
            min={field.type === 'number' ? 0 : undefined}
            autoComplete={field.type === 'password' ? 'new-password' : 'off'}
            onChange={(e) => setValue(field, e.target.value)}
            aria-describedby={help}
          />
        )}{' '}
        {field.help && (
          <p id={help} className="uai-footnote">
            {field.help}
          </p>
        )}
      </Field>
    );
  };
  const normal = form.fields.filter((f) => !f.advanced && !f.section);
  const groups = [
    ...new Set(form.fields.filter((f) => f.section).map((f) => f.section!)),
  ];
  return (
    <dialog
      ref={ref}
      className={`admin-dialog${form.readOnly?' admin-dialog-readonly':''}${form.action.startsWith('models_')?' admin-dialog-models':''}${form.action.startsWith('rates_')?' admin-dialog-rates':''}`}
      onCancel={(event) => {
        if (pending) event.preventDefault();
        else onClose();
      }}
      aria-labelledby="command-title"
      aria-describedby="command-description"
    >
      <form
        onSubmit={submit}
        onInvalidCapture={(event) => {
          let parent = (event.target as HTMLElement).parentElement;
          while (parent) {
            if (parent instanceof HTMLDetailsElement) parent.open = true;
            parent = parent.parentElement;
          }
        }}
      >
        <div className="admin-dialog-heading">
          <div>
            <h2 id="command-title">{form.title}</h2>
            <p id="command-description">{form.description}</p>
          </div>
          <button
            className="admin-close"
            type="button"
            onClick={onClose}
            disabled={pending}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="admin-dialog-body">
          {form.provenance&&<section aria-label="Published source" className="admin-editor-section">
            <h3>Published source</h3>
            <dl className="admin-source-details">
              <div><dt>File</dt><dd>{form.provenance.path}</dd></div>
              <div><dt>Git revision</dt><dd>{form.provenance.git_revision}{form.provenance.git_dirty?' · working-tree changes':''}</dd></div>
              <div><dt>Content SHA-256</dt><dd>{form.provenance.content_hash}</dd></div>
              <div><dt>Schema</dt><dd>{form.provenance.schema_version}</dd></div>
              <div><dt>Published by</dt><dd>{form.provenance.publisher}</dd></div>
              <div><dt>Release</dt><dd>{form.provenance.release_id}</dd></div>
            </dl>
            <details><summary>Published dependencies</summary><dl className="admin-source-details">{Object.entries(form.provenance.dependencies).map(([key,id])=><div key={key}><dt>{key}</dt><dd>{id}</dd></div>)}</dl></details>
          </section>}
          {form.comparison && <ConfigurationDiff {...form.comparison}/>}
          <fieldset disabled={pending||(form.readOnly&&!form.action.startsWith('models_'))} className="admin-form-fields">
            <FieldGroup>
              {lookupError && (
                <p role="status" className="uai-footnote">
                  {lookupError}
                </p>
              )}
              {normal
                .filter((f) => f.key !== 'reason' && f.key !== 'comment')
                .map(renderField)}
              {groups.map((group) => (
                <details className="admin-disclosure" key={group}>
                  <summary>{group}</summary>
                  <FieldGroup>
                    {form.fields
                      .filter((f) => f.section === group)
                      .map(renderField)}
                    {group === 'Advanced metadata' && (
                      <p className="uai-footnote">
                        These values do not enforce execution limits. Open{' '}
                        <a href="#budgets" onClick={onClose}>
                          Execution budgets
                        </a>{' '}
                        or{' '}
                        <a href="#limiters" onClick={onClose}>
                          Rate limits
                        </a>{' '}
                        to change active limits.
                      </p>
                    )}
                  </FieldGroup>
                </details>
              ))}
              {normal
                .filter((f) => f.key === 'reason' || f.key === 'comment')
                .map(renderField)}
            </FieldGroup>
          </fieldset>
          {form.readOnly&&<details className="admin-disclosure"><summary>Full configuration JSON</summary><pre className="admin-json">{JSON.stringify(source.fields.find(f=>f.key==='payload')?.value??{},null,2)}</pre></details>}
          {error && (
            <Alert variant="destructive" role="alert">
              <AlertTitle>Changes were not saved</AlertTitle>
              <AlertDescription>
                {error} Your entered values are still in the form.
              </AlertDescription>
            </Alert>
          )}
        </div>
        <div className="admin-dialog-footer">
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={pending}
          >
            {form.readOnly?'Close':'Cancel'}
          </Button>
          {!form.readOnly&&<Button
            type="submit"
            variant={form.destructive ? 'destructive' : 'default'}
            disabled={pending}
          >
            {pending ? 'Saving…' : (form.submit ?? 'Save')}
          </Button>}
        </div>
      </form>
    </dialog>
  );
}
function DurationInput({
  id,
  value,
  scale,
  onChange,
  required,
}: {
  id: string;
  value: any;
  scale: number;
  onChange: (v: number | string) => void;
  required?: boolean;
}) {
  const [unit, setUnit] = useState(() =>
    Number(value) > 0 && Number(value) % (60 * scale) === 0 ? 60 : 1,
  );
  const [draft, setDraft] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setDraft(null);
    input.current?.setCustomValidity('');
  }, [value, unit]);
  return (
    <div className="admin-duration">
      <Input
        ref={input}
        id={id}
        type="number"
        min="0"
        step="any"
        required={required}
        value={draft ?? (value === '' ? '' : Number(value) / (unit * scale))}
        onChange={(e) => {
          setDraft(e.target.value);
          try {
            const next =
              e.target.value === ''
                ? ''
                : durationToUnits(e.target.value, unit * scale);
            e.target.setCustomValidity('');
            onChange(next);
          } catch (error) {
            e.target.setCustomValidity((error as Error).message);
          }
        }}
      />
      <select
        className="admin-select"
        aria-label="Time unit"
        value={unit}
        onChange={(e) => {
          if (input.current && !input.current.checkValidity()) {
            input.current.reportValidity();
            return;
          }
          setUnit(Number(e.target.value));
        }}
      >
        <option value="1">Seconds</option>
        <option value="60">Minutes</option>
      </select>
    </div>
  );
}
