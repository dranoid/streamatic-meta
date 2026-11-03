import { useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Loader2, Mic, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';

// The server cuts a recording at this length too; stopping here means the person is not cut off without knowing.
const MAX_SECONDS = 60;

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

// A sentence by voice, recorded here. The words go into the box for the person to read before anything is planned.
export function VoiceNote({ read, onText, disabled = false }: { read: (audio: Blob) => Promise<{ text: string }>; onText: (text: string) => void; disabled?: boolean }) {
  const [seconds, setSeconds] = useState<number | null>(null);
  const [micProblem, setMicProblem] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const reading = useMutation({ mutationFn: read, onSuccess: ({ text }) => onText(text.slice(0, 300)) });
  const canRecord = typeof MediaRecorder !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia);

  useEffect(() => {
    if (seconds === null) return;
    if (seconds >= MAX_SECONDS) {
      recorder.current?.stop();
      return;
    }
    const tick = setTimeout(() => setSeconds((s) => (s === null ? s : s + 1)), 1_000);
    return () => clearTimeout(tick);
  }, [seconds]);
  useEffect(() => () => recorder.current?.stop(), []);

  const start = async () => {
    setMicProblem(false);
    reading.reset();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const taking = new MediaRecorder(stream);
      const parts: Blob[] = [];
      taking.ondataavailable = (e) => parts.push(e.data);
      taking.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        recorder.current = null;
        setSeconds(null);
        reading.mutate(new Blob(parts, { type: taking.mimeType }));
      };
      recorder.current = taking;
      taking.start();
      setSeconds(0);
    } catch {
      setMicProblem(true);
    }
  };

  const recording = seconds !== null;
  return (
    <div className='space-y-2'>
      <div className='flex flex-wrap items-center gap-2'>
        {canRecord &&
          (recording ? (
            <Button type='button' variant='outline' size='sm' onClick={() => recorder.current?.stop()}>
              <Square />
              Stop
              <span className='tabular-nums'>{clock(seconds)}</span>
            </Button>
          ) : (
            <Button type='button' variant='outline' size='sm' disabled={disabled || reading.isPending} onClick={() => void start()}>
              <Mic />
              Record a voice note
            </Button>
          ))}
        {reading.isPending && (
          <span className='text-muted-foreground flex items-center gap-1.5 text-xs'>
            <Loader2 className='size-3.5 animate-spin' />
            Writing out the voice note
          </span>
        )}
      </div>
      {!canRecord && <p className='text-muted-foreground text-xs'>This browser cannot record a voice note here. Please write the rule instead.</p>}
      {canRecord && !reading.isSuccess && <p className='text-muted-foreground text-xs'>Voice notes are read in English.</p>}
      {reading.isSuccess && <p className='text-muted-foreground text-xs'>The voice note is written out above. Please read it and correct any errors before adding the rule.</p>}
      {reading.isError && <Notice tone='error'>{reading.error.message}</Notice>}
      {micProblem && <Notice tone='error'>The microphone could not be used. Please allow it in the browser, or write the rule instead.</Notice>}
    </div>
  );
}
