import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { Slot } from "radix-ui"

/* on the shared `.btn` classes (index.css), as bui's Button: one height and radius for every control */
const buttonVariants = cva(
  "btn group/button bg-clip-padding aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "btn-primary",
        outline: "btn-outline",
        secondary: "bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)]",
        ghost: "btn-ghost",
        destructive: "btn-danger",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "",
        xs: "btn-xs [&_svg:not([class*='size-'])]:size-3",
        sm: "",
        lg: "h-9 px-3.5",
        icon: "btn-icon",
        "icon-xs": "btn-xs btn-icon [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "btn-icon size-7",
        "icon-lg": "btn-icon size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
