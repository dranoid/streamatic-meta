import type { Picture } from '../sam/client.js';

export interface SecondOpinion {
  confirmed: boolean | null;
  reason: string;
}

export interface SecondOpinionJudge {
  // zoneOutline is the zone's outline at setup, as an SVG path in picture pixels.
  judge(input: { rule: string; zone: string; zoneOutline: string; before: Picture; now: Picture }): Promise<SecondOpinion>;
}

// The alert goes out first; this runs after it and appends the verdict, since Spark Open's reasoning takes seconds.
export async function recordSecondOpinion({
  judge,
  sender,
  messageId,
  caption,
  rule,
  zone,
  zoneOutline,
  before,
  now,
}: {
  judge: SecondOpinionJudge;
  sender: { editCaption(messageId: number, caption: string): Promise<void> };
  messageId: number;
  caption: string;
  rule: string;
  zone: string;
  zoneOutline: string;
  before: Picture;
  now: Picture;
}): Promise<SecondOpinion> {
  const opinion = await judge.judge({ rule, zone, zoneOutline, before, now });
  const verdict =
    opinion.confirmed === null
      ? 'could not judge from the pictures.'
      : `${opinion.confirmed ? 'confirmed' : 'unconfirmed'}. ${opinion.reason.trim()}`.trim();
  await sender.editCaption(messageId, `${caption}\nSecond opinion (Muse Spark Open): ${verdict}`);
  return opinion;
}
