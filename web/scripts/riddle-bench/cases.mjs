/**
 * Riddle-judge benchmark cases. NOT a canonical-answer key — these are
 * manually tiered test inputs for measuring whether a candidate judge
 * statement produces useful *ordering*, not a list of "correct" answers the
 * game ships with or scores against. The game itself never reads this file.
 *
 * tier (lower = should score higher) follows the categories requested:
 *   1 excellent interpretation
 *   2 strong interpretation
 *   3 plausible but weaker interpretation
 *   4 unexpected but defensible interpretation      (should land near 1-3)
 *   5 potentially clever but questionable/stretching (should land mid-pack,
 *     not top - this is the hardest category to place and the most
 *     informative one to watch)
 *   6 vague answer
 *   7 literal answer that fails (resolves nothing, states the obvious)
 *   8 riddle-word repetition / parroting
 *   9 unrelated answer
 *  10 obvious nonsense
 *
 * Tiers 1-4 are "should score well" (roughly 70-100). Tiers 5-6 are "mixed,
 * mid-range" (roughly 30-70). Tiers 7-10 are "should score poorly" (roughly
 * 0-30). The exact numbers matter less than whether tier 1-4 beats tier 7-10
 * with real separation and without 8-10 (nonsense/repetition/unrelated)
 * sneaking into the top.
 *
 * Where the task prompt itself gave worked examples (R1's "a competition" /
 * "a conversation" / "a password" as good, "purple elephant toaster" as bad,
 * "a dream" scored 91 in the leaderboard mock), those are used verbatim as
 * the strongest ground truth in this set.
 */

export const RIDDLES = [
  {
    id: "enter-without-going-in",
    prompt: "What can you enter without going in?",
    cases: [
      { tier: 1, answer: "A competition" }, // prompt's own GOOD example
      { tier: 1, answer: "A race" },
      { tier: 2, answer: "A conversation" }, // prompt's own "potentially good"
      { tier: 2, answer: "A password" }, // prompt's own "potentially good"
      { tier: 3, answer: "A raffle" },
      { tier: 4, answer: "A dream" }, // prompt's own leaderboard example (91)
      { tier: 5, answer: "A trance" },
      { tier: 6, answer: "Something abstract" },
      { tier: 7, answer: "A room" }, // literal: entering a room IS going in
      { tier: 7, answer: "A building" },
      { tier: 8, answer: "You enter without going in by entering it" },
      { tier: 9, answer: "A sandwich" },
      { tier: 10, answer: "Purple elephant toaster" }, // prompt's own BAD example
      { tier: 10, answer: "asdkjfh qwoeiru" },
    ],
  },
  {
    id: "behind-before-passed",
    prompt: "What can be behind you before you've passed it?",
    cases: [
      { tier: 1, answer: "Your reputation" },
      { tier: 2, answer: "A rumor about you" },
      { tier: 2, answer: "Your past mistakes" },
      { tier: 3, answer: "A deadline you already missed" },
      { tier: 4, answer: "The sunset" },
      { tier: 5, answer: "Your shadow at the right time of day" },
      { tier: 6, answer: "Time" },
      { tier: 7, answer: "A person standing behind you in a queue" },
      { tier: 8, answer: "Something behind me before I pass it" },
      { tier: 9, answer: "A sandwich" },
      { tier: 10, answer: "Banana telephone quantum" },
    ],
  },
  {
    id: "more-true-when-stop-believing",
    prompt: "What can become more true when you stop believing it?",
    cases: [
      { tier: 1, answer: "That you don't need it" },
      { tier: 2, answer: "Your independence" },
      { tier: 3, answer: "A superstition losing its power over you" },
      { tier: 4, answer: "That you've moved on" },
      { tier: 5, answer: "Doubt itself" },
      { tier: 6, answer: "A feeling" },
      { tier: 7, answer: "A fact" },
      { tier: 8, answer: "Believing it more true when you stop believing" },
      { tier: 9, answer: "A sandwich" },
      { tier: 10, answer: "Glorble wafflecopter nine" },
    ],
  },
  {
    id: "leave-without-going-anywhere",
    prompt: "What can you leave without going anywhere?",
    cases: [
      { tier: 1, answer: "A message" },
      { tier: 1, answer: "A voicemail" },
      { tier: 2, answer: "A note" },
      { tier: 2, answer: "An impression" },
      { tier: 3, answer: "A legacy" },
      { tier: 4, answer: "A job, by quitting in your head" },
      { tier: 5, answer: "A relationship, emotionally" },
      { tier: 6, answer: "Something behind" },
      { tier: 7, answer: "Your house" },
      { tier: 8, answer: "Leaving without going anywhere at all" },
      { tier: 9, answer: "A sandwich" },
      { tier: 10, answer: "Xylophone quantum soup" },
    ],
  },
  {
    id: "found-only-after-lost",
    prompt: "What can be found only after it is lost?",
    cases: [
      { tier: 1, answer: "Your voice, in a crowd" },
      { tier: 2, answer: "Peace of mind" },
      { tier: 2, answer: "Gratitude" },
      { tier: 3, answer: "A sense of home" },
      { tier: 4, answer: "Your appetite, after being sick" },
      { tier: 5, answer: "Confidence" },
      { tier: 6, answer: "Something important" },
      { tier: 7, answer: "Your keys" },
      { tier: 8, answer: "Found only after it is lost, which is lost" },
      { tier: 9, answer: "A sandwich" },
      { tier: 10, answer: "Marmalade dinosaur printer" },
    ],
  },
];
