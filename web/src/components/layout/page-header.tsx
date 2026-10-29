import { Fragment, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { Link } from '@/components/ui/link';

export function PageHeader({
  trail = [],
  icon,
  title,
  badges,
  description,
  actions,
}: {
  trail?: Array<{ href: string; label: string }>;
  icon: ReactNode;
  title: string;
  badges?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className='mb-6 space-y-3'>
      {trail.length > 0 && (
        <nav aria-label='Breadcrumb'>
          <ol className='text-muted-foreground flex flex-wrap items-center gap-1.5 text-xs font-medium'>
            {trail.map((t) => (
              <Fragment key={t.href}>
                <li>
                  <Link href={t.href} className='hover:text-foreground'>
                    {t.label}
                  </Link>
                </li>
                <li aria-hidden='true'>
                  <ChevronRight className='size-3.5' />
                </li>
              </Fragment>
            ))}
            <li aria-current='page' className='text-foreground max-w-[20rem] truncate'>
              {title}
            </li>
          </ol>
        </nav>
      )}
      <div className='flex flex-wrap items-start gap-3'>
        <div className='bg-primary/15 text-primary flex size-10 shrink-0 items-center justify-center rounded-lg [&_svg]:size-5'>{icon}</div>
        <div className='min-w-0 flex-1'>
          <div className='flex flex-wrap items-center gap-2'>
            <h1 className='text-xl font-semibold'>{title}</h1>
            {badges}
          </div>
          {description && <p className='text-muted-foreground mt-0.5 text-sm'>{description}</p>}
        </div>
        {actions && <div className='flex flex-wrap items-center gap-2'>{actions}</div>}
      </div>
    </header>
  );
}
