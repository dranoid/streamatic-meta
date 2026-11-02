import { Info } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

const PARTS = [
  {
    title: 'Setting up a camera',
    sam: 'Outlines each listed thing on the day, dusk and night pictures, so it becomes a zone a rule can watch.',
    spark: 'Lists what it sees in the three pictures, and suggests rules for what was outlined.',
    code: 'Matches each zone across the three pictures, so it is named once.',
  },
  {
    title: 'Running a rule',
    sam: 'Outlines the rule’s zones again on the pictures being checked.',
    spark: 'Answers the question on each drawn box. When a rule is saved, reads from its sentence whether one picture settles it or a change across several.',
    code: 'Compares each picture with the one before and asks for a check only when something changed inside a zone. Raises an alert when the answer becomes yes, not again while it stays yes.',
  },
  {
    title: 'The guide',
    sam: null,
    spark: 'Drafts a plan for the rule from the person’s sentence.',
    code: 'Checks the plan against the camera’s zones and the person’s own words, and sends a refused plan back with the reason. Ticks a step only when the page shows it done and the person confirms it.',
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
        description='Streamatic, built for the Meta hackathon on SAM 3.1 and Muse Spark Open. This page sets out what each part does.'
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
            <CardDescription>SAM 3.1 is called through Meta’s Model API. Muse Spark Open runs on Baseten.</CardDescription>
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
