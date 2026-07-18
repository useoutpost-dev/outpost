import { useEffect, useState } from 'react';

// Mirror of the server's nameSchema (sandboxes/routes.ts)
const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

function validateName(v: string): string | null {
  if (!v) return 'Name is required.';
  if (!NAME_RE.test(v))
    return 'Lowercase letters, digits, and hyphens only. No leading/trailing hyphens. Max 40 chars.';
  return null;
}

export interface AccountPublic {
  id: string;
  label: string;
  kind: 'subscription' | 'api_key';
  hasCredentials: boolean;
  createdAt: string;
}

type AccountMode = 'existing' | 'new-subscription' | 'new-api-key' | 'none';

export interface SandboxCreateProps {
  onCreated: () => void;
  onBack: () => void;
}

export function SandboxCreate({ onCreated, onBack }: SandboxCreateProps) {
  // — name field —
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);

  // — account mode —
  const [accountMode, setAccountMode] = useState<AccountMode>('none');

  // — existing accounts —
  const [accounts, setAccounts] = useState<AccountPublic[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);

  // — new account fields —
  const [newLabel, setNewLabel] = useState('');
  const [newApiKey, setNewApiKey] = useState('');
  const [newLabelError, setNewLabelError] = useState<string | null>(null);
  const [newApiKeyError, setNewApiKeyError] = useState<string | null>(null);

  // — submission —
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Load accounts on mount
  useEffect(() => {
    setAccountsLoading(true);
    setAccountsError(null);
    fetch('/api/accounts', { credentials: 'include' })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<AccountPublic[]>;
      })
      .then((data) => {
        setAccounts(data);
        setAccountsLoading(false);
      })
      .catch((err: unknown) => {
        setAccountsError(err instanceof Error ? err.message : String(err));
        setAccountsLoading(false);
      });
  }, []);

  function handleNameChange(v: string) {
    setName(v);
    if (nameError) setNameError(validateName(v));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);

    // Validate name
    const nameErr = validateName(name);
    if (nameErr) {
      setNameError(nameErr);
      return;
    }

    // Validate new account fields
    if (accountMode === 'new-subscription' || accountMode === 'new-api-key') {
      let hasFieldError = false;
      if (!newLabel.trim()) {
        setNewLabelError('Label is required.');
        hasFieldError = true;
      } else {
        setNewLabelError(null);
      }
      if (accountMode === 'new-api-key' && !newApiKey.trim()) {
        setNewApiKeyError('API key is required.');
        hasFieldError = true;
      } else {
        setNewApiKeyError(null);
      }
      if (hasFieldError) return;
    }

    if (accountMode === 'existing' && !selectedAccountId) {
      setSubmitError('Select an account or choose a different option.');
      return;
    }

    setSubmitting(true);
    try {
      let accountId: string | undefined;

      // Step 1: create account if needed
      if (accountMode === 'new-subscription' || accountMode === 'new-api-key') {
        const body: Record<string, string> = {
          label: newLabel.trim(),
          kind: accountMode === 'new-subscription' ? 'subscription' : 'api_key',
        };
        if (accountMode === 'new-api-key') body.apiKey = newApiKey;

        const res = await fetch('/api/accounts', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          const msg = res.status === 409
            ? 'An account with that label already exists.'
            : `Failed to create account: ${text || res.status}`;
          setSubmitError(msg);
          setSubmitting(false);
          return;
        }
        const created = (await res.json()) as AccountPublic;
        accountId = created.id;
      } else if (accountMode === 'existing') {
        accountId = selectedAccountId ?? undefined;
      }
      // 'none' → no accountId

      // Step 2: create sandbox
      const sbBody: Record<string, unknown> = { name };
      if (accountId) sbBody.accountId = accountId;

      const sbRes = await fetch('/api/sandboxes', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sbBody),
      });
      if (!sbRes.ok) {
        const text = await sbRes.text().catch(() => '');
        const msg = sbRes.status === 409
          ? 'A sandbox with that name already exists.'
          : `Failed to create sandbox: ${text || sbRes.status}`;
        setSubmitError(msg);
        setSubmitting(false);
        return;
      }

      onCreated();
    } catch (err: unknown) {
      setSubmitError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-basalt">
      {/* Top bar */}
      <header className="flex h-14 flex-none items-center border-b border-ash/20 bg-console px-6">
        <button
          type="button"
          onClick={onBack}
          className="font-mono text-xs text-ash transition-colors hover:text-bonewhite"
        >
          ← back
        </button>
        <span className="ml-4 select-none font-display text-sm font-semibold uppercase tracking-[0.25em] text-bonewhite">
          New Sandbox
        </span>
      </header>

      <main className="flex flex-1 flex-col p-6">
        <form onSubmit={handleSubmit} className="flex w-full max-w-md flex-col gap-6" noValidate>

          {/* Name field */}
          <section className="flex flex-col gap-2">
            <label className="font-display text-xs font-semibold uppercase tracking-[0.2em] text-ash">
              Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              placeholder="my-sandbox"
              autoCapitalize="none"
              autoComplete="off"
              spellCheck={false}
              className="rounded border border-ash/30 bg-console px-3 py-2 font-mono text-sm text-bonewhite placeholder-ash/50 outline-none focus:border-beacon"
            />
            {nameError && (
              <p className="font-mono text-xs text-rust">{nameError}</p>
            )}
          </section>

          {/* Account picker */}
          <section className="flex flex-col gap-3">
            <span className="font-display text-xs font-semibold uppercase tracking-[0.2em] text-ash">
              Account
            </span>

            {/* Existing account */}
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="radio"
                name="accountMode"
                value="existing"
                checked={accountMode === 'existing'}
                onChange={() => setAccountMode('existing')}
                className="accent-beacon"
              />
              <span className="font-mono text-sm text-bonewhite">Use existing account</span>
            </label>

            {accountMode === 'existing' && (
              <div className="ml-5 flex flex-col gap-2">
                {accountsLoading && (
                  <p className="font-mono text-xs text-ash">loading…</p>
                )}
                {accountsError && (
                  <p className="font-mono text-xs text-rust">Error: {accountsError}</p>
                )}
                {!accountsLoading && !accountsError && accounts.length === 0 && (
                  <p className="font-mono text-xs text-ash">No accounts yet.</p>
                )}
                {!accountsLoading && !accountsError && accounts.map((acc) => (
                  <label
                    key={acc.id}
                    className="flex cursor-pointer items-start gap-2 rounded border border-ash/20 bg-console px-3 py-2"
                  >
                    <input
                      type="radio"
                      name="existingAccount"
                      value={acc.id}
                      checked={selectedAccountId === acc.id}
                      onChange={() => setSelectedAccountId(acc.id)}
                      className="mt-0.5 accent-beacon"
                    />
                    <div className="flex flex-col gap-0.5">
                      <span className="font-mono text-sm text-bonewhite">{acc.label}</span>
                      <span className="font-mono text-xs text-ash">
                        {acc.kind === 'api_key' ? 'API key' : 'Subscription'}
                        {!acc.hasCredentials && (
                          <span className="ml-2 text-ash/60">· no credentials yet</span>
                        )}
                      </span>
                    </div>
                  </label>
                ))}
              </div>
            )}

            {/* New subscription account */}
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="radio"
                name="accountMode"
                value="new-subscription"
                checked={accountMode === 'new-subscription'}
                onChange={() => setAccountMode('new-subscription')}
                className="accent-beacon"
              />
              <span className="font-mono text-sm text-bonewhite">New subscription account</span>
            </label>

            {accountMode === 'new-subscription' && (
              <div className="ml-5 flex flex-col gap-2">
                <input
                  type="text"
                  value={newLabel}
                  onChange={(e) => { setNewLabel(e.target.value); if (newLabelError) setNewLabelError(null); }}
                  placeholder="Account label"
                  autoComplete="off"
                  className="rounded border border-ash/30 bg-console px-3 py-2 font-mono text-sm text-bonewhite placeholder-ash/50 outline-none focus:border-beacon"
                />
                {newLabelError && (
                  <p className="font-mono text-xs text-rust">{newLabelError}</p>
                )}
              </div>
            )}

            {/* New API key account */}
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="radio"
                name="accountMode"
                value="new-api-key"
                checked={accountMode === 'new-api-key'}
                onChange={() => setAccountMode('new-api-key')}
                className="accent-beacon"
              />
              <span className="font-mono text-sm text-bonewhite">New API key account</span>
            </label>

            {accountMode === 'new-api-key' && (
              <div className="ml-5 flex flex-col gap-2">
                <input
                  type="text"
                  value={newLabel}
                  onChange={(e) => { setNewLabel(e.target.value); if (newLabelError) setNewLabelError(null); }}
                  placeholder="Account label"
                  autoComplete="off"
                  className="rounded border border-ash/30 bg-console px-3 py-2 font-mono text-sm text-bonewhite placeholder-ash/50 outline-none focus:border-beacon"
                />
                {newLabelError && (
                  <p className="font-mono text-xs text-rust">{newLabelError}</p>
                )}
                <input
                  type="password"
                  value={newApiKey}
                  onChange={(e) => { setNewApiKey(e.target.value); if (newApiKeyError) setNewApiKeyError(null); }}
                  placeholder="sk-ant-…"
                  autoComplete="new-password"
                  className="rounded border border-ash/30 bg-console px-3 py-2 font-mono text-sm text-bonewhite placeholder-ash/50 outline-none focus:border-beacon"
                />
                {newApiKeyError && (
                  <p className="font-mono text-xs text-rust">{newApiKeyError}</p>
                )}
              </div>
            )}

            {/* No account */}
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="radio"
                name="accountMode"
                value="none"
                checked={accountMode === 'none'}
                onChange={() => setAccountMode('none')}
                className="accent-beacon"
              />
              <span className="font-mono text-sm text-bonewhite">No account</span>
            </label>
          </section>

          {/* Submit error */}
          {submitError && (
            <p className="font-mono text-xs text-rust">{submitError}</p>
          )}

          {/* Actions */}
          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={submitting}
              className="rounded bg-beacon px-4 py-2 font-mono text-xs font-medium text-basalt transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {submitting ? 'Creating…' : 'Create sandbox'}
            </button>
            <button
              type="button"
              onClick={onBack}
              disabled={submitting}
              className="font-mono text-xs text-ash transition-colors hover:text-bonewhite disabled:opacity-50"
            >
              Cancel
            </button>
          </div>

        </form>
      </main>
    </div>
  );
}
