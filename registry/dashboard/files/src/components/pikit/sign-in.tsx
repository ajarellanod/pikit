import { KeyRound } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api, ApiFailure, token } from "@/lib/api";

/**
 * Asks for the operator's token (PIKIT_ADMIN_TOKEN with admin-auth-token), checks it against the API
 * and keeps it in this browser.
 */
export function SignIn({ onSignedIn, refused = false }: { onSignedIn: () => void; refused?: boolean }) {
  const [value, setValue] = useState("");
  const [problem, setProblem] = useState<string | undefined>(refused ? "The API refused the token: sign in again." : undefined);
  const [checking, setChecking] = useState(false);

  const submit = async () => {
    setChecking(true);
    setProblem(undefined);
    token.set(value.trim());
    try {
      await api("/app");
      onSignedIn();
    } catch (error) {
      token.clear();
      setProblem(error instanceof ApiFailure && error.status === 401 ? "That is not the operator's token." : `The API cannot be reached: ${String(error)}`);
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="size-4" /> pikit
          </CardTitle>
          <CardDescription>Paste the operator's token (PIKIT_ADMIN_TOKEN). It stays in this browser.</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <Input type="password" autoComplete="current-password" placeholder="Token" value={value} onChange={(event) => setValue(event.target.value)} autoFocus />
            {problem !== undefined && <p className="text-sm text-destructive">{problem}</p>}
            <Button type="submit" className="w-full" disabled={checking || value.trim() === ""}>
              {checking ? "Checking…" : "Sign in"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
