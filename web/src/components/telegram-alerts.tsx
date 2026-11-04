import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, Send } from 'lucide-react';
import type { AlertLanguage } from '@/components/language-choice';
import { NeedsKeys } from '@/components/needs-keys';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { useAbilities } from '@/lib/abilities';

const WAIT_FOR_START_MS = 2_000;
// Long enough to find the chat and select Start; after this the person is told what to do if Telegram refused the link.
const NOT_LINKED_YET_MS = 45_000;

// Whether this visitor's alerts go to Telegram. The clip and language chosen here are what the chat uses.
export function useTelegramLink(clip: string, language: AlertLanguage) {
  const { telegram } = useAbilities();
  const [opened, setOpened] = useState(false);
  const [waitedLong, setWaitedLong] = useState(false);
  const [openProblem, setOpenProblem] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: ['telegram', clip],
    queryFn: () => api.telegramStatus(clip),
    enabled: telegram,
    refetchInterval: (query) => (opened && !query.state.data?.linked ? WAIT_FOR_START_MS : false),
  });
  const linked = status.data?.linked === true;
  useEffect(() => {
    if (linked) void api.telegramChoose(clip, language);
  }, [linked, clip, language]);
  useEffect(() => {
    setWaitedLong(false);
    if (!opened || linked) return;
    const waited = setTimeout(() => setWaitedLong(true), NOT_LINKED_YET_MS);
    return () => clearTimeout(waited);
  }, [opened, linked]);
  const turnOff = useMutation({
    mutationFn: api.telegramTurnOff,
    onSuccess: () => {
      setOpened(false);
      void queryClient.invalidateQueries({ queryKey: ['telegram', clip] });
    },
  });
  // A link is asked for at the moment of opening it: one fetched when the page loaded may have lapsed since. The tab is opened
  // first, because a browser allows that only during the click itself.
  const open = async () => {
    setOpenProblem(null);
    const tab = window.open('', '_blank');
    if (tab) tab.opener = null;
    try {
      const fresh = await api.telegramStatus(clip);
      queryClient.setQueryData(['telegram', clip], fresh);
      if (!fresh.link) {
        tab?.close();
        return;
      }
      setOpened(true);
      if (tab) tab.location.href = fresh.link;
      else window.location.assign(fresh.link);
    } catch {
      tab?.close();
      setOpenProblem('The Telegram link could not be created. Please try again.');
    }
  };
  return { available: telegram, linked, opened, waitedLong, openProblem, open, turnOff: () => turnOff.mutate() };
}

export function TelegramAlerts({ telegram, problem }: { telegram: ReturnType<typeof useTelegramLink>; problem: string | null }) {
  const { available, linked, opened, waitedLong, openProblem, open, turnOff } = telegram;
  if (!available) {
    return (
      <div className='space-y-2'>
        <Button size='sm' variant='outline' disabled>
          <Send />
          Send alerts to Telegram
        </Button>
        <NeedsKeys />
      </div>
    );
  }
  if (linked) {
    return (
      <div className='space-y-2'>
        <p role='status' className='text-success flex items-center gap-1.5 text-sm font-medium'>
          <CircleCheck className='size-4 shrink-0' />
          Linked to Telegram
        </p>
        <p className='text-muted-foreground text-xs leading-relaxed'>Alerts from the rules you select on any clip go to your Telegram chat as that clip plays. You can also send a voice note in English, or a sentence, in that chat to add a rule to the clip you last opened.</p>
        <Button size='sm' variant='outline' onClick={turnOff}>
          Stop sending alerts to Telegram
        </Button>
        {problem && <p role='alert' className='text-destructive text-sm'>{problem}</p>}
      </div>
    );
  }
  return (
    <div className='space-y-2'>
      <Button size='sm' variant='outline' onClick={() => void open()}>
        <Send />
        Send alerts to Telegram
      </Button>
      {opened && (
        <p role='status' className='text-sm'>
          {waitedLong ? 'This chat is not linked yet. If Telegram reports that the link has lapsed, select “Send alerts to Telegram” again.' : 'Select Start in Telegram to finish. This page updates when the chat is linked.'}
        </p>
      )}
      {openProblem && <p className='text-sm'>{openProblem}</p>}
      <p className='text-muted-foreground text-xs leading-relaxed'>
        A linked Telegram account stays linked to this browser for a day. A voice note you send in that chat goes to Meta to be written out, under the hackathon’s credit terms, which allow Meta to use it for product improvement. This page keeps no copy.
      </p>
    </div>
  );
}
