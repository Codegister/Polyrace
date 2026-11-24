/* Leaderboard policy shared by every origin this repo controls.
 *
 * The leaderboard backend is shared with other clients, so the only thing a
 * mirror can be sure of is what it asks for, what it forwards and what it
 * shows:
 *
 *   - reads pass the caller's verification filter through, defaulting to the
 *     full list: the shared backend reports no `verifiedState` and no verified
 *     rows at all, so forcing verified-only renders empty leaderboards (an
 *     explicit `onlyVerified=true` from the in-game toggle still works),
 *   - uploads must be structurally consistent: a run's recording can only
 *     encode inputs strictly before the frame count it claims to have
 *     finished on, so a submission where they disagree is refused instead of
 *     being ranked,
 *   - rows the origin has already identified as bad are dropped from reads
 *     (`leaderboard-quarantine.mjs`, maintained by
 *     `npm run audit:leaderboard -- --apply`).
 *
 * The module is plain ESM with no dependencies so it runs unchanged in the
 * Cloudflare Worker, in the Node dev proxy and in the test suite.
 */

export const VERIFIED_STATE = {
  Pending: 0,
  Verified: 1,
  Invalid: 2,
  InvalidDuplicate: 3,
  InvalidManual: 4,
};

export const MAX_FRAMES = 5999999;
export const MAX_RECORDING_LENGTH = 9999;
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

const TOKEN_PATTERN = /^[0-9a-f]{64}$/i;
const CAR_COLORS_PATTERN = /^[0-9a-f]{24}$/i;
const RECORDING_PATTERN = /^[A-Za-z0-9_-]+$/;
const TRACK_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/* Rewrites a leaderboard query string so that the verification filter is
 * explicit and paging stays within sane bounds. A missing filter means the full
 * list, because the backend has nothing verified to show. */
export function sanitizeLeaderboardSearch(search) {
  const params = new URLSearchParams(search || "");
  if (params.get("onlyVerified") !== "true") {
    params.set("onlyVerified", "false");
  }
  const amount = Number.parseInt(params.get("amount") || "", 10);
  params.set(
    "amount",
    String(
      Number.isSafeInteger(amount) && amount > 0
        ? Math.min(amount, MAX_PAGE_SIZE)
        : DEFAULT_PAGE_SIZE
    )
  );
  const skip = Number.parseInt(params.get("skip") || "", 10);
  params.set("skip", String(Number.isSafeInteger(skip) && skip > 0 ? skip : 0));
  return params;
}

function base64UrlToBytes(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function inflate(bytes) {
  if (typeof DecompressionStream !== "function") {
    throw new Error("DecompressionStream is not available");
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/* Decodes the game's recording format (five runs of delta-encoded toggle
 * frames, zlib-compressed, base64url) and returns the last frame that carries
 * an input, or null when the string is missing, oversized or undecodable. */
export async function maximumInputFrame(recording) {
  if (typeof recording !== "string" || recording.length === 0) return null;
  if (recording.length > MAX_RECORDING_LENGTH) return null;
  if (!RECORDING_PATTERN.test(recording)) return null;

  let bytes;
  try {
    bytes = await inflate(base64UrlToBytes(recording));
  } catch {
    return null;
  }

  let offset = 0;
  let maximum = 0;
  for (let section = 0; section < 5; section += 1) {
    if (offset + 3 > bytes.length) return null;
    const count = bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
    offset += 3;
    if (offset + count * 3 > bytes.length) return null;
    let frame = 0;
    for (let i = 0; i < count; i += 1) {
      const delta = bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
      offset += 3;
      frame += delta;
      if (!Number.isSafeInteger(frame) || frame < 0) return null;
      if (frame > maximum) maximum = frame;
    }
  }
  if (offset !== bytes.length) return null;
  return maximum;
}

/* Checks an upload before it is forwarded. The recording stops on the frame the
 * car finishes, so an input recorded after that frame cannot belong to the run
 * the time claims; an input exactly on the finish frame is legitimate (a control
 * pressed on the winning tick). Restarting mid-run is recorded as reset toggles
 * on the same frame timeline, so earlier attempts stay behind the finish. */
export async function validateLeaderboardUpload(params) {
  const trackId = params.get("trackId");
  const token = params.get("userToken");
  const name = params.get("name");
  const carColors = params.get("carColors");
  const frames = Number.parseInt(params.get("frames") || "", 10);
  const recording = params.get("recording");

  if (!trackId || !TRACK_ID_PATTERN.test(trackId)) {
    return { ok: false, reason: "trackId is missing or malformed" };
  }
  if (!token || !TOKEN_PATTERN.test(token)) {
    return { ok: false, reason: "userToken is missing or is not 64 hex characters" };
  }
  if (typeof name !== "string" || name.length < 1 || name.length > 50) {
    return { ok: false, reason: "name must be 1-50 characters" };
  }
  if (!carColors || !CAR_COLORS_PATTERN.test(carColors)) {
    return { ok: false, reason: "carColors must be 24 hex characters" };
  }
  if (!Number.isSafeInteger(frames) || frames <= 0 || frames > MAX_FRAMES) {
    return { ok: false, reason: "frames is missing or out of range" };
  }

  const lastInputFrame = await maximumInputFrame(recording);
  if (lastInputFrame === null) {
    return { ok: false, reason: "recording is missing, oversized or undecodable" };
  }
  if (lastInputFrame > frames) {
    return {
      ok: false,
      reason: "recording has inputs after the claimed finish frame",
    };
  }
  return { ok: true };
}

/* Turns the generated quarantine module into a set of row ids. */
export function parseQuarantine(value) {
  const list = Array.isArray(value) ? value : Array.isArray(value && value.ids) ? value.ids : [];
  const ids = new Set();
  for (const entry of list) {
    const id = Number(entry);
    if (Number.isSafeInteger(id) && id > 0) ids.add(id);
  }
  return ids;
}

/* Removes quarantined rows from a leaderboard payload and keeps the count and
 * the caller's own row consistent with what is left. */
export function filterLeaderboardPayload(payload, quarantined) {
  if (!payload || !Array.isArray(payload.entries) || !quarantined || quarantined.size === 0) {
    return { payload, removed: 0 };
  }
  const entries = payload.entries.filter((entry) => !(entry && quarantined.has(entry.id)));
  const removed = payload.entries.length - entries.length;
  if (removed === 0) return { payload, removed: 0 };
  const total = Number.isSafeInteger(payload.total)
    ? Math.max(0, payload.total - removed)
    : payload.total;
  const userEntry =
    payload.userEntry && quarantined.has(payload.userEntry.id) ? null : payload.userEntry;
  return { payload: { ...payload, total, entries, userEntry }, removed };
}

/* Splits entries into verified / pending / invalid / unknown row ids. A row
 * without a state is unknown, not invalid: this backend sends no state at all,
 * and the audit tool must never quarantine rows it knows nothing about. */
export function classifyEntries(entries) {
  const verified = [];
  const pending = [];
  const invalid = [];
  const unknown = [];
  for (const entry of entries || []) {
    if (!entry || !Number.isSafeInteger(entry.id)) continue;
    if (entry.verifiedState == null) unknown.push(entry.id);
    else if (entry.verifiedState === VERIFIED_STATE.Verified) verified.push(entry.id);
    else if (entry.verifiedState === VERIFIED_STATE.Pending) pending.push(entry.id);
    else invalid.push(entry.id);
  }
  return { verified, pending, invalid, unknown };
}

export function describeVerifiedState(state) {
  if (state == null) return "unknown";
  switch (state) {
    case VERIFIED_STATE.Verified:
      return "verified";
    case VERIFIED_STATE.Pending:
      return "pending";
    case VERIFIED_STATE.InvalidDuplicate:
      return "duplicate";
    default:
      return "invalid";
  }
}
