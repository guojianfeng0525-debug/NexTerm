import * as React from "react";
import { Eye, EyeOff } from "lucide-react";
import { Button } from "./button";
import { Input } from "./input";
import { cn } from "./utils";

function PasswordInput({ className, type: _type, ...props }: React.ComponentProps<"input">) {
  const [show, setShow] = React.useState(false);
  // Passwords are ASCII — block IME composition (Chinese/Japanese/Korean) so
  // the input method can never inject composed text into the field. Both the
  // composition events AND beforeinput (fires on Windows when IME commits)
  // are intercepted; anything non-ASCII is dropped.
  const blockIme = (e: React.CompositionEvent<HTMLInputElement>) => e.preventDefault();
  const blockBeforeInput = (e: React.FormEvent<HTMLInputElement> & { data?: string | null }) => {
    // Allow only plain ASCII keystrokes (letters, digits, common symbols).
    if (e.data && !/^[\x20-\x7e]+$/.test(e.data)) {
      e.preventDefault();
    }
  };
  return (
    <div className="relative">
      <Input
        type={show ? "text" : "password"}
        className={cn("pr-10", className)}
        onCompositionStart={blockIme}
        onCompositionUpdate={blockIme}
        onCompositionEnd={blockIme}
        onBeforeInput={blockBeforeInput}
        {...props}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2 text-muted-foreground hover:text-foreground"
        aria-label={show ? "Hide password" : "Show password"}
        title={show ? "Hide password" : "Show password"}
        onClick={() => setShow((v) => !v)}
      >
        {show ? <EyeOff /> : <Eye />}
      </Button>
    </div>
  );
}

export { PasswordInput };
