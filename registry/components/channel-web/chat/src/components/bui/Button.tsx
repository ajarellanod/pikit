import type { ButtonHTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/*
 * A button on the shared `.btn` classes (index.css): the controls' height (32px, 36px on touch) and
 * radius (8px), so a button beside an input is as tall as it. `primary` is ink, `secondary` an outline,
 * `ghost` and `quiet` only a hover; `sm` is `md` (one height for every control), `xs` the dense one.
 */
export const buttonVariants = cva("btn", {
  variants: {
    variant: {
      primary: "btn-primary",
      secondary: "btn-outline",
      ghost: "btn-ghost",
      accent: "btn-accent",
      danger: "btn-danger",
      /* transparent until hovered, in the ink of the text around it: dense toolbars, a heading's aside */
      quiet: "btn-ghost text-ink-2 hover:text-ink",
    },
    size: {
      xs: "btn-xs",
      sm: "",
      md: "",
    },
  },
  defaultVariants: { variant: "secondary", size: "md" },
});

export type ButtonVariant = NonNullable<VariantProps<typeof buttonVariants>["variant"]>;

export function Button({ variant, size, className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>) {
  return <button type="button" className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
