import type { ReactNode } from 'react';
import { CircleAlert } from 'lucide-react';
import { cn } from '@/lib/cn';

export function Notice({ tone = 'muted', children, className }: { tone?: 'muted' | 'error'; children: ReactNode; className?: string }) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm',
        tone === 'error' ? 'border-destructive/40 bg-destructive/5 text-destructive' : 'bg-muted/50 text-muted-foreground',
        className,
      )}
    >
      <CircleAlert className='mt-0.5 size-4 shrink-0' />
      <div>{children}</div>
    </div>
  );
}
