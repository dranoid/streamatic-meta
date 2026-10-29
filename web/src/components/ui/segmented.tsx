import { cn } from '@/lib/cn';

// The dashboard's tab strip, used here for small either-or choices (picture, view).
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  className,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  label: string;
  className?: string;
}) {
  return (
    <div role='tablist' aria-label={label} className={cn('bg-muted text-muted-foreground inline-flex h-9 w-fit items-center rounded-lg p-[3px]', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type='button'
          role='tab'
          aria-selected={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn(
            'inline-flex h-full items-center justify-center rounded-md px-3 text-sm font-medium whitespace-nowrap transition-[color,box-shadow] focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
            o.value === value ? 'bg-background text-foreground shadow-sm dark:bg-input/30 dark:border-input dark:border' : 'hover:text-foreground',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
