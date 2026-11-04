import { Info } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

const PARTS = [
  {
    title: 'Setting up a camera',
    sam: 'Outlines each listed item on the day, dusk and night pictures, so it becomes a zone a rule can watch.',
    spark: 'Lists what it sees in the three pictures, and suggests rules for what was outlined.',
    built: 'Matches each zone across the three pictures, so it is named once. Lets a visitor rename or delete a zone for themselves alone, and carries that to the player, Add a rule and the chat.',
  },
  {
    title: 'Running a rule',
    sam: 'Outlines the rule’s zones on the alert’s pictures, so the person sees the place the rule is about.',
    spark: 'Chooses which picture goes on the alert. It is not asked whether the rule holds.',
    built: 'Sends Streamatic’s rules the sentence with each zone’s place, shows how much of the clip they have read, and copies their alerts onto the timeline as they are found.',
    before: 'Streamatic’s rules read the sentence, answer it on the camera’s pictures, and decide whether and when to alert.',
  },
  {
    title: 'Adding a rule',
    sam: null,
    spark: 'Decides from the person’s sentence, typed or written out from a voice note by Muse Voice Transcribe, whether it is a rule, a search or a question. For a rule it drafts the plan; for a search it gives up to three names for the item.',
    built: 'Chooses among the cameras this person has set up, from what setup outlined, or stays on the camera the person is on. Checks a plan against the camera’s zones and the person’s own words, and sends a refused plan back with the reason. Looks for a searched item on the paused frame and then every 30 seconds through the clip. Marks each stage done when the page shows it done, and asks the person only to select among the items found.',
  },
  {
    title: 'Questions about a clip',
    sam: null,
    spark: 'Chooses what to count for the question and writes the answer in a sentence.',
    detector: 'RF-DETR and ByteTrack went over each clip once, found the people, vehicles and bags in it and how each moves, and the tracks are recorded. This stands in for a detector running live. RF-DETR reads each frame in enlarged sections, so that people far from the camera are found.',
    built: 'Counts from those tracks within the person’s own zones, in seconds. Replaces an answer whose numbers are not the counts, declines a question the counts do not fit, and offers each moment found on the clip. Counts are approximate.',
  },
  {
    title: 'Searching a clip',
    sam: 'Outlines what is on the paused frame, under each word or inside a box the person draws. Then tracks up to four selected outlines in one request, both ways from that frame, from their boxes alone, over the minute around that frame, since each frame is charged.',
    spark: 'Lists the kinds of thing on the frame that could be searched for, and names what a drawn box holds.',
    built: 'Accumulates what each search finds on the one frame, prefers the outline found by a drawn item’s name when it is the same thing, removes stray dots, works out from the frames SAM has finished how far the track has gone and when each item was in view, and keeps each result so asking again costs nothing.',
  },
  {
    title: 'Events',
    sam: null,
    spark: null,
    built: 'Lists every alert Streamatic’s rules raised on the clips, and those of the rules a visitor added, which only that visitor sees, in the language chosen. No model is called.',
  },
  {
    title: 'The clips on this page',
    sam: 'Outlines what a clip shows when the clip is set up, and on a picture you upload.',
    spark: 'Lists what is worth outlining, suggests rules and drafts the plan for a rule.',
    built: 'Only the clips, their first rules and what the detector found are recorded. Setup, a new rule and a question run live.Keeps the clips and rules in this page’s own database, serves the videos, and works out from the moment a rule is selected what you see and when.',
    before: 'Whether and when a rule alerts is decided by Streamatic’s rules, and copied here.',
  },
  {
    title: 'Alerts in Pidgin and Yoruba',
    sam: null,
    spark: 'Says what a rule’s alert means in the language chosen, from the rule alone. It is not asked whether the rule holds.',
    built: 'Keeps what was written, so each rule is written once and playing a clip calls no model.',
  },
  {
    title: 'Alerts on Telegram',
    sam: null,
    spark: 'Plans a rule from a voice note or a sentence sent in the chat, as Add a rule does on the page.',
    built: 'Links the chat from the page by Telegram’s own number for the person, keeps the page’s daily limits, and sends each alert as the clip plays through it.',
  },
] satisfies Array<{ title: string; sam: string | null; spark: string | null; detector?: string; built: string; before?: string }>;

export function AboutPage() {
  return (
    <>
      <PageHeader
        icon={<Info />}
        title='About'
        description='What each part of this page does: what SAM 3.1, Muse Spark Open and Muse Voice Transcribe do, what was built for this hackathon, and what Streamatic had from before this event.'
      />
      <div className='grid gap-4 lg:grid-cols-2'>
        {PARTS.map((part) => (
          <Card key={part.title}>
            <CardHeader>
              <CardTitle>{part.title}</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className='space-y-3 text-sm'>
                {part.sam && <Part name='SAM 3.1' text={part.sam} />}
                {part.spark && <Part name='Muse Spark Open' text={part.spark} />}
                {'detector' in part && part.detector && <Part name='Detector and tracker, not from Meta' text={part.detector} />}
                <Part name='Built for this hackathon' text={part.built} />
                {'before' in part && part.before && <Part name='Streamatic, from before this event' text={part.before} />}
              </dl>
            </CardContent>
          </Card>
        ))}
      </div>
      <Card className='mt-4'>
        <CardHeader>
          <div>
            <CardTitle>Where the models run</CardTitle>
            <CardDescription>SAM 3.1 and Muse Voice Transcribe are called through Meta’s Model API. Muse Spark Open runs on Baseten. RF-DETR (Apache 2.0) and ByteTrack (MIT) run on Modal.</CardDescription>
          </div>
        </CardHeader>
      </Card>
    </>
  );
}

function Part({ name, text }: { name: string; text: string }) {
  return (
    <div>
      <dt className='font-medium'>{name}</dt>
      <dd className='text-muted-foreground mt-0.5'>{text}</dd>
    </div>
  );
}
