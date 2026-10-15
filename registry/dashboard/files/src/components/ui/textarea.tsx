import * as React from "react"
import { cn } from "cn"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "control flex field-sizing-content min-h-16 w-full",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
