import { ArrowRight, Eye, EyeClosed, Lock } from "iconoir-react";
import { useRef, useState } from "react";
import { Button } from "@/components/bui/Button";
import { Field } from "@/components/bui/Field";
import { ApiFailure, signIn } from "@/lib/api";
import { usePageTitle } from "@/lib/shell";
import { Mark } from "./mark";

/** Each part of the card rises in after the one before it (`sign-in-rise`; none with reduced motion). */
const rise = (step: number) => ({ animation: `sign-in-rise 620ms cubic-bezier(0.16, 1, 0.3, 1) ${80 + step * 60}ms both` });

/**
 * Asks for the operator's token (PIKIT_ADMIN_TOKEN with admin-auth-token) and signs in with it once:
 * the browser keeps a session cookie no script can read, never the token. In Beautiful UI's language:
 * a raised card on the app's canvas (its shadow scale), the mark and the product, a title and what to
 * paste, an inset field that shows or hides the token, the primary pill with its progress, and a line
 * that says what went wrong and what to do.
 */
export function SignIn({ onSignedIn, refused = false }: { onSignedIn: (operator: string | undefined) => void; refused?: boolean }) {
  const [value, setValue] = useState("");
  const [shown, setShown] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(refused ? "Your session ended. Sign in again to go on." : undefined);
  const [checking, setChecking] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  usePageTitle("Sign in");

  const submit = async () => {
    if (value.trim() === "" || checking) return;
    setChecking(true);
    setProblem(undefined);
    try {
      const operator = await signIn(value.trim());
      setValue("");
      onSignedIn(operator);
    } catch (error) {
      setProblem(
        error instanceof ApiFailure && error.status === 401
          ? "That token was not accepted. Check PIKIT_ADMIN_TOKEN in the service's environment."
          : `The service could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      );
      field.current?.select();
    } finally {
      setChecking(false);
    }
  };

  return (
    <main className="relative flex min-h-svh items-center justify-center overflow-hidden bg-canvas p-6 text-ink">
      {/* the product's banner behind the card: a field of dots fading out, and the mark's warm light */}
      <div aria-hidden className="sign-in-glow pointer-events-none absolute inset-0" />
      <div aria-hidden className="sign-in-dots pointer-events-none absolute inset-0" />

      <div className="relative w-full max-w-[400px]" style={rise(0)}>
        <div className="rounded-[20px] bg-surface p-1.5 shadow-overlay">
          <div className="rounded-[15px] px-6 pt-6 pb-5">
            <div className="flex items-center gap-2.5" style={rise(1)}>
              <Mark size={26} />
              <span className="text-[19px] leading-[26px] font-semibold tracking-[-0.02em] text-ink">Pikit</span>
            </div>

            {/* what happens to the token, quietly, before anything is asked */}
            <div className="mt-5 inline-flex max-w-full items-center gap-1.5 rounded-md bg-inset px-2 py-1 text-[11.5px] leading-4 text-ink-3 shadow-hairline" style={rise(2)}>
              <span className="size-1.5 shrink-0 rounded-full bg-green" aria-hidden />
              <span className="truncate">Sent once; this browser keeps a session, never the token.</span>
            </div>

            <h1 className="mt-4 text-[22px] font-medium tracking-[-0.02em] text-ink" style={rise(2)}>
              Sign in
            </h1>
            <p className="mt-1.5 text-[13.5px] leading-[1.55] text-ink-2" style={rise(2)}>
              Paste your Pikit token to see this service's conversations, live.
            </p>

            <form
              className="mt-6 flex flex-col gap-3"
              style={rise(3)}
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <Field
                id="operator-token"
                label="Pikit token"
                required
                error={problem}
                hint={
                  <>
                    It is <span className="font-mono text-[11.5px] text-ink-2">PIKIT_ADMIN_TOKEN</span> in the service's environment.
                  </>
                }
              >
                {(control) => (
                  <div className="control group flex items-center gap-2 pr-0.5 pl-2.5">
                    <Lock width={15} height={15} strokeWidth={1.9} className="shrink-0 text-ink-3" aria-hidden />
                    <input
                      {...control}
                      ref={field}
                      type={shown ? "text" : "password"}
                      autoComplete="current-password"
                      spellCheck={false}
                      placeholder="Paste the token"
                      value={value}
                      onChange={(event) => {
                        setValue(event.target.value);
                        if (problem !== undefined) setProblem(undefined);
                      }}
                      autoFocus
                      className="h-full min-w-0 flex-1 bg-transparent font-mono text-[13.5px] tracking-[0.01em] text-ink outline-none placeholder:font-sans placeholder:tracking-normal"
                    />
                    <button
                      type="button"
                      aria-label={shown ? "Hide the token" : "Show the token"}
                      aria-pressed={shown}
                      onClick={() => {
                        setShown((current) => !current);
                        field.current?.focus();
                      }}
                      className="flex size-7 shrink-0 items-center justify-center rounded-[6px] text-ink-3 transition-colors duration-100 hover:bg-(--control-hover) hover:text-ink"
                    >
                      {shown ? <EyeClosed width={16} height={16} strokeWidth={1.9} /> : <Eye width={16} height={16} strokeWidth={1.9} />}
                    </button>
                  </div>
                )}
              </Field>

              <Button type="submit" variant="primary" className="mt-2 w-full" disabled={checking || value.trim() === ""} aria-busy={checking}>
                {checking ? (
                  <>
                    <span className="size-3.5 rounded-full border-[1.5px] border-current border-t-transparent" style={{ animation: "spin 700ms linear infinite" }} aria-hidden />
                    Signing in
                  </>
                ) : (
                  <>
                    Sign in
                    <ArrowRight width={15} height={15} strokeWidth={2} aria-hidden />
                  </>
                )}
              </Button>
            </form>
          </div>

        </div>
      </div>
    </main>
  );
}
