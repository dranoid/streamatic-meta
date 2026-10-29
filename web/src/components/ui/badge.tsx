import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

const variants = {
  default: 'border-transparent bg-primary text-primary-foreground',
  muted: 'border-transparent bg-muted text-muted-foreground',
  outline: 'text-foreground',
  success: 'border-success/30 bg-success/10 text-success',
  warning: 'border-warning/30 bg-warning/10 text-warning',
  alert: 'border-alert/30 bg-alert/10 text-alert',
  gold: 'border-gold/40 bg-gold/15 text-foreground',
};

export function Badge({ className, variant = 'default', ...props }: ComponentProps<'span'> & { variant?: keyof typeof variants }) {
  return (
    <span
      className={cn(
        'inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap [&>svg]:size-3',
        variants[variant],
        className,
      )}
      {...props}
    />
  );
}
