import { useState } from 'react';
const names: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  cartesia: 'Cartesia',
  serper: 'Serper',
  firecrawl: 'Firecrawl',
  typesafe: 'TypeSafe Jev',
  fake: 'Local test adapter',
  voyage: 'Voyage',
  replicate: 'Replicate',
  quiver: 'Quiver',
};
export function ProviderIdentity({
  provider,
  name,
}: {
  provider: string;
  name: string;
}) {
  const [failed, setFailed] = useState(false);
  const branded = ['openai', 'anthropic', 'cartesia', 'serper'].includes(
    provider,
  );
  return (
    <span className="admin-provider-identity">
      <span className="admin-provider-logo" aria-hidden="true">
        {branded && !failed ? (
          <img
            src={`/providers/${provider}.${provider === 'serper' ? 'ico' : 'svg'}`}
            alt=""
            onError={() => setFailed(true)}
          />
        ) : provider === 'fake' ? (
          'T'
        ) : (
          (names[provider] ?? provider ?? '?').slice(0, 1).toUpperCase()
        )}
      </span>
      <span>
        <span className="admin-provider-name block">{name}</span>
        <span className="admin-provider-description uai-footnote block">
          {names[provider] ?? provider ?? 'Provider unavailable'}
        </span>
      </span>
    </span>
  );
}
