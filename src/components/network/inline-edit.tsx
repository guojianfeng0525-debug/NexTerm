import { useState } from 'react';
import { Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/**
 * Compact click-to-edit text cell used by the interface / route / firewall /
 * port tables. The pencil is always faintly visible (not hover-only) so the
 * affordance survives touch input and narrow-sidebar layouts.
 */
export interface InlineEditProps {
  /** Current persisted value. */
  value: string;
  /** Called with the new value only when it actually changed. */
  onCommit: (next: string) => void;
  /** Placeholder (and tooltip fallback) shown when `value` is empty. */
  placeholder?: string;
  /** Accessible name for the pencil button and the input. */
  label: string;
  className?: string;
  inputClassName?: string;
  textClassName?: string;
}

export function InlineEdit({
  value,
  onCommit,
  placeholder,
  label,
  className,
  inputClassName,
  textClassName,
}: InlineEditProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const commit = () => {
    setEditing(false);
    if (draft !== value) onCommit(draft);
  };

  if (editing) {
    return (
      <Input
        autoFocus
        value={draft}
        aria-label={label}
        placeholder={placeholder}
        className={cn('h-5 w-full min-w-0 px-1 text-[10px]', inputClassName)}
        onChange={event => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={event => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            setEditing(false);
          }
        }}
      />
    );
  }

  return (
    <div className={cn('flex min-w-0 items-center gap-0.5', className)}>
      <span
        className={cn(
          'min-w-0 flex-1 truncate',
          !value && 'text-muted-foreground/60',
          textClassName,
        )}
        title={value || placeholder}
      >
        {value || placeholder}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={label}
        title={label}
        className="h-4 w-4 shrink-0 opacity-40 transition-opacity hover:opacity-100 focus-visible:opacity-100"
        onClick={() => {
          setDraft(value);
          setEditing(true);
        }}
      >
        <Pencil className="h-2.5 w-2.5" />
      </Button>
    </div>
  );
}
