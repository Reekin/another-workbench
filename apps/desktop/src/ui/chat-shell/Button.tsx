import type { ButtonHTMLAttributes, ReactElement } from "react";

export type ButtonVariant =
  | "primary"
  | "accent"
  | "secondary"
  | "ghost"
  | "danger"
  | "text";
export type ButtonSize = "sm" | "md" | "lg" | "icon";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
};

export const Button = ({
  variant = "secondary",
  size = "md",
  className,
  type = "button",
  ...props
}: ButtonProps): ReactElement => (
  <button
    type={type}
    className={[
      "awb-button",
      `awb-button--${variant}`,
      `awb-button--${size}`,
      className
    ]
      .filter(Boolean)
      .join(" ")}
    {...props}
  />
);
