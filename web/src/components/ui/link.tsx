import type { ComponentProps, MouseEvent } from 'react';
import { navigate } from '@/lib/router';

export function Link({ href, onClick, ...props }: ComponentProps<'a'> & { href: string }) {
  const go = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    navigate(href);
  };
  return <a href={href} onClick={go} {...props} />;
}
