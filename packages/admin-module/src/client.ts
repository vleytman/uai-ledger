export const ADMIN_API_PATH='/api/uai-admin';
export async function api(
  view: string,
  id?: string,
  query: Record<string, string> = {},
) {
  const response = await fetch(
    `${ADMIN_API_PATH}?view=${encodeURIComponent(view)}${id ? `&id=${encodeURIComponent(id)}` : ''}${Object.entries(
      query,
    )
      .map(([k, v]) => `&${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('')}`,
    { cache: 'no-store' },
  );
  const result = await response.json();
  if (!response.ok && typeof window!=='undefined' && [401,403].includes(response.status)) window.dispatchEvent(new CustomEvent('uai-access-changed',{detail:result}));
  if (!response.ok)
    throw Object.assign(
      new Error(
        typeof result.error === 'string'
          ? result.error
          : (result.error?.message ?? 'Unable to load data.'),
      ),
      { status: response.status, code: result.error?.code, mode:result.mode, login_url:result.login_url },
    );
  return result;
}
export async function command(
  action: string,
  data: unknown,
  key: string,
  id?: string,
  revision?: number,
) {
  const response = await fetch(ADMIN_API_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, data, key, id, revision }),
  });
  const result = await response.json();
  if (!response.ok && typeof window!=='undefined' && [401,403].includes(response.status)) window.dispatchEvent(new CustomEvent('uai-access-changed',{detail:result}));
  if (!response.ok)
    throw Object.assign(
      new Error(
        typeof result.error === 'string'
          ? result.error
          : (result.error?.message ?? 'Unable to complete the action.'),
      ),
      { status: response.status, code: result.error?.code, mode:result.mode, login_url:result.login_url },
    );
  return result;
}
