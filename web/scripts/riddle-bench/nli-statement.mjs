/** Declarative form of shared/challenges.js's riddleStatement(), for NLI-style
 * entailment scoring (premise/hypothesis pairs need a declarative hypothesis,
 * not a question). Kept separate from challenges.js so this fallback's
 * phrasing can be iterated on without touching the shipped kev-0.6b prompt. */
export function riddleStatementAsDeclarative(prompt) {
  return `This answer is a plausible interpretation of the riddle "${prompt}" that resolves its apparent contradiction.`;
}
