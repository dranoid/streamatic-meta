import { Info } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

const PARTS = [
  {
    title: 'Setting up a camera',
    sam: 'Outlines each listed item on the day, dusk and night pictures, so it becomes a zone a rule can watch.',
    spark: 'Lists what it sees in the three pictures, and suggests rules for what was outlined.',
    code: 'Matches each zone across the three pictures, so it is named once.',
  },
  {
    title: 'Running a rule',
    sam: 'Outlines the rule’s zones on the alert’s pictures, so the person sees the place the rule is about.',
    spark: 'Chooses which picture goes on the alert. It is not asked whether the rule holds.',
    code: 'Streamatic’s existing rules, which were built before this event, read the sentence and answer it on the camera’s pictures. This build sends them the sentence with each zone’s place, and copies their alerts into its events.',
  },
  {
    title: 'The guide',
    sam: null,
    spark: 'Drafts a plan for the rule from the person’s sentence, typed or written out from a voice note by Muse Voice Transcribe.',
    code: 'Checks the plan against the camera’s zones and the person’s own words, and sends a refused plan back with the reason. Shows how Streamatic reads the rule, and marks a step done only when the page shows it done and the person confirms it.',
  },
  {
    title: 'Searching a clip',
    sam: 'Outlines what is on the paused frame, under each word or at a click. Then tracks the selected outline both ways from that frame, from its box alone: through the whole clip on a private copy, and over the minute around that frame on this public page, where each frame is charged.',
    spark: 'Lists the kinds of thing on the frame that could be searched for, and names something selected by a click.',
    code: 'Accumulates what each search finds on the one frame, works out when the thing was in view, and keeps each result so asking again costs nothing.',
  },
  {
    title: 'The clips on this page',
    sam: 'Outlines what a clip shows when the clip is set up, and on a picture you upload.',
    spark: 'Lists what is worth outlining, suggests rules and drafts the guide’s plan.',
    code: 'Keeps the clips and rules in this page’s own database, serves the videos, and works out from the moment a rule is selected what you see and when. Whether and when a rule alerts is decided by Streamatic’s existing rules, built before this event, and copied here once.',
  },
  {
    title: 'Alerts in Pidgin and Yoruba',
    sam: null,
    spark: 'Says what a rule’s alert means in the language chosen, from the rule alone. It is not asked whether the rule holds.',
    code: 'Keeps what was written, so each rule is written once and playing a clip calls no model.',
  },
  {
    title: 'Alerts on Telegram',
    sam: null,
    spark: 'Plans a rule from a voice note or a sentence sent in the chat, as the guide does on the page.',
    code: 'Links the chat from the page by Telegram’s own number for the person, keeps the page’s daily limits, and sends each alert as the clip plays through it.',
  },
  {
    title: 'Questions about events',
    sam: null,
    spark: 'Chooses what to look up for the question.',
    code: 'Does the counting in the events database, so every number links to its events.',
  },
];

export function AboutPage() {
  return (
    <>
      <PageHeader
        icon={<Info />}
        title='About'
        description='Streamatic, built for the Meta hackathon on SAM 3.1, Muse Spark Open and Muse Voice Transcribe. This page sets out what each part does.'
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
                <Part name='Muse Spark Open' text={part.spark} />
                <Part name='Streamatic’s own code' text={part.code} />
              </dl>
            </CardContent>
          </Card>
        ))}
      </div>
      <Card className='mt-4'>
        <CardHeader>
          <div>
            <CardTitle>Where the models run</CardTitle>
            <CardDescription>SAM 3.1 and Muse Voice Transcribe are called through Meta’s Model API. Muse Spark Open runs on Baseten.</CardDescription>
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
