/* Leaderboard rows this origin refuses to serve.
 *
 * Regenerate with:
 *   npm run audit:leaderboard -- --track-id <sha256> --apply
 *
 * The audit tool lists a track's unfiltered leaderboard and records the ids
 * whose verdict is Invalid / InvalidDuplicate / InvalidManual, so a row the
 * verifier network rejected cannot keep ranking here even if the shared
 * backend still returns it.
 */
export default [];
