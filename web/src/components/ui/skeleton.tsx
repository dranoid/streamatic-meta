import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('bg-accent animate-pulse rounded-md', className)} {...props} />;
}
