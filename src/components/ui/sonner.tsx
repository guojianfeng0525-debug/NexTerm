"use client";

import { useTheme } from "next-themes";
import { Toaster as Sonner, ToasterProps } from "sonner";

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme();

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      toastOptions={{
        classNames: {
          toast: "rounded-xl border border-border shadow-lg",
          success: "border-green-500/30",
          error: "border-red-500/30",
          warning: "border-yellow-500/30",
          info: "border-blue-500/30",
        },
        // Small-window adaptive toasts (visual review B-1, v2.9.0): cap the
        // width so a toast never covers the top toolbar or dialog fields at
        // 960x700, and keep it below the top bar (56px clears the toolbar).
        style: {
          maxWidth: "min(320px, calc(100vw - 32px))",
          marginTop: "56px",
          width: "fit-content",
        },
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "0.75rem",
        } as React.CSSProperties
      }
      {...props}
    />
  );
};

export { Toaster };
