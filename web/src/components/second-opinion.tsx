import { CircleCheck, CircleHelp, CircleX, Hourglass } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { StoredEvent } from '@/lib/api';

export function SecondOpinionBadge({ opinion }: { opinion: StoredEvent['secondOpinion'] }) {
  if (!opinion)
    return (
      <Badge variant='muted'>
        <Hourglass />
        Second opinion pending
      </Badge>
    );
  if (opinion.confirmed === null)
    return (
      <Badge variant='warning'>
        <CircleHelp />
        Not judged
      </Badge>
    );
  return opinion.confirmed ? (
    <Badge variant='success'>
      <CircleCheck />
      Confirmed
    </Badge>
  ) : (
    <Badge variant='warning'>
      <CircleX />
      Unconfirmed
    </Badge>
  );
}
