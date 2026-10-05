import { CircleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ApiFailure } from "@/lib/api";

/** An error from the admin API, said plainly. */
export function ErrorNote({ error, title = "Something went wrong" }: { error: Error; title?: string }) {
  return (
    <Alert variant="destructive">
      <CircleAlert />
      <AlertTitle>{error instanceof ApiFailure ? `${title} (${error.status})` : title}</AlertTitle>
      <AlertDescription>{error.message}</AlertDescription>
    </Alert>
  );
}
