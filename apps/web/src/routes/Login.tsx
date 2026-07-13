export function Login() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-basalt">
      <div className="w-full max-w-sm rounded-lg border border-ash/20 bg-console p-10">
        <p className="mb-2 select-none font-display text-lg font-semibold uppercase tracking-[0.25em] text-bonewhite">
          OUTPOST
        </p>
        <p className="mb-8 font-body text-sm text-ash">
          Your self-hosted Claude Code environment.
        </p>
        <a
          href="/auth/login"
          className="block w-full rounded bg-beacon px-4 py-2.5 text-center font-body text-sm font-medium text-basalt transition-opacity hover:opacity-90"
        >
          Continue with GitHub
        </a>
      </div>
    </div>
  );
}
