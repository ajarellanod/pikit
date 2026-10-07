import { useState } from "react";
import { Button } from "@/components/bui/Button";
import { ApiFailure, signIn } from "@/lib/api";

/** The App's mark: a monogram tile, as the favicon. */
export function Monogram({ name = "pi", size = 20 }: { name?: string; size?: number }) {
  return (
    <span className="flex shrink-0 items-center justify-center rounded-[6px] bg-ink font-semibold text-surface" style={{ width: size, height: size, fontSize: Math.round(size * 0.5) }}>
      {name.slice(0, 2).toLowerCase()}
    </span>
  );
}

/**
 * Asks for the operator's token (PIKIT_ADMIN_TOKEN with admin-auth-token) and signs in with it once:
 * the browser keeps a session cookie no script can read, never the token.
 */
export function SignIn({ onSignedIn, refused = false }: { onSignedIn: (operator: string | undefined) => void; refused?: boolean }) {
  const [value, setValue] = useState("");
  const [problem, setProblem] = useState<string | undefined>(refused ? "The session ended: sign in again." : undefined);
  const [checking, setChecking] = useState(false);

  const submit = async () => {
    setChecking(true);
    setProblem(undefined);
    try {
      const operator = await signIn(value.trim());
      setValue("");
      onSignedIn(operator);
    } catch (error) {
      setProblem(error instanceof ApiFailure && error.status === 401 ? "That is not the operator's token." : `The API cannot be reached: ${String(error)}`);
    } finally {
      setChecking(false);
    }
  };

  return (
    <main className="flex min-h-svh items-center justify-center bg-canvas p-6 text-ink">
      <div className="w-full max-w-[380px] rounded-window border border-line bg-page p-6 shadow-card" style={{ animation: "fade-up 450ms cubic-bezier(0.23,1,0.32,1) both" }}>
        <div className="flex items-center gap-2">
          <Monogram size={24} />
          <span className="text-[14px] font-medium text-ink-2">pikit</span>
        </div>
        <h1 className="mt-6 text-[22px] font-normal tracking-[-0.02em] text-ink">Sign in</h1>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-2">Paste the operator's token (PIKIT_ADMIN_TOKEN). It is sent once; this browser keeps a session, not the token.</p>
        <form
          className="mt-5 flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <input
            type="password"
            autoComplete="current-password"
            placeholder="Token"
            aria-label="The operator's token"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            autoFocus
            className="h-10 w-full rounded-[10px] border border-line bg-surface px-3 text-[14px] text-ink shadow-card outline-none transition-[border-color] duration-150 placeholder:text-ink-3 focus:border-line-strong"
          />
          {problem !== undefined && <p className="text-[13px] text-red">{problem}</p>}
          <Button type="submit" variant="primary" className="w-full" disabled={checking || value.trim() === ""}>
            {checking ? "Checking…" : "Sign in"}
          </Button>
        </form>
      </div>
    </main>
  );
}
