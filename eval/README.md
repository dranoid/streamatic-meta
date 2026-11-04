# What SAM 3.1 found at setup

`setup-coverage.json` is the measured result of camera setup on three real cameras at one residential site in Lagos, each with
a day, a dusk and a night picture. For each camera, Muse Spark Open listed what it saw, and SAM 3.1 outlined each thing under
one word per request. The pictures are not in this repository, and the file names neither the cameras nor the site.

Build it again from an app folder holding those cameras' setup results, with no model call:

```
cd service && npm run eval-setup -- <app folder> <group> ../eval/setup-coverage.json
```

**The measure.** Across the three cameras, counting each camera on its own, SAM 3.1 outlined 33 kinds of thing. 20 of them were still
found on the night picture, and 16 were found on all three pictures. A kind can hold several zones, such as seven walls. A later run of setup on the same cameras, 4 November, gave 29 kinds and 18 at night, in 127 zones, so the result differs from run to run.

**What it missed.** Five were seen but not outlined, on the words tried: a drain on all three cameras, a bridge on one and a
power line on one. On the camera where a drain is plainly visible, SAM 3.1 found nothing under drain, ditch, gutter, drainage
channel, drainage ditch, open drain, storm drain, culvert, trench, canal or concrete channel at 768×432, nor under the first
four of those at 1280×720. The app names such things in its setup report, so a rule on one uses a drawn box instead of an outline.

**Limits.** This counts what was outlined, not whether each outline is right, and one picture stands for each time of day.

# A rule by voice note

`voice-notes.json` holds three real voice notes in English as Muse Voice Transcribe wrote them out, each with the plan from its words
and the plan from the sentence as typed. The recordings are not in this repository. Voice notes are supported in English only, since
Meta's list of supported languages does not include Nigerian Pidgin or Yoruba, and the words came out wrong in a trial of Pidgin notes.

**The measure.** Two of the three gave the same rule as the typed sentence. One of those was written out word for word; in the other,
"allow me" for "alert me" did not change the rule.

**What it got wrong.** "Ikeke" for "a keke" reached the plan's question. The page shows the words before anything is planned, and the
chat shows them with the plan before Confirm, so a wrong word can be put right.

**Limits.** One speaker and one recording of each sentence, and plans can vary from run to run.
